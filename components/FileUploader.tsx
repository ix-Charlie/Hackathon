import React, { useRef, useState } from 'react';
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from '../constants';
import Button from './Button';

interface FileUploaderProps {
  onFilesSelected: (files: File[]) => void;
  isProcessing: boolean;
}

const FileUploader: React.FC<FileUploaderProps> = ({ onFilesSelected, isProcessing }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const validateAndPassFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    
    setError(null);
    const validFiles: File[] = [];
    const invalidFiles: string[] = [];

    // Extensions allowed even if browser MIME type is generic (e.g. application/octet-stream)
    const ALLOWED_EXTENSIONS = ['.pdf','.txt','.csv','.jpg','.jpeg','.png','.doc','.docx','.xls','.xlsx','.msg'];

    Array.from(files).forEach(file => {
      const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
      const mimeOk = ALLOWED_MIME_TYPES.includes(file.type);
      const extOk = ALLOWED_EXTENSIONS.includes(ext);
      if ((mimeOk || extOk) && file.size <= MAX_FILE_SIZE_BYTES) {
        validFiles.push(file);
      } else {
        invalidFiles.push(file.name);
      }
    });

    if (invalidFiles.length > 0) {
      setError(`Skipped ${invalidFiles.length} file(s) due to type or size limits (Max 10MB).`);
    }

    if (validFiles.length > 0) {
      onFilesSelected(validFiles);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      validateAndPassFiles(e.dataTransfer.files);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files.length > 0) {
      validateAndPassFiles(e.target.files);
      if (fileInputRef.current) fileInputRef.current.value = ""; 
    }
  };

  return (
    <div className="max-w-xl mx-auto mt-10 p-6 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-charcoal-border dark:border-gray-700">
      <div className="text-center mb-6">
        <h2 className="text-2xl font-serif font-bold text-charcoal dark:text-white mb-2">Upload Case Documents</h2>
        <p className="text-charcoal-muted dark:text-gray-400 text-sm">
          Securely upload case files. They will be processed locally in your browser.
        </p>
      </div>

      <div 
        className={`relative border-2 border-dashed rounded-lg p-10 transition-all ${
          dragActive 
            ? 'border-charcoal dark:border-gray-400 bg-white dark:bg-gray-700' 
            : 'border-charcoal-border dark:border-gray-600 hover:border-charcoal-muted dark:hover:border-gray-500 bg-white dark:bg-gray-800'
        }`}
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
      >
        <input 
          ref={fileInputRef}
          type="file" 
          multiple 
          accept=".pdf,.txt,.csv,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx,.msg"
          className="hidden"
          onChange={handleChange}
        />
        
        <div className="flex flex-col items-center justify-center text-charcoal-muted dark:text-gray-400">
          <svg className="w-12 h-12 mb-4 text-charcoal-muted dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
          </svg>
          <p className="mb-2 font-medium text-charcoal dark:text-gray-200">Drag & drop files here</p>
          <p className="text-xs text-charcoal-muted dark:text-gray-500 mb-6">or click to browse</p>
          
          <Button 
            variant="secondary" 
            onClick={() => fileInputRef.current?.click()}
            isLoading={isProcessing}
          >
            Select Documents
          </Button>
        </div>
      </div>

      {error && (
        <div className="mt-4 p-3 bg-red-50 dark:bg-red-900/20 text-semantic-error dark:text-red-400 text-sm rounded border border-red-200 dark:border-red-800 flex items-start gap-2">
           <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
             <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
           </svg>
           {error}
        </div>
      )}
      
      <div className="mt-6 border-t border-charcoal-border dark:border-gray-700 pt-4">
        <h4 className="text-xs font-semibold text-charcoal dark:text-gray-300 uppercase tracking-wide mb-2">Supported Formats</h4>
        <div className="flex gap-2 flex-wrap">
          {['PDF', 'TXT', 'CSV', 'DOCX', 'XLSX', 'Images'].map(fmt => (
            <span key={fmt} className="px-2 py-1 bg-white dark:bg-gray-700 text-charcoal-muted dark:text-gray-400 text-xs rounded font-medium border border-charcoal-border dark:border-gray-600">
              {fmt}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

export default FileUploader;
