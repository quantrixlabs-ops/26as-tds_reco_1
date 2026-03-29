/**
 * FileDropzone — drag-and-drop file upload area with visual feedback.
 * Built on react-dropzone for reliable cross-browser drag handling.
 */
import { useCallback } from 'react';
import { useDropzone, type Accept } from 'react-dropzone';
import { Upload, FileSpreadsheet, X, AlertCircle } from 'lucide-react';
import { cn } from '../../lib/utils';

interface FileDropzoneProps {
  /** Accepted MIME types / extensions */
  accept?: Accept;
  /** Allow multiple files */
  multiple?: boolean;
  /** Callback with accepted files */
  onFilesAccepted: (files: File[]) => void;
  /** Currently selected files (controlled) */
  files?: File[];
  /** Remove a file by index */
  onRemoveFile?: (index: number) => void;
  /** Label shown in the drop area */
  label?: string;
  /** Sub-label (e.g. accepted formats) */
  hint?: string;
  /** Max file size in bytes */
  maxSize?: number;
  /** Disabled state */
  disabled?: boolean;
  className?: string;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileDropzone({
  accept = {
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
    'application/vnd.ms-excel': ['.xls'],
  },
  multiple = false,
  onFilesAccepted,
  files = [],
  onRemoveFile,
  label = 'Drop your file here, or click to browse',
  hint = 'Supports .xlsx and .xls files',
  maxSize = 50 * 1024 * 1024, // 50MB
  disabled = false,
  className,
}: FileDropzoneProps) {
  const onDrop = useCallback(
    (accepted: File[]) => {
      if (accepted.length > 0) onFilesAccepted(accepted);
    },
    [onFilesAccepted],
  );

  const { getRootProps, getInputProps, isDragActive, fileRejections } = useDropzone({
    onDrop,
    accept,
    multiple,
    maxSize,
    disabled,
  });

  return (
    <div className={cn('space-y-3', className)}>
      <div
        {...getRootProps()}
        className={cn(
          'relative rounded-xl border-2 border-dashed transition-all duration-200 cursor-pointer',
          'flex flex-col items-center justify-center text-center p-8',
          disabled && 'opacity-50 cursor-not-allowed',
          isDragActive
            ? 'border-[#1B3A5C] bg-[#1B3A5C]/5 scale-[1.01]'
            : 'border-gray-300 bg-gray-50/50 hover:border-[#1B3A5C]/50 hover:bg-gray-50',
        )}
      >
        <input {...getInputProps()} />
        <div
          className={cn(
            'w-12 h-12 rounded-xl flex items-center justify-center mb-3 transition-colors',
            isDragActive ? 'bg-[#1B3A5C]/10' : 'bg-gray-100',
          )}
        >
          <Upload
            className={cn(
              'h-5 w-5 transition-colors',
              isDragActive ? 'text-[#1B3A5C]' : 'text-gray-400',
            )}
          />
        </div>
        <p
          className={cn(
            'text-sm font-medium transition-colors',
            isDragActive ? 'text-[#1B3A5C]' : 'text-gray-700',
          )}
        >
          {isDragActive ? 'Drop files here...' : label}
        </p>
        <p className="text-xs text-gray-500 mt-1">{hint}</p>
      </div>

      {/* File rejection errors */}
      {fileRejections.length > 0 && (
        <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-lg p-3">
          <AlertCircle className="h-4 w-4 text-red-500 shrink-0 mt-0.5" />
          <div className="text-xs text-red-700">
            {fileRejections.map((r, i) => (
              <p key={i}>
                <strong>{r.file.name}</strong>: {r.errors.map((e) => e.message).join(', ')}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* Selected files list */}
      {files.length > 0 && (
        <div className="space-y-2">
          {files.map((file, idx) => (
            <div
              key={`${file.name}-${idx}`}
              className="flex items-center gap-3 bg-white border border-gray-200 rounded-lg px-3 py-2.5"
            >
              <FileSpreadsheet className="h-4 w-4 text-emerald-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 truncate">{file.name}</p>
                <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
              </div>
              {onRemoveFile && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveFile(idx);
                  }}
                  className="text-gray-400 hover:text-red-500 transition-colors shrink-0"
                  aria-label={`Remove ${file.name}`}
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default FileDropzone;
