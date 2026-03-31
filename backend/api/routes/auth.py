"""
Auth routes — production-grade authentication system.

Endpoints:
- POST /register         — Self-registration with email verification + security questions
- POST /login            — JWT login with rate limiting + account lockout
- POST /refresh          — Token refresh
- POST /forgot-password  — Request password reset email
- POST /reset-password   — Reset password with token
- POST /verify-email     — Email verification
- POST /verify-security-questions — Verify security question answers
- GET  /password-strength — Check password strength
- GET  /me               — Current user
- GET  /users            — List users (admin only)
- POST /api-keys         — Create API key
- DELETE /api-keys/{id}  — Revoke API key
- POST /setup-admin      — One-time first admin setup

Security:
- bcrypt password hashing (never store plaintext)
- SHA-256 token hashing (reset + verification tokens)
- Rate limiting per IP on all auth endpoints
- Account lockout after 5 failed logins (15 min)
- Login attempt audit logging
- Time-limited tokens with single-use enforcement
- Generic error messages to prevent user enumeration
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, EmailStr, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.audit import log_event
from core.deps import get_current_user, require_admin
from core.email_service import send_password_reset_email, send_verification_email
from core.password_policy import validate_password
from core.rate_limiter import (
    check_login_rate, check_register_rate, check_reset_rate,
    get_client_ip, rate_limiter,
)
from core.security import (
    create_access_token, create_refresh_token, decode_token,
    hash_password, verify_password, generate_api_key, hash_api_key,
    sha256_str,
)
from core.settings import settings
from db.base import get_db
from db.models import (
    User, ApiKey, PasswordResetToken, EmailVerificationToken,
    SecurityQuestion, LoginAttempt,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ── Phase 7B: Admin-configurable password policy loader ──────────────────────

async def _validate_password_with_policy(password: str, db: AsyncSession):
    """Load password rules from AdminSettings and validate."""
    from db.models import AdminSettings
    result = await db.execute(select(AdminSettings).where(AdminSettings.is_active == True))
    s = result.scalar_one_or_none()
    return validate_password(
        password,
        min_length=getattr(s, 'password_min_length', None),
        require_mixed_case=getattr(s, 'password_require_mixed_case', None),
        require_number=getattr(s, 'password_require_number', None),
    )


# ── Schemas ───────────────────────────────────────────────────────────────────

class SecurityQuestionInput(BaseModel):
    question: str
    answer: str


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str
    full_name: str
    role: str = "PREPARER"
    security_questions: Optional[List[SecurityQuestionInput]] = None


class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    remember_me: bool = False


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user_id: str
    role: str
    full_name: str
    is_verified: bool = True


class RefreshRequest(BaseModel):
    refresh_token: str


class UserOut(BaseModel):
    id: str
    email: str
    full_name: str
    role: str
    is_active: bool
    is_verified: bool = True
    created_at: datetime


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class ResetPasswordRequest(BaseModel):
    token: str
    new_password: str


class VerifyEmailRequest(BaseModel):
    token: str


class VerifySecurityQuestionsRequest(BaseModel):
    email: EmailStr
    answers: List[SecurityQuestionInput]


class PasswordStrengthRequest(BaseModel):
    password: str


class PasswordStrengthResponse(BaseModel):
    strength: int
    strength_label: str
    valid: bool
    errors: List[str]


class CreateApiKeyRequest(BaseModel):
    label: str


class ApiKeyOut(BaseModel):
    id: str
    label: str
    raw_key: Optional[str] = None
    last_used: Optional[datetime]
    created_at: datetime


# ── Helper: log login attempt ────────────────────────────────────────────────

async def _log_login_attempt(
    db: AsyncSession,
    email: str,
    request: Request,
    success: bool,
    failure_reason: Optional[str] = None,
) -> None:
    attempt = LoginAttempt(
        email=email,
        ip_address=get_client_ip(request),
        user_agent=request.headers.get("User-Agent", "")[:500],
        success=success,
        failure_reason=failure_reason,
    )
    db.add(attempt)


# ── Helper: generate secure token ────────────────────────────────────────────

def _generate_token() -> tuple[str, str]:
    """Returns (raw_token, sha256_hash_of_token)."""
    raw = secrets.token_urlsafe(48)
    return raw, sha256_str(raw)


# ── Self-Registration ─────────────────────────────────────────────────────────

@router.post("/register", response_model=UserOut, status_code=201)
async def register(
    body: RegisterRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Public self-registration (when ALLOW_SELF_REGISTRATION=True).
    Creates unverified user + sends verification email.
    Security questions are stored with bcrypt-hashed answers.
    """
    check_register_rate(request)

    if not settings.ALLOW_SELF_REGISTRATION:
        raise HTTPException(status_code=403, detail="Self-registration is disabled. Contact an administrator.")

    # Validate password strength
    pw_result = await _validate_password_with_policy(body.password, db)
    if not pw_result.valid:
        raise HTTPException(status_code=400, detail={"message": "Password too weak", "errors": pw_result.errors})

    # Check duplicate email
    existing = await db.execute(select(User).where(User.email == body.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already registered")

    # Role validation: self-registration only allows PREPARER/REVIEWER
    allowed_roles = ("PREPARER", "REVIEWER")
    role = body.role if body.role in allowed_roles else "PREPARER"

    # Create user (unverified)
    user = User(
        email=body.email,
        hashed_password=hash_password(body.password),
        full_name=body.full_name,
        role=role,
        is_active=True,
        is_verified=False,
    )
    db.add(user)
    await db.flush()

    # Store security questions (hashed answers)
    if body.security_questions:
        for sq in body.security_questions[:3]:  # Max 3 questions
            question = SecurityQuestion(
                user_id=user.id,
                question=sq.question.strip(),
                answer_hash=hash_password(sq.answer.strip().lower()),  # Normalize + hash
            )
            db.add(question)

    # Generate email verification token
    raw_token, token_hash = _generate_token()
    verify_token = EmailVerificationToken(
        user_id=user.id,
        token_hash=token_hash,
        expires_at=datetime.now(timezone.utc) + timedelta(hours=settings.EMAIL_VERIFY_EXPIRE_HOURS),
    )
    db.add(verify_token)
    await db.flush()

    # Send verification email
    verify_url = f"{settings.FRONTEND_URL}/verify-email?token={raw_token}"
    send_verification_email(body.email, body.full_name, verify_url)

    await log_event(
        db, "USER_REGISTERED",
        f"User {body.email} registered (pending email verification)",
        user_id=user.id,
        ip_address=get_client_ip(request),
    )

    return UserOut(
        id=user.id, email=user.email, full_name=user.full_name,
        role=user.role, is_active=user.is_active, is_verified=user.is_verified,
        created_at=user.created_at,
    )


# ── Admin-only user creation ─────────────────────────────────────────────────

@router.post("/users", response_model=UserOut, status_code=201)
async def admin_create_user(
    body: RegisterRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Admin-only: create user with any role, auto-verified."""
    pw_result = await _validate_password_with_policy(body.password, db)
    if not pw_result.valid:
        raise HTTPException(status_code=400, detail={"message": "Password too weak", "errors": pw_result.errors})

    existing = await db.execute(select(User).where(User.email == body.email))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Email already registered")

    if body.role not in ("ADMIN", "PREPARER", "REVIEWER"):
        raise HTTPException(status_code=400, detail="Invalid role")

    user = User(
        email=body.email,
        hashed_password=hash_password(body.password),
        full_name=body.full_name,
        role=body.role,
        is_active=True,
        is_verified=True,  # Admin-created users are pre-verified
    )
    db.add(user)
    await db.flush()

    await log_event(db, "USER_CREATED", f"User {body.email} created with role {body.role}",
                    user_id=current_user.id, metadata={"new_user_email": body.email})

    return UserOut(id=user.id, email=user.email, full_name=user.full_name,
                   role=user.role, is_active=user.is_active, is_verified=user.is_verified,
                   created_at=user.created_at)


# ── Email Verification ────────────────────────────────────────────────────────

@router.post("/verify-email")
async def verify_email(body: VerifyEmailRequest, db: AsyncSession = Depends(get_db)):
    """Verify email address using the token from the verification email."""
    token_hash = sha256_str(body.token)
    result = await db.execute(
        select(EmailVerificationToken).where(
            EmailVerificationToken.token_hash == token_hash,
            EmailVerificationToken.used == False,
        )
    )
    token_record = result.scalar_one_or_none()

    if not token_record:
        raise HTTPException(status_code=400, detail="Invalid or expired verification link")

    if token_record.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Verification link has expired. Please request a new one.")

    # Mark token as used
    token_record.used = True

    # Verify the user
    user_result = await db.execute(select(User).where(User.id == token_record.user_id))
    user = user_result.scalar_one_or_none()
    if user:
        user.is_verified = True

    await log_event(db, "EMAIL_VERIFIED", f"Email verified for {user.email if user else 'unknown'}",
                    user_id=token_record.user_id)

    return {"message": "Email verified successfully. You can now sign in."}


# ── Resend Verification Email ─────────────────────────────────────────────────

@router.post("/resend-verification")
async def resend_verification(
    body: ForgotPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Resend email verification link."""
    check_reset_rate(request)

    # Always return success to prevent user enumeration
    result = await db.execute(select(User).where(User.email == body.email, User.is_active == True))
    user = result.scalar_one_or_none()

    if user and not user.is_verified:
        raw_token, token_hash = _generate_token()
        verify_token = EmailVerificationToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=settings.EMAIL_VERIFY_EXPIRE_HOURS),
        )
        db.add(verify_token)
        await db.flush()

        verify_url = f"{settings.FRONTEND_URL}/verify-email?token={raw_token}"
        send_verification_email(body.email, user.full_name, verify_url)

    return {"message": "If an account exists with that email, a verification link has been sent."}


# ── Login ─────────────────────────────────────────────────────────────────────

@router.post("/login", response_model=TokenResponse)
async def login(
    body: LoginRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    JWT login with:
    - Rate limiting (5 attempts / 15 min per IP)
    - Account lockout (5 failures → 15 min lock per email)
    - Login attempt audit logging
    - Remember me extends refresh token to 30 days
    """
    check_login_rate(request)

    # Phase 7C: Load configurable login protection from AdminSettings
    from db.models import AdminSettings
    _adm_r = await db.execute(select(AdminSettings).where(AdminSettings.is_active == True))
    _adm = _adm_r.scalar_one_or_none()
    _max_attempts = getattr(_adm, 'max_failed_login_attempts', None) or settings.MAX_LOGIN_ATTEMPTS
    _lockout_min = getattr(_adm, 'login_lockout_duration_min', None) or settings.LOCKOUT_DURATION_MINUTES
    _notify_lockout = getattr(_adm, 'notify_admin_on_lockout', False)

    # Check account lockout
    if rate_limiter.is_account_locked(
        body.email,
        max_failures=_max_attempts,
        lock_seconds=_lockout_min * 60,
    ):
        await _log_login_attempt(db, body.email, request, success=False, failure_reason="ACCOUNT_LOCKED")
        if _notify_lockout:
            await log_event(db, "ACCOUNT_LOCKOUT", f"Account locked: {body.email} after {_max_attempts} failed attempts",
                            ip_address=get_client_ip(request))
        raise HTTPException(
            status_code=423,
            detail=f"Account temporarily locked due to too many failed attempts. Try again in {_lockout_min} minutes."
        )

    result = await db.execute(select(User).where(User.email == body.email, User.is_active == True))
    user = result.scalar_one_or_none()

    if not user or not verify_password(body.password, user.hashed_password):
        rate_limiter.record_login_failure(body.email)
        await _log_login_attempt(db, body.email, request, success=False, failure_reason="INVALID_CREDENTIALS")
        raise HTTPException(status_code=401, detail="Invalid email or password")

    # Check email verification
    if not user.is_verified:
        await _log_login_attempt(db, body.email, request, success=False, failure_reason="UNVERIFIED_EMAIL")
        raise HTTPException(
            status_code=403,
            detail="Email not verified. Please check your inbox for the verification link."
        )

    # Success — clear lockout counter
    rate_limiter.clear_login_failures(body.email)

    user.last_login = datetime.now(timezone.utc)
    await _log_login_attempt(db, body.email, request, success=True)

    await log_event(db, "USER_LOGIN", f"User {user.email} logged in",
                    user_id=user.id, ip_address=get_client_ip(request))

    # Remember me: extend refresh token expiry
    refresh_expire = timedelta(days=30) if body.remember_me else timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)

    return TokenResponse(
        access_token=create_access_token(user.id, user.role),
        refresh_token=create_refresh_token(user.id, expires_delta=refresh_expire),
        user_id=user.id,
        role=user.role,
        full_name=user.full_name,
        is_verified=user.is_verified,
    )


# ── Refresh ───────────────────────────────────────────────────────────────────

@router.post("/refresh", response_model=TokenResponse)
async def refresh(body: RefreshRequest, db: AsyncSession = Depends(get_db)):
    try:
        payload = decode_token(body.refresh_token)
        if payload.get("type") != "refresh":
            raise HTTPException(status_code=401, detail="Invalid token type")
        user_id = payload["sub"]
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    result = await db.execute(select(User).where(User.id == user_id, User.is_active == True))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=401, detail="User not found")

    return TokenResponse(
        access_token=create_access_token(user.id, user.role),
        refresh_token=create_refresh_token(user.id),
        user_id=user.id,
        role=user.role,
        full_name=user.full_name,
        is_verified=user.is_verified,
    )


# ── Forgot Password ──────────────────────────────────────────────────────────

@router.post("/forgot-password")
async def forgot_password(
    body: ForgotPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Request password reset email.
    Always returns success to prevent user enumeration.
    Token is single-use, expires in 1 hour.
    """
    check_reset_rate(request)

    result = await db.execute(select(User).where(User.email == body.email, User.is_active == True))
    user = result.scalar_one_or_none()

    if user:
        # Invalidate any existing unused tokens for this user
        existing_tokens = await db.execute(
            select(PasswordResetToken).where(
                PasswordResetToken.user_id == user.id,
                PasswordResetToken.used == False,
            )
        )
        for token in existing_tokens.scalars().all():
            token.used = True

        # Generate new token
        raw_token, token_hash = _generate_token()
        reset_token = PasswordResetToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=settings.PASSWORD_RESET_EXPIRE_HOURS),
        )
        db.add(reset_token)
        await db.flush()

        # Send reset email
        reset_url = f"{settings.FRONTEND_URL}/reset-password?token={raw_token}"
        send_password_reset_email(user.email, user.full_name, reset_url)

        await log_event(db, "PASSWORD_RESET_REQUESTED",
                        f"Password reset requested for {user.email}",
                        user_id=user.id, ip_address=get_client_ip(request))

    # Always return success (prevent enumeration)
    return {"message": "If an account exists with that email, a password reset link has been sent."}


# ── Reset Password ────────────────────────────────────────────────────────────

@router.post("/reset-password")
async def reset_password(
    body: ResetPasswordRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Reset password using a valid token.
    Token is invalidated after use.
    """
    # Validate new password strength
    pw_result = await _validate_password_with_policy(body.new_password, db)
    if not pw_result.valid:
        raise HTTPException(status_code=400, detail={"message": "Password too weak", "errors": pw_result.errors})

    token_hash = sha256_str(body.token)
    result = await db.execute(
        select(PasswordResetToken).where(
            PasswordResetToken.token_hash == token_hash,
            PasswordResetToken.used == False,
        )
    )
    token_record = result.scalar_one_or_none()

    if not token_record:
        raise HTTPException(status_code=400, detail="Invalid or expired reset link")

    if token_record.expires_at.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Reset link has expired. Please request a new one.")

    # Mark token as used
    token_record.used = True
    token_record.used_at = datetime.now(timezone.utc)

    # Update user password
    user_result = await db.execute(select(User).where(User.id == token_record.user_id))
    user = user_result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=400, detail="Invalid reset link")

    user.hashed_password = hash_password(body.new_password)

    # Clear any login lockout
    rate_limiter.clear_login_failures(user.email)

    await log_event(db, "PASSWORD_RESET_COMPLETED",
                    f"Password reset completed for {user.email}",
                    user_id=user.id, ip_address=get_client_ip(request))

    return {"message": "Password reset successfully. You can now sign in with your new password."}


# ── Verify Security Questions ─────────────────────────────────────────────────

@router.post("/verify-security-questions")
async def verify_security_questions(
    body: VerifySecurityQuestionsRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """
    Verify security question answers.
    Used as extra verification before password reset.
    """
    check_reset_rate(request)

    result = await db.execute(select(User).where(User.email == body.email, User.is_active == True))
    user = result.scalar_one_or_none()

    if not user:
        # Generic response to prevent enumeration
        raise HTTPException(status_code=400, detail="Verification failed")

    # Get user's security questions
    sq_result = await db.execute(
        select(SecurityQuestion).where(SecurityQuestion.user_id == user.id)
    )
    stored_questions = {sq.question: sq.answer_hash for sq in sq_result.scalars().all()}

    if not stored_questions:
        raise HTTPException(status_code=400, detail="No security questions configured for this account")

    # Verify each answer
    correct_count = 0
    for answer in body.answers:
        stored_hash = stored_questions.get(answer.question)
        if stored_hash and verify_password(answer.answer.strip().lower(), stored_hash):
            correct_count += 1

    if correct_count < len(stored_questions):
        await log_event(db, "SECURITY_QUESTION_FAILED",
                        f"Security question verification failed for {body.email}",
                        user_id=user.id, ip_address=get_client_ip(request))
        raise HTTPException(status_code=400, detail="One or more answers are incorrect")

    await log_event(db, "SECURITY_QUESTION_VERIFIED",
                    f"Security questions verified for {body.email}",
                    user_id=user.id, ip_address=get_client_ip(request))

    return {"verified": True, "message": "Security questions verified successfully"}


# ── Get Security Questions (for a user, no answers) ──────────────────────────

@router.get("/security-questions")
async def get_security_questions(
    email: str,
    db: AsyncSession = Depends(get_db),
):
    """Return the security questions (without answers) for password reset flow."""
    result = await db.execute(select(User).where(User.email == email, User.is_active == True))
    user = result.scalar_one_or_none()

    if not user:
        return {"questions": []}

    sq_result = await db.execute(
        select(SecurityQuestion).where(SecurityQuestion.user_id == user.id)
    )
    questions = [sq.question for sq in sq_result.scalars().all()]
    return {"questions": questions}


# ── Password Strength Check ──────────────────────────────────────────────────

@router.post("/password-strength", response_model=PasswordStrengthResponse)
async def check_password_strength(body: PasswordStrengthRequest, db: AsyncSession = Depends(get_db)):
    """Real-time password strength checker (no auth required)."""
    result = await _validate_password_with_policy(body.password, db)
    return PasswordStrengthResponse(
        strength=result.strength,
        strength_label=result.strength_label,
        valid=result.valid,
        errors=result.errors,
    )


# ── Get Me ────────────────────────────────────────────────────────────────────

@router.get("/me", response_model=UserOut)
async def get_me(current_user: User = Depends(get_current_user)):
    return UserOut(
        id=current_user.id, email=current_user.email,
        full_name=current_user.full_name, role=current_user.role,
        is_active=current_user.is_active, is_verified=current_user.is_verified,
        created_at=current_user.created_at,
    )


# ── List Users (Admin) ───────────────────────────────────────────────────────

@router.get("/users", response_model=List[UserOut])
async def list_users(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    result = await db.execute(select(User).order_by(User.created_at.desc()))
    users = result.scalars().all()
    return [UserOut(id=u.id, email=u.email, full_name=u.full_name,
                    role=u.role, is_active=u.is_active, is_verified=u.is_verified,
                    created_at=u.created_at) for u in users]


# ── Login Attempts (Admin Audit) ──────────────────────────────────────────────

@router.get("/login-attempts")
async def get_login_attempts(
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(require_admin),
):
    """Admin: view recent login attempts for security audit."""
    result = await db.execute(
        select(LoginAttempt).order_by(LoginAttempt.created_at.desc()).limit(min(limit, 200))
    )
    attempts = result.scalars().all()
    return [
        {
            "id": a.id,
            "email": a.email,
            "ip_address": a.ip_address,
            "success": a.success,
            "failure_reason": a.failure_reason,
            "created_at": a.created_at,
        }
        for a in attempts
    ]


# ── API Key Management ────────────────────────────────────────────────────────

@router.post("/api-keys", response_model=ApiKeyOut, status_code=201)
async def create_api_key(
    body: CreateApiKeyRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    raw_key, key_hash = generate_api_key()
    api_key = ApiKey(
        user_id=current_user.id,
        key_hash=key_hash,
        label=body.label,
        is_active=True,
    )
    db.add(api_key)
    await db.flush()

    await log_event(db, "API_KEY_CREATED", f"API key '{body.label}' created",
                    user_id=current_user.id)

    return ApiKeyOut(id=api_key.id, label=api_key.label, raw_key=raw_key,
                     last_used=api_key.last_used, created_at=api_key.created_at)


@router.delete("/api-keys/{key_id}", status_code=204)
async def revoke_api_key(
    key_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    result = await db.execute(select(ApiKey).where(ApiKey.id == key_id, ApiKey.user_id == current_user.id))
    api_key = result.scalar_one_or_none()
    if not api_key:
        raise HTTPException(status_code=404, detail="API key not found")
    api_key.is_active = False
    await log_event(db, "API_KEY_REVOKED", f"API key '{api_key.label}' revoked",
                    user_id=current_user.id)


# ── Setup First Admin ─────────────────────────────────────────────────────────

@router.post("/setup-admin", response_model=TokenResponse, status_code=201)
async def setup_first_admin(body: RegisterRequest, request: Request, db: AsyncSession = Depends(get_db)):
    """
    One-time endpoint to create the first admin user.
    Disabled once any user exists. Returns tokens so user is logged in immediately.
    """
    result = await db.execute(select(User))
    if result.scalars().first():
        raise HTTPException(status_code=403, detail="Admin already exists. Use /register via admin account.")

    # Validate password
    pw_result = await _validate_password_with_policy(body.password, db)
    if not pw_result.valid:
        raise HTTPException(status_code=400, detail={"message": "Password too weak", "errors": pw_result.errors})

    user = User(
        email=body.email,
        hashed_password=hash_password(body.password),
        full_name=body.full_name,
        role="ADMIN",
        is_active=True,
        is_verified=True,
    )
    db.add(user)
    await db.flush()
    await log_event(db, "ADMIN_SETUP", f"First admin {body.email} created",
                    user_id=user.id, ip_address=get_client_ip(request))

    return TokenResponse(
        access_token=create_access_token(user.id, user.role),
        refresh_token=create_refresh_token(user.id),
        user_id=user.id,
        role=user.role,
        full_name=user.full_name,
        is_verified=user.is_verified,
    )
