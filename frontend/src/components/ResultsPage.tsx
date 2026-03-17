import { useState } from 'react';
import {
  Download, CheckCircle, XCircle,
  ChevronDown, ChevronUp, RefreshCw
} from 'lucide-react';
import type { CleaningReport, RecoResult } from '../api';
import { downloadUrl } from '../api';

interface Props {
  result: RecoResult;
  cleaning: CleaningReport;
  onReset: () => void;
}

function StatCard({
  label, value, sub, color = 'default'
}: {
  label: string; value: string | number; sub?: string;
  color?: 'default' | 'green' | 'amber' | 'red';
}) {
  const colors = {
    default: 'text-slate-900',
    green:   'text-emerald-600',
    amber:   'text-amber-600',
    red:     'text-red-600',
  };
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">{label}</p>
      <p className={`text-2xl font-bold ${colors[color]}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-1">{sub}</p>}
    </div>
  );
}

function matchRateColor(pct: number): 'green' | 'amber' | 'red' {
  if (pct >= 95) return 'green';
  if (pct >= 75) return 'amber';
  return 'red';
}


export default function ResultsPage({ result, cleaning, onReset }: Props) {
  const [showClean, setShowClean] = useState(false);

  const totalExcluded = cleaning.total_rows_input - cleaning.rows_after_cleaning;
  const excludedPct   = cleaning.total_rows_input > 0
    ? ((totalExcluded / cleaning.total_rows_input) * 100).toFixed(0) : '0';

  return (
    <div className="max-w-3xl mx-auto px-6 py-12">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="inline-flex items-center gap-2 bg-[#1F3864] text-white px-3 py-1 rounded-full text-xs font-semibold mb-3">
            <CheckCircle size={12} /> Reconciliation Complete
          </div>
          <h2 className="text-2xl font-bold text-slate-900">{result.deductor_name}</h2>
          <p className="text-slate-500 text-sm mt-1">
            TAN: <span className="font-mono font-semibold">{result.tan}</span>
            {result.fuzzy_score !== null && (
              <span className="ml-3 text-xs bg-slate-100 px-2 py-0.5 rounded-full text-slate-600">
                Name match: {result.fuzzy_score?.toFixed(0)}%
              </span>
            )}
          </p>
        </div>
        <button
          onClick={onReset}
          className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-800 transition-colors border border-slate-200 rounded-xl px-4 py-2 hover:border-slate-300"
        >
          <RefreshCw size={14} /> New Reco
        </button>
      </div>

      {/* Constraint violations banner */}
      {result.constraint_violations > 0 && (
        <div className="flex items-center gap-3 bg-red-50 border border-red-300 rounded-xl p-4 mb-6">
          <XCircle size={20} className="text-red-600 flex-shrink-0" />
          <div>
            <p className="text-sm font-bold text-red-700">
              {result.constraint_violations} Constraint Violation{result.constraint_violations > 1 ? 's' : ''}
            </p>
            <p className="text-xs text-red-600 mt-0.5">
              Books sum exceeded 26AS amount in {result.constraint_violations} case(s).
              These entries were not matched and must be reviewed immediately.
            </p>
          </div>
        </div>
      )}

      {/* Key metrics */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <StatCard
          label="Match Rate"
          value={`${result.match_rate_pct.toFixed(1)}%`}
          sub={`${result.matched_count} / ${result.total_26as_entries} entries`}
          color={matchRateColor(result.match_rate_pct)}
        />
        <StatCard
          label="Avg. Variance"
          value={`${result.avg_variance_pct.toFixed(2)}%`}
          sub="26AS vs Books"
        />
        <StatCard
          label="Constraint Violations"
          value={result.constraint_violations}
          sub={result.constraint_violations === 0 ? 'All clear ✓' : 'Review required'}
          color={result.constraint_violations === 0 ? 'green' : 'red'}
        />
        <StatCard
          label="Variance Cap"
          value="5%"
          sub="Matches above 5% rejected"
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
        <StatCard
          label="HIGH Confidence"
          value={result.high_confidence_count}
          sub="Variance ≤ 1%"
          color="green"
        />
        <StatCard
          label="MEDIUM Confidence"
          value={result.medium_confidence_count}
          sub="Variance 1–5%"
          color="amber"
        />
        <StatCard
          label="Unmatched 26AS"
          value={result.unmatched_26as_count}
          sub={result.unmatched_26as_count > 0 ? 'Best match exceeded 5% cap' : 'All matched ✓'}
          color={result.unmatched_26as_count > 0 ? 'amber' : 'green'}
        />
        <StatCard
          label="Cross-FY Matches"
          value={result.cross_fy_match_count}
          sub="SAP invoice from prior FY"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 mb-6">
        <StatCard
          label="Unmatched Books"
          value={result.unmatched_books_count}
          sub={result.unmatched_books_count > 0 ? 'Advances or timing diff' : 'All matched ✓'}
          color={result.unmatched_books_count > 0 ? 'amber' : 'green'}
        />
        <StatCard
          label="Rows Cleaned"
          value={`${totalExcluded} of ${cleaning.total_rows_input}`}
          sub={`${excludedPct}% removed`}
        />
      </div>

      {/* Cleaning breakdown */}
      <div className="bg-white border border-slate-200 rounded-2xl mb-6 overflow-hidden shadow-sm">
        <button
          className="w-full flex items-center justify-between px-5 py-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
          onClick={() => setShowClean(!showClean)}
        >
          <div className="flex items-center gap-2">
            <span>Cleaning Breakdown</span>
            {cleaning.used_fallback_doc_types && (
              <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full font-semibold">
                ⚠ Fallback doc types used
              </span>
            )}
          </div>
          {showClean ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showClean && (
          <div className="border-t border-slate-100 px-5 py-4">
            {cleaning.used_fallback_doc_types && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-3 text-xs text-amber-800">
                <strong>⚠ No RV/DR rows found</strong> — results are based on fallback document types.
                Check that the SAP file contains RV or DR entries for this deductor.
              </div>
            )}
            <div className="space-y-1.5">
              {[
                ['Total raw rows',                    cleaning.total_rows_input],
                ['→ After cleaning',                  cleaning.rows_after_cleaning],
                ['Excluded: null amount',             cleaning.excluded_null],
                ['Excluded: negative/zero',           cleaning.excluded_negative],
                ['Excluded: noise (<₹100)',           cleaning.excluded_noise],
                ['Excluded: doc type (CC/BR/other)',   cleaning.excluded_doc_type],
                ['Excluded: SGL (L/E/U)',             cleaning.excluded_sgl],
                ['Excluded: outside FY date range',   cleaning.excluded_date_fy],
                ['Flagged: advance (SGL=V)',          cleaning.flagged_advance],
                ['Flagged: other SGL (O/A/N)',        cleaning.flagged_other_sgl],
                ['Duplicates removed',                cleaning.duplicates_removed],
              ].map(([label, val]) => (
                <div key={label as string} className="flex justify-between text-sm">
                  <span className="text-slate-600">{label}</span>
                  <span className="font-semibold text-slate-800">{val}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Download button */}
      <a
        href={downloadUrl(result.session_id)}
        download
        className="flex items-center justify-center gap-3 w-full py-4 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl font-semibold text-sm shadow-lg hover:shadow-xl transition-all active:scale-[0.99]"
      >
        <Download size={18} />
        Download Excel Report (5 sheets)
      </a>

      <p className="text-center text-xs text-slate-400 mt-3">
        Summary · Matched Pairs · Unmatched 26AS · Unmatched Books · Variance Analysis
      </p>
    </div>
  );
}
