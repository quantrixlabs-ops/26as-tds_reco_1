/**
 * MatchingMethodologyPanel — Explains the reconciliation algorithm phases
 * Shows each phase with its rules, thresholds, and how matches were produced.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { runsApi, type MatchedPair } from '../lib/api';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { cn, formatCurrency, formatPct } from '../lib/utils';
import { ChevronDown, ChevronRight, Info } from 'lucide-react';

interface MatchingMethodologyPanelProps {
  runId: string;
}

interface PhaseInfo {
  key: string;
  label: string;
  description: string;
  matchTypes: string[];
  varianceCap: string;
  rules: string[];
}

const PHASES: PhaseInfo[] = [
  {
    key: 'A',
    label: 'Phase A — Clearing Group',
    description: 'Groups SAP entries sharing a Clearing Document, then matches the group total against a 26AS entry.',
    matchTypes: ['CLR_GROUP'],
    varianceCap: '3%',
    rules: [
      'Group size: 2–5 entries (hard cap)',
      'Variance tolerance: ≤3%',
      'books_sum must not exceed as26_amount (over-claim prevention)',
    ],
  },
  {
    key: 'B',
    label: 'Phase B — Individual Matching',
    description: 'Matches remaining 26AS entries using progressively relaxed strategies.',
    matchTypes: ['EXACT', 'SINGLE', 'COMBO_2', 'COMBO_3', 'COMBO_4', 'COMBO_5'],
    varianceCap: '2% (single), 3% (combo)',
    rules: [
      'EXACT: 0% variance',
      'SINGLE: ≤2% variance, one invoice',
      'COMBO_2: ≤2% variance, 2 invoices',
      'COMBO_3–5: ≤3% variance, 3–5 invoices',
      'Per-size combo budget to prevent explosion',
      'Pool cap: 50 books per 26AS entry',
    ],
  },
  {
    key: 'C',
    label: 'Phase C — Restricted Force-Match',
    description: 'Last-resort matching with higher tolerance for otherwise unmatched entries.',
    matchTypes: ['FORCE_SINGLE', 'FORCE_COMBO'],
    varianceCap: '5% (single), 2% (combo)',
    rules: [
      'FORCE_SINGLE: ≤5% variance, single invoice',
      'FORCE_COMBO: max 3 invoices, ≤2% variance',
      'Returns None if no match (does not force-fit)',
      'Always LOW confidence',
    ],
  },
  {
    key: 'E',
    label: 'Phase E — Prior-Year Exception',
    description: 'Handles entries from prior financial years when cross-FY is disabled.',
    matchTypes: ['PRIOR_EXACT', 'PRIOR_SINGLE', 'PRIOR_COMBO'],
    varianceCap: 'Same as Phase B',
    rules: [
      'Only runs when ALLOW_CROSS_FY=False',
      'Uses prior-FY books with Phase B logic',
      'Tagged with PRIOR_* match type',
      'Always LOW confidence',
    ],
  },
  {
    key: 'D',
    label: 'Phase D — Unmatched',
    description: 'Entries that could not be matched in any phase receive reason codes.',
    matchTypes: [],
    varianceCap: 'N/A',
    rules: [
      'U01: No matching invoice found in SAP',
      'U02: Invoice found but variance exceeds all thresholds',
      'U04: Amount too small or negative',
    ],
  },
];

function countByPhase(pairs: MatchedPair[]): Map<string, { count: number; totalAmount: number; avgVariance: number }> {
  const result = new Map<string, { count: number; totalAmount: number; varianceSum: number }>();

  for (const p of pairs) {
    const mt = p.match_type || '';
    let phaseKey = 'D';

    if (mt.startsWith('CLR_GROUP')) phaseKey = 'A';
    else if (mt.startsWith('FORCE')) phaseKey = 'C';
    else if (mt.startsWith('PRIOR')) phaseKey = 'E';
    else if (['EXACT', 'SINGLE', 'COMBO_2', 'COMBO_3', 'COMBO_4', 'COMBO_5'].includes(mt)) phaseKey = 'B';

    const entry = result.get(phaseKey) ?? { count: 0, totalAmount: 0, varianceSum: 0 };
    entry.count += 1;
    entry.totalAmount += p.as26_amount;
    entry.varianceSum += p.variance_pct;
    result.set(phaseKey, entry);
  }

  const out = new Map<string, { count: number; totalAmount: number; avgVariance: number }>();
  for (const [key, val] of result) {
    out.set(key, {
      count: val.count,
      totalAmount: val.totalAmount,
      avgVariance: val.count > 0 ? val.varianceSum / val.count : 0,
    });
  }
  return out;
}

export default function MatchingMethodologyPanel({ runId }: MatchingMethodologyPanelProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: pairs = [], isLoading } = useQuery({
    queryKey: ['runs', runId, 'matched'],
    queryFn: () => runsApi.matched(runId),
  });

  const phaseStats = countByPhase(pairs);
  const totalMatched = pairs.length;

  const toggle = (key: string) => {
    setExpanded(expanded === key ? null : key);
  };

  return (
    <Card padding={false}>
      <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
        <Info className="h-3.5 w-3.5 text-[#1B3A5C]" />
        <p className="text-xs font-semibold text-[#1B3A5C]">Matching Methodology — Algorithm v5</p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <p className="text-sm text-gray-400">Loading methodology data...</p>
        </div>
      ) : (
        <div className="divide-y divide-gray-100">
          {PHASES.map((phase) => {
            const stats = phaseStats.get(phase.key);
            const isOpen = expanded === phase.key;
            const phasePct = totalMatched > 0 && stats ? (stats.count / totalMatched) * 100 : 0;

            return (
              <div key={phase.key}>
                <button
                  onClick={() => toggle(phase.key)}
                  className="w-full px-4 py-3 flex items-center gap-3 hover:bg-gray-50 transition-colors text-left"
                >
                  <div className="shrink-0">
                    {isOpen
                      ? <ChevronDown className="h-4 w-4 text-[#1B3A5C]" />
                      : <ChevronRight className="h-4 w-4 text-gray-400" />}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-gray-900">{phase.label}</span>
                      {stats && stats.count > 0 ? (
                        <Badge variant="green" size="sm">
                          {stats.count} matches
                        </Badge>
                      ) : phase.key !== 'D' ? (
                        <Badge variant="gray" size="sm">0 matches</Badge>
                      ) : null}
                    </div>
                    <p className="text-[10px] text-gray-400 mt-0.5">{phase.description}</p>
                  </div>

                  {stats && stats.count > 0 && (
                    <div className="shrink-0 text-right">
                      <span className="font-mono text-xs font-semibold text-[#1B3A5C]">
                        {phasePct.toFixed(1)}%
                      </span>
                      <p className="text-[10px] text-gray-400">
                        {formatCurrency(stats.totalAmount)}
                      </p>
                    </div>
                  )}
                </button>

                {isOpen && (
                  <div className="px-4 pb-4 ml-7">
                    <div className="bg-gray-50 rounded-lg p-3 space-y-3">
                      {/* Thresholds */}
                      <div className="flex items-center gap-4 text-xs">
                        <div>
                          <span className="text-gray-400">Variance Cap: </span>
                          <span className="font-mono font-semibold text-gray-700">{phase.varianceCap}</span>
                        </div>
                        {stats && stats.count > 0 && (
                          <div>
                            <span className="text-gray-400">Actual Avg: </span>
                            <span className={cn(
                              'font-mono font-semibold',
                              stats.avgVariance > 3 ? 'text-red-600' : stats.avgVariance > 1 ? 'text-amber-600' : 'text-emerald-600',
                            )}>
                              {formatPct(stats.avgVariance)}
                            </span>
                          </div>
                        )}
                      </div>

                      {/* Match types */}
                      {phase.matchTypes.length > 0 && (
                        <div>
                          <p className="text-[10px] text-gray-400 mb-1">Match Types</p>
                          <div className="flex flex-wrap gap-1">
                            {phase.matchTypes.map((mt) => (
                              <span
                                key={mt}
                                className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-[#1B3A5C]/10 text-[#1B3A5C]"
                              >
                                {mt}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Phase volume bar */}
                      {stats && stats.count > 0 && (
                        <div>
                          <div className="flex items-center gap-2">
                            <div className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-[#1B3A5C]"
                                style={{ width: `${phasePct}%` }}
                              />
                            </div>
                            <span className="text-[10px] text-gray-500 w-16 text-right">
                              {stats.count} / {totalMatched}
                            </span>
                          </div>
                        </div>
                      )}

                      {/* Rules */}
                      <div>
                        <p className="text-[10px] text-gray-400 mb-1">Rules</p>
                        <ul className="space-y-0.5">
                          {phase.rules.map((rule, i) => (
                            <li key={i} className="flex items-start gap-1.5 text-xs text-gray-600">
                              <span className="text-gray-300 mt-0.5">•</span>
                              <span>{rule}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}
