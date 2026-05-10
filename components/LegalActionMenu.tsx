import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  LegalActionFlags,
  DEFAULT_LEGAL_ACTION_FLAGS,
  JURISDICTIONS,
  Jurisdiction,
  HorizonMode,
  Case,
} from '../types';

// Re-use DbFile from ChatInterface
export interface DbFile {
  id: string;
  filename: string;
  status: string;
  case_id?: string;
  folder_id?: string;
  created_at: string;
}

// ─── File type helpers ───────────────────────────────────────────────────────

type FileCategory = 'pdf' | 'doc' | 'sheet' | 'image' | 'email' | 'other';

const FILE_CATEGORIES: Record<FileCategory, { label: string; color: string; extensions: string[] }> = {
  pdf:   { label: 'PDF',    color: 'text-red-500',    extensions: ['.pdf'] },
  doc:   { label: 'Doc',    color: 'text-blue-500',   extensions: ['.doc', '.docx', '.txt', '.rtf', '.md', '.odt'] },
  sheet: { label: 'Sheet',  color: 'text-green-500',  extensions: ['.xls', '.xlsx', '.csv', '.tsv'] },
  image: { label: 'Image',  color: 'text-purple-500', extensions: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff'] },
  email: { label: 'Email',  color: 'text-amber-500',  extensions: ['.msg', '.eml'] },
  other: { label: 'File',   color: 'text-gray-400',   extensions: [] },
};

function getFileCategory(filename: string): FileCategory {
  const lower = filename.toLowerCase();
  for (const [cat, cfg] of Object.entries(FILE_CATEGORIES) as [FileCategory, typeof FILE_CATEGORIES[FileCategory]][]) {
    if (cfg.extensions.some(ext => lower.endsWith(ext))) return cat;
  }
  return 'other';
}

function getFileIcon(category: FileCategory): React.ReactNode {
  const cls = `w-4 h-4 flex-shrink-0 ${FILE_CATEGORIES[category].color}`;
  switch (category) {
    case 'pdf':
      return <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>;
    case 'doc':
      return <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>;
    case 'sheet':
      return <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>;
    case 'image':
      return <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>;
    case 'email':
      return <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>;
    default:
      return <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>;
  }
}

/** Simple fuzzy-ish search: split query into tokens and require all tokens to appear in the filename */
function fuzzyMatch(filename: string, query: string): boolean {
  if (!query) return true;
  const lower = filename.toLowerCase();
  return query.toLowerCase().split(/\s+/).every(token => lower.includes(token));
}

/** Highlight matched portions of filename */
function highlightMatch(filename: string, query: string): React.ReactNode {
  if (!query.trim()) return filename;
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return filename;
  // Build regex from tokens
  const escaped = tokens.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi');
  const parts = filename.split(pattern);
  return (
    <>
      {parts.map((part, i) =>
        pattern.test(part) ? (
          <mark key={i} className="bg-yellow-200 dark:bg-yellow-700/50 text-inherit rounded-sm px-0">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

/** Max files shown before "Show all" is needed (performance guard) */
const VISIBLE_FILE_LIMIT = 20;

interface LegalActionMenuProps {
  isOpen: boolean;
  onClose: () => void;
  activeMatter: Case | null;
  readyFiles: DbFile[];
  selectedFileIds: string[];
  onToggleFile: (id: string) => void;
  onClearFiles: () => void;
  flags: LegalActionFlags;
  onFlagsChange: (flags: LegalActionFlags) => void;
  onAttach: (files: FileList) => void;
  mode: HorizonMode;
  anchorDirection?: 'up' | 'down';
  pendingAttachmentCount?: number;
}

// ─── Section toggle helper ───────────────────────────────────────────────────

const SectionHeader: React.FC<{
  title: string;
  icon: React.ReactNode;
  isExpanded: boolean;
  onToggle: () => void;
  badge?: number | boolean;
}> = ({ title, icon, isExpanded, onToggle, badge }) => (
  <button
    type="button"
    onClick={onToggle}
    className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
  >
    <span className="flex items-center gap-2">
      {icon}
      {title}
      {badge ? (
        <span className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-500 text-[10px] text-white font-bold leading-none">
          {typeof badge === 'number' ? badge : ''}
        </span>
      ) : null}
    </span>
    <svg
      className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  </button>
);

// ─── Toggle row ──────────────────────────────────────────────────────────────

const ToggleRow: React.FC<{
  label: string;
  description: string;
  enabled: boolean;
  onToggle: () => void;
  disabled?: boolean;
}> = ({ label, description, enabled, onToggle, disabled }) => (
  <button
    type="button"
    onClick={disabled ? undefined : onToggle}
    className={`w-full flex items-center justify-between gap-3 px-4 py-2 text-left transition-colors ${
      disabled
        ? 'opacity-40 cursor-not-allowed'
        : 'hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer'
    }`}
  >
    <div className="flex-1 min-w-0">
      <div className="text-sm font-medium text-gray-700 dark:text-gray-200">{label}</div>
      <div className="text-xs text-gray-400 dark:text-gray-500 truncate">{description}</div>
    </div>
    <div
      className={`relative flex-shrink-0 w-9 h-5 rounded-full transition-colors duration-200 ${
        enabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'
      }`}
    >
      <div
        className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform duration-200 ${
          enabled ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </div>
  </button>
);

// ─── Main Component ──────────────────────────────────────────────────────────

const LegalActionMenu: React.FC<LegalActionMenuProps> = ({
  isOpen,
  onClose,
  activeMatter,
  readyFiles,
  selectedFileIds,
  onToggleFile,
  onClearFiles,
  flags,
  onFlagsChange,
  onAttach,
  mode,
  anchorDirection = 'up',
  pendingAttachmentCount = 0,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const attachInputRef = useRef<HTMLInputElement>(null);
  const fileSearchRef = useRef<HTMLInputElement>(null);

  // Section expand states — auto-expand based on mode
  const [attachExpanded, setAttachExpanded] = useState(true);
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [intelligenceExpanded, setIntelligenceExpanded] = useState(false);
  const [advancedExpanded, setAdvancedExpanded] = useState(false);

  // File search & filter
  const [fileQuery, setFileQuery] = useState('');
  const [activeTypeFilter, setActiveTypeFilter] = useState<FileCategory | null>(null);
  const [showAllFiles, setShowAllFiles] = useState(false);

  // Auto-expand sections based on active mode
  useEffect(() => {
    if (mode === 'legal_research') {
      setIntelligenceExpanded(true);
    } else if (mode === 'contract_review' || mode === 'multi_document') {
      setAdvancedExpanded(true);
    }
  }, [mode]);

  // Reset search state when menu opens/closes
  useEffect(() => {
    if (!isOpen) {
      setFileQuery('');
      setActiveTypeFilter(null);
      setShowAllFiles(false);
    }
  }, [isOpen]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Small delay so the opening click doesn't immediately close
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleMouseDown);
    }, 10);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [isOpen, onClose]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  const updateFlag = useCallback(
    <K extends keyof LegalActionFlags>(key: K, value: LegalActionFlags[K]) => {
      const next = { ...flags, [key]: value };
      // Mutual exclusion: fast_mode ↔ deep_analysis
      if (key === 'fast_mode' && value) next.deep_analysis = false;
      if (key === 'deep_analysis' && value) next.fast_mode = false;
      onFlagsChange(next);
    },
    [flags, onFlagsChange]
  );

  // Count active indicators
  const activeFlagCount =
    (flags.web_search_enabled ? 1 : 0) +
    (flags.jurisdiction ? 1 : 0) +
    (flags.deep_analysis ? 1 : 0) +
    (flags.strict_citations ? 1 : 0) +
    (flags.privilege_review ? 1 : 0) +
    (flags.fast_mode ? 1 : 0);

  if (!isOpen) return null;

  const matterFiles = activeMatter
    ? readyFiles.filter(f => f.case_id === activeMatter.id)
    : readyFiles;

  // ─── Smart file filtering: search → type filter → sort (selected first, then recency) ───
  const filteredFiles = matterFiles
    .filter(f => fuzzyMatch(f.filename, fileQuery))
    .filter(f => !activeTypeFilter || getFileCategory(f.filename) === activeTypeFilter);

  // Sort: selected files pinned to top, then by recency (newest first)
  const sortedFiles = [...filteredFiles].sort((a, b) => {
    const aSelected = selectedFileIds.includes(a.id) ? 0 : 1;
    const bSelected = selectedFileIds.includes(b.id) ? 0 : 1;
    if (aSelected !== bSelected) return aSelected - bSelected;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });

  // Available file types in current matter (for filter chips)
  const availableTypes = Array.from(new Set(matterFiles.map(f => getFileCategory(f.filename)))) as FileCategory[];

  // Limit visible files for performance (unless searching or expanded)
  const isSearching = fileQuery.length > 0;
  const visibleFiles = (showAllFiles || isSearching) ? sortedFiles : sortedFiles.slice(0, VISIBLE_FILE_LIMIT);
  const hasMore = !isSearching && !showAllFiles && sortedFiles.length > VISIBLE_FILE_LIMIT;

  return (
    <div
      ref={menuRef}
      className={`absolute ${
        anchorDirection === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
      } left-0 w-80 max-h-[70vh] overflow-y-auto bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 z-50 animate-popover-in [animation-duration:280ms]`}
    >
      {/* Hidden unified file input — accepts all supported types */}
      <input
        ref={attachInputRef}
        type="file"
        multiple
        accept=".pdf,.doc,.docx,.xlsx,.xls,.csv,.txt,.md,.msg,.png,.jpg,.jpeg,.gif,.webp,.svg,.bmp,.tiff"
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onAttach(e.target.files);
            e.target.value = '';
            // Close the menu after files are attached
            onClose();
          }
        }}
      />

      {/* ── ATTACH ─────────────────────────────────────────────────────── */}
      <SectionHeader
        title="Attach"
        icon={
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        }
        isExpanded={attachExpanded}
        onToggle={() => setAttachExpanded(!attachExpanded)}
      />
      {attachExpanded && (
        <div className="pb-1">
          {/* Unified attach button */}
          <div className="px-3 pb-2">
            <button
              type="button"
              onClick={() => attachInputRef.current?.click()}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-200 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 border-dashed rounded-lg hover:bg-gray-100 dark:hover:bg-gray-600 hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
            >
              <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
              Attach files or images
              {pendingAttachmentCount > 0 && (
                <span className="ml-1 inline-flex items-center justify-center w-5 h-5 rounded-full bg-blue-500 text-[10px] text-white font-bold">
                  {pendingAttachmentCount}
                </span>
              )}
            </button>
            <p className="mt-1 text-[10px] text-gray-400 dark:text-gray-500 text-center">
              PDF, DOCX, XLSX, CSV, TXT, MSG, images
            </p>
          </div>
        </div>
      )}

      <div className="border-t border-gray-200 dark:border-gray-700" />

      {/* ── SELECT FILES ───────────────────────────────────────────────── */}
      <SectionHeader
        title="Select Files"
        icon={
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
          </svg>
        }
        isExpanded={filesExpanded}
        onToggle={() => setFilesExpanded(!filesExpanded)}
        badge={selectedFileIds.length > 0 ? selectedFileIds.length : false}
      />
      {filesExpanded && (
        <div className="pb-1">
          {/* Header: count + clear */}
          <div className="px-4 py-1.5 flex items-center justify-between">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {activeMatter ? `Files in "${activeMatter.name}"` : 'All files'}
              {matterFiles.length > 0 && (
                <span className="ml-1 text-gray-400 dark:text-gray-500">({matterFiles.length})</span>
              )}
            </span>
            {selectedFileIds.length > 0 && (
              <button
                type="button"
                onClick={onClearFiles}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                Clear {selectedFileIds.length}
              </button>
            )}
          </div>

          {matterFiles.length > 0 ? (
            <>
              {/* Search input — always visible when ≥5 files */}
              {matterFiles.length >= 5 && (
                <div className="px-3 pb-2">
                  <div className="relative">
                    <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <input
                      ref={fileSearchRef}
                      type="text"
                      value={fileQuery}
                      onChange={(e) => { setFileQuery(e.target.value); setShowAllFiles(false); }}
                      placeholder="Search files..."
                      className="w-full pl-8 pr-8 py-1.5 text-sm bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-gray-700 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-400 dark:focus:ring-blue-500"
                    />
                    {fileQuery && (
                      <button
                        type="button"
                        onClick={() => { setFileQuery(''); fileSearchRef.current?.focus(); }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4 flex items-center justify-center rounded-full hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-400"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Type filter chips — show when ≥2 types exist */}
              {availableTypes.length >= 2 && !fileQuery && (
                <div className="px-3 pb-2 flex flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => setActiveTypeFilter(null)}
                    className={`px-2 py-0.5 text-[11px] rounded-full border transition-colors ${
                      !activeTypeFilter
                        ? 'bg-gray-800 dark:bg-white text-white dark:text-gray-900 border-transparent'
                        : 'text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
                    }`}
                  >
                    All
                  </button>
                  {availableTypes.map(cat => {
                    const count = matterFiles.filter(f => getFileCategory(f.filename) === cat).length;
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setActiveTypeFilter(activeTypeFilter === cat ? null : cat)}
                        className={`px-2 py-0.5 text-[11px] rounded-full border transition-colors ${
                          activeTypeFilter === cat
                            ? 'bg-gray-800 dark:bg-white text-white dark:text-gray-900 border-transparent'
                            : 'text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
                        }`}
                      >
                        {FILE_CATEGORIES[cat].label} ({count})
                      </button>
                    );
                  })}
                </div>
              )}

              {/* File list */}
              {visibleFiles.length > 0 ? (
                <div className="px-2 pb-1 space-y-0.5 max-h-48 overflow-y-auto">
                  {visibleFiles.map(file => {
                    const cat = getFileCategory(file.filename);
                    const isSelected = selectedFileIds.includes(file.id);
                    return (
                      <label
                        key={file.id}
                        className={`flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/30'
                            : 'hover:bg-gray-50 dark:hover:bg-gray-700'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => onToggleFile(file.id)}
                          className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
                        />
                        {getFileIcon(cat)}
                        <span className="text-sm text-gray-700 dark:text-gray-200 truncate flex-1 leading-tight">
                          {highlightMatch(file.filename, fileQuery)}
                        </span>
                      </label>
                    );
                  })}
                  {/* "Show all" button */}
                  {hasMore && (
                    <button
                      type="button"
                      onClick={() => setShowAllFiles(true)}
                      className="w-full py-1.5 text-xs text-center text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      Show all {sortedFiles.length} files
                    </button>
                  )}
                </div>
              ) : (
                <div className="px-4 pb-3">
                  <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-2">
                    No files match "{fileQuery}"
                    {activeTypeFilter && ` in ${FILE_CATEGORIES[activeTypeFilter].label}`}
                  </p>
                </div>
              )}
            </>
          ) : (
            <div className="px-4 pb-3">
              <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-2">
                {activeMatter
                  ? 'No files in this matter yet. Upload files in the Vault.'
                  : 'No files uploaded yet. Go to Vault to upload files.'}
              </p>
            </div>
          )}
        </div>
      )}

      <div className="border-t border-gray-200 dark:border-gray-700" />

      {/* ── INTELLIGENCE ───────────────────────────────────────────────── */}
      <SectionHeader
        title="Intelligence"
        icon={
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
          </svg>
        }
        isExpanded={intelligenceExpanded}
        onToggle={() => setIntelligenceExpanded(!intelligenceExpanded)}
        badge={flags.web_search_enabled || flags.jurisdiction ? true : false}
      />
      {intelligenceExpanded && (
        <div className="pb-1">
          <ToggleRow
            label="Web Search"
            description="Search the web for current information"
            enabled={flags.web_search_enabled}
            onToggle={() => updateFlag('web_search_enabled', !flags.web_search_enabled)}
          />

          {/* Jurisdiction Selector */}
          <div className="px-4 py-2">
            <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-1.5">Jurisdiction</div>
            <div className="flex flex-wrap gap-1.5">
              {/* None option */}
              <button
                type="button"
                onClick={() => updateFlag('jurisdiction', null)}
                className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                  !flags.jurisdiction
                    ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-600'
                    : 'text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
              >
                None
              </button>
              {JURISDICTIONS.map(j => (
                <button
                  key={j}
                  type="button"
                  onClick={() => updateFlag('jurisdiction', j)}
                  className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
                    flags.jurisdiction === j
                      ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-600'
                      : 'text-gray-600 dark:text-gray-300 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
                  }`}
                >
                  {j}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="border-t border-gray-200 dark:border-gray-700" />

      {/* ── ADVANCED ────────────────────────────────────────────────────── */}
      <SectionHeader
        title="Advanced"
        icon={
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
          </svg>
        }
        isExpanded={advancedExpanded}
        onToggle={() => setAdvancedExpanded(!advancedExpanded)}
        badge={activeFlagCount > (flags.web_search_enabled ? 1 : 0) + (flags.jurisdiction ? 1 : 0) ? true : false}
      />
      {advancedExpanded && (
        <div className="pb-1">
          <ToggleRow
            label="Deep Analysis"
            description="Extended reasoning with risk weighting"
            enabled={flags.deep_analysis}
            onToggle={() => updateFlag('deep_analysis', !flags.deep_analysis)}
          />
          <ToggleRow
            label="Strict Citations"
            description="Only cite verified sources with attribution"
            enabled={flags.strict_citations}
            onToggle={() => updateFlag('strict_citations', !flags.strict_citations)}
          />
          <ToggleRow
            label="Privilege Review"
            description="Flag attorney-client privilege concerns"
            enabled={flags.privilege_review}
            onToggle={() => updateFlag('privilege_review', !flags.privilege_review)}
          />
          <ToggleRow
            label="Fast Response"
            description="Prioritize speed over depth"
            enabled={flags.fast_mode}
            onToggle={() => updateFlag('fast_mode', !flags.fast_mode)}
          />
        </div>
      )}

      {/* Reset all */}
      {(activeFlagCount > 0 || selectedFileIds.length > 0) && (
        <>
          <div className="border-t border-gray-200 dark:border-gray-700" />
          <button
            type="button"
            onClick={() => {
              onFlagsChange({ ...DEFAULT_LEGAL_ACTION_FLAGS });
              onClearFiles();
            }}
            className="w-full px-4 py-2.5 text-xs text-center text-red-500 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
          >
            Reset all settings
          </button>
        </>
      )}
    </div>
  );
};

export default LegalActionMenu;
