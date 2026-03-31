/**
 * TableExport — CSV download + clipboard copy button for tables.
 * Accepts headers and rows as string arrays, generates CSV on-the-fly.
 */
import { useState } from 'react';
import { Download, Copy, Check } from 'lucide-react';
import { cn } from '../../lib/utils';

interface TableExportProps {
  headers: string[];
  rows: string[][];
  filename?: string;
  className?: string;
}

function toCsv(headers: string[], rows: string[][]): string {
  const escape = (v: string) => {
    if (v.includes(',') || v.includes('"') || v.includes('\n')) {
      return `"${v.replace(/"/g, '""')}"`;
    }
    return v;
  };
  const lines = [headers.map(escape).join(',')];
  for (const row of rows) {
    lines.push(row.map(escape).join(','));
  }
  return lines.join('\n');
}

export function TableExport({ headers, rows, filename = 'export.csv', className }: TableExportProps) {
  const [copied, setCopied] = useState(false);

  const handleDownload = () => {
    const csv = toCsv(headers, rows);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopy = async () => {
    const csv = toCsv(headers, rows);
    try {
      await navigator.clipboard.writeText(csv);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
      const ta = document.createElement('textarea');
      ta.value = csv;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className={cn('flex items-center gap-1', className)}>
      <button
        onClick={handleDownload}
        title="Download CSV"
        className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
      >
        <Download className="h-3.5 w-3.5" />
      </button>
      <button
        onClick={handleCopy}
        title={copied ? 'Copied!' : 'Copy to clipboard'}
        className={cn(
          'p-1.5 rounded transition-colors',
          copied
            ? 'text-emerald-500 bg-emerald-50'
            : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100',
        )}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
