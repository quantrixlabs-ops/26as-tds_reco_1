import { useEffect, useState } from 'react';
import { CheckCircle, Loader2 } from 'lucide-react';

const STEPS = [
  { label: 'Parsing SAP file', sub: 'Reading AR ledger rows…' },
  { label: 'Cleaning SAP data', sub: 'Removing noise, reversals, provisions…' },
  { label: 'Parsing 26AS file', sub: 'Filtering Status=F entries…' },
  { label: 'Matching deductor', sub: 'Fuzzy name alignment…' },
  { label: 'Running reconciliation', sub: 'Combination match algorithm…' },
  { label: 'Generating Excel', sub: 'Building 5-sheet workbook…' },
];

export default function ProcessingSpinner() {
  const [activeStep, setActiveStep] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setActiveStep((s) => Math.min(s + 1, STEPS.length - 1));
    }, 1200);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="max-w-md mx-auto px-6 py-20 text-center">
      <div className="inline-flex items-center justify-center w-16 h-16 bg-[#EBF3FB] rounded-full mb-8">
        <Loader2 size={32} className="text-[#1F3864] animate-spin" />
      </div>
      <h2 className="text-xl font-bold text-slate-900 mb-2">Processing your files</h2>
      <p className="text-slate-500 text-sm mb-10">This usually takes a few seconds…</p>

      <div className="space-y-3 text-left">
        {STEPS.map((step, i) => {
          const done    = i < activeStep;
          const active  = i === activeStep;
          const pending = i > activeStep;
          return (
            <div key={i} className="flex items-center gap-3">
              {done ? (
                <CheckCircle size={20} className="text-emerald-500 flex-shrink-0" />
              ) : active ? (
                <Loader2 size={20} className="text-[#1F3864] animate-spin flex-shrink-0" />
              ) : (
                <div className="w-5 h-5 rounded-full border-2 border-slate-200 flex-shrink-0" />
              )}
              <div>
                <p className={`text-sm font-medium ${pending ? 'text-slate-400' : 'text-slate-800'}`}>
                  {step.label}
                </p>
                {active && (
                  <p className="text-xs text-slate-500 mt-0.5">{step.sub}</p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
