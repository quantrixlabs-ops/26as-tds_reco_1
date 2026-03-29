/**
 * RunProgressPanel — real-time progress display for a PROCESSING run.
 * Always shows the full pipeline visualization, even before progress arrives.
 */
import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle,
  Clock,
  Loader2,
  XCircle,
  Zap,
  FileSearch,
  ShieldCheck,
  AlertTriangle,
  Save,
  Flag,
  History,
  BarChart3,
} from 'lucide-react';
import {
  runsApi,
  type RunProgress,
  type ProgressStatus,
} from '../lib/api';
import { cn } from '../lib/utils';

// ── Stage pipeline definition ───────────────────────────────────────────────

interface StageInfo {
  key: ProgressStatus;
  label: string;
  shortLabel: string;
  description: string;
  icon: React.ReactNode;
}

const PIPELINE_STAGES: StageInfo[] = [
  { key: 'PARSING',        label: 'Parsing Files',          shortLabel: 'Parse',       description: 'Reading SAP & 26AS files',           icon: <FileSearch className="h-4 w-4" /> },
  { key: 'VALIDATING',     label: 'Validating Data',        shortLabel: 'Validate',    description: 'Checking data integrity & formats',   icon: <ShieldCheck className="h-4 w-4" /> },
  { key: 'PHASE_A',        label: 'Clearing Groups',        shortLabel: 'Phase A',     description: 'Matching clearing document groups',    icon: <Zap className="h-4 w-4" /> },
  { key: 'PHASE_B_SINGLE', label: 'Bipartite Matching',     shortLabel: 'Phase B₁',    description: 'Single invoice optimal assignment',    icon: <BarChart3 className="h-4 w-4" /> },
  { key: 'PHASE_B_COMBO',  label: 'Combo Matching',         shortLabel: 'Phase B₂',    description: 'Multi-invoice ILP optimization',       icon: <Zap className="h-4 w-4" /> },
  { key: 'PHASE_C',        label: 'Force Matching',         shortLabel: 'Phase C',     description: 'Relaxed variance force-match',         icon: <Zap className="h-4 w-4" /> },
  { key: 'PHASE_E',        label: 'Prior Year',             shortLabel: 'Phase E',     description: 'Cross-FY exception matching',          icon: <History className="h-4 w-4" /> },
  { key: 'POST_VALIDATE',  label: 'Compliance Check',       shortLabel: 'Comply',      description: 'Over-claim, uniqueness, combo cap',    icon: <ShieldCheck className="h-4 w-4" /> },
  { key: 'PERSISTING',     label: 'Saving Results',         shortLabel: 'Save',        description: 'Writing matched pairs to database',    icon: <Save className="h-4 w-4" /> },
  { key: 'EXCEPTIONS',     label: 'Exceptions',             shortLabel: 'Except',      description: 'Generating review items',              icon: <AlertTriangle className="h-4 w-4" /> },
  { key: 'FINALIZING',     label: 'Finalizing',             shortLabel: 'Finalize',    description: 'Computing stats & completing run',     icon: <Flag className="h-4 w-4" /> },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(secs: number): string {
  if (secs < 0) return '--';
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatNumber(n: number): string {
  return n.toLocaleString('en-IN');
}

// ── Main component ──────────────────────────────────────────────────────────

interface RunProgressPanelProps {
  runId: string;
  /** Called when progress reaches COMPLETE or FAILED */
  onComplete?: () => void;
  /** Compact mode — less vertical space */
  compact?: boolean;
}

export function RunProgressPanel({ runId, onComplete, compact = false }: RunProgressPanelProps) {
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  const completeFiredRef = useRef(false);

  useEffect(() => {
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const data = await runsApi.progress(runId);
        if (cancelled) return;
        setProgress(data);
        if ((data.status === 'COMPLETE' || data.status === 'FAILED') && !completeFiredRef.current) {
          completeFiredRef.current = true;
          setTimeout(() => onCompleteRef.current?.(), 500);
          if (pollTimer) clearInterval(pollTimer);
        }
      } catch { /* ignore network errors */ }
    };

    poll();
    pollTimer = setInterval(poll, 800);

    return () => {
      cancelled = true;
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [runId]);

  const isWaiting = !progress || progress.status === 'NOT_FOUND' || progress.status === 'QUEUED';
  const isComplete = progress?.status === 'COMPLETE';
  const isFailed = progress?.status === 'FAILED';
  const pct = isWaiting ? 0 : Math.min(progress!.overall_pct, 100);

  const activeStageIndex = isWaiting
    ? -1
    : PIPELINE_STAGES.findIndex((s) => s.key === progress!.status);
  const completedStages = new Set(progress?.stages_completed ?? []);

  const stageLabel = isWaiting ? 'Queued — Waiting for pipeline' : progress!.stage_label;
  const stageDetail = isWaiting ? 'Initializing reconciliation engine...' : progress!.current_phase_detail;

  return (
    <div
      className={cn(
        'bg-white border rounded-xl overflow-hidden transition-all',
        isFailed ? 'border-red-200' : isComplete ? 'border-emerald-200' : 'border-[#1B3A5C]/20',
      )}
    >
      {/* ── Header + Progress ──────────────────────────────────────────────── */}
      <div className="px-5 py-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            {isFailed ? (
              <XCircle className="h-5 w-5 text-red-500" />
            ) : isComplete ? (
              <CheckCircle className="h-5 w-5 text-emerald-500" />
            ) : (
              <Loader2 className="h-5 w-5 text-[#1B3A5C] animate-spin" />
            )}
            <div>
              <p className={cn(
                'text-sm font-semibold',
                isFailed ? 'text-red-800' : isComplete ? 'text-emerald-800' : 'text-gray-900',
              )}>
                {stageLabel}
              </p>
              {stageDetail && (
                <p className="text-xs text-gray-500 mt-0.5 max-w-lg truncate">
                  {stageDetail}
                </p>
              )}
            </div>
          </div>
          <span className={cn(
            'text-lg font-bold tabular-nums',
            isFailed ? 'text-red-600' : isComplete ? 'text-emerald-600' : 'text-[#1B3A5C]',
          )}>
            {Math.round(pct)}%
          </span>
        </div>

        {/* ── Progress bar ──────────────────────────────────────────────────── */}
        <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-500 ease-out',
              isFailed
                ? 'bg-red-500'
                : isComplete
                ? 'bg-emerald-500'
                : isWaiting
                ? 'bg-[#1B3A5C]/30 animate-pulse'
                : 'bg-gradient-to-r from-[#1B3A5C] to-[#2563eb]',
            )}
            style={{ width: isWaiting ? '2%' : `${pct}%` }}
          />
        </div>

        {/* ── Stats row ────────────────────────────────────────────────────── */}
        {!isWaiting && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            {progress!.total_26as > 0 && (
              <div className="bg-gray-50 rounded-lg px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">26AS Entries</p>
                <p className="text-sm font-bold text-gray-900 tabular-nums">{formatNumber(progress!.total_26as)}</p>
              </div>
            )}
            {progress!.total_sap > 0 && (
              <div className="bg-gray-50 rounded-lg px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">SAP Entries</p>
                <p className="text-sm font-bold text-gray-900 tabular-nums">{formatNumber(progress!.total_sap)}</p>
              </div>
            )}
            {progress!.matched_so_far > 0 && (
              <div className="bg-emerald-50 rounded-lg px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-emerald-600 font-semibold">Matched</p>
                <p className="text-sm font-bold text-emerald-700 tabular-nums">
                  {formatNumber(progress!.matched_so_far)}
                  {progress!.total_26as > 0 && (
                    <span className="text-xs font-normal text-emerald-500 ml-1">
                      ({progress!.match_rate_so_far.toFixed(1)}%)
                    </span>
                  )}
                </p>
              </div>
            )}
            <div className="bg-gray-50 rounded-lg px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-gray-400 font-semibold">
                {isComplete || isFailed ? 'Duration' : 'Elapsed'}
              </p>
              <p className="text-sm font-bold text-gray-900 tabular-nums flex items-center gap-1.5">
                <Clock className="h-3 w-3 text-gray-400" />
                {formatDuration(progress!.elapsed_seconds)}
                {progress!.eta_seconds != null && !isComplete && !isFailed && (
                  <span className="text-xs font-normal text-gray-400 ml-1">
                    (ETA: ~{formatDuration(progress!.eta_seconds)})
                  </span>
                )}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* ── Stage pipeline — always visible ────────────────────────────────── */}
      {!compact && (
        <div className="border-t border-gray-100 bg-gray-50/50">
          {/* Horizontal pipeline chips */}
          <div className="px-5 pt-3 pb-2">
            <div className="flex items-center gap-0.5 overflow-x-auto pb-1">
              {PIPELINE_STAGES.map((stage, idx) => {
                const isDone = completedStages.has(stage.key);
                const isActive = activeStageIndex === idx && !isComplete && !isFailed;
                const isUpcoming = !isDone && !isActive;

                return (
                  <div key={stage.key} className="flex items-center shrink-0">
                    {idx > 0 && (
                      <div className={cn(
                        'w-3 h-px mx-0.5 transition-colors',
                        isDone ? 'bg-emerald-400' : isActive ? 'bg-[#1B3A5C]' : 'bg-gray-200',
                      )} />
                    )}
                    <div
                      className={cn(
                        'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold transition-all whitespace-nowrap',
                        isDone && 'bg-emerald-50 text-emerald-700',
                        isActive && 'bg-[#1B3A5C] text-white shadow-sm ring-2 ring-[#1B3A5C]/20',
                        isUpcoming && 'bg-gray-100 text-gray-400',
                      )}
                      title={`${stage.label}: ${stage.description}`}
                    >
                      {isDone ? (
                        <CheckCircle className="h-3 w-3" />
                      ) : isActive ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <span className="h-3 w-3 flex items-center justify-center">{stage.icon}</span>
                      )}
                      <span className="hidden sm:inline">{stage.shortLabel}</span>
                    </div>
                  </div>
                );
              })}

              {/* Final complete indicator */}
              <div className="flex items-center shrink-0">
                <div className={cn('w-3 h-px mx-0.5', isComplete ? 'bg-emerald-500' : 'bg-gray-200')} />
                <div className={cn(
                  'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold',
                  isComplete ? 'bg-emerald-500 text-white' : isFailed ? 'bg-red-100 text-red-600' : 'bg-gray-100 text-gray-400',
                )}>
                  {isComplete ? (
                    <CheckCircle className="h-3 w-3" />
                  ) : isFailed ? (
                    <AlertTriangle className="h-3 w-3" />
                  ) : (
                    <CheckCircle className="h-3 w-3" />
                  )}
                  <span className="hidden sm:inline">{isFailed ? 'Failed' : 'Done'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Vertical step list — shows current + upcoming stages with descriptions */}
          <div className="px-5 pb-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1">
              {PIPELINE_STAGES.map((stage, idx) => {
                const isDone = completedStages.has(stage.key);
                const isActive = activeStageIndex === idx && !isComplete && !isFailed;

                return (
                  <div
                    key={stage.key}
                    className={cn(
                      'flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs transition-all',
                      isDone && 'text-emerald-700 bg-emerald-50/50',
                      isActive && 'text-[#1B3A5C] bg-[#1B3A5C]/5 font-semibold',
                      !isDone && !isActive && 'text-gray-400',
                    )}
                  >
                    <span className="shrink-0 w-4 h-4 flex items-center justify-center">
                      {isDone ? (
                        <CheckCircle className="h-3.5 w-3.5 text-emerald-500" />
                      ) : isActive ? (
                        <Loader2 className="h-3.5 w-3.5 text-[#1B3A5C] animate-spin" />
                      ) : (
                        <span className="w-1.5 h-1.5 rounded-full bg-gray-300" />
                      )}
                    </span>
                    <span className="truncate">{stage.label}</span>
                    {isActive && stageDetail && (
                      <span className="text-[10px] text-gray-400 font-normal truncate ml-auto hidden lg:inline">
                        {stageDetail}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default RunProgressPanel;
