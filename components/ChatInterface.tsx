import React, { useRef, useEffect, useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatMessage, Role, UploadedFile, SourceCitation, HorizonMode, HORIZON_MODES, LegalActionFlags, DEFAULT_LEGAL_ACTION_FLAGS, PendingAttachment, ChatAttachmentType } from '../types';
import { useMatter } from '../contexts/MatterContext';
import { getMatterTypeConfig } from '../constants';
import LegalActionMenu from './LegalActionMenu';

// ============================================================================
// STATE-DRIVEN RESEARCH PANEL
// States: A (Processing) → B (Research) → C (Collapsed)
// Only renders when substantive work (RAG, tools, reasoning) is detected.
// Orchestration states (classification, basic synthesis) are invisible.
// ============================================================================

interface ResearchPanelProps {
  thinking: string;
  isActive: boolean;
  hasContent: boolean;
  hasSubstantiveWork: boolean;
}

const ResearchPanel: React.FC<ResearchPanelProps> = ({ thinking, isActive, hasContent, hasSubstantiveWork }) => {
  const [manualToggle, setManualToggle] = useState<boolean | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const hasSteps = thinking.length > 0;
  const stateA = isActive && !hasSteps && !hasContent && hasSubstantiveWork;
  const stateB = isActive && hasSteps && !hasContent;
  const stateC = hasContent || (!isActive && hasSteps);

  const title = stateA ? 'Processing…' : stateC ? 'Research details' : 'Research';
  const autoExpanded = stateA || stateB;
  const isExpanded = manualToggle !== null ? manualToggle : autoExpanded;

  useEffect(() => {
    if (isExpanded && panelRef.current && isActive) {
      panelRef.current.scrollTop = panelRef.current.scrollHeight;
    }
  }, [thinking, isExpanded, isActive]);

  // --- SUBSTANTIVE PROCESSING GATE ---
  // Only render if there is actual substantive work (RAG, tools, reasoning)
  if (!hasSubstantiveWork) return null;
  if (!isActive && !thinking) return null;

  return (
    <div className="mb-3">
      <button
        onClick={() => setManualToggle(prev => prev === null ? !autoExpanded : !prev)}
        className="flex items-center gap-2 py-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 transition-colors select-none"
      >
        <svg
          className={`w-3 h-3 transition-transform duration-150 ${isExpanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-xs font-medium">{title}</span>
        {isActive && !hasContent && (
          <span className="inline-block w-1.5 h-1.5 bg-gray-400 dark:bg-gray-500 rounded-full animate-pulse" />
        )}
      </button>
      {isExpanded && (
        <div ref={panelRef} className="mt-1 pl-5 text-xs text-gray-500 dark:text-gray-400 space-y-0.5 max-h-40 overflow-y-auto">
          {hasSteps ? (
            thinking.split('\n').map((line, i) => (
              <div key={i} className="leading-relaxed">{line}</div>
            ))
          ) : (
            <div className="text-gray-400 dark:text-gray-500">Preparing…</div>
          )}
        </div>
      )}
    </div>
  );
};

// Database file type (from API)
interface DbFile {
  id: string;
  filename: string;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  case_id?: string;
  folder_id?: string;
  created_at: string;
}

// ============================================================================
// SOURCE CITATIONS PANEL
// Inline citation chips + collapsible source details panel.
// Renders below AI answer when msg.sources is non-empty.
// ============================================================================

interface SourceCitationsPanelProps {
  sources: SourceCitation[];
  messageId: string;
}

const SourceCitationsPanel: React.FC<SourceCitationsPanelProps> = ({ sources, messageId }) => {
  const [expanded, setExpanded] = useState(false);

  if (!sources || sources.length === 0) return null;

  // Deduplicate by filename, keep highest similarity
  const deduped = new Map<string, SourceCitation>();
  for (const s of sources) {
    const existing = deduped.get(s.filename);
    if (!existing || s.similarity > existing.similarity) {
      deduped.set(s.filename, s);
    }
  }
  const uniqueSources = Array.from(deduped.values())
    .filter(s => s.similarity >= 0.35) // Backend quality-gates sources; allow tool-discovered ones through
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 8); // Cap at 8 sources

  // If no sources pass the relevance threshold, don't render anything
  if (uniqueSources.length === 0) return null;

  const truncateFilename = (name: string, max = 28) => {
    if (name.length <= max) return name;
    const ext = name.lastIndexOf('.') > 0 ? name.slice(name.lastIndexOf('.')) : '';
    return name.slice(0, max - ext.length - 3) + '...' + ext;
  };

  const relevanceLabel = (sim: number) => {
    if (sim >= 0.85) return { text: 'High', color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' };
    if (sim >= 0.7) return { text: 'Good', color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' };
    return { text: 'Fair', color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400' };
  };

  return (
    <div className="mt-3">
      {/* Inline citation chips */}
      <div className="flex flex-wrap gap-1.5 mb-1">
        {uniqueSources.slice(0, 4).map((src, idx) => (
          <button
            key={`${messageId}-src-${idx}`}
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium
              bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400
              hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors cursor-pointer
              border border-gray-200 dark:border-gray-700"
            title={src.filename}
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span className="truncate max-w-[140px]">{truncateFilename(src.filename, 22)}</span>
          </button>
        ))}
        {uniqueSources.length > 4 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium
              bg-gray-100 dark:bg-gray-800 text-gray-500 dark:text-gray-400
              hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            +{uniqueSources.length - 4} more
          </button>
        )}
      </div>

      {/* Collapsible full sources panel */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-[11px] text-gray-400 dark:text-gray-500
          hover:text-gray-600 dark:hover:text-gray-400 transition-colors select-none"
      >
        <svg
          className={`w-3 h-3 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
        </svg>
        <span>{uniqueSources.length} source{uniqueSources.length !== 1 ? 's' : ''} referenced</span>
      </button>

      {expanded && (
        <div className="mt-2 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 overflow-hidden">
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {uniqueSources.map((src, idx) => {
              const rel = relevanceLabel(src.similarity);
              return (
                <div key={`${messageId}-detail-${idx}`} className="flex items-center gap-3 px-3 py-2">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                    <span className="text-[10px] font-bold text-gray-500 dark:text-gray-400">{idx + 1}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-gray-700 dark:text-gray-300 truncate" title={src.filename}>
                      {src.filename}
                    </p>
                  </div>
                  <span className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${rel.color}`}>
                    {rel.text} ({Math.round(src.similarity * 100)}%)
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

interface ChatInterfaceProps {
  files: UploadedFile[];
  dbFiles?: DbFile[];
  messages: ChatMessage[];
  isTyping: boolean;
  onSendMessage: (msg: string, selectedFileIds?: string[], flags?: LegalActionFlags) => void;
  onStopGeneration?: () => void;
  onEditMessage?: (messageId: string, newContent: string) => void;
  onRegenerateMessage?: (messageId: string) => void;
  onBackToUpload: () => void;
  onOpenVault: () => void;
  hasFiles: boolean;
  currentSessionId: string | null; // Track which chat session is active for draft isolation
  // Mode selection
  mode?: HorizonMode;
  onModeChange?: (mode: HorizonMode) => void;
  // Auto-detection
  detectedMode?: HorizonMode | null;
  onAcceptDetectedMode?: () => void;
  onDismissDetectedMode?: () => void;
  // Sub-option toggles
  activeSubOptions?: string[];
  onSubOptionToggle?: (optionId: string) => void;
  // New chat counter — increments on every New Chat click to rotate subheading
  newChatCounter?: number;
  // File selector state lifted to parent
  selectedFileIds?: string[];
  onSelectedFileIdsChange?: (ids: string[])=> void;
  showFileSelector?: boolean;
  onShowFileSelectorChange?: (show: boolean) => void;
  // Advanced action flags — lifted to App.tsx for session persistence
  actionFlags?: LegalActionFlags;
  onActionFlagsChange?: (flags: LegalActionFlags) => void;
  // Subscription gating
  allowedModes?: string[];
  creditWarning?: boolean;
  creditPercent?: number;
  // Attachment state — lifted to parent so App.tsx can pass to send handler
  pendingAttachments?: PendingAttachment[];
  onPendingAttachmentsChange?: (attachments: PendingAttachment[]) => void;
}

const ChatInterface: React.FC<ChatInterfaceProps> = ({ 
  files,
  dbFiles = [],
  messages, 
  isTyping, 
  onSendMessage,
  onStopGeneration,
  onEditMessage,
  onRegenerateMessage,
  onBackToUpload,
  onOpenVault,
  hasFiles,
  currentSessionId,
  mode = 'general',
  onModeChange,
  detectedMode,
  onAcceptDetectedMode,
  onDismissDetectedMode,
  activeSubOptions = [],
  onSubOptionToggle,
  newChatCounter = 0,
  actionFlags: actionFlagsProp,
  onActionFlagsChange,
  allowedModes,
  creditWarning,
  creditPercent,
  pendingAttachments: pendingAttachmentsProp,
  onPendingAttachmentsChange,
}) => {
  const { activeMatter, clearActiveMatter } = useMatter();
  const [input, setInput] = useState('');
  // Attachment state: use props from App.tsx if provided, otherwise local
  const [localPendingAttachments, setLocalPendingAttachments] = useState<PendingAttachment[]>([]);
  const pendingAttachments = pendingAttachmentsProp ?? localPendingAttachments;
  // Unified setter: if parent provides onPendingAttachmentsChange, wrap it to support
  // both direct values and updater functions; otherwise use local React setState.
  const setPendingAttachments = useCallback(
    (valOrUpdater: PendingAttachment[] | ((prev: PendingAttachment[]) => PendingAttachment[])) => {
      if (onPendingAttachmentsChange) {
        if (typeof valOrUpdater === 'function') {
          // Need to derive the new value from the current prop
          const next = valOrUpdater(pendingAttachmentsProp ?? []);
          onPendingAttachmentsChange(next);
        } else {
          onPendingAttachmentsChange(valOrUpdater);
        }
      } else {
        setLocalPendingAttachments(valOrUpdater as any);
      }
    },
    [onPendingAttachmentsChange, pendingAttachmentsProp]
  );
  const [isDragOver, setIsDragOver] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [showActionMenu, setShowActionMenu] = useState(false);
  // Action flags: use props from App.tsx if provided, otherwise fall back to local state
  const [localActionFlags, setLocalActionFlags] = useState<LegalActionFlags>({ ...DEFAULT_LEGAL_ACTION_FLAGS });
  const actionFlags = actionFlagsProp ?? localActionFlags;
  const setActionFlags = onActionFlagsChange ?? setLocalActionFlags;
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingContent, setEditingContent] = useState('');
  const [isModesCollapsed, setIsModesCollapsed] = useState(false);

  // Response action state
  const [feedbackState, setFeedbackState] = useState<Record<string, 'like' | 'dislike' | null>>({});
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [tryAgainMenuId, setTryAgainMenuId] = useState<string | null>(null);
  const [isDotMenuClosing, setIsDotMenuClosing] = useState(false);
  const [isTryAgainMenuClosing, setIsTryAgainMenuClosing] = useState(false);
  const [readingAloudMsgId, setReadingAloudMsgId] = useState<string | null>(null);
  const [isMobileViewport, setIsMobileViewport] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 767px)').matches;
  });
  const [tryAgainMenuDirection, setTryAgainMenuDirection] = useState<'down' | 'up'>('down');
  const [dotMenuDirection, setDotMenuDirection] = useState<'down' | 'up'>('down');
  const menuRef = useRef<HTMLDivElement>(null);
  const tryAgainMenuRef = useRef<HTMLDivElement>(null);
  const dotMenuCloseTimerRef = useRef<number | null>(null);
  const tryAgainMenuCloseTimerRef = useRef<number | null>(null);

  // No longer needed — single flex row layout handles all states

  // Draft isolation: Store drafts keyed by session ID to prevent leakage
  const draftsRef = useRef<Record<string, string>>({});
  const previousSessionIdRef = useRef<string | null>(null);

  // Rotating subheading for empty chat state
  const EMPTY_STATE_SUBHEADINGS = [
    'Ask me about the facts, dates, or clauses in your uploaded files.',
    'Need a contract reviewed? Upload it and ask away.',
    'Summarise lengthy documents in seconds — just ask.',
    'Compare clauses across multiple agreements instantly.',
    'Draft a legal memo, letter, or motion — describe what you need.',
    'Identify risks, deadlines, and obligations in any document.',
    'Research case law and statutes with structured analysis.',
    'Extract key parties, dates, and terms from your files.',
  ];
  const subheadingIndexRef = useRef(0);
  const [subheadingText, setSubheadingText] = useState(EMPTY_STATE_SUBHEADINGS[0]);

  // Smart scroll state
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(true);
  const [showScrollIndicator, setShowScrollIndicator] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const actionMenuRefBottom = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const MENU_ANIM_MS = 340;

  const closeDotMenu = useCallback(() => {
    if (!openMenuId || isDotMenuClosing) return;
    setIsDotMenuClosing(true);
    if (dotMenuCloseTimerRef.current) window.clearTimeout(dotMenuCloseTimerRef.current);
    dotMenuCloseTimerRef.current = window.setTimeout(() => {
      setOpenMenuId(null);
      setIsDotMenuClosing(false);
      dotMenuCloseTimerRef.current = null;
    }, MENU_ANIM_MS);
  }, [openMenuId, isDotMenuClosing]);

  const closeTryAgainMenu = useCallback(() => {
    if (!tryAgainMenuId || isTryAgainMenuClosing) return;
    setIsTryAgainMenuClosing(true);
    if (tryAgainMenuCloseTimerRef.current) window.clearTimeout(tryAgainMenuCloseTimerRef.current);
    tryAgainMenuCloseTimerRef.current = window.setTimeout(() => {
      setTryAgainMenuId(null);
      setIsTryAgainMenuClosing(false);
      tryAgainMenuCloseTimerRef.current = null;
    }, MENU_ANIM_MS);
  }, [tryAgainMenuId, isTryAgainMenuClosing]);

  useEffect(() => {
    return () => {
      if (dotMenuCloseTimerRef.current) window.clearTimeout(dotMenuCloseTimerRef.current);
      if (tryAgainMenuCloseTimerRef.current) window.clearTimeout(tryAgainMenuCloseTimerRef.current);
    };
  }, []);

  // Track mobile breakpoint changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(max-width: 767px)');
    const handleChange = (event: MediaQueryListEvent) => setIsMobileViewport(event.matches);
    setIsMobileViewport(media.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  // --- AUTO-GROW TEXTAREA ---
  const MAX_TEXTAREA_HEIGHT = 200; // ~8 lines at 24px line-height

  const recalcTextareaHeight = useCallback((textarea: HTMLTextAreaElement, _value?: string, skipAnimation = false) => {
    // Reset height to auto so scrollHeight measures natural content size
    textarea.style.height = 'auto';
    const scrollH = textarea.scrollHeight;
    const targetHeight = Math.min(scrollH, MAX_TEXTAREA_HEIGHT);

    textarea.style.height = `${targetHeight}px`;
    textarea.style.overflowY = scrollH > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, []);

  // --- DRAFT ISOLATION (keyed by session ID) ---
  // Restore draft and recalculate height when active session changes
  useEffect(() => {
    if (currentSessionId !== previousSessionIdRef.current) {
      // Load draft for the incoming session (empty for new chat)
      const savedDraft = currentSessionId ? (draftsRef.current[currentSessionId] || '') : '';
      setInput(savedDraft);

      // Recalculate textarea height (RAF ensures DOM is ready)
      requestAnimationFrame(() => {
        if (inputRef.current) {
          recalcTextareaHeight(inputRef.current, undefined, true);
        }
      });

      previousSessionIdRef.current = currentSessionId;
    }
  }, [currentSessionId, recalcTextareaHeight]);

  // Rotate the empty-state subheading on every New Chat click
  useEffect(() => {
    if (newChatCounter > 0) {
      subheadingIndexRef.current = (subheadingIndexRef.current + 1) % EMPTY_STATE_SUBHEADINGS.length;
      setSubheadingText(EMPTY_STATE_SUBHEADINGS[subheadingIndexRef.current]);
    }
  }, [newChatCounter]);

  // Only show ready files for selection
  const readyFiles = dbFiles.filter(f => f.status === 'ready');

  // --- SMART SCROLL ---
  const isNearBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    messagesEndRef.current?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto' });
    setAutoScrollEnabled(true);
    setShowScrollIndicator(false);
    userScrolledRef.current = false;
  }, []);

  // Track user scroll position
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const handleScroll = () => {
      if (isNearBottom()) {
        setAutoScrollEnabled(true);
        setShowScrollIndicator(false);
        userScrolledRef.current = false;
      } else if (isTyping) {
        userScrolledRef.current = true;
        setAutoScrollEnabled(false);
        setShowScrollIndicator(true);
      }
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, [isNearBottom, isTyping]);

  // Auto-scroll on content change only if enabled
  useEffect(() => {
    if (autoScrollEnabled && !userScrolledRef.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
    }
  }, [messages, autoScrollEnabled]);

  // Reset indicator when streaming stops
  useEffect(() => {
    if (!isTyping && isNearBottom()) {
      setShowScrollIndicator(false);
      setAutoScrollEnabled(true);
      userScrolledRef.current = false;
    }
  }, [isTyping, isNearBottom]);

  // Focus input after generation
  useEffect(() => {
    if (!isTyping) {
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isTyping, messages]);

  // Close 3-dot menu when clicking outside
  useEffect(() => {
    if (!openMenuId) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        closeDotMenu();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [openMenuId, closeDotMenu]);

  // Close try-again menu when clicking outside
  useEffect(() => {
    if (!tryAgainMenuId) return;
    const handleClick = (e: MouseEvent) => {
      if (tryAgainMenuRef.current && !tryAgainMenuRef.current.contains(e.target as Node)) {
        closeTryAgainMenu();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [tryAgainMenuId, closeTryAgainMenu]);

  // Prevent background page scrolling while mobile action menus are open
  useEffect(() => {
    if (!(isMobileViewport && (openMenuId || tryAgainMenuId))) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isMobileViewport, openMenuId, tryAgainMenuId]);

  // Smart dropdown direction: measure available space and flip if needed
  // Accounts for the pinned input area at the bottom (~120px) so menus don't hide behind it
  const calcMenuDirection = useCallback((containerRef: React.RefObject<HTMLDivElement | null>, estimatedMenuHeight: number): 'down' | 'up' => {
    if (!containerRef.current) return 'down';
    const rect = containerRef.current.getBoundingClientRect();
    // The input bar + footer occupy ~120px at the bottom of the viewport
    const INPUT_AREA_HEIGHT = 120;
    const MARGIN = 24; // extra breathing room
    const usableSpaceBelow = window.innerHeight - rect.bottom - INPUT_AREA_HEIGHT - MARGIN;
    const usableSpaceAbove = rect.top - MARGIN;
    // Only flip up when there truly isn't enough room below AND there IS enough room above
    if (usableSpaceBelow < estimatedMenuHeight && usableSpaceAbove > estimatedMenuHeight) {
      return 'up';
    }
    return 'down';
  }, []);

  // Recalculate direction when try-again menu opens
  useEffect(() => {
    if (tryAgainMenuId && !isTryAgainMenuClosing) {
      // Use requestAnimationFrame so the ref is attached
      requestAnimationFrame(() => {
        setTryAgainMenuDirection(calcMenuDirection(tryAgainMenuRef, 320));
      });
    }
  }, [tryAgainMenuId, isTryAgainMenuClosing, calcMenuDirection]);

  // Recalculate direction when 3-dot menu opens
  useEffect(() => {
    if (openMenuId && !isDotMenuClosing) {
      requestAnimationFrame(() => {
        setDotMenuDirection(calcMenuDirection(menuRef, 180));
      });
    }
  }, [openMenuId, isDotMenuClosing, calcMenuDirection]);

  // --- Response action handlers ---
  const handleCopyResponse = useCallback((msgId: string, content: string) => {
    navigator.clipboard.writeText(content.replace(/<\/?(?:thinking|final)>/g, ''));
    setCopiedMessageId(msgId);
    setTimeout(() => setCopiedMessageId(null), 2000);
  }, []);

  const handleFeedback = useCallback((msgId: string, type: 'like' | 'dislike') => {
    setFeedbackState(prev => ({
      ...prev,
      [msgId]: prev[msgId] === type ? null : type
    }));
  }, []);

  const handleShare = useCallback((content: string) => {
    if (navigator.share) {
      navigator.share({ text: content.replace(/<\/?(?:thinking|final)>/g, '') }).catch(() => {});
    } else {
      navigator.clipboard.writeText(content.replace(/<\/?(?:thinking|final)>/g, ''));
    }
  }, []);

  // Read aloud with toggle and state
  const handleReadAloud = useCallback((msgId: string, content: string) => {
    if (!('speechSynthesis' in window)) return;
    // If already reading this message, stop
    if (readingAloudMsgId === msgId) {
      window.speechSynthesis.cancel();
      setReadingAloudMsgId(null);
      return;
    }
    // If reading something else, stop first
    window.speechSynthesis.cancel();
    const utterance = new window.SpeechSynthesisUtterance(content.replace(/<\/?(?:thinking|final)>/g, '').replace(/[#*`_~]/g, ''));
    utterance.onend = () => setReadingAloudMsgId(null);
    utterance.onerror = () => setReadingAloudMsgId(null);
    setReadingAloudMsgId(msgId);
    window.speechSynthesis.speak(utterance);
  }, [readingAloudMsgId]);

  // Action menu close is handled inside LegalActionMenu via click-outside + Escape

  // Auto-dismiss detection banner after 8 seconds
  useEffect(() => {
    if (!detectedMode) return;
    const timer = setTimeout(() => {
      onDismissDetectedMode?.();
    }, 8000);
    return () => clearTimeout(timer);
  }, [detectedMode, onDismissDetectedMode]);

  const toggleFileSelection = (fileId: string) => {
    setSelectedFileIds(prev => 
      prev.includes(fileId)
        ? prev.filter(id => id !== fileId)
        : [...prev, fileId]
    );
  };

  // ── Attachment helpers ──────────────────────────────────────────────────────
  const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.tiff']);

  const classifyAttachmentType = (filename: string): ChatAttachmentType => {
    const ext = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
    return IMAGE_EXTENSIONS.has(ext) ? 'image' : 'file';
  };

  const handleAttach = useCallback((fileList: FileList) => {
    const newAttachments: PendingAttachment[] = Array.from(fileList).map(file => {
      const type = classifyAttachmentType(file.name);
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return {
        id,
        file,
        filename: file.name,
        mime_type: file.type || 'application/octet-stream',
        size: file.size,
        type,
        preview_url: type === 'image' ? URL.createObjectURL(file) : undefined,
        status: 'pending' as const,
      };
    });
    setPendingAttachments(prev => [...prev, ...newAttachments]);
  }, [setPendingAttachments]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments(prev => {
      const att = prev.find(a => a.id === id);
      if (att?.preview_url) URL.revokeObjectURL(att.preview_url);
      return prev.filter(a => a.id !== id);
    });
  }, [setPendingAttachments]);

  // ── Drag & drop ─────────────────────────────────────────────────────────────
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleAttach(e.dataTransfer.files);
    }
  }, [handleAttach]);

  const hasAttachments = pendingAttachments.length > 0;
  const canSend = (input.trim() || hasAttachments) && !isTyping;
  // Allow typing while streaming — only block sending

  const handleSendMessageInternal = () => {
    if (canSend) {
      // Reset scroll state on new message
      setAutoScrollEnabled(true);
      setShowScrollIndicator(false);
      userScrolledRef.current = false;
      onSendMessage(input, selectedFileIds.length > 0 ? selectedFileIds : undefined, actionFlags);
      // Reset file selection, attachments, and menu after send (flags persist across messages)
      // NOTE: Don't revoke blob URLs — they're preserved on sent messages for image preview
      setPendingAttachments([]);
      setSelectedFileIds([]);
      setShowActionMenu(false);
      // Clear draft for this session
      if (currentSessionId) {
        delete draftsRef.current[currentSessionId];
      }
      setInput('');
      // Reset textarea height after send
      requestAnimationFrame(() => {
        if (inputRef.current) {
          recalcTextareaHeight(inputRef.current, undefined, true);
        }
      });
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    handleSendMessageInternal();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key !== 'Enter') return;

    const isMobileViewport = typeof window !== 'undefined' && window.matchMedia('(max-width: 767px)').matches;
    if (isMobileViewport) {
      return;
    }

    if (!e.shiftKey) {
      e.preventDefault();
      handleSendMessageInternal();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    // Save draft inline (always correct session ID, always fresh value)
    if (currentSessionId) {
      draftsRef.current[currentSessionId] = value;
    }
    // Auto-grow: measure after React state update flushes
    requestAnimationFrame(() => {
      if (inputRef.current) {
        recalcTextareaHeight(inputRef.current);
      }
    });
  };

  // Recalculate height after paste (DOM content may not be reflected in onChange immediately)
  const handlePaste = useCallback(() => {
    // Double-RAF ensures both React re-render and browser paste have fully settled
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (inputRef.current) {
          recalcTextareaHeight(inputRef.current);
        }
      });
    });
  }, [recalcTextareaHeight]);

  // Mode tab bar renderer — always-visible horizontal tabs above input
  const currentModeConfig = HORIZON_MODES[mode];
  const modeKeys = Object.keys(HORIZON_MODES) as HorizonMode[];
  const modeTabContainerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

  // Get mode-specific placeholder text
  const getPlaceholderText = (currentMode: HorizonMode): string => {
    const placeholders: Record<HorizonMode, string> = {
      general: 'Ask Horizon anything...',
      legal_research: 'Ask about case law, statutes, or legal precedents...',
      contract_review: 'Ask about specific clauses or contract terms...',
      multi_document: 'Compare documents or ask about cross-references...',
      summary: 'Ask for a summary or extract key information...',
      drafting: 'Describe what you\'d like to draft...'
    };
    return placeholders[currentMode];
  };

  // Update sliding indicator position when mode changes
  useEffect(() => {
    if (!modeTabContainerRef.current) return;
    const container = modeTabContainerRef.current;
    const activeBtn = container.querySelector('[data-mode-active="true"]') as HTMLElement | null;
    if (activeBtn) {
      setIndicatorStyle({ left: activeBtn.offsetLeft, width: activeBtn.offsetWidth });
    }
  }, [mode]);

  const renderModeTabBar = () => (
    <div className="w-full mb-2 transition-all duration-300">
      {/* Credit Warning Banner */}
      {creditWarning && typeof creditPercent === 'number' && (
        <div className="mb-2 px-3 py-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg flex items-center gap-2">
          <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <span className="text-xs text-amber-700 dark:text-amber-300">
            {creditPercent >= 100
              ? 'Credit limit reached. Upgrade your plan to continue.'
              : `${Math.round(creditPercent)}% of monthly credits used.`}
          </span>
        </div>
      )}
      {/* Modes Label with active mode + Collapse toggle — entire area is clickable */}
      <button
        type="button"
        onClick={() => setIsModesCollapsed(!isModesCollapsed)}
        className="flex items-center gap-1.5 mb-1.5 px-0.5 group cursor-pointer"
      >
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400 group-hover:text-gray-700 dark:group-hover:text-gray-300 transition-colors">Modes</p>
        {mode !== 'general' && (
          <span className="text-xs font-medium text-indigo-600 dark:text-indigo-400">· {currentModeConfig.shortLabel}</span>
        )}
        <svg className={`w-3 h-3 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-300 transition-all duration-200 ${!isModesCollapsed ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
        </svg>
      </button>
      
      {/* Tab bar - collapsible */}
      <div className={`overflow-hidden transition-all duration-300 ease-in-out ${
        isModesCollapsed ? 'max-h-0 opacity-0' : 'max-h-96 opacity-100'
      }`}>
      <div className="relative flex gap-1 overflow-x-auto scrollbar-hide pb-1" ref={modeTabContainerRef}>
        {/* Sliding background pill */}
        <div
          className="absolute top-0 h-full bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-700 rounded-lg shadow-sm transition-all duration-300 ease-in-out z-0"
          style={{ left: indicatorStyle.left, width: indicatorStyle.width, opacity: indicatorStyle.width ? 1 : 0 }}
        />
        {modeKeys.map((modeKey) => {
          const cfg = HORIZON_MODES[modeKey];
          const isActive = mode === modeKey;
          const isLocked = allowedModes && allowedModes.length > 0 && !allowedModes.includes(modeKey);
          return (
            <button
              key={modeKey}
              type="button"
              data-mode-active={isActive ? 'true' : 'false'}
              onClick={() => !isLocked && onModeChange?.(modeKey)}
              disabled={isLocked}
              className={`relative z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors duration-200 ${
                isLocked
                  ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                  : isActive
                  ? 'text-indigo-700 dark:text-indigo-300'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 hover:text-gray-700 dark:hover:text-gray-300'
              }`}
              title={isLocked ? `${cfg.shortLabel} — upgrade your plan to unlock` : cfg.description}
            >
              <span className="text-sm">{cfg.icon}</span>
              <span className="hidden sm:inline">{cfg.shortLabel}</span>
              <span className="sm:hidden">{cfg.shortLabel}</span>
              {isLocked && <span className="text-[10px] ml-0.5">🔒</span>}
            </button>
          );
        })}
      </div>

      {/* Sub-option toggles — shown for non-Auto modes */}
      <div className={`overflow-hidden transition-all duration-300 ease-in-out ${
        mode !== 'general' && currentModeConfig.subOptions && currentModeConfig.subOptions.length > 0
          ? 'max-h-24 opacity-100 mt-1.5'
          : 'max-h-0 opacity-0 mt-0'
      }`}>
        {mode !== 'general' && currentModeConfig.subOptions && currentModeConfig.subOptions.length > 0 && (
        <div className="flex gap-1.5 flex-wrap">
          {currentModeConfig.subOptions.map((option, idx) => {
            const isActive = activeSubOptions.includes(option.id);
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onSubOptionToggle?.(option.id)}
                className={`text-[10px] px-2 py-0.5 rounded-full border transition-all cursor-pointer select-none animate-scale-in ${
                  isActive
                    ? 'bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 border-indigo-200 dark:border-indigo-700'
                    : 'bg-gray-50 dark:bg-gray-800/50 text-gray-400 dark:text-gray-500 border-gray-200 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 hover:text-gray-600 dark:hover:text-gray-300'
                }`}
                style={{ animationDelay: `${idx * 40}ms` }}
                title={option.effect}
              >
                {option.label}
              </button>
            );
          })}
        </div>
        )}
      </div>

      {/* Detection banner — shown when Auto Detect suggests a specialized mode */}
      {detectedMode && mode === 'general' && (
        <div className="mt-1.5 flex items-center gap-2 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-lg px-3 py-1.5 text-xs animate-slide-down">
          <span className="text-indigo-600 dark:text-indigo-400">✨</span>
          <span className="text-indigo-700 dark:text-indigo-300 flex-1">
            Detected: <strong>{HORIZON_MODES[detectedMode].label}</strong> — optimized for this query
          </span>
          <button
            type="button"
            onClick={onAcceptDetectedMode}
            className="px-2 py-0.5 rounded bg-indigo-600 text-white text-[11px] font-medium hover:bg-indigo-700 transition-colors"
          >
            Switch
          </button>
          <button
            type="button"
            onClick={onDismissDetectedMode}
            className="px-2 py-0.5 rounded bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-[11px] font-medium hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
          >
            Stay
          </button>
        </div>
      )}
      </div>
    </div>
  );

  return (
    <div
      className={`flex flex-col h-full bg-white dark:bg-gray-900 relative ${isDragOver ? 'ring-2 ring-blue-400 ring-inset' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-blue-50/80 dark:bg-blue-900/30 pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-blue-600 dark:text-blue-400">
            <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
            <span className="text-sm font-medium">Drop files to attach</span>
          </div>
        </div>
      )}
      {/* Scroll to latest indicator */}
      <button
        onClick={() => scrollToBottom(true)}
        className={`absolute bottom-24 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 px-3 py-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full shadow-md text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all duration-300 ${
          showScrollIndicator ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'
        }`}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
        </svg>
        Scroll to latest
      </button>

      {/* Active Matter Context Banner */}
      {activeMatter && (
        <div className="flex items-center gap-2 px-4 py-2 bg-blue-50 dark:bg-blue-900/20 border-b border-blue-100 dark:border-blue-800">
          <svg className="w-4 h-4 text-blue-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span className="text-sm text-blue-700 dark:text-blue-300 flex-1 min-w-0">
            Chatting in: <span className="font-medium">{activeMatter.name}</span>
          </span>
          {activeMatter.matter_type && (() => {
            const tc = getMatterTypeConfig(activeMatter.matter_type);
            return (
              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${tc.color} ${tc.textColor}`}>
                {tc.label}
              </span>
            );
          })()}
          <button
            onClick={clearActiveMatter}
            className="flex-shrink-0 text-xs text-blue-500 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-200 transition-colors"
            title="Remove matter from this chat"
          >
            Clear
          </button>
        </div>
      )}

      {/* Messages Area */}
      <div className="flex-1 overflow-y-auto" ref={scrollContainerRef}>
        {messages.length === 0 ? (
          /* Empty State */
          <div className="flex flex-col items-center h-full px-4 pt-[20vh]">
            <h1 className="text-2xl font-medium text-gray-800 dark:text-white mb-2">
              Horizon Legal Associate
            </h1>
            <p className="text-gray-500 dark:text-gray-400 text-center mb-8 max-w-md">
              {subheadingText}
            </p>
            
            <div className="w-full max-w-2xl transition-all duration-300">
              {renderModeTabBar()}
              <form onSubmit={handleSubmit} className="focus:outline-none focus-visible:outline-none">
                <div className="flex items-end gap-2 bg-white dark:bg-gray-800 rounded-2xl border border-gray-300 dark:border-gray-600 shadow-sm pl-3 pr-2 py-2 transition-all duration-200 ease-in-out focus-within:border-gray-400 dark:focus-within:border-gray-500">
                  {/* + Legal Action Menu */}
                  <div className="relative flex-shrink-0 mb-0.5" ref={actionMenuRef}>
                    <button
                      type="button"
                      onClick={() => setShowActionMenu(!showActionMenu)}
                      className={`relative flex items-center justify-center w-8 h-8 rounded-full border transition-colors ${
                        selectedFileIds.length > 0 || actionFlags.web_search_enabled || actionFlags.jurisdiction || actionFlags.deep_analysis || actionFlags.strict_citations || actionFlags.privilege_review || actionFlags.fast_mode
                          ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-600'
                          : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600'
                      }`}
                      title="Legal actions & files"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      {(selectedFileIds.length > 0 || actionFlags.web_search_enabled || actionFlags.deep_analysis || actionFlags.strict_citations || actionFlags.privilege_review || actionFlags.fast_mode || actionFlags.jurisdiction) && (
                        <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-blue-500 rounded-full border-2 border-white dark:border-gray-800" />
                      )}
                    </button>
                    <LegalActionMenu
                      isOpen={showActionMenu}
                      onClose={() => setShowActionMenu(false)}
                      activeMatter={activeMatter}
                      readyFiles={readyFiles}
                      selectedFileIds={selectedFileIds}
                      onToggleFile={toggleFileSelection}
                      onClearFiles={() => setSelectedFileIds([])}
                      flags={actionFlags}
                      onFlagsChange={setActionFlags}
                      onAttach={handleAttach}
                      pendingAttachmentCount={pendingAttachments.length}
                      mode={mode}
                      anchorDirection="up"
                    />
                  </div>

                  {/* Input column: attachment previews + textarea */}
                  <div className="flex-1 min-w-0 flex flex-col">
                    {/* Attachment previews — images as thumbnails, files as chips */}
                    {hasAttachments && (
                      <div className="flex flex-wrap gap-2 pb-2">
                        {pendingAttachments.map(att => (
                          att.type === 'image' && att.preview_url ? (
                            /* Image thumbnail — ChatGPT style */
                            <div key={att.id} className="relative group/att w-14 h-14 flex-shrink-0">
                              <img
                                src={att.preview_url}
                                alt={att.filename}
                                className="w-14 h-14 rounded-lg object-cover border border-gray-200 dark:border-gray-600"
                              />
                              <button
                                type="button"
                                onClick={() => removeAttachment(att.id)}
                                className="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-800 opacity-0 group-hover/att:opacity-100 transition-opacity shadow-sm"
                                title="Remove"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </div>
                          ) : (
                            /* File chip */
                            <span
                              key={att.id}
                              className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-600"
                            >
                              <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                              <span className="truncate max-w-[120px]">{att.filename}</span>
                              <button
                                type="button"
                                onClick={() => removeAttachment(att.id)}
                                className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded-full hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                                title="Remove"
                              >
                                <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            </span>
                          )
                        ))}
                      </div>
                    )}
                    <textarea
                      ref={inputRef}
                      className="w-full min-w-0 bg-transparent text-gray-900 dark:text-white placeholder-gray-400 resize-none focus:outline-none focus-visible:outline-none text-base leading-6 py-1"
                      placeholder={hasAttachments ? 'Add a message or just send...' : getPlaceholderText(mode)}
                      value={input}
                      onChange={handleInput}
                      onKeyDown={handleKeyDown}
                      onPaste={handlePaste}
                      rows={1}
                      style={{ outline: 'none', boxShadow: 'none' }}
                    />
                  </div>

                  {/* Send / Stop */}
                  <div className="flex-shrink-0 mb-0.5">
                    {isTyping ? (
                      <button
                        type="button"
                        onClick={onStopGeneration}
                        className="w-8 h-8 flex items-center justify-center bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-full hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                        title="Stop generating"
                      >
                        <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                          <rect x="6" y="6" width="12" height="12" rx="1" />
                        </svg>
                      </button>
                    ) : (
                      <button
                        type="submit"
                        disabled={!canSend}
                        className="w-8 h-8 flex items-center justify-center bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-full disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-80 transition-opacity"
                        title="Send"
                      >
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                        </svg>
                      </button>
                    )}
                  </div>
                </div>
              </form>
              <p className="text-center text-xs text-gray-400 mt-3">Horizon can make mistakes. Verify important information.</p>
            </div>
          </div>
        ) : (
          /* Conversation */
          <div className="max-w-3xl mx-auto px-4 py-8 space-y-10">
            {messages.map((msg) => (
              <div key={msg.id} className={`relative ${tryAgainMenuId === msg.id || openMenuId === msg.id ? 'z-30' : 'z-0'}`}>
                {/* ---- USER ---- */}
                {msg.role === Role.USER && (
                  <div className="flex justify-end group relative animate-message-in">
                    <div className="max-w-[80%] relative">
                      {editingMessageId === msg.id ? (
                        <div className="space-y-2">
                          <textarea
                            value={editingContent}
                            onChange={(e) => setEditingContent(e.target.value)}
                            className="w-full p-3 border border-gray-300 dark:border-gray-600 rounded-2xl bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                            rows={3}
                            autoFocus
                          />
                          <div className="flex gap-2 justify-end">
                            <button
                              onClick={() => setEditingMessageId(null)}
                              className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                            >
                              Cancel
                            </button>
                            <button
                              onClick={() => {
                                if (onEditMessage && editingContent.trim()) {
                                  onEditMessage(msg.id, editingContent.trim());
                                  setEditingMessageId(null);
                                }
                              }}
                              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
                            >
                              Save & Resend
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          {/* Image attachments — rendered above text bubble like ChatGPT */}
                          {msg.attachments && msg.attachments.filter(a => a.type === 'image').length > 0 && (
                            <div className="flex flex-wrap gap-2 mb-2 justify-end">
                              {msg.attachments.filter(a => a.type === 'image').map(att => (
                                <img
                                  key={att.id}
                                  src={att.thumbnail_url || ''}
                                  alt={att.filename}
                                  className="max-w-[280px] max-h-[280px] rounded-2xl object-cover border border-gray-200 dark:border-gray-700"
                                />
                              ))}
                            </div>
                          )}
                          <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl px-4 py-3 text-gray-900 dark:text-gray-100">
                            <div className="prose prose-sm max-w-none dark:prose-invert break-words [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                              <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                            </div>
                            {/* File attachments (non-image) — chips inside bubble */}
                            {msg.attachments && msg.attachments.filter(a => a.type === 'file').length > 0 && (
                              <div className="flex flex-wrap gap-1.5 mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                                {msg.attachments.filter(a => a.type === 'file').map(att => (
                                  <span
                                    key={att.id}
                                    className="inline-flex items-center gap-1.5 pl-2 pr-2.5 py-1 rounded-full text-[11px] font-medium bg-white dark:bg-gray-700 text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-gray-600"
                                  >
                                    <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                                    <span className="truncate max-w-[160px]">{att.filename}</span>
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <button
                            onClick={() => {
                              setEditingMessageId(msg.id);
                              setEditingContent(msg.content);
                            }}
                            className="absolute -left-10 top-2 opacity-0 group-hover:opacity-100 p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-all"
                            data-tooltip="Edit message"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                            </svg>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* ---- ASSISTANT ---- */}
                {msg.role === Role.MODEL && (
                  <div className="text-gray-900 dark:text-gray-100 animate-message-in">
                    {/* Research panel — only renders for substantive work (RAG, tools, reasoning) */}
                    {(msg.isThinking || msg.thinking) && (
                      <ResearchPanel
                        thinking={msg.thinking || ''}
                        isActive={msg.isThinking || false}
                        hasContent={!!msg.content}
                        hasSubstantiveWork={msg.hasSubstantiveWork || false}
                      />
                    )}

                    {/* Standalone state indicator — large, prominent (e.g. "Creating file...") */}
                    {msg.isThinking && !msg.content && msg.stateLabel && (
                      <div className="flex items-center gap-3 py-3">
                        <span className="text-base text-gray-700 dark:text-gray-200 font-medium">{msg.stateLabel}</span>
                        <span className="inline-block w-2 h-2 bg-gray-500 dark:bg-gray-400 rounded-full animate-[pulse-dot_1.2s_ease-in-out_infinite]" />
                      </div>
                    )}

                    {/* Typing indicator — single pulsing dot while waiting for first token */}
                    {msg.isThinking && !msg.content && !msg.stateLabel && (
                      <div className="flex items-center py-2 h-8">
                        <span className="inline-block w-3 h-3 bg-gray-800 dark:bg-gray-200 rounded-full animate-[pulse-dot_1.2s_ease-in-out_infinite]" />
                      </div>
                    )}

                    {/* Answer — streams directly, no container */}
                    {msg.content && (
                      <div className="prose prose-base max-w-none dark:prose-invert prose-gray leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:mt-6 [&_h2]:mb-2 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:mt-4 [&_h3]:mb-1.5 [&_h4]:text-sm [&_h4]:font-semibold [&_h4]:mt-3 [&_h4]:mb-1 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0.5 [&_p]:my-2 [&_table]:text-sm [&_th]:bg-gray-100 [&_th]:dark:bg-gray-800 [&_td]:px-3 [&_td]:py-1.5 [&_th]:px-3 [&_th]:py-2 [&_hr]:my-4">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content.replace(/<\/?(?:thinking|final)>/g, '')}</ReactMarkdown>
                        {/* Inline pulsing dot — visible only on currently-streaming message */}
                        {isTyping && msg === messages.filter(m => m.role === Role.MODEL).slice(-1)[0] && (
                          <span className="inline-block w-2.5 h-2.5 bg-gray-800 dark:bg-gray-200 rounded-full ml-1 align-middle animate-[pulse-dot_1.2s_ease-in-out_infinite]" />
                        )}
                      </div>
                    )}

                    {/* ── Source Citations ── */}
                    {msg.sources && msg.sources.length > 0 && !msg.isThinking && msg.hasSubstantiveWork && (
                      <SourceCitationsPanel sources={msg.sources} messageId={msg.id} />
                    )}

                    {/* Error states */}
                    {msg.isError && (
                      msg.isRateLimit ? (
                        <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 rounded-lg text-sm">
                          <p className="text-amber-700 dark:text-amber-400 font-medium">Credit limit reached</p>
                          <p className="text-amber-600 dark:text-amber-300 text-xs mt-1">You've used all your monthly credits. Upgrade your plan or wait for your credits to reset.</p>
                        </div>
                      ) : (
                        <p className="text-red-500 dark:text-red-400 text-sm mt-4 italic">An error occurred while generating this response.</p>
                      )
                    )}

                    {/* Response action icons — only show when not streaming */}
                    {msg.content && !msg.isThinking && (
                      <div className="flex items-center gap-1 mt-3 -ml-1">
                        {/* Copy */}
                        <button
                          onClick={() => handleCopyResponse(msg.id, msg.content)}
                          className="w-7 h-7 flex items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                          data-tooltip={copiedMessageId === msg.id ? 'Copied' : 'Copy'}
                        >
                          {copiedMessageId === msg.id ? (
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                          )}
                        </button>

                        {/* Good response */}
                        <button
                          onClick={() => handleFeedback(msg.id, 'like')}
                          className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
                            feedbackState[msg.id] === 'like'
                              ? 'text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800'
                              : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                          }`}
                          data-tooltip="Good"
                        >
                          <svg className="w-3.5 h-3.5" fill={feedbackState[msg.id] === 'like' ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 9V5a3 3 0 00-3-3l-4 9v11h11.28a2 2 0 002-1.7l1.38-9a2 2 0 00-2-2.3H14zm-9 11H3a1 1 0 01-1-1v-7a1 1 0 011-1h2" />
                          </svg>
                        </button>

                        {/* Bad response */}
                        <button
                          onClick={() => handleFeedback(msg.id, 'dislike')}
                          className={`w-7 h-7 flex items-center justify-center rounded-md transition-colors ${
                            feedbackState[msg.id] === 'dislike'
                              ? 'text-gray-700 dark:text-gray-200 bg-gray-100 dark:bg-gray-800'
                              : 'text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
                          }`}
                          data-tooltip="Bad"
                        >
                          <svg className="w-3.5 h-3.5" fill={feedbackState[msg.id] === 'dislike' ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 15v4a3 3 0 003 3l4-9V2H5.72a2 2 0 00-2 1.7l-1.38 9a2 2 0 002 2.3H10zm9-13h2a1 1 0 011 1v7a1 1 0 01-1 1h-2" />
                          </svg>
                        </button>

                        {/* Share */}
                        <button
                          onClick={() => handleShare(msg.content)}
                          className="w-7 h-7 flex items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                          data-tooltip="Share"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                          </svg>
                        </button>

                        {/* Try again — dropdown trigger */}
                        <div className="relative" ref={tryAgainMenuId === msg.id ? tryAgainMenuRef : undefined}>
                          <button
                            onClick={() => {
                              if (tryAgainMenuId === msg.id && !isTryAgainMenuClosing) {
                                closeTryAgainMenu();
                              } else {
                                if (tryAgainMenuCloseTimerRef.current) window.clearTimeout(tryAgainMenuCloseTimerRef.current);
                                setTryAgainMenuId(msg.id);
                                setIsTryAgainMenuClosing(false);
                              }
                            }}
                            className="w-7 h-7 flex items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                            data-tooltip="Try again"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                            </svg>
                          </button>

                          {tryAgainMenuId === msg.id && (
                            <div className={`bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700 z-50 overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                              isTryAgainMenuClosing
                                ? `opacity-0 scale-95 pointer-events-none ${tryAgainMenuDirection === 'up' ? 'translate-y-2' : '-translate-y-2'}`
                                : 'opacity-100 scale-100 translate-y-0 animate-popover-in [animation-duration:340ms]'
                            } ${
                              isMobileViewport
                                ? `fixed right-4 w-64 max-w-[calc(100vw-2rem)] max-h-[60dvh] overflow-y-auto ${tryAgainMenuDirection === 'up' ? 'bottom-24' : 'top-20'}`
                                : `absolute left-0 w-64 ${tryAgainMenuDirection === 'up' ? 'bottom-full mb-3' : 'top-full mt-3'}`
                            }`}>
                              {/* Ask to change response — input field */}
                              <div className="p-2 border-b border-gray-100 dark:border-gray-700">
                                <form onSubmit={(e) => {
                                  e.preventDefault();
                                  const input = (e.target as HTMLFormElement).elements.namedItem('changeInput') as HTMLInputElement;
                                  if (input?.value.trim()) {
                                    closeTryAgainMenu();
                                    const msgIdx = messages.findIndex(m => m.id === msg.id);
                                    let userContent = '';
                                    for (let i = msgIdx - 1; i >= 0; i--) {
                                      if (messages[i].role === Role.USER) { userContent = messages[i].content; break; }
                                    }
                                    onRegenerateMessage?.(msg.id);
                                    setTimeout(() => {
                                      onSendMessage(userContent ? `${userContent}\n\n[Instruction: ${input.value.trim()}]` : input.value.trim());
                                    }, 200);
                                  }
                                }} className="flex items-center gap-2">
                                  <input
                                    name="changeInput"
                                    type="text"
                                    placeholder="Ask to change response"
                                    className="flex-1 text-sm bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg px-3 py-2 text-gray-700 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:focus:ring-gray-500"
                                  />
                                  <button type="submit" className="w-7 h-7 flex items-center justify-center rounded-full bg-gray-200 dark:bg-gray-600 text-gray-500 dark:text-gray-300 hover:bg-gray-300 dark:hover:bg-gray-500 transition-colors">
                                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                                    </svg>
                                  </button>
                                </form>
                              </div>

                              <div className="py-1">
                                {/* Try again */}
                                <button
                                  onClick={() => { closeTryAgainMenu(); onRegenerateMessage?.(msg.id); }}
                                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                                >
                                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                                  </svg>
                                  Try again
                                </button>

                                {/* Add details */}
                                <button
                                  onClick={() => {
                                    closeTryAgainMenu();
                                    const msgIdx = messages.findIndex(m => m.id === msg.id);
                                    let userContent = '';
                                    for (let i = msgIdx - 1; i >= 0; i--) {
                                      if (messages[i].role === Role.USER) { userContent = messages[i].content; break; }
                                    }
                                    if (userContent) {
                                      onRegenerateMessage?.(msg.id);
                                      setTimeout(() => onSendMessage(`${userContent}\n\n[Instruction: Add more details and elaborate further]`), 200);
                                    }
                                  }}
                                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                                >
                                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <line x1="12" y1="3" x2="12" y2="9" strokeLinecap="round" strokeWidth={2} />
                                    <polyline points="9 6 12 3 15 6" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                                    <line x1="12" y1="15" x2="12" y2="21" strokeLinecap="round" strokeWidth={2} />
                                    <polyline points="15 18 12 21 9 18" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                                    <line x1="4" y1="12" x2="9" y2="12" strokeLinecap="round" strokeWidth={2} />
                                    <line x1="15" y1="12" x2="20" y2="12" strokeLinecap="round" strokeWidth={2} />
                                  </svg>
                                  Add details
                                </button>

                                {/* More concise */}
                                <button
                                  onClick={() => {
                                    closeTryAgainMenu();
                                    const msgIdx = messages.findIndex(m => m.id === msg.id);
                                    let userContent = '';
                                    for (let i = msgIdx - 1; i >= 0; i--) {
                                      if (messages[i].role === Role.USER) { userContent = messages[i].content; break; }
                                    }
                                    if (userContent) {
                                      onRegenerateMessage?.(msg.id);
                                      setTimeout(() => onSendMessage(`${userContent}\n\n[Instruction: Be more concise and brief]`), 200);
                                    }
                                  }}
                                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                                >
                                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <line x1="4" y1="6" x2="20" y2="6" strokeLinecap="round" strokeWidth={2} />
                                    <circle cx="10" cy="6" r="2" strokeWidth={2} />
                                    <line x1="4" y1="12" x2="20" y2="12" strokeLinecap="round" strokeWidth={2} />
                                    <circle cx="16" cy="12" r="2" strokeWidth={2} />
                                    <line x1="4" y1="18" x2="20" y2="18" strokeLinecap="round" strokeWidth={2} />
                                    <circle cx="8" cy="18" r="2" strokeWidth={2} />
                                  </svg>
                                  More concise
                                </button>
                              </div>

                              <div className="border-t border-gray-100 dark:border-gray-700 py-1">
                                {/* Search the web (placeholder) */}
                                <button
                                  onClick={() => { closeTryAgainMenu(); }}
                                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-400 dark:text-gray-500 cursor-not-allowed"
                                  disabled
                                >
                                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" />
                                  </svg>
                                  Search the web
                                </button>

                                {/* Think longer */}
                                <button
                                  onClick={() => {
                                    closeTryAgainMenu();
                                    const msgIdx = messages.findIndex(m => m.id === msg.id);
                                    let userContent = '';
                                    for (let i = msgIdx - 1; i >= 0; i--) {
                                      if (messages[i].role === Role.USER) { userContent = messages[i].content; break; }
                                    }
                                    if (userContent) {
                                      onRegenerateMessage?.(msg.id);
                                      setTimeout(() => onSendMessage(`${userContent}\n\n[Instruction: Think step by step very carefully. Take your time to reason through this thoroughly before answering]`), 200);
                                    }
                                  }}
                                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                                >
                                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                                  </svg>
                                  Think longer
                                </button>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* More actions (3-dot) */}
                        <div className="relative" ref={openMenuId === msg.id ? menuRef : undefined}>
                          <button
                            onClick={() => {
                              if (openMenuId === msg.id && !isDotMenuClosing) {
                                closeDotMenu();
                              } else {
                                if (dotMenuCloseTimerRef.current) window.clearTimeout(dotMenuCloseTimerRef.current);
                                setOpenMenuId(msg.id);
                                setIsDotMenuClosing(false);
                              }
                            }}
                            className="w-7 h-7 flex items-center justify-center rounded-md text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
                            data-tooltip="More"
                          >
                            <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                              <circle cx="5" cy="12" r="2" />
                              <circle cx="12" cy="12" r="2" />
                              <circle cx="19" cy="12" r="2" />
                            </svg>
                          </button>

                          {openMenuId === msg.id && (
                            <div className={`bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700 z-50 overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
                              isDotMenuClosing
                                ? `opacity-0 scale-95 pointer-events-none ${dotMenuDirection === 'up' ? 'translate-y-2' : '-translate-y-2'}`
                                : 'opacity-100 scale-100 translate-y-0 animate-popover-in [animation-duration:340ms]'
                            } ${
                              isMobileViewport
                                ? `fixed right-4 w-56 max-w-[calc(100vw-2rem)] ${dotMenuDirection === 'up' ? 'bottom-24' : 'top-20'}`
                                : `absolute right-0 w-56 ${dotMenuDirection === 'up' ? 'bottom-full mb-3' : 'top-full mt-3'}`
                            }`}>
                              <div className="py-1">
                                <div className="px-4 py-2 text-xs text-gray-400 dark:text-gray-500">
                                  {new Date(msg.timestamp).toLocaleString(undefined, {
                                    weekday: 'short',
                                    month: 'short',
                                    day: 'numeric',
                                    hour: 'numeric',
                                    minute: '2-digit',
                                    hour12: true
                                  })}
                                </div>

                                <button
                                  onClick={() => {
                                    closeDotMenu();
                                    const msgIndex = messages.findIndex(m => m.id === msg.id);
                                    if (msgIndex >= 0) {
                                      const context = messages.slice(Math.max(0, msgIndex - 1), msgIndex + 1)
                                        .map(m => `${m.role === Role.USER ? 'User' : 'Assistant'}: ${m.content}`)
                                        .join('\n\n');
                                      navigator.clipboard.writeText(context);
                                    }
                                  }}
                                  className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                                >
                                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 17l-4-4m0 0l4-4m-4 4h14m-4 4l4-4m0 0l-4-4" />
                                  </svg>
                                  Branch in new chat
                                </button>

                                <button
                                  onClick={() => { handleReadAloud(msg.id, msg.content); }}
                                  className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors
                                    ${readingAloudMsgId === msg.id
                                      ? 'text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900'
                                      : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'}
                                  `}
                                >
                                  {readingAloudMsgId === msg.id ? (
                                    <>
                                      <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <rect x="6" y="6" width="12" height="12" rx="2" strokeWidth={2} />
                                      </svg>
                                      Stop reading
                                    </>
                                  ) : (
                                    <>
                                      <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z" />
                                      </svg>
                                      Read aloud
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input Area — pinned bottom */}
      {messages.length > 0 && (
        <div className="p-4 bg-white dark:bg-gray-900 flex-shrink-0 transition-all duration-300">
          <div className="max-w-3xl mx-auto">
            {renderModeTabBar()}
          </div>
          <form onSubmit={handleSubmit} className="max-w-3xl mx-auto focus:outline-none focus-visible:outline-none">
            <div className="flex items-end gap-2 bg-white dark:bg-gray-800 rounded-2xl border border-gray-300 dark:border-gray-600 shadow-sm pl-3 pr-2 py-2 transition-all duration-200 ease-in-out focus-within:border-gray-400 dark:focus-within:border-gray-500">
              {/* + Legal Action Menu */}
              <div className="relative flex-shrink-0 mb-0.5" ref={actionMenuRefBottom}>
                <button
                  type="button"
                  onClick={() => setShowActionMenu(!showActionMenu)}
                  className={`relative flex items-center justify-center w-8 h-8 rounded-full border transition-colors ${
                    selectedFileIds.length > 0 || actionFlags.web_search_enabled || actionFlags.jurisdiction || actionFlags.deep_analysis || actionFlags.strict_citations || actionFlags.privilege_review || actionFlags.fast_mode
                      ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 border-blue-300 dark:border-blue-600'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }`}
                  title="Legal actions & files"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  {(selectedFileIds.length > 0 || actionFlags.web_search_enabled || actionFlags.deep_analysis || actionFlags.strict_citations || actionFlags.privilege_review || actionFlags.fast_mode || actionFlags.jurisdiction) && (
                    <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-blue-500 rounded-full border-2 border-white dark:border-gray-800" />
                  )}
                </button>
                <LegalActionMenu
                  isOpen={showActionMenu}
                  onClose={() => setShowActionMenu(false)}
                  activeMatter={activeMatter}
                  readyFiles={readyFiles}
                  selectedFileIds={selectedFileIds}
                  onToggleFile={toggleFileSelection}
                  onClearFiles={() => setSelectedFileIds([])}
                  flags={actionFlags}
                  onFlagsChange={setActionFlags}
                  onAttach={handleAttach}
                  pendingAttachmentCount={pendingAttachments.length}
                  mode={mode}
                  anchorDirection="up"
                />
              </div>

              {/* Input column: attachment previews + textarea */}
              <div className="flex-1 min-w-0 flex flex-col">
                {/* Attachment previews — images as thumbnails, files as chips */}
                {hasAttachments && (
                  <div className="flex flex-wrap gap-2 pb-2">
                    {pendingAttachments.map(att => (
                      att.type === 'image' && att.preview_url ? (
                        /* Image thumbnail — ChatGPT style */
                        <div key={att.id} className="relative group/att w-14 h-14 flex-shrink-0">
                          <img
                            src={att.preview_url}
                            alt={att.filename}
                            className="w-14 h-14 rounded-lg object-cover border border-gray-200 dark:border-gray-600"
                          />
                          <button
                            type="button"
                            onClick={() => removeAttachment(att.id)}
                            className="absolute -top-1.5 -right-1.5 w-5 h-5 flex items-center justify-center rounded-full bg-gray-800 dark:bg-gray-200 text-white dark:text-gray-800 opacity-0 group-hover/att:opacity-100 transition-opacity shadow-sm"
                            title="Remove"
                          >
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </div>
                      ) : (
                        /* File chip */
                        <span
                          key={att.id}
                          className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full text-[11px] font-medium bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-600"
                        >
                          <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                          <span className="truncate max-w-[120px]">{att.filename}</span>
                          <button
                            type="button"
                            onClick={() => removeAttachment(att.id)}
                            className="flex-shrink-0 w-4 h-4 flex items-center justify-center rounded-full hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                            title="Remove"
                          >
                            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" /></svg>
                          </button>
                        </span>
                      )
                    ))}
                  </div>
                )}
                <textarea
                  ref={inputRef}
                  className="w-full min-w-0 bg-transparent text-gray-900 dark:text-white placeholder-gray-400 resize-none focus:outline-none focus-visible:outline-none text-base leading-6 py-1"
                  placeholder={hasAttachments ? 'Add a message or just send...' : getPlaceholderText(mode)}
                  value={input}
                  onChange={handleInput}
                  onKeyDown={handleKeyDown}
                  onPaste={handlePaste}
                  rows={1}
                  style={{ outline: 'none', boxShadow: 'none' }}
                />
              </div>

              {/* Send / Stop */}
              <div className="flex-shrink-0 mb-0.5">
                {isTyping ? (
                  <button
                    type="button"
                    onClick={onStopGeneration}
                    className="w-8 h-8 flex items-center justify-center bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-full hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
                    title="Stop generating"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <rect x="6" y="6" width="12" height="12" rx="1" />
                    </svg>
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={!canSend}
                    className="w-8 h-8 flex items-center justify-center bg-gray-900 dark:bg-white text-white dark:text-gray-900 rounded-full disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-80 transition-opacity"
                    title="Send"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          </form>
          <p className="text-center text-xs text-gray-400 mt-3">Horizon can make mistakes. Verify important information.</p>
        </div>
      )}
    </div>
  );
};

export default ChatInterface;