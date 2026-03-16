import { useState } from 'react';
import { Search, CheckCircle, AlertTriangle, Loader2 } from 'lucide-react';
import { searchDeductor } from '../api';
import type { DeductorCandidate } from '../api';

interface Props {
  identityString: string;
  candidates: DeductorCandidate[];
  alignmentId: string;
  onConfirm: (name: string, tan: string) => void;
  isLoading: boolean;
}

export default function AlignmentPage({
  identityString,
  candidates,
  alignmentId,
  onConfirm,
  isLoading,
}: Props) {
  const [selected, setSelected]       = useState<DeductorCandidate | null>(null);
  const [searchQ, setSearchQ]         = useState('');
  const [searching, setSearching]     = useState(false);
  const [searchResults, setSearchResults] = useState<DeductorCandidate[] | null>(null);

  const displayList = searchResults ?? candidates;

  const handleSearch = async () => {
    if (!searchQ.trim()) return;
    setSearching(true);
    try {
      const res = await searchDeductor(searchQ.trim(), alignmentId);
      setSearchResults(res);
      setSelected(null);
    } catch (e) {
      console.error(e);
    } finally {
      setSearching(false);
    }
  };

  const scoreColor = (score: number) =>
    score >= 95 ? 'text-emerald-600 bg-emerald-50' :
    score >= 80 ? 'text-amber-600 bg-amber-50' :
                  'text-red-600 bg-red-50';

  return (
    <div className="max-w-2xl mx-auto px-6 py-12">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center gap-2 bg-amber-100 text-amber-800 px-3 py-1 rounded-full text-xs font-semibold mb-4">
          <AlertTriangle size={13} />
          Deductor Confirmation Required
        </div>
        <h2 className="text-2xl font-bold text-slate-900 mb-2">Select the correct deductor</h2>
        <p className="text-slate-500 text-sm">
          SAP file: <span className="font-semibold text-slate-700">{identityString}</span>
        </p>
        <p className="text-xs text-slate-400 mt-1">
          The match score wasn't high enough to auto-confirm. Please select the correct deductor below.
        </p>
      </div>

      {/* Candidate table */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden mb-6 shadow-sm">
        <div className="px-5 py-3 bg-slate-50 border-b border-slate-200">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
            Top Candidates from 26AS
          </p>
        </div>
        <div className="divide-y divide-slate-100">
          {displayList.map((c) => (
            <label
              key={`${c.deductor_name}-${c.tan}`}
              className={`flex items-center gap-4 px-5 py-4 cursor-pointer transition-colors
                ${selected?.tan === c.tan ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
            >
              <input
                type="radio"
                name="candidate"
                className="accent-[#1F3864] w-4 h-4 flex-shrink-0"
                checked={selected?.tan === c.tan}
                onChange={() => setSelected(c)}
              />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-slate-800 text-sm truncate">{c.deductor_name}</p>
                <p className="text-xs text-slate-500 mt-0.5">TAN: {c.tan}</p>
              </div>
              <div className="flex flex-col items-end gap-1 flex-shrink-0">
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${scoreColor(c.score)}`}>
                  {c.score.toFixed(0)}%
                </span>
                <span className="text-xs text-slate-400">{c.entry_count} entries</span>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Manual search */}
      <div className="mb-6">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
          Not listed? Search manually
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Type deductor name…"
            value={searchQ}
            onChange={(e) => setSearchQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            className="flex-1 border border-slate-300 rounded-xl px-4 py-2.5 text-sm focus:outline-none focus:border-[#1F3864] focus:ring-2 focus:ring-blue-100"
          />
          <button
            onClick={handleSearch}
            disabled={searching}
            className="flex items-center gap-2 bg-slate-800 text-white px-4 py-2.5 rounded-xl text-sm font-medium hover:bg-slate-700 transition-colors disabled:opacity-50"
          >
            {searching ? <Loader2 size={15} className="animate-spin" /> : <Search size={15} />}
            Search
          </button>
        </div>
        {searchResults && (
          <p className="text-xs text-slate-400 mt-2">
            Showing search results for "{searchQ}" — click Back to see original candidates
          </p>
        )}
        {searchResults && (
          <button
            onClick={() => { setSearchResults(null); setSelected(null); }}
            className="text-xs text-[#1F3864] underline mt-1"
          >
            ← Show original candidates
          </button>
        )}
      </div>

      {/* Confirm button */}
      <button
        disabled={!selected || isLoading}
        onClick={() => selected && onConfirm(selected.deductor_name, selected.tan)}
        className={`
          w-full py-3.5 rounded-xl font-semibold text-sm flex items-center justify-center gap-2 transition-all
          ${selected && !isLoading
            ? 'bg-[#1F3864] text-white hover:bg-[#162d52] shadow-lg'
            : 'bg-slate-200 text-slate-400 cursor-not-allowed'
          }
        `}
      >
        {isLoading
          ? <><Loader2 size={16} className="animate-spin" /> Running reconciliation…</>
          : <><CheckCircle size={16} /> Confirm Selection &amp; Run Reco</>
        }
      </button>
    </div>
  );
}
