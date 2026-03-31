"""
Tests for core/security.py — password hashing, JWT tokens, API keys, SHA-256.
"""
import pytest
from datetime import timedelta

from core.security import (
    hash_password, verify_password,
    create_access_token, create_refresh_token, decode_token,
    generate_api_key, hash_api_key,
    sha256_file, sha256_str,
)
from jose import JWTError


# ── Password Hashing ──────────────────────────────────────────────────────────

def test_hash_verify_roundtrip():
    hashed = hash_password("mypassword")
    assert verify_password("mypassword", hashed) is True


def test_verify_wrong_password():
    hashed = hash_password("correct")
    assert verify_password("wrong", hashed) is False


def test_hash_different_each_time():
    """bcrypt produces different salts → different hashes for same input."""
    h1 = hash_password("same")
    h2 = hash_password("same")
    assert h1 != h2  # different salts
    assert verify_password("same", h1) is True
    assert verify_password("same", h2) is True


# ── JWT Tokens ────────────────────────────────────────────────────────────────

def test_create_access_token():
    token = create_access_token("user-123", "ADMIN")
    assert isinstance(token, str)
    assert len(token) > 20


def test_access_token_claims():
    token = create_access_token("user-123", "REVIEWER")
    payload = decode_token(token)
    assert payload["sub"] == "user-123"
    assert payload["role"] == "REVIEWER"
    assert payload["type"] == "access"
    assert "exp" in payload


def test_refresh_token_claims():
    token = create_refresh_token("user-456")
    payload = decode_token(token)
    assert payload["sub"] == "user-456"
    assert payload["type"] == "refresh"
    assert "exp" in payload


def test_expired_token_rejected():
    """Token with negative TTL should be expired on creation."""
    token = create_access_token("user-x", "ADMIN", expires_delta=timedelta(seconds=-10))
    with pytest.raises(JWTError):
        decode_token(token)


def test_decode_garbage_token():
    with pytest.raises(JWTError):
        decode_token("not.a.valid.jwt")


# ── API Keys ─────────────────────────────────────────────────────────────────

def test_generate_api_key_format():
    raw, hashed = generate_api_key()
    assert raw.startswith("reco_")
    assert len(raw) == 5 + 48  # "reco_" + 48 chars
    assert len(hashed) == 64  # SHA-256 hex


def test_generate_api_key_unique():
    raw1, _ = generate_api_key()
    raw2, _ = generate_api_key()
    assert raw1 != raw2


def test_hash_api_key_matches():
    """hash_api_key(raw) should equal the hashed value from generate_api_key."""
    raw, expected_hash = generate_api_key()
    assert hash_api_key(raw) == expected_hash


# ── SHA-256 ───────────────────────────────────────────────────────────────────

def test_sha256_file_deterministic():
    data = b"hello world"
    h1 = sha256_file(data)
    h2 = sha256_file(data)
    assert h1 == h2
    assert len(h1) == 64


def test_sha256_file_different_inputs():
    assert sha256_file(b"aaa") != sha256_file(b"bbb")


def test_sha256_str_deterministic():
    assert sha256_str("test") == sha256_str("test")


def test_sha256_str_different():
    assert sha256_str("a") != sha256_str("b")


def test_sha256_file_empty():
    h = sha256_file(b"")
    assert len(h) == 64  # Should still produce a valid hash
