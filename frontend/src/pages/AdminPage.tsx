/**
 * AdminPage — algorithm settings + user management (ADMIN only)
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  UserPlus,
  Users,
  Shield,
  AlertCircle,
  Mail,
  Lock,
  User,
  SlidersHorizontal,
  ChevronDown,
  ChevronRight,
  X,
  Plus,
  Save,
  Check,
} from 'lucide-react';
import {
  authApi,
  settingsApi,
  type Role,
  type User as UserType,
  type AdminSettingsUpdate,
} from '../lib/api';
import { useAuth } from '../lib/auth';
import { Card, CardHeader } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Table, type Column } from '../components/ui/Table';
import { FullPageSpinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { roleVariant, getErrorMessage, cn, formatDateTime } from '../lib/utils';

// ── Toggle switch (inline) ────────────────────────────────────────────────────

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-3 cursor-pointer">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative w-10 h-5 rounded-full transition-colors',
          checked ? 'bg-[#1B3A5C]' : 'bg-gray-300',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform',
            checked && 'translate-x-5',
          )}
        />
      </button>
      <span className="text-sm text-gray-700">{label}</span>
    </label>
  );
}

// ── Multi-tag input ───────────────────────────────────────────────────────────

function TagInput({
  tags,
  onChange,
  placeholder,
}: {
  tags: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [inputValue, setInputValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = useCallback(() => {
    const val = inputValue.trim().toUpperCase();
    if (val && !tags.includes(val)) {
      onChange([...tags, val]);
    }
    setInputValue('');
  }, [inputValue, tags, onChange]);

  const removeTag = useCallback(
    (tag: string) => {
      onChange(tags.filter((t) => t !== tag));
    },
    [tags, onChange],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    } else if (e.key === 'Backspace' && !inputValue && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  };

  return (
    <div
      className="flex flex-wrap items-center gap-1.5 min-h-[38px] w-full px-2.5 py-1.5 border border-gray-300 rounded-lg focus-within:border-[#1B3A5C] focus-within:ring-2 focus-within:ring-[#1B3A5C]/10 transition-colors cursor-text"
      onClick={() => inputRef.current?.focus()}
    >
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium bg-[#1B3A5C]/10 text-[#1B3A5C] rounded-md"
        >
          {tag}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              removeTag(tag);
            }}
            className="hover:text-red-600 transition-colors"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      <div className="flex items-center gap-1 flex-1 min-w-[60px]">
        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={addTag}
          placeholder={tags.length === 0 ? placeholder : ''}
          className="flex-1 text-sm outline-none bg-transparent min-w-[40px]"
        />
        {inputValue.trim() && (
          <button
            type="button"
            onClick={addTag}
            className="text-[#1B3A5C] hover:text-[#15304d]"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Number input for settings ─────────────────────────────────────────────────

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  helpText,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  helpText?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          value={value}
          onChange={(e) => {
            let v = parseFloat(e.target.value) || 0;
            if (min != null && v < min) v = min;
            if (max != null && v > max) v = max;
            onChange(v);
          }}
          min={min}
          max={max}
          step={step ?? 1}
          className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 transition-colors"
        />
        {suffix && (
          <span className="text-sm text-gray-500 shrink-0">{suffix}</span>
        )}
      </div>
      {helpText && (
        <p className="text-xs text-gray-400 mt-1">{helpText}</p>
      )}
    </div>
  );
}

// ── Section wrapper ───────────────────────────────────────────────────────────

function SettingsSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
        {title}
      </h4>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

// ── Algorithm Settings Card ───────────────────────────────────────────────────

function AlgorithmSettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  const {
    data: settings,
    isLoading,
    isError,
    error,
  } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: settingsApi.get,
  });

  // Local draft state, synced from server on load
  const [draft, setDraft] = useState<AdminSettingsUpdate | null>(null);

  // Sync draft when server data arrives
  useEffect(() => {
    if (settings && !draft) {
      setDraft({
        doc_types_include: settings.doc_types_include,
        doc_types_exclude: settings.doc_types_exclude,
        date_hard_cutoff_days: settings.date_hard_cutoff_days,
        date_soft_preference_days: settings.date_soft_preference_days,
        enforce_books_before_26as: settings.enforce_books_before_26as,
        variance_normal_ceiling_pct: settings.variance_normal_ceiling_pct,
        variance_suggested_ceiling_pct: settings.variance_suggested_ceiling_pct,
        exclude_sgl_v: settings.exclude_sgl_v,
        max_combo_size: settings.max_combo_size,
        date_clustering_preference: settings.date_clustering_preference,
        allow_cross_fy: settings.allow_cross_fy,
        cross_fy_lookback_years: settings.cross_fy_lookback_years,
        force_match_enabled: settings.force_match_enabled,
        noise_threshold: settings.noise_threshold,
      });
    }
  }, [settings, draft]);

  const saveMut = useMutation({
    mutationFn: (data: AdminSettingsUpdate) => settingsApi.update(data),
    onSuccess: (updated) => {
      queryClient.setQueryData(['admin-settings'], updated);
      toast('Settings saved', 'Algorithm parameters updated successfully', 'success');
      // Reset draft to match the saved data
      setDraft({
        doc_types_include: updated.doc_types_include,
        doc_types_exclude: updated.doc_types_exclude,
        date_hard_cutoff_days: updated.date_hard_cutoff_days,
        date_soft_preference_days: updated.date_soft_preference_days,
        enforce_books_before_26as: updated.enforce_books_before_26as,
        variance_normal_ceiling_pct: updated.variance_normal_ceiling_pct,
        variance_suggested_ceiling_pct: updated.variance_suggested_ceiling_pct,
        exclude_sgl_v: updated.exclude_sgl_v,
        max_combo_size: updated.max_combo_size,
        date_clustering_preference: updated.date_clustering_preference,
        allow_cross_fy: updated.allow_cross_fy,
        cross_fy_lookback_years: updated.cross_fy_lookback_years,
        force_match_enabled: updated.force_match_enabled,
        noise_threshold: updated.noise_threshold,
      });
    },
    onError: (err) => {
      toast('Save failed', getErrorMessage(err), 'error');
    },
  });

  const update = useCallback(
    <K extends keyof AdminSettingsUpdate>(key: K, value: AdminSettingsUpdate[K]) => {
      setDraft((prev) => (prev ? { ...prev, [key]: value } : { [key]: value }));
    },
    [],
  );

  const handleSave = () => {
    if (!draft) return;
    // Client-side validation guard
    const numericChecks: Array<[string, number | undefined]> = [
      ['Hard cutoff days', draft.date_hard_cutoff_days],
      ['Soft preference days', draft.date_soft_preference_days],
      ['Normal ceiling %', draft.variance_normal_ceiling_pct],
      ['Suggested ceiling %', draft.variance_suggested_ceiling_pct],
      ['Noise threshold', draft.noise_threshold],
      ['Max combo size', draft.max_combo_size],
      ['Cross-FY lookback', draft.cross_fy_lookback_years],
    ];
    for (const [label, val] of numericChecks) {
      if (val != null && val < 0) {
        toast('Validation error', `${label} cannot be negative`, 'error');
        return;
      }
    }
    saveMut.mutate(draft);
  };

  const paramCount = 14;

  return (
    <Card>
      {/* Collapsible header */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between -m-6 p-6"
      >
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-[#1B3A5C]/10">
            <SlidersHorizontal className="h-4 w-4 text-[#1B3A5C]" />
          </div>
          <div className="text-left">
            <h3 className="text-sm font-semibold text-gray-900">
              Algorithm Settings
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Configure reconciliation engine parameters
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="navy" size="sm">
            {paramCount} parameters
          </Badge>
          {expanded ? (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronRight className="h-4 w-4 text-gray-400" />
          )}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-8 pt-6 border-t border-gray-100">
          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-[#1B3A5C] border-t-transparent" />
              <span className="ml-3 text-sm text-gray-500">Loading settings...</span>
            </div>
          )}

          {isError && (
            <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />
              Failed to load settings: {getErrorMessage(error)}
            </div>
          )}

          {draft && !isLoading && (
            <div className="space-y-8">
              {/* Section 1: Document Filters */}
              <SettingsSection title="Document Filters">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Doc types to include
                  </label>
                  <TagInput
                    tags={draft.doc_types_include ?? []}
                    onChange={(v) => update('doc_types_include', v)}
                    placeholder="Type and press Enter (e.g. RV, DR)"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    SAP document types to include in matching (e.g. RV, DR, DC)
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Doc types to exclude
                  </label>
                  <TagInput
                    tags={draft.doc_types_exclude ?? []}
                    onChange={(v) => update('doc_types_exclude', v)}
                    placeholder="Type and press Enter (e.g. CC, BR)"
                  />
                  <p className="text-xs text-gray-400 mt-1">
                    SAP document types to always exclude
                  </p>
                </div>
              </SettingsSection>

              {/* Section 2: Date Rules */}
              <SettingsSection title="Date Rules">
                <div className="grid grid-cols-2 gap-4">
                  <NumberField
                    label="Hard cutoff days"
                    value={draft.date_hard_cutoff_days ?? 90}
                    onChange={(v) => update('date_hard_cutoff_days', v)}
                    min={0}
                    suffix="days"
                    helpText="Max days between book date and 26AS date"
                  />
                  <NumberField
                    label="Soft preference days"
                    value={draft.date_soft_preference_days ?? 180}
                    onChange={(v) => update('date_soft_preference_days', v)}
                    min={0}
                    suffix="days"
                    helpText="Preferred date window (scoring bonus)"
                  />
                </div>
                <Toggle
                  checked={draft.enforce_books_before_26as ?? false}
                  onChange={(v) => update('enforce_books_before_26as', v)}
                  label="Enforce books before 26AS date"
                />
              </SettingsSection>

              {/* Section 3: Variance Thresholds */}
              <SettingsSection title="Variance Thresholds">
                <div className="grid grid-cols-2 gap-4">
                  <NumberField
                    label="Normal ceiling %"
                    value={draft.variance_normal_ceiling_pct ?? 3.0}
                    onChange={(v) => update('variance_normal_ceiling_pct', v)}
                    min={0}
                    max={100}
                    step={0.1}
                    suffix="%"
                    helpText="Max variance for normal matches"
                  />
                  <NumberField
                    label="Suggested ceiling %"
                    value={draft.variance_suggested_ceiling_pct ?? 20.0}
                    onChange={(v) => update('variance_suggested_ceiling_pct', v)}
                    min={0}
                    max={100}
                    step={0.5}
                    suffix="%"
                    helpText="Max variance for suggested matches"
                  />
                </div>
              </SettingsSection>

              {/* Section 4: Matching Behavior */}
              <SettingsSection title="Matching Behavior">
                <NumberField
                  label="Max combo size"
                  value={draft.max_combo_size ?? 5}
                  onChange={(v) => update('max_combo_size', v)}
                  min={0}
                  helpText="Max invoices per combo match (0 = unlimited)"
                />
                <NumberField
                  label="Noise threshold (Rs.)"
                  value={draft.noise_threshold ?? 1.0}
                  onChange={(v) => update('noise_threshold', v)}
                  min={0}
                  step={0.5}
                  suffix="Rs."
                  helpText="Amounts below this are excluded as noise"
                />
                <Toggle
                  checked={draft.date_clustering_preference ?? false}
                  onChange={(v) => update('date_clustering_preference', v)}
                  label="Date clustering preference"
                />
                <Toggle
                  checked={draft.force_match_enabled ?? true}
                  onChange={(v) => update('force_match_enabled', v)}
                  label="Force match enabled"
                />
              </SettingsSection>

              {/* Section 5: Cross-FY & Advances */}
              <SettingsSection title="Cross-FY & Advances">
                <Toggle
                  checked={draft.exclude_sgl_v ?? false}
                  onChange={(v) => update('exclude_sgl_v', v)}
                  label="Exclude SGL_V (advances)"
                />
                <Toggle
                  checked={draft.allow_cross_fy ?? false}
                  onChange={(v) => update('allow_cross_fy', v)}
                  label="Allow cross-FY matching"
                />
                <NumberField
                  label="Cross-FY lookback years"
                  value={draft.cross_fy_lookback_years ?? 1}
                  onChange={(v) => update('cross_fy_lookback_years', v)}
                  min={0}
                  max={5}
                  suffix="years"
                  helpText="Number of prior FYs to search"
                />
              </SettingsSection>

              {/* Footer with save button and timestamp */}
              <div className="flex items-center justify-between pt-4 border-t border-gray-100">
                <div className="text-xs text-gray-400">
                  {settings?.updated_at ? (
                    <>Last updated: {formatDateTime(settings.updated_at)}</>
                  ) : (
                    'Default settings'
                  )}
                </div>
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saveMut.isPending}
                  className={cn(
                    'flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-semibold',
                    'bg-[#1B3A5C] text-white hover:bg-[#15304d] transition-colors',
                    'disabled:opacity-60 disabled:cursor-not-allowed',
                  )}
                >
                  {saveMut.isPending ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                      Saving...
                    </>
                  ) : saveMut.isSuccess ? (
                    <>
                      <Check className="h-4 w-4" />
                      Saved
                    </>
                  ) : (
                    <>
                      <Save className="h-4 w-4" />
                      Save Settings
                    </>
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Create User Form ──────────────────────────────────────────────────────────

const schema = z
  .object({
    full_name: z.string().min(2, 'Name must be at least 2 characters'),
    email: z.string().email('Enter a valid email'),
    password: z.string().min(8, 'Minimum 8 characters'),
    confirm_password: z.string().min(1, 'Confirm password'),
    role: z.enum(['ADMIN', 'REVIEWER', 'PREPARER'] as const),
  })
  .refine((d) => d.password === d.confirm_password, {
    message: 'Passwords do not match',
    path: ['confirm_password'],
  });

type FormData = z.infer<typeof schema>;

const ROLE_OPTIONS: Array<{ value: Role; label: string; desc: string }> = [
  {
    value: 'PREPARER',
    label: 'Preparer',
    desc: 'Can upload files and start reconciliation runs',
  },
  {
    value: 'REVIEWER',
    label: 'Reviewer',
    desc: 'Can approve or reject runs prepared by others',
  },
  {
    value: 'ADMIN',
    label: 'Admin',
    desc: 'Full access including user management',
  },
];

function CreateUserForm({ onSuccess }: { onSuccess: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: { role: 'PREPARER' },
  });

  const mut = useMutation({
    mutationFn: (data: FormData) =>
      authApi.createUser(data.email, data.password, data.full_name, data.role),
    onSuccess: (user) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast('User created', `${user.full_name} (${user.role})`, 'success');
      reset();
      onSuccess();
    },
    onError: (err) => {
      setError('root', { message: getErrorMessage(err) });
    },
  });

  const inputClass = (hasError: boolean) =>
    cn(
      'w-full pl-9 pr-4 py-2.5 text-sm border rounded-lg outline-none transition-colors',
      hasError
        ? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-100'
        : 'border-gray-300 focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10',
    );

  return (
    <form onSubmit={handleSubmit((d) => mut.mutate(d))} noValidate className="space-y-4">
      {errors.root && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2.5 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {errors.root.message}
        </div>
      )}

      {/* Full name */}
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1.5">
          Full name
        </label>
        <div className="relative">
          <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder="Ravi Kumar"
            className={inputClass(!!errors.full_name)}
            {...register('full_name')}
          />
        </div>
        {errors.full_name && (
          <p className="text-xs text-red-600 mt-1">{errors.full_name.message}</p>
        )}
      </div>

      {/* Email */}
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1.5">
          Email address
        </label>
        <div className="relative">
          <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="email"
            placeholder="user@firm.com"
            className={inputClass(!!errors.email)}
            {...register('email')}
          />
        </div>
        {errors.email && (
          <p className="text-xs text-red-600 mt-1">{errors.email.message}</p>
        )}
      </div>

      {/* Password */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1.5">
            Password
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="password"
              placeholder="Min 8 chars"
              className={inputClass(!!errors.password)}
              {...register('password')}
            />
          </div>
          {errors.password && (
            <p className="text-xs text-red-600 mt-1">{errors.password.message}</p>
          )}
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1.5">
            Confirm password
          </label>
          <div className="relative">
            <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
            <input
              type="password"
              placeholder="Repeat"
              className={inputClass(!!errors.confirm_password)}
              {...register('confirm_password')}
            />
          </div>
          {errors.confirm_password && (
            <p className="text-xs text-red-600 mt-1">
              {errors.confirm_password.message}
            </p>
          )}
        </div>
      </div>

      {/* Role */}
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-1.5">Role</label>
        <div className="space-y-2">
          {ROLE_OPTIONS.map((opt) => (
            <label
              key={opt.value}
              className="flex items-start gap-3 cursor-pointer p-3 rounded-lg border border-gray-200 hover:border-gray-300 hover:bg-gray-50 transition-colors"
            >
              <input
                type="radio"
                value={opt.value}
                className="mt-0.5"
                {...register('role')}
              />
              <div>
                <p className="text-sm font-medium text-gray-900">{opt.label}</p>
                <p className="text-xs text-gray-500">{opt.desc}</p>
              </div>
            </label>
          ))}
        </div>
        {errors.role && (
          <p className="text-xs text-red-600 mt-1">{errors.role.message}</p>
        )}
      </div>

      <button
        type="submit"
        disabled={isSubmitting || mut.isPending}
        className={cn(
          'w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg',
          'bg-[#1B3A5C] text-white text-sm font-semibold',
          'hover:bg-[#15304d] transition-colors',
          'disabled:opacity-60 disabled:cursor-not-allowed',
        )}
      >
        <UserPlus className="h-4 w-4" />
        {mut.isPending ? 'Creating...' : 'Create user'}
      </button>
    </form>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { user: me } = useAuth();
  const [showForm, setShowForm] = useState(false);

  const { data: users = [], isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: authApi.users,
  });

  const cols: Column<UserType>[] = [
    {
      key: 'full_name',
      header: 'Name',
      sortable: true,
      render: (u) => (
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-full bg-[#1B3A5C]/10 flex items-center justify-center text-[#1B3A5C] text-xs font-semibold shrink-0">
            {u.full_name[0]?.toUpperCase()}
          </div>
          <div>
            <p className="text-sm font-medium text-gray-900">{u.full_name}</p>
            {u.id === me?.id && (
              <p className="text-xs text-gray-400">(you)</p>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'email',
      header: 'Email',
      sortable: true,
      render: (u) => <span className="text-sm text-gray-600">{u.email}</span>,
    },
    {
      key: 'role',
      header: 'Role',
      sortable: true,
      render: (u) => <Badge variant={roleVariant(u.role)}>{u.role}</Badge>,
    },
    {
      key: 'id',
      header: 'User ID',
      render: (u) => (
        <span className="font-mono text-xs text-gray-400">{u.id.slice(0, 8)}...</span>
      ),
    },
  ];

  if (isLoading) return <FullPageSpinner message="Loading users..." />;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Administration</h1>
          <p className="text-sm text-gray-500 mt-0.5">User management and platform settings</p>
        </div>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-[#1B3A5C] text-white text-sm font-semibold rounded-lg hover:bg-[#15304d] transition-colors"
        >
          <UserPlus className="h-4 w-4" />
          {showForm ? 'Cancel' : 'Add User'}
        </button>
      </div>

      {/* Algorithm Settings — ADMIN only, above user management */}
      {me?.role === 'ADMIN' && <AlgorithmSettingsCard />}

      {/* Maker-checker notice */}
      <Card className="bg-blue-50 border-blue-100 flex gap-3">
        <Shield className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold text-blue-800">Maker-Checker Policy</p>
          <p className="text-xs text-blue-600 mt-1">
            A PREPARER cannot approve or reject runs they submitted.
            REVIEWER/ADMIN with <code className="bg-blue-100 px-1 rounded">run.created_by !== user.id</code>{' '}
            can perform approval actions. This separation is enforced by the backend.
          </p>
        </div>
      </Card>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* User list */}
        <div className="lg:col-span-2">
          <Card padding={false}>
            <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
              <Users className="h-4 w-4 text-gray-400" />
              <p className="text-sm font-semibold text-gray-900">
                Users ({users.length})
              </p>
            </div>
            <Table
              columns={cols}
              data={users}
              keyExtractor={(u) => u.id}
              emptyMessage="No users found"
            />
          </Card>
        </div>

        {/* Create user form */}
        {showForm && (
          <div>
            <Card>
              <CardHeader title="Create New User" />
              <CreateUserForm onSuccess={() => setShowForm(false)} />
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
