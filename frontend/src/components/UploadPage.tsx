import React, { useRef, useState } from 'react';
import { Upload, FileSpreadsheet, AlertCircle } from 'lucide-react';

interface Props {
  onUpload: (sapFile: File, as26File: File) => void;
  isLoading: boolean;
  error?: string;
}

interface DropZoneProps {
  label: string;
  subtitle: string;
  file: File | null;
  onFile: (f: File) => void;
  accent: string;
  bgAccent: string;
}

function DropZone({ label, subtitle, file, onFile, accent, bgAccent }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) onFile(f);
  };

  return (
    <div
      className={`
        relative flex flex-col items-center justify-center p-8 rounded-2xl border-2 border-dashed
        transition-all duration-200 cursor-pointer min-h-[200px]
        ${dragging ? `border-[${accent}] ${bgAccent}` : 'border-slate-300 bg-white hover:border-slate-400 hover:bg-slate-50'}
        ${file ? `border-[${accent}] ${bgAccent}` : ''}
      `}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls"
        className="hidden"
        onChange={(e) => { if (e.target.files?.[0]) onFile(e.target.files[0]); }}
      />
      {file ? (
        <>
          <FileSpreadsheet size={36} className="mb-3" style={{ color: accent }} />
          <p className="font-semibold text-slate-800 text-center text-sm leading-snug">{file.name}</p>
          <p className="text-xs text-slate-500 mt-1">{(file.size / 1024).toFixed(1)} KB</p>
          <p className="text-xs mt-2 font-medium" style={{ color: accent }}>✓ Ready</p>
        </>
      ) : (
        <>
          <Upload size={32} className="mb-3 text-slate-400" />
          <p className="font-semibold text-slate-700 text-sm">{label}</p>
          <p className="text-xs text-slate-400 mt-1 text-center">{subtitle}</p>
          <p className="text-xs text-slate-400 mt-3">Drop here or click to browse</p>
        </>
      )}
    </div>
  );
}

export default function UploadPage({ onUpload, isLoading, error }: Props) {
  const [sapFile, setSapFile]   = useState<File | null>(null);
  const [as26File, setAs26File] = useState<File | null>(null);
  const ready = sapFile && as26File && !isLoading;

  return (
    <div className="max-w-2xl mx-auto px-6 py-16">
      {/* Header */}
      <div className="text-center mb-10">
        <div className="inline-flex items-center gap-2 bg-[#1F3864] text-white px-4 py-1.5 rounded-full text-xs font-semibold tracking-wide mb-4">
          HRA &amp; Co. / Akurat Advisory
        </div>
        <h1 className="text-3xl font-bold text-slate-900 mb-2">TDS Reconciliation</h1>
        <p className="text-slate-500 text-sm">Phase 1 — Single file reco · FY 2023-24</p>
      </div>

      {/* Drop zones */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <DropZone
          label="SAP AR Ledger"
          subtitle="Upload your SAP export (.xlsx)"
          file={sapFile}
          onFile={setSapFile}
          accent="#1F3864"
          bgAccent="bg-blue-50"
        />
        <DropZone
          label="26AS Master File"
          subtitle="Upload the 26AS Excel (.xlsx)"
          file={as26File}
          onFile={setAs26File}
          accent="#059669"
          bgAccent="bg-emerald-50"
        />
      </div>

      {/* Instruction */}
      <p className="text-center text-xs text-slate-400 mb-5">
        Name your SAP file after the deductor (e.g.{' '}
        <code className="bg-slate-100 px-1 rounded text-slate-600">BHUSHAN_POWER_&amp;_STEEL.XLSX</code>)
        for automatic matching.
      </p>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-3 bg-red-50 border border-red-200 rounded-xl p-4 mb-5">
          <AlertCircle size={18} className="text-red-500 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {/* Button */}
      <button
        disabled={!ready}
        onClick={() => ready && onUpload(sapFile!, as26File!)}
        className={`
          w-full py-3.5 rounded-xl font-semibold text-sm tracking-wide transition-all duration-200
          ${ready
            ? 'bg-[#1F3864] text-white hover:bg-[#162d52] shadow-lg hover:shadow-xl active:scale-[0.99]'
            : 'bg-slate-200 text-slate-400 cursor-not-allowed'
          }
        `}
      >
        {isLoading ? 'Processing…' : 'Upload &amp; Reconcile'}
      </button>
    </div>
  );
}
