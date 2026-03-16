import { useState } from 'react';
import UploadPage from './components/UploadPage';
import ProcessingSpinner from './components/ProcessingSpinner';
import AlignmentPage from './components/AlignmentPage';
import ResultsPage from './components/ResultsPage';
import { reconcile, confirmAlignment } from './api';
import type {
  CleaningReport, DeductorCandidate, RecoResult, ReconcileResponse
} from './api';

// ── Page state machine ────────────────────────────────────────────────────────
type Page = 'upload' | 'processing' | 'alignment' | 'results';

interface AlignmentState {
  alignmentId: string;
  identityString: string;
  candidates: DeductorCandidate[];
  cleaningReport: CleaningReport;
}

interface ResultsState {
  result: RecoResult;
  cleaning: CleaningReport;
}

export default function App() {
  const [page, setPage]               = useState<Page>('upload');
  const [uploadError, setUploadError] = useState<string | undefined>();
  const [alignState, setAlignState]   = useState<AlignmentState | null>(null);
  const [resultsState, setResultsState] = useState<ResultsState | null>(null);
  const [confirming, setConfirming]   = useState(false);

  const handleResponse = (res: ReconcileResponse) => {
    if (res.status === 'complete' && res.reco_summary && res.cleaning_report) {
      setResultsState({ result: res.reco_summary, cleaning: res.cleaning_report });
      setPage('results');
    } else if ((res.status === 'pending' || res.status === 'no_match') && res.alignment_id) {
      setAlignState({
        alignmentId: res.alignment_id,
        identityString: res.identity_string || '',
        candidates: res.top_candidates || [],
        cleaningReport: res.cleaning_report!,
      });
      setPage('alignment');
    }
  };

  const handleUpload = async (sapFile: File, as26File: File) => {
    setUploadError(undefined);
    setPage('processing');
    try {
      const res = await reconcile(sapFile, as26File);
      handleResponse(res);
    } catch (e: any) {
      setPage('upload');
      setUploadError(e.message || 'An unexpected error occurred. Please try again.');
    }
  };

  const handleConfirm = async (deductorName: string, tan: string) => {
    if (!alignState) return;
    setConfirming(true);
    try {
      const res = await confirmAlignment(alignState.alignmentId, deductorName, tan);
      handleResponse(res);
    } catch (e: any) {
      setUploadError(e.message || 'Confirmation failed. Please try again.');
      setPage('upload');
    } finally {
      setConfirming(false);
    }
  };

  const handleReset = () => {
    setPage('upload');
    setUploadError(undefined);
    setAlignState(null);
    setResultsState(null);
    setConfirming(false);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50">
      {/* Top bar */}
      <header className="border-b border-slate-200 bg-white/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-3xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-[#1F3864] rounded-lg flex items-center justify-center">
              <span className="text-white text-xs font-bold">TDS</span>
            </div>
            <div>
              <p className="text-sm font-bold text-slate-900 leading-tight">TDS Reco</p>
              <p className="text-xs text-slate-400 leading-tight">Phase 1 · FY 2023-24</p>
            </div>
          </div>
          <p className="text-xs text-slate-400 hidden sm:block">
            HRA &amp; Co. / Akurat Advisory · Precision. Integrity. Insight.
          </p>
        </div>
      </header>

      <main>
        {page === 'upload' && (
          <UploadPage
            onUpload={handleUpload}
            isLoading={false}
            error={uploadError}
          />
        )}
        {page === 'processing' && <ProcessingSpinner />}
        {page === 'alignment' && alignState && (
          <AlignmentPage
            identityString={alignState.identityString}
            candidates={alignState.candidates}
            alignmentId={alignState.alignmentId}
            onConfirm={handleConfirm}
            isLoading={confirming}
          />
        )}
        {page === 'results' && resultsState && (
          <ResultsPage
            result={resultsState.result}
            cleaning={resultsState.cleaning}
            onReset={handleReset}
          />
        )}
      </main>

      <footer className="text-center py-6 text-xs text-slate-400">
        TDS Reconciliation System · Phase 1 · Section 199 Income Tax Act ·
        HRA &amp; Co. / Akurat Advisory
      </footer>
    </div>
  );
}
