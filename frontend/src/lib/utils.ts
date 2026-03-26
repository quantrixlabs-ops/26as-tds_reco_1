/**
 * Utility helpers — cn(), formatting, badge colors
 */
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { format, parseISO, addMinutes } from 'date-fns';
import type { RunStatus, ConfidenceTier, ExceptionSeverity } from './api';

// ── Tailwind class merge ───────────────────────────────────────────────────────

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

// ── Number formatting ─────────────────────────────────────────────────────────

export function formatCurrency(value: number | null | undefined): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null) return '—';
  return new Intl.NumberFormat('en-IN').format(value);
}

export function formatPct(value: number | null | undefined, decimals = 2): string {
  if (value == null) return '—';
  return `${value.toFixed(decimals)}%`;
}

// ── Date formatting ───────────────────────────────────────────────────────────

/**
 * Convert a UTC ISO string to IST (UTC+5:30) and format it.
 */
export function formatDate(
  value: string | null | undefined,
  fmt = 'dd MMM yyyy',
): string {
  if (!value) return '—';
  try {
    const utc = parseISO(value);
    const ist = addMinutes(utc, 330); // UTC+5:30 = +330 minutes
    return format(ist, fmt);
  } catch {
    return value;
  }
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return formatDate(value, 'dd MMM yyyy, HH:mm') + ' IST';
}

// ── FY helpers ────────────────────────────────────────────────────────────────

export function formatFY(fy: string): string {
  return fy.replace('FY', 'FY ');
}

// ── Badge color helpers ───────────────────────────────────────────────────────

export type BadgeVariant =
  | 'default'
  | 'green'
  | 'yellow'
  | 'orange'
  | 'red'
  | 'blue'
  | 'gray'
  | 'deepred'
  | 'navy';

export function runStatusVariant(status: RunStatus): BadgeVariant {
  switch (status) {
    case 'APPROVED':
      return 'green';
    case 'PENDING_REVIEW':
      return 'yellow';
    case 'PROCESSING':
      return 'blue';
    case 'FAILED':
      return 'red';
    case 'REJECTED':
      return 'red';
    default:
      return 'gray';
  }
}

export function runStatusLabel(status: RunStatus): string {
  switch (status) {
    case 'APPROVED':
      return 'Approved';
    case 'PENDING_REVIEW':
      return 'Pending Review';
    case 'PROCESSING':
      return 'Processing';
    case 'FAILED':
      return 'Failed';
    case 'REJECTED':
      return 'Rejected';
    default:
      return status;
  }
}

export function confidenceVariant(tier: ConfidenceTier): BadgeVariant {
  switch (tier) {
    case 'HIGH':
      return 'green';
    case 'MEDIUM':
      return 'yellow';
    case 'LOW':
      return 'orange';
    default:
      return 'gray';
  }
}

export function severityVariant(sev: ExceptionSeverity): BadgeVariant {
  switch (sev) {
    case 'CRITICAL':
      return 'deepred';
    case 'HIGH':
      return 'red';
    case 'MEDIUM':
      return 'orange';
    case 'LOW':
      return 'yellow';
    default:
      return 'gray';
  }
}

export function roleVariant(role: string): BadgeVariant {
  switch (role) {
    case 'ADMIN':
      return 'navy';
    case 'REVIEWER':
      return 'blue';
    case 'PREPARER':
      return 'gray';
    default:
      return 'gray';
  }
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export function truncate(str: string, maxLen = 40): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '…';
}

export function getErrorMessage(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as { response?: { data?: { detail?: string } }; message?: string };
    if (e.response?.data?.detail) return e.response.data.detail;
    if (e.message) return e.message;
  }
  return 'An unexpected error occurred';
}
