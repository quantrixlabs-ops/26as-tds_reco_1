/**
 * NewRunPage — Single or Batch reconciliation upload
 * Toggle between Single (1 SAP + 1 26AS) and Batch (N SAP + 1 26AS)
 * Batch mode has a 2-step flow: Upload → Review Mappings → Run
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Upload, FileSpreadsheet, X, CheckCircle, AlertCircle,
  ChevronDown, Layers, FileText, ChevronRight, ArrowLeft,
  Check, AlertTriangle, HelpCircle, Settings,
} from 'lucide-react';
import {
  runsApi, miscApi, settingsApi,
  type BatchMapping, type BatchParty, type AdminSettings,
} from '../lib/api';
import { cn, getErrorMessage, formatFY } from '../lib/utils';
import { Card } from '../components/ui/Card';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';

// ── Shared sub-components ─────────────────────────────────────────────────────

function FYSelector({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div>
      <label className="block text-xs font-semibold text-gray-700 mb-2">
        Financial Year
      </label>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full appearance-none border border-gray-300 rounded-lg px-4 py-2.5 pr-10 text-sm text-gray-900 bg-white outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 cursor-pointer"
        >
          {options.length === 0 && <option value="">Loading…</option>}
          {options.map((fy) => (
            <option key={fy} value={fy}>{formatFY(fy)}</option>
          ))}
        </select>
        <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
      </div>
    </div>
  );
}

function FileDropZone({
  label, accept, file, onFile, onClear, hint, multiple, files, onFiles,
}: {
  label: string;
  accept: string;
  file?: File | null;
  onFile?: (f: File) => void;
  onClear?: () => void;
  hint?: string;
  multiple?: boolean;
  files?: File[];
  onFiles?: (f: File[]) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      if (multiple && onFiles) {
        onFiles(Array.from(e.dataTransfer.files));
      } else if (onFile) {
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }
    },
    [multiple, onFile, onFiles],
  );

  // Single-file mode
  if (!multiple) {
    return (
      <div>
        <label className="block text-xs font-semibold text-gray-700 mb-2">{label}</label>
        {file ? (
          <div className="flex items-center gap-3 border border-emerald-200 bg-emerald-50 rounded-xl px-4 py-3">
            <FileSpreadsheet className="h-5 w-5 text-emerald-600 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-emerald-800 truncate">{file.name}</p>
              <p className="text-xs text-emerald-600">{(file.size / 1024).toFixed(0)} KB</p>
            </div>
            <CheckCircle className="h-4 w-4 text-emerald-500 shrink-0" />
            <button type="button" onClick={onClear} className="p-1 hover:bg-emerald-100 rounded-full text-emerald-700">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <div
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            className={cn(
              'border-2 border-dashed rounded-xl px-6 py-8 text-center cursor-pointer transition-colors',
              dragging ? 'border-[#1B3A5C] bg-[#1B3A5C]/5' : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50',
            )}
          >
            <Upload className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-600 font-medium">
              Drop file here or <span className="text-[#1B3A5C]">browse</span>
            </p>
            {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
            <input ref={inputRef} type="file" accept={accept} className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f && onFile) onFile(f); e.target.value = ''; }} />
          </div>
        )}
      </div>
    );
  }

  // Multi-file mode
  const fileList = files ?? [];
  const addFiles = (incoming: File[]) => {
    if (!onFiles) return;
    const existing = new Set(fileList.map((f) => f.name));
    const newOnes = incoming.filter((f) => !existing.has(f.name));
    onFiles([...fileList, ...newOnes]);
  };
  const removeFile = (name: string) => {
    if (onFiles) onFiles(fileList.filter((f) => f.name !== name));
  };

  return (
    <div>
      <label className="block text-xs font-semibold text-gray-700 mb-2">{label}</label>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}
        className={cn(
          'border-2 border-dashed rounded-xl transition-colors',
          dragging ? 'border-[#1B3A5C] bg-[#1B3A5C]/5' : 'border-gray-200',
        )}
      >
        {fileList.length > 0 ? (
          <div className="p-3 space-y-1.5">
            {fileList.map((f) => (
              <div key={f.name} className="flex items-center gap-2 bg-white border border-gray-100 rounded-lg px-3 py-2">
                <FileSpreadsheet className="h-4 w-4 text-[#1B3A5C] shrink-0" />
                <span className="text-sm text-gray-700 flex-1 truncate">{f.name}</span>
                <span className="text-xs text-gray-400 shrink-0">{(f.size / 1024).toFixed(0)} KB</span>
                <button type="button" onClick={() => removeFile(f.name)} className="text-gray-300 hover:text-red-500 transition-colors">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="w-full text-xs text-[#1B3A5C] hover:underline py-1.5 text-center"
            >
              + Add more files
            </button>
          </div>
        ) : (
          <div
            onClick={() => inputRef.current?.click()}
            className="px-6 py-8 text-center cursor-pointer hover:bg-gray-50 rounded-xl transition-colors"
          >
            <Upload className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-600 font-medium">
              Drop files here or <span className="text-[#1B3A5C]">browse</span>
            </p>
            {hint && <p className="text-xs text-gray-400 mt-1">{hint}</p>}
          </div>
        )}
        <input ref={inputRef} type="file" accept={accept} multiple className="hidden"
          onChange={(e) => { if (e.target.files) addFiles(Array.from(e.target.files)); e.target.value = ''; }} />
      </div>
      {fileList.length > 0 && (
        <p className="text-xs text-gray-500 mt-1.5">{fileList.length} file{fileList.length > 1 ? 's' : ''} selected</p>
      )}
    </div>
  );
}

// ── Status badge for batch mapping ────────────────────────────────────────────

function MappingStatusBadge({ status, score }: { status: string; score: number | null }) {
  if (status === 'AUTO_CONFIRMED') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
        <Check className="h-3 w-3" /> Auto ({score?.toFixed(0)}%)
      </span>
    );
  }
  if (status === 'PENDING') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
        <AlertTriangle className="h-3 w-3" /> Review ({score?.toFixed(0)}%)
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-red-50 text-red-700 border border-red-200">
      <HelpCircle className="h-3 w-3" /> No match
    </span>
  );
}

// ── Single mode ───────────────────────────────────────────────────────────────

type SingleStep = 'upload' | 'mapping';

function SingleUploadForm({ fyOptions, fyDefault }: { fyOptions: string[]; fyDefault: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();

  // Step management
  const [step, setStep] = useState<SingleStep>('upload');

  // Upload state
  const [sapFile, setSapFile] = useState<File | null>(null);
  const [as26File, setAs26File] = useState<File | null>(null);
  const [financialYear, setFinancialYear] = useState(fyDefault || (fyOptions[fyOptions.length - 1] ?? ''));
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Mapping state (from preview)
  const [mapping, setMapping] = useState<BatchMapping | null>(null);
  const [allParties, setAllParties] = useState<BatchParty[]>([]);
  const [noDeductors, setNoDeductors] = useState(false);
  const [selectedParty, setSelectedParty] = useState<{ deductor_name: string; tan: string } | null>(null);
  const [showDropdown, setShowDropdown] = useState(false);
  const [partySearch, setPartySearch] = useState('');

  // Run state
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (fyOptions.length && !financialYear) setFinancialYear(fyDefault || fyOptions[fyOptions.length - 1]);
  }, [fyOptions, financialYear, fyDefault]);

  const canPreview = sapFile && as26File && financialYear && !previewing;

  // ── Preview: parse 26AS + fuzzy match ─────────────────────────────────────
  const handlePreview = async () => {
    if (!sapFile || !as26File) return;
    setError(null);
    setPreviewing(true);
    try {
      const result = await runsApi.batchPreview([sapFile], as26File);
      const m = result.mappings[0] ?? null;
      setMapping(m);
      setAllParties(result.all_parties);
      setNoDeductors(result.no_deductors === true || result.all_parties.length === 0);

      // Auto-select if confirmed
      if (m?.confirmed_name && m?.confirmed_tan) {
        setSelectedParty({ deductor_name: m.confirmed_name, tan: m.confirmed_tan });
      }
      setStep('mapping');
    } catch (err) {
      const msg = getErrorMessage(err);
      setError(msg);
      toast('Preview failed', msg, 'error');
    } finally {
      setPreviewing(false);
    }
  };

  // ── Run reconciliation ────────────────────────────────────────────────────
  const handleRun = async () => {
    if (!sapFile || !as26File) return;
    setError(null);
    setSubmitting(true);
    try {
      const parties = selectedParty ? [selectedParty] : null;
      const result = await runsApi.create(sapFile, as26File, financialYear, parties);
      toast('Run submitted', `Run #${result.run_number} is processing`, 'success');
      navigate(`/runs/${result.run_id}`);
    } catch (err) {
      const msg = getErrorMessage(err);
      setError(msg);
      toast('Run failed', msg, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  // ── Step 1: Upload ────────────────────────────────────────────────────────
  if (step === 'upload') {
    return (
      <Card className="space-y-6">
        {error && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <FYSelector value={financialYear} onChange={setFinancialYear} options={fyOptions} />

        <FileDropZone
          label="SAP AR Ledger (.xlsx)"
          accept=".xlsx,.xls"
          file={sapFile}
          onFile={setSapFile}
          onClear={() => setSapFile(null)}
          hint="Excel file exported from SAP (FBL5N or similar)"
        />

        <FileDropZone
          label="Form 26AS (.xlsx)"
          accept=".xlsx,.xls"
          file={as26File}
          onFile={setAs26File}
          onClear={() => setAs26File(null)}
          hint="26AS Excel download from TRACES / ITD portal"
        />

        <div className="bg-amber-50 border border-amber-100 rounded-lg px-4 py-3 text-xs text-amber-700 leading-relaxed">
          <strong>Note:</strong> Only Status=F (Final) entries from Form 26AS will be processed.
          The algorithm enforces Section 199 constraints: books_sum must not exceed the 26AS credit amount.
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            disabled={!canPreview}
            onClick={handlePreview}
            className={cn(
              'flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors',
              canPreview ? 'bg-[#1B3A5C] text-white hover:bg-[#15304d]' : 'bg-gray-100 text-gray-400 cursor-not-allowed',
            )}
          >
            {previewing && <Spinner size="sm" className="border-white/30 border-t-white" />}
            {previewing ? 'Analysing…' : 'Continue'} <ChevronRight className="h-4 w-4" />
          </button>
          <button type="button" onClick={() => navigate(-1)} className="px-4 py-2.5 text-sm text-gray-600 hover:text-gray-900 font-medium">
            Cancel
          </button>
        </div>
      </Card>
    );
  }

  // ── Step 2: Mapping ───────────────────────────────────────────────────────
  const filteredParties = allParties.filter((p) => {
    if (!partySearch) return true;
    const q = partySearch.toLowerCase();
    return p.deductor_name.toLowerCase().includes(q) || p.tan.toLowerCase().includes(q);
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => { setStep('upload'); setMapping(null); setSelectedParty(null); setNoDeductors(false); }}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 font-medium"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Upload
        </button>
        <span className="text-xs text-gray-400">Step 2 of 2</span>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <Card className="space-y-5">
        <div className="flex items-center gap-2 pb-3 border-b border-gray-100">
          <FileSpreadsheet className="h-4 w-4 text-[#1B3A5C]" />
          <h3 className="text-sm font-semibold text-gray-900">Party Mapping</h3>
        </div>

        {/* SAP file identity */}
        <div className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg">
          <FileText className="h-5 w-5 text-gray-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-gray-900 truncate">{sapFile?.name}</p>
            {mapping && <p className="text-xs text-gray-500">Identity: {mapping.identity_string}</p>}
          </div>
          <ChevronRight className="h-4 w-4 text-gray-300" />
          {/* Status badge */}
          {noDeductors ? (
            <span className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-blue-50 text-blue-700 border border-blue-200">
              <HelpCircle className="h-3 w-3" /> All Data
            </span>
          ) : mapping?.status === 'AUTO_CONFIRMED' ? (
            <span className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
              <Check className="h-3 w-3" /> Auto ({Math.round(mapping.fuzzy_score ?? 0)}%)
            </span>
          ) : mapping?.status === 'PENDING' ? (
            <span className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-700 border border-amber-200">
              <AlertTriangle className="h-3 w-3" /> Review
            </span>
          ) : (
            <span className="shrink-0 flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-50 text-red-700 border border-red-200">
              <AlertCircle className="h-3 w-3" /> No Match
            </span>
          )}
        </div>

        {/* No deductors info */}
        {noDeductors && (
          <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-xs text-blue-700 leading-relaxed">
            <strong>No deductor information found in 26AS.</strong> All entries in the 26AS file will be matched against your SAP file.
          </div>
        )}

        {/* Selected party chip + change option (when deductors exist) */}
        {!noDeductors && selectedParty && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Selected Deductor</p>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-sm">
                <span className="font-medium text-emerald-800 truncate max-w-[240px]">{selectedParty.deductor_name}</span>
                <span className="text-xs text-emerald-600 font-mono">{selectedParty.tan}</span>
                <button type="button" onClick={() => { setSelectedParty(null); setShowDropdown(true); }}
                  className="p-0.5 hover:bg-emerald-100 rounded-full text-emerald-600">
                  <X className="h-3.5 w-3.5" />
                </button>
              </span>
            </div>
            <button type="button" onClick={() => setShowDropdown(!showDropdown)}
              className="text-xs text-[#1B3A5C] hover:underline font-medium">
              {showDropdown ? 'Hide list' : 'Change selection'}
            </button>
          </div>
        )}

        {/* Party selection dropdown (shown when no auto-match, or user wants to change) */}
        {!noDeductors && (!selectedParty || showDropdown) && allParties.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              {selectedParty ? 'Change Deductor' : 'Select Deductor from 26AS'}
            </p>
            <div className="relative">
              <input
                type="text"
                value={partySearch}
                onChange={(e) => setPartySearch(e.target.value)}
                placeholder="Search by name or TAN…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10"
              />
            </div>
            <div className="border border-gray-200 rounded-lg max-h-52 overflow-y-auto divide-y divide-gray-100">
              {filteredParties.map((p) => {
                const isSelected = selectedParty?.tan === p.tan && selectedParty?.deductor_name === p.deductor_name;
                return (
                  <button
                    key={p.tan + p.deductor_name}
                    type="button"
                    onClick={() => {
                      setSelectedParty({ deductor_name: p.deductor_name, tan: p.tan });
                      setShowDropdown(false);
                      setPartySearch('');
                    }}
                    className={cn(
                      'w-full flex items-center justify-between px-3 py-2 text-left text-sm hover:bg-gray-50 transition-colors',
                      isSelected && 'bg-emerald-50',
                    )}
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-gray-900 truncate block">{p.deductor_name}</span>
                      <span className="text-xs text-gray-500 font-mono">{p.tan}</span>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 ml-3">
                      <span className="text-xs text-gray-400">{p.entry_count} entries</span>
                      {isSelected && <Check className="h-4 w-4 text-emerald-600" />}
                    </div>
                  </button>
                );
              })}
              {filteredParties.length === 0 && (
                <p className="text-xs text-gray-400 px-3 py-4 text-center">No parties match your search</p>
              )}
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div className="flex items-center gap-3 pt-3 border-t border-gray-100">
          <button
            type="button"
            disabled={!noDeductors && !selectedParty || submitting}
            onClick={handleRun}
            className={cn(
              'flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors',
              (noDeductors || selectedParty) && !submitting
                ? 'bg-[#1B3A5C] text-white hover:bg-[#15304d]'
                : 'bg-gray-100 text-gray-400 cursor-not-allowed',
            )}
          >
            {submitting && <Spinner size="sm" className="border-white/30 border-t-white" />}
            {submitting ? 'Starting…' : 'Start Reconciliation'}
          </button>
        </div>
      </Card>
    </div>
  );
}

// ── Batch mode ────────────────────────────────────────────────────────────────

type BatchStep = 'upload' | 'config' | 'review';

// ── Batch Config Step ─────────────────────────────────────────────────────────

function BatchConfigStep({
  onContinue,
  onBack,
}: {
  onContinue: (cfg: Partial<AdminSettings> | null) => void;
  onBack: () => void;
}) {
  const [useDefaults, setUseDefaults] = useState(true);
  const { data: adminSettings, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: settingsApi.get,
  });

  const [draft, setDraft] = useState<Partial<AdminSettings>>({});

  // Sync from admin when loaded
  useEffect(() => {
    if (adminSettings && Object.keys(draft).length === 0) {
      setDraft({
        doc_types_include: adminSettings.doc_types_include,
        doc_types_exclude: adminSettings.doc_types_exclude,
        date_hard_cutoff_days: adminSettings.date_hard_cutoff_days,
        date_soft_preference_days: adminSettings.date_soft_preference_days,
        enforce_books_before_26as: adminSettings.enforce_books_before_26as,
        variance_normal_ceiling_pct: adminSettings.variance_normal_ceiling_pct,
        variance_suggested_ceiling_pct: adminSettings.variance_suggested_ceiling_pct,
        exclude_sgl_v: adminSettings.exclude_sgl_v,
        max_combo_size: adminSettings.max_combo_size,
        date_clustering_preference: adminSettings.date_clustering_preference,
        allow_cross_fy: adminSettings.allow_cross_fy,
        cross_fy_lookback_years: adminSettings.cross_fy_lookback_years,
        force_match_enabled: adminSettings.force_match_enabled,
        noise_threshold: adminSettings.noise_threshold,
      });
    }
  }, [adminSettings, draft]);

  const setField = <K extends keyof AdminSettings>(key: K, value: AdminSettings[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const toggleDoc = (field: 'doc_types_include' | 'doc_types_exclude', val: string) => {
    const cur = (draft[field] ?? []) as string[];
    setDraft((prev) => ({
      ...prev,
      [field]: cur.includes(val) ? cur.filter((v) => v !== val) : [...cur, val],
    }));
  };

  if (isLoading) {
    return (
      <Card className="flex items-center justify-center py-12">
        <Spinner size="lg" />
        <p className="text-sm text-gray-400 ml-3">Loading admin settings...</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <button type="button" onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 font-medium">
          <ArrowLeft className="h-4 w-4" /> Back to Upload
        </button>
        <span className="text-xs text-gray-400">Step 2 of 3</span>
      </div>

      <Card className="space-y-5">
        <div className="flex items-center gap-2 pb-3 border-b border-gray-100">
          <Settings className="h-4 w-4 text-[#1B3A5C]" />
          <h3 className="text-sm font-semibold text-gray-900">Run Configuration</h3>
        </div>

        {/* Use defaults toggle */}
        <label className="flex items-center gap-3 cursor-pointer p-3 rounded-lg bg-gray-50 border border-gray-100">
          <button
            type="button"
            role="switch"
            aria-checked={useDefaults}
            onClick={() => setUseDefaults(!useDefaults)}
            className={cn('relative w-10 h-5 rounded-full transition-colors', useDefaults ? 'bg-[#1B3A5C]' : 'bg-gray-300')}
          >
            <span className={cn('absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform', useDefaults && 'translate-x-5')} />
          </button>
          <div>
            <span className="text-sm font-medium text-gray-800">Use Admin Defaults</span>
            {adminSettings?.updated_at && (
              <p className="text-xs text-gray-400 mt-0.5">Last updated: {new Date(adminSettings.updated_at).toLocaleDateString()}</p>
            )}
          </div>
        </label>

        {!useDefaults && (
          <div className="space-y-4">
            {/* Document types */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Document Filters</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Include doc types</label>
                  <div className="flex flex-wrap gap-1.5">
                    {['RV', 'DR', 'DC'].map((dt) => {
                      const active = (draft.doc_types_include ?? []).includes(dt);
                      return (
                        <button key={dt} type="button" onClick={() => toggleDoc('doc_types_include', dt)}
                          className={cn('px-2.5 py-1 rounded text-xs font-mono font-semibold border transition-colors',
                            active ? 'bg-[#1B3A5C] text-white border-[#1B3A5C]' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400')}>
                          {dt}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Exclude doc types</label>
                  <div className="flex flex-wrap gap-1.5">
                    {['CC', 'BR'].map((dt) => {
                      const active = (draft.doc_types_exclude ?? []).includes(dt);
                      return (
                        <button key={dt} type="button" onClick={() => toggleDoc('doc_types_exclude', dt)}
                          className={cn('px-2.5 py-1 rounded text-xs font-mono font-semibold border transition-colors',
                            active ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400')}>
                          {dt}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Date rules */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Date Rules</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Hard cutoff (days)</label>
                  <input type="number" value={draft.date_hard_cutoff_days ?? 90}
                    onChange={(e) => setField('date_hard_cutoff_days', parseInt(e.target.value) || 90)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1B3A5C]" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Soft preference (days)</label>
                  <input type="number" value={draft.date_soft_preference_days ?? 180}
                    onChange={(e) => setField('date_soft_preference_days', parseInt(e.target.value) || 180)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1B3A5C]" />
                </div>
              </div>
              <label className="flex items-center gap-2 mt-2 cursor-pointer">
                <input type="checkbox" checked={draft.enforce_books_before_26as ?? true}
                  onChange={(e) => setField('enforce_books_before_26as', e.target.checked)}
                  className="rounded border-gray-300" />
                <span className="text-xs text-gray-600">Books date must be on or before 26AS date</span>
              </label>
            </div>

            {/* Variance */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Variance Thresholds</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Normal ceiling (%)</label>
                  <input type="number" step="0.5" value={draft.variance_normal_ceiling_pct ?? 3.0}
                    onChange={(e) => setField('variance_normal_ceiling_pct', parseFloat(e.target.value) || 3.0)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1B3A5C]" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Suggested ceiling (%)</label>
                  <input type="number" step="0.5" value={draft.variance_suggested_ceiling_pct ?? 20.0}
                    onChange={(e) => setField('variance_suggested_ceiling_pct', parseFloat(e.target.value) || 20.0)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1B3A5C]" />
                </div>
              </div>
            </div>

            {/* Matching behavior */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Matching Behavior</p>
              <div className="grid grid-cols-2 gap-3 mb-2">
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Max combo size (0=unlimited)</label>
                  <input type="number" value={draft.max_combo_size ?? 0}
                    onChange={(e) => setField('max_combo_size', parseInt(e.target.value) || 0)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1B3A5C]" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 mb-1">Noise threshold (Rs.)</label>
                  <input type="number" step="0.1" value={draft.noise_threshold ?? 1.0}
                    onChange={(e) => setField('noise_threshold', parseFloat(e.target.value) || 1.0)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1B3A5C]" />
                </div>
              </div>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={draft.force_match_enabled ?? true}
                    onChange={(e) => setField('force_match_enabled', e.target.checked)} className="rounded border-gray-300" />
                  <span className="text-xs text-gray-600">Enable force matching</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={draft.date_clustering_preference ?? true}
                    onChange={(e) => setField('date_clustering_preference', e.target.checked)} className="rounded border-gray-300" />
                  <span className="text-xs text-gray-600">Prefer date-clustered combos</span>
                </label>
              </div>
            </div>

            {/* Advances and Cross-FY */}
            <div>
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Advances & Cross-FY</p>
              <div className="space-y-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={draft.exclude_sgl_v ?? true}
                    onChange={(e) => setField('exclude_sgl_v', e.target.checked)} className="rounded border-gray-300" />
                  <span className="text-xs text-gray-600">Exclude advance payments (SGL_V)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={draft.allow_cross_fy ?? false}
                    onChange={(e) => setField('allow_cross_fy', e.target.checked)} className="rounded border-gray-300" />
                  <span className="text-xs text-gray-600">Allow cross-FY matching</span>
                </label>
                {(draft.allow_cross_fy) && (
                  <div className="ml-6">
                    <label className="block text-xs text-gray-600 mb-1">Lookback years</label>
                    <input type="number" value={draft.cross_fy_lookback_years ?? 1} min={1} max={3}
                      onChange={(e) => setField('cross_fy_lookback_years', parseInt(e.target.value) || 1)}
                      className="w-20 border border-gray-300 rounded-lg px-3 py-2 text-sm outline-none focus:border-[#1B3A5C]" />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {useDefaults && adminSettings && (
          <div className="text-xs text-gray-400 space-y-1">
            <p>Doc types: {adminSettings.doc_types_include.join(', ')} | Variance: 0-{adminSettings.variance_normal_ceiling_pct}% normal, up to {adminSettings.variance_suggested_ceiling_pct}% suggested</p>
            <p>Date: {adminSettings.date_hard_cutoff_days}d hard cutoff, {adminSettings.date_soft_preference_days}d soft | Cross-FY: {adminSettings.allow_cross_fy ? 'Yes' : 'No'} | Advances: {adminSettings.exclude_sgl_v ? 'Excluded' : 'Included'}</p>
          </div>
        )}

        <div className="flex items-center gap-3 pt-3 border-t border-gray-100">
          <button
            type="button"
            onClick={() => onContinue(useDefaults ? null : draft)}
            className="flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold bg-[#1B3A5C] text-white hover:bg-[#15304d] transition-colors"
          >
            Continue to Name Mapping <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </Card>
    </div>
  );
}

function BatchUploadForm({ fyOptions, fyDefault }: { fyOptions: string[]; fyDefault: string }) {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [step, setStep] = useState<BatchStep>('upload');
  const [sapFiles, setSapFiles] = useState<File[]>([]);
  const [as26File, setAs26File] = useState<File | null>(null);
  const [financialYear, setFinancialYear] = useState(fyDefault || (fyOptions[fyOptions.length - 1] ?? ''));

  // Config step state
  const [batchConfig, setBatchConfig] = useState<Partial<AdminSettings> | null>(null);

  // Preview step state
  const [mappings, setMappings] = useState<BatchMapping[]>([]);
  const [allParties, setAllParties] = useState<BatchParty[]>([]);
  const [overrides, setOverrides] = useState<Record<string, Array<{ deductor_name: string; tan: string }>>>({});
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [expandedChips, setExpandedChips] = useState<string | null>(null);
  const [dropdownSearch, setDropdownSearch] = useState('');

  const [previewing, setPreviewing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Chunked batch progress
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
    currentFile: string;
    succeeded: number;
    failed: number;
    errors: Array<{ file: string; error: string }>;
  } | null>(null);

  useEffect(() => {
    if (fyOptions.length && !financialYear) setFinancialYear(fyDefault || fyOptions[fyOptions.length - 1]);
  }, [fyOptions, financialYear, fyDefault]);

  const canPreview = sapFiles.length > 0 && as26File && financialYear && !previewing;

  const handlePreview = async () => {
    if (!as26File || sapFiles.length === 0) return;
    setError(null);
    setPreviewing(true);
    try {
      const result = await runsApi.batchPreview(sapFiles, as26File);
      setMappings(result.mappings);
      setAllParties(result.all_parties);
      // Seed overrides from auto-confirmed
      const seed: Record<string, Array<{ deductor_name: string; tan: string }>> = {};
      for (const m of result.mappings) {
        if (m.confirmed_name && m.confirmed_tan) {
          seed[m.sap_filename] = [{ deductor_name: m.confirmed_name, tan: m.confirmed_tan }];
        }
      }
      setOverrides(seed);
      setStep('config');
    } catch (err) {
      const msg = getErrorMessage(err);
      setError(msg);
      toast('Preview failed', msg, 'error');
    } finally {
      setPreviewing(false);
    }
  };

  const toggleParty = (filename: string, party: BatchParty) => {
    setOverrides((prev) => {
      const current = prev[filename] ?? [];
      const exists = current.some((p) => p.tan === party.tan && p.deductor_name === party.deductor_name);
      const updated = exists
        ? current.filter((p) => !(p.tan === party.tan && p.deductor_name === party.deductor_name))
        : [...current, { deductor_name: party.deductor_name, tan: party.tan }];
      if (updated.length === 0) {
        const n = { ...prev };
        delete n[filename];
        return n;
      }
      return { ...prev, [filename]: updated };
    });
  };

  const removePartyChip = (filename: string, tan: string) => {
    setOverrides((prev) => {
      const updated = (prev[filename] ?? []).filter((p) => p.tan !== tan);
      if (updated.length === 0) {
        const n = { ...prev };
        delete n[filename];
        return n;
      }
      return { ...prev, [filename]: updated };
    });
  };

  const isPartySelected = (filename: string, party: BatchParty) =>
    (overrides[filename] ?? []).some((p) => p.tan === party.tan && p.deductor_name === party.deductor_name);

  const resolvedCount = mappings.filter((m) => (overrides[m.sap_filename] ?? []).length > 0).length;
  const needsReview = mappings.filter((m) => m.status !== 'AUTO_CONFIRMED').length;

  const handleRunAll = async () => {
    if (!as26File) return;
    setError(null);
    setSubmitting(true);

    const activeFiles = sapFiles.filter((f) => (overrides[f.name] ?? []).length > 0);
    const total = activeFiles.length;

    setBatchProgress({ current: 0, total, currentFile: 'Initializing…', succeeded: 0, failed: 0, errors: [] });

    try {
      // Step 1: Upload 26AS and get batch session
      const { batch_id } = await runsApi.batchInit(as26File, financialYear, batchConfig);

      // Step 2: Upload each SAP file one-by-one
      let succeeded = 0;
      let failed = 0;
      const errors: Array<{ file: string; error: string }> = [];

      for (let i = 0; i < activeFiles.length; i++) {
        const file = activeFiles[i];
        const parties = overrides[file.name] ?? [];
        setBatchProgress({ current: i + 1, total, currentFile: file.name, succeeded, failed, errors });

        try {
          await runsApi.batchAddParty(batch_id, file, parties);
          succeeded++;
        } catch (err) {
          failed++;
          errors.push({ file: file.name, error: getErrorMessage(err) });
        }

        setBatchProgress({ current: i + 1, total, currentFile: file.name, succeeded, failed, errors });
      }

      // Done
      if (failed > 0) {
        toast('Batch complete with errors', `${succeeded} succeeded, ${failed} failed`, 'error');
      } else {
        toast('Batch complete', `${succeeded} reconciliations submitted`, 'success');
      }
      navigate('/runs');
    } catch (err) {
      // Init failed — nothing was submitted
      const msg = getErrorMessage(err);
      setError(msg);
      toast('Batch init failed', msg, 'error');
    } finally {
      setSubmitting(false);
      setBatchProgress(null);
    }
  };

  // ── Step 1: Upload ──────────────────────────────────────────────────────────
  if (step === 'upload') {
    return (
      <Card className="space-y-6">
        {error && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <FYSelector value={financialYear} onChange={setFinancialYear} options={fyOptions} />

        <FileDropZone
          label="Form 26AS (.xlsx) — single file covering all parties"
          accept=".xlsx,.xls"
          file={as26File}
          onFile={setAs26File}
          onClear={() => setAs26File(null)}
          hint="26AS Excel from TRACES / ITD portal"
        />

        <FileDropZone
          label="SAP AR Ledger files — one file per party"
          accept=".xlsx,.xls"
          multiple
          files={sapFiles}
          onFiles={setSapFiles}
          hint="Name each file after the deductor (e.g. ACME_LIMITED.xlsx) for auto-mapping"
        />

        <div className="bg-blue-50 border border-blue-100 rounded-lg px-4 py-3 text-xs text-blue-700 leading-relaxed">
          <strong>Auto-mapping:</strong> Each SAP filename is fuzzy-matched against 26AS deductor names.
          You'll review and confirm mappings before running. Files with scores ≥ 95% are auto-confirmed.
        </div>

        <div className="flex items-center gap-3 pt-2">
          <button
            type="button"
            disabled={!canPreview}
            onClick={handlePreview}
            className={cn(
              'flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors',
              canPreview ? 'bg-[#1B3A5C] text-white hover:bg-[#15304d]' : 'bg-gray-100 text-gray-400 cursor-not-allowed',
            )}
          >
            {previewing && <Spinner size="sm" className="border-white/30 border-t-white" />}
            {previewing ? 'Detecting parties…' : (
              <>Preview Mappings <ChevronRight className="h-4 w-4" /></>
            )}
          </button>
        </div>
      </Card>
    );
  }

  // ── Step 2: Batch Config ──────────────────────────────────────────────────
  if (step === 'config') {
    return (
      <BatchConfigStep
        onBack={() => setStep('upload')}
        onContinue={(cfg) => {
          setBatchConfig(cfg);
          setStep('review');
        }}
      />
    );
  }

  // ── Step 3: Review mappings ─────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Header bar */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setStep('config')}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-900 font-medium"
        >
          <ArrowLeft className="h-4 w-4" /> Back to Config
        </button>
        <div className="flex items-center gap-3 text-xs text-gray-500">
          <span className="text-emerald-600 font-semibold">{resolvedCount} ready</span>
          {needsReview > 0 && <span className="text-amber-600 font-semibold">{needsReview} need review</span>}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg px-4 py-3 text-sm text-red-700">
          <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      <Card className="overflow-hidden p-0">
        <div className="px-4 py-3 border-b border-gray-100 bg-gray-50">
          <h3 className="text-sm font-semibold text-gray-800">Party Mappings — {mappings.length} files</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Review auto-detected matches. Use the dropdown to change any mapping.
          </p>
        </div>

        <div className="divide-y divide-gray-100 max-h-[60vh] overflow-y-auto">
          {mappings.map((m) => {
            const selectedParties = overrides[m.sap_filename] ?? [];

            return (
              <div key={m.sap_filename} className="px-4 py-3 flex items-start gap-3">
                {/* File info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <FileText className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                    <span className="text-xs font-mono text-gray-600 truncate">{m.sap_filename}</span>
                  </div>
                  <p className="text-xs text-gray-400">Identity: {m.identity_string}</p>
                </div>

                {/* Arrow */}
                <ChevronRight className="h-4 w-4 text-gray-300 mt-1 shrink-0" />

                {/* Selected parties + multi-select dropdown */}
                <div className="flex-1 min-w-0 relative">
                  {/* Status badge */}
                  <div className="flex items-center gap-2 mb-2">
                    {selectedParties.length === 0 ? (
                      <MappingStatusBadge status={m.status} score={m.fuzzy_score} />
                    ) : selectedParties.length === 1 ? (
                      <MappingStatusBadge status="AUTO_CONFIRMED" score={m.fuzzy_score} />
                    ) : (
                      <span className="inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-200">
                        <Layers className="h-3 w-3" /> {selectedParties.length} parties
                      </span>
                    )}
                  </div>

                  {/* Chips for selected parties — max 2 visible, rest collapsed */}
                  {selectedParties.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5 mb-2">
                      {selectedParties.slice(0, 2).map((p) => (
                        <span
                          key={p.tan}
                          className="inline-flex items-center gap-1 bg-[#1B3A5C]/8 text-[#1B3A5C] text-xs font-medium px-2 py-1 rounded-lg border border-[#1B3A5C]/20"
                        >
                          <span className="truncate max-w-[140px]">{p.deductor_name}</span>
                          <span className="text-[10px] text-gray-400 shrink-0">{p.tan}</span>
                          <button
                            type="button"
                            onClick={() => removePartyChip(m.sap_filename, p.tan)}
                            className="ml-0.5 text-gray-400 hover:text-red-500 transition-colors"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                      {selectedParties.length > 2 && (
                        <button
                          type="button"
                          onClick={() => setExpandedChips((prev) => prev === m.sap_filename ? null : m.sap_filename)}
                          className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#1B3A5C] bg-[#1B3A5C]/5 px-2 py-1 rounded-lg hover:bg-[#1B3A5C]/10 transition-colors"
                        >
                          +{selectedParties.length - 2} more
                          <ChevronDown className={`h-3 w-3 transition-transform ${expandedChips === m.sap_filename ? 'rotate-180' : ''}`} />
                        </button>
                      )}
                      {/* Expanded overflow chips */}
                      {expandedChips === m.sap_filename && selectedParties.length > 2 && (
                        <div className="w-full flex flex-wrap gap-1.5 mt-1 pt-1.5 border-t border-gray-100">
                          {selectedParties.slice(2).map((p) => (
                            <span
                              key={p.tan}
                              className="inline-flex items-center gap-1 bg-[#1B3A5C]/8 text-[#1B3A5C] text-xs font-medium px-2 py-1 rounded-lg border border-[#1B3A5C]/20"
                            >
                              <span className="truncate max-w-[140px]">{p.deductor_name}</span>
                              <span className="text-[10px] text-gray-400 shrink-0">{p.tan}</span>
                              <button
                                type="button"
                                onClick={() => removePartyChip(m.sap_filename, p.tan)}
                                className="ml-0.5 text-gray-400 hover:text-red-500 transition-colors"
                              >
                                <X className="h-3 w-3" />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Open dropdown button */}
                  <button
                    type="button"
                    onClick={() => {
                      const next = openDropdown === m.sap_filename ? null : m.sap_filename;
                      setOpenDropdown(next);
                      setDropdownSearch('');
                    }}
                    className="inline-flex items-center gap-1 text-xs text-[#1B3A5C] hover:underline font-medium"
                  >
                    {selectedParties.length === 0 ? '+ Select parties' : '+ Add party'}
                    <ChevronDown className="h-3 w-3" />
                  </button>

                  {/* Multi-select dropdown */}
                  {openDropdown === m.sap_filename && (
                    <div className="absolute left-0 top-full mt-1 z-30 w-80 bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden">
                      {/* Search */}
                      <div className="px-3 py-2 border-b border-gray-100">
                        <input
                          autoFocus
                          type="text"
                          placeholder="Search deductor or TAN…"
                          value={dropdownSearch}
                          onChange={(e) => setDropdownSearch(e.target.value)}
                          className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 outline-none focus:border-[#1B3A5C] focus:ring-2 focus:ring-[#1B3A5C]/10 placeholder-gray-400"
                        />
                      </div>
                      {/* Checkbox list */}
                      <div className="max-h-48 overflow-y-auto">
                        {allParties
                          .filter((p) =>
                            dropdownSearch === '' ||
                            p.deductor_name.toLowerCase().includes(dropdownSearch.toLowerCase()) ||
                            p.tan.toLowerCase().includes(dropdownSearch.toLowerCase()),
                          )
                          .map((p) => {
                            const checked = isPartySelected(m.sap_filename, p);
                            return (
                              <button
                                key={`${p.deductor_name}|${p.tan}`}
                                type="button"
                                onClick={() => toggleParty(m.sap_filename, p)}
                                className={cn(
                                  'w-full flex items-center gap-3 px-3 py-2.5 text-sm transition-colors border-b border-gray-50 last:border-0',
                                  checked ? 'bg-blue-50' : 'hover:bg-gray-50',
                                )}
                              >
                                {/* Checkbox */}
                                <span className={cn(
                                  'h-4 w-4 shrink-0 rounded border-2 flex items-center justify-center transition-colors',
                                  checked ? 'bg-[#1B3A5C] border-[#1B3A5C]' : 'border-gray-300',
                                )}>
                                  {checked && <Check className="h-2.5 w-2.5 text-white" />}
                                </span>
                                <div className="flex-1 text-left min-w-0">
                                  <p className="font-medium text-gray-800 truncate">{p.deductor_name}</p>
                                  <p className="text-xs text-gray-400">{p.tan} · {p.entry_count} entries</p>
                                </div>
                              </button>
                            );
                          })}
                        {allParties.filter((p) =>
                          dropdownSearch === '' ||
                          p.deductor_name.toLowerCase().includes(dropdownSearch.toLowerCase()) ||
                          p.tan.toLowerCase().includes(dropdownSearch.toLowerCase()),
                        ).length === 0 && (
                          <p className="px-3 py-4 text-sm text-gray-400 text-center">No match for "{dropdownSearch}"</p>
                        )}
                      </div>
                      {/* Done button */}
                      <div className="px-3 py-2 border-t border-gray-100 bg-gray-50 flex items-center justify-between">
                        <span className="text-xs text-gray-500">
                          {selectedParties.length} selected
                        </span>
                        <button
                          type="button"
                          onClick={() => setOpenDropdown(null)}
                          className="text-xs font-semibold text-[#1B3A5C] hover:underline"
                        >
                          Done
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* Run button */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={resolvedCount === 0 || submitting}
          onClick={handleRunAll}
          className={cn(
            'flex items-center gap-2 px-6 py-2.5 rounded-lg text-sm font-semibold transition-colors',
            resolvedCount > 0 && !submitting
              ? 'bg-[#1B3A5C] text-white hover:bg-[#15304d]'
              : 'bg-gray-100 text-gray-400 cursor-not-allowed',
          )}
        >
          {submitting && <Spinner size="sm" className="border-white/30 border-t-white" />}
          {submitting ? `Uploading ${batchProgress?.current ?? 0}/${batchProgress?.total ?? resolvedCount}…` : `Run All — ${resolvedCount} parties`}
        </button>
        {resolvedCount < mappings.length && (
          <p className="text-xs text-amber-600">
            {mappings.length - resolvedCount} file{mappings.length - resolvedCount > 1 ? 's' : ''} skipped (no mapping set)
          </p>
        )}
      </div>

      {submitting && batchProgress && (
        <Card className="space-y-4">
          <div className="flex items-center gap-4">
            <Spinner size="lg" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">
                Uploading file {batchProgress.current} of {batchProgress.total}
              </p>
              <p className="text-xs text-gray-500 mt-0.5 truncate">
                {batchProgress.currentFile}
              </p>
            </div>
            <div className="text-right shrink-0">
              {batchProgress.succeeded > 0 && (
                <span className="text-xs font-semibold text-emerald-600">{batchProgress.succeeded} ok</span>
              )}
              {batchProgress.failed > 0 && (
                <span className="text-xs font-semibold text-red-600 ml-2">{batchProgress.failed} failed</span>
              )}
            </div>
          </div>

          {/* Progress bar */}
          <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
            <div
              className="h-full bg-[#1B3A5C] rounded-full transition-all duration-300"
              style={{ width: `${batchProgress.total > 0 ? (batchProgress.current / batchProgress.total) * 100 : 0}%` }}
            />
          </div>

          {/* Error list */}
          {batchProgress.errors.length > 0 && (
            <div className="space-y-1 max-h-32 overflow-y-auto">
              {batchProgress.errors.map((e, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-red-600 bg-red-50 rounded px-2 py-1.5">
                  <AlertCircle className="h-3 w-3 shrink-0 mt-0.5" />
                  <span className="truncate"><strong>{e.file}:</strong> {e.error}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ── Page root ─────────────────────────────────────────────────────────────────

type Mode = 'single' | 'batch';

export default function NewRunPage() {
  const [mode, setMode] = useState<Mode>('single');

  const { data: fyData } = useQuery({
    queryKey: ['financial-years'],
    queryFn: miscApi.financialYears,
  });

  const fyOptions = fyData?.years ?? [];
  const fyDefault = fyData?.default ?? fyOptions[fyOptions.length - 1] ?? '';

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-bold text-gray-900">New Reconciliation Run</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Upload SAP AR Ledger and Form 26AS to begin TDS reconciliation
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1 w-fit">
        <button
          type="button"
          onClick={() => setMode('single')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all',
            mode === 'single'
              ? 'bg-white text-[#1B3A5C] shadow-sm'
              : 'text-gray-500 hover:text-gray-700',
          )}
        >
          <FileText className="h-4 w-4" />
          Single Party
        </button>
        <button
          type="button"
          onClick={() => setMode('batch')}
          className={cn(
            'flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all',
            mode === 'batch'
              ? 'bg-white text-[#1B3A5C] shadow-sm'
              : 'text-gray-500 hover:text-gray-700',
          )}
        >
          <Layers className="h-4 w-4" />
          Batch Multi-Party
        </button>
      </div>

      {/* Mode description */}
      {mode === 'single' ? (
        <p className="text-xs text-gray-400 -mt-3">
          One SAP file + one 26AS → single reconciliation run
        </p>
      ) : (
        <p className="text-xs text-gray-400 -mt-3">
          Multiple SAP files + one 26AS → auto-map parties → run all in one go
        </p>
      )}

      {/* Form */}
      {mode === 'single' ? (
        <SingleUploadForm fyOptions={fyOptions} fyDefault={fyDefault} />
      ) : (
        <BatchUploadForm fyOptions={fyOptions} fyDefault={fyDefault} />
      )}
    </div>
  );
}
