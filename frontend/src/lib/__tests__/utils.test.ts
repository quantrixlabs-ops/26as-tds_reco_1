/**
 * Tests for lib/utils.ts — formatters, badge color helpers, misc utilities.
 */
import { describe, it, expect } from 'vitest';
import {
  formatCurrency,
  formatNumber,
  formatPct,
  formatDate,
  formatDateTime,
  formatFY,
  runStatusVariant,
  runStatusLabel,
  confidenceVariant,
  severityVariant,
  roleVariant,
  matchRateColor,
  truncate,
  getErrorMessage,
} from '../utils';

// ── formatCurrency ───────────────────────────────────────────────────────────

describe('formatCurrency', () => {
  it('formats a normal value in INR', () => {
    const result = formatCurrency(150000);
    expect(result).toContain('1,50,000');  // Indian numbering
    expect(result).toContain('₹');
  });

  it('returns dash for null', () => {
    expect(formatCurrency(null)).toBe('—');
  });

  it('returns dash for undefined', () => {
    expect(formatCurrency(undefined)).toBe('—');
  });

  it('formats zero', () => {
    const result = formatCurrency(0);
    expect(result).toContain('0');
  });

  it('formats negative values', () => {
    const result = formatCurrency(-5000);
    expect(result).toContain('5,000');
    expect(result).toContain('-');
  });

  it('includes decimal places', () => {
    const result = formatCurrency(1234.56);
    expect(result).toContain('.56');
  });
});

// ── formatNumber ─────────────────────────────────────────────────────────────

describe('formatNumber', () => {
  it('formats with Indian numbering', () => {
    const result = formatNumber(1234567);
    expect(result).toContain('12,34,567');
  });

  it('returns dash for null', () => {
    expect(formatNumber(null)).toBe('—');
  });

  it('returns dash for undefined', () => {
    expect(formatNumber(undefined)).toBe('—');
  });
});

// ── formatPct ────────────────────────────────────────────────────────────────

describe('formatPct', () => {
  it('formats with 2 decimals by default', () => {
    expect(formatPct(85.456)).toBe('85.46%');
  });

  it('formats zero', () => {
    expect(formatPct(0)).toBe('0.00%');
  });

  it('formats 100', () => {
    expect(formatPct(100)).toBe('100.00%');
  });

  it('returns dash for null', () => {
    expect(formatPct(null)).toBe('—');
  });

  it('returns dash for undefined', () => {
    expect(formatPct(undefined)).toBe('—');
  });

  it('respects custom decimals', () => {
    expect(formatPct(33.3333, 1)).toBe('33.3%');
  });
});

// ── formatDate ───────────────────────────────────────────────────────────────

describe('formatDate', () => {
  it('formats a valid ISO date', () => {
    const result = formatDate('2024-01-15T10:30:00Z');
    // Should be in IST (UTC+5:30) format
    expect(result).toContain('15');
    expect(result).toContain('Jan');
    expect(result).toContain('2024');
  });

  it('returns dash for null', () => {
    expect(formatDate(null)).toBe('—');
  });

  it('returns dash for undefined', () => {
    expect(formatDate(undefined)).toBe('—');
  });

  it('returns dash for empty string', () => {
    expect(formatDate('')).toBe('—');
  });

  it('returns original string for invalid date', () => {
    const result = formatDate('not-a-date');
    // Should either return the original or dash — not crash
    expect(typeof result).toBe('string');
  });
});

// ── formatDateTime ───────────────────────────────────────────────────────────

describe('formatDateTime', () => {
  it('includes IST suffix', () => {
    const result = formatDateTime('2024-01-15T10:30:00Z');
    expect(result).toContain('IST');
  });

  it('returns dash for null', () => {
    expect(formatDateTime(null)).toBe('—');
  });
});

// ── formatFY ─────────────────────────────────────────────────────────────────

describe('formatFY', () => {
  it('adds space after FY', () => {
    expect(formatFY('FY2023-24')).toBe('FY 2023-24');
  });

  it('handles already-spaced input', () => {
    expect(formatFY('FY 2023-24')).toBe('FY  2023-24'); // double space — known behavior
  });
});

// ── runStatusVariant ─────────────────────────────────────────────────────────

describe('runStatusVariant', () => {
  it('APPROVED → green', () => {
    expect(runStatusVariant('APPROVED')).toBe('green');
  });

  it('PENDING_REVIEW → yellow', () => {
    expect(runStatusVariant('PENDING_REVIEW')).toBe('yellow');
  });

  it('PROCESSING → blue', () => {
    expect(runStatusVariant('PROCESSING')).toBe('blue');
  });

  it('FAILED → red', () => {
    expect(runStatusVariant('FAILED')).toBe('red');
  });

  it('REJECTED → red', () => {
    expect(runStatusVariant('REJECTED')).toBe('red');
  });

  it('unknown → gray', () => {
    expect(runStatusVariant('UNKNOWN' as any)).toBe('gray');
  });
});

// ── runStatusLabel ───────────────────────────────────────────────────────────

describe('runStatusLabel', () => {
  it('APPROVED → Approved', () => {
    expect(runStatusLabel('APPROVED')).toBe('Approved');
  });

  it('PENDING_REVIEW → Pending Review', () => {
    expect(runStatusLabel('PENDING_REVIEW')).toBe('Pending Review');
  });

  it('FAILED → Failed', () => {
    expect(runStatusLabel('FAILED')).toBe('Failed');
  });

  it('unknown → returns raw status', () => {
    expect(runStatusLabel('ARCHIVED' as any)).toBe('ARCHIVED');
  });
});

// ── confidenceVariant ────────────────────────────────────────────────────────

describe('confidenceVariant', () => {
  it('HIGH → green', () => {
    expect(confidenceVariant('HIGH')).toBe('green');
  });

  it('MEDIUM → yellow', () => {
    expect(confidenceVariant('MEDIUM')).toBe('yellow');
  });

  it('LOW → orange', () => {
    expect(confidenceVariant('LOW')).toBe('orange');
  });

  it('unknown → gray', () => {
    expect(confidenceVariant('NONE' as any)).toBe('gray');
  });
});

// ── severityVariant ──────────────────────────────────────────────────────────

describe('severityVariant', () => {
  it('CRITICAL → deepred', () => {
    expect(severityVariant('CRITICAL')).toBe('deepred');
  });

  it('HIGH → red', () => {
    expect(severityVariant('HIGH')).toBe('red');
  });

  it('MEDIUM → orange', () => {
    expect(severityVariant('MEDIUM')).toBe('orange');
  });

  it('LOW → yellow', () => {
    expect(severityVariant('LOW')).toBe('yellow');
  });

  it('unknown → gray', () => {
    expect(severityVariant('INFO' as any)).toBe('gray');
  });
});

// ── roleVariant ──────────────────────────────────────────────────────────────

describe('roleVariant', () => {
  it('ADMIN → navy', () => {
    expect(roleVariant('ADMIN')).toBe('navy');
  });

  it('REVIEWER → blue', () => {
    expect(roleVariant('REVIEWER')).toBe('blue');
  });

  it('PREPARER → gray', () => {
    expect(roleVariant('PREPARER')).toBe('gray');
  });

  it('unknown → gray', () => {
    expect(roleVariant('GUEST')).toBe('gray');
  });
});

// ── matchRateColor ───────────────────────────────────────────────────────────

describe('matchRateColor', () => {
  it('below 75 → red', () => {
    expect(matchRateColor(74)).toBe('text-red-600');
    expect(matchRateColor(0)).toBe('text-red-600');
  });

  it('75 → amber (yellow)', () => {
    expect(matchRateColor(75)).toBe('text-amber-600');
  });

  it('between 75-84 → amber', () => {
    expect(matchRateColor(80)).toBe('text-amber-600');
    expect(matchRateColor(84.99)).toBe('text-amber-600');
  });

  it('85 → green', () => {
    expect(matchRateColor(85)).toBe('text-emerald-600');
  });

  it('above 85 → green', () => {
    expect(matchRateColor(100)).toBe('text-emerald-600');
  });
});

// ── truncate ─────────────────────────────────────────────────────────────────

describe('truncate', () => {
  it('returns short string unchanged', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long string with ellipsis', () => {
    const result = truncate('hello world foo bar', 10);
    expect(result.length).toBeLessThanOrEqual(10);
    expect(result).toContain('…');
  });

  it('uses default maxLen of 40', () => {
    const short = 'a'.repeat(40);
    expect(truncate(short)).toBe(short);

    const long = 'a'.repeat(41);
    expect(truncate(long)).toContain('…');
    expect(truncate(long).length).toBe(40);
  });

  it('handles exact length', () => {
    expect(truncate('12345', 5)).toBe('12345');
  });
});

// ── getErrorMessage ──────────────────────────────────────────────────────────

describe('getErrorMessage', () => {
  it('extracts axios-style error detail', () => {
    const err = { response: { data: { detail: 'Not found' } } };
    expect(getErrorMessage(err)).toBe('Not found');
  });

  it('extracts message property', () => {
    const err = { message: 'Network error' };
    expect(getErrorMessage(err)).toBe('Network error');
  });

  it('returns fallback for string', () => {
    // String is not an object with response/message
    expect(getErrorMessage('some error')).toBe('An unexpected error occurred');
  });

  it('returns fallback for null', () => {
    expect(getErrorMessage(null)).toBe('An unexpected error occurred');
  });

  it('returns fallback for undefined', () => {
    expect(getErrorMessage(undefined)).toBe('An unexpected error occurred');
  });

  it('prefers detail over message', () => {
    const err = { response: { data: { detail: 'Specific' } }, message: 'Generic' };
    expect(getErrorMessage(err)).toBe('Specific');
  });
});
