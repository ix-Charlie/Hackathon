import React, { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { flushSync } from 'react-dom';
import Sidebar from './components/Sidebar';
import FileUploader from './components/FileUploader';
import ChatInterface from './components/ChatInterface';
import MatterSwitcher from './components/MatterSwitcher';

// Lazy-loaded components (non-critical paths)
const Vault = React.lazy(() => import('./components/Vault'));
const Settings = React.lazy(() => import('./components/Settings'));
const AuthPage = React.lazy(() => import('./components/AuthPage'));
const LandingPage = React.lazy(() => import('./components/LandingPage'));
const MatterBrief = React.lazy(() => import('./components/MatterBrief'));

import { DataProvider, useData } from './contexts/DataContext';
import { MatterProvider, useMatter } from './contexts/MatterContext';
import { AppView, UploadedFile, ChatMessage, Role, ChatSession, HorizonMode, HORIZON_MODES, getAllDefaultSubOptions, LegalActionFlags, DEFAULT_LEGAL_ACTION_FLAGS, BillingStatus, FeatureFlags, PendingAttachment } from './types';
import { processFile, generateId } from './services/fileUtils';
import { sendMessageToHorizonStream, sendMessageWithAttachments, SourceCitation } from './services/openaiService';
import { getUser, signOut } from './services/authService';
import { supabase } from './services/supabaseClient';
import * as fileService from './services/fileService';
import * as chatService from './services/chatService';
import { getBillingStatus, getFeatures } from './services/billingService';
import { exportChat } from './services/exportService';

// Lazy-loaded billing component
const PricingOverlay = React.lazy(() => import('./components/PricingOverlay'));

// Minimal loading skeleton for lazy-loaded views
const ViewSkeleton: React.FC = () => (
  <div className="flex items-center justify-center h-full bg-white dark:bg-gray-900">
    <div className="w-8 h-8 border-3 border-steel-blue dark:border-indigo-bright border-t-transparent rounded-full animate-spin"></div>
  </div>
);

// Type for database files (minimal info needed for chat)
interface DbFile {
  id: string;
  filename: string;
  status: 'uploaded' | 'processing' | 'ready' | 'failed';
  case_id?: string;
  folder_id?: string;
  created_at: string;
}

const CHAT_SESSION_STORAGE_KEY = 'horizon_active_chat_snapshot_v1';
const CHAT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

interface SessionChatSnapshot {
  userId: string;
  sessionId: string;
  messages: ChatMessage[];
  savedAt: number;
}

const clearChatSnapshot = () => {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(CHAT_SESSION_STORAGE_KEY);
};

const isValidSnapshotMessage = (value: any): value is ChatMessage => {
  return Boolean(
    value &&
    typeof value.id === 'string' &&
    (value.role === Role.USER || value.role === Role.MODEL) &&
    typeof value.content === 'string' &&
    typeof value.timestamp === 'number'
  );
};

const readChatSnapshot = (userId: string): SessionChatSnapshot | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(CHAT_SESSION_STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as SessionChatSnapshot;
    if (!parsed || parsed.userId !== userId || typeof parsed.savedAt !== 'number') {
      clearChatSnapshot();
      return null;
    }

    if (Date.now() - parsed.savedAt > CHAT_SESSION_TTL_MS) {
      clearChatSnapshot();
      return null;
    }

    if (!parsed.sessionId || !Array.isArray(parsed.messages)) {
      clearChatSnapshot();
      return null;
    }

    const messages = parsed.messages.filter(isValidSnapshotMessage);
    return {
      userId: parsed.userId,
      sessionId: parsed.sessionId,
      messages,
      savedAt: parsed.savedAt,
    };
  } catch {
    clearChatSnapshot();
    return null;
  }
};

const writeChatSnapshot = (snapshot: SessionChatSnapshot) => {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(CHAT_SESSION_STORAGE_KEY, JSON.stringify(snapshot));
};

// Inner App component that uses the DataContext
const AppContent: React.FC = () => {
  const [user, setUser] = useState<any>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  
  // Subscription state
  const [billingStatus, setBillingStatus] = useState<BillingStatus | null>(null);
  const [featureFlags, setFeatureFlags] = useState<FeatureFlags | null>(null);
  const [isLoadingSubscription, setIsLoadingSubscription] = useState(false);
  const [showPricingOverlay, setShowPricingOverlay] = useState(false);
  
  // State to track whether to show Landing Page or Auth Page when not logged in
  // authMode: null = Landing, 'login' = Auth (Login), 'book-call' = Book a Call
  const [authMode, setAuthMode] = useState<'login' | 'book-call' | null>(null);

  // App State
  const [currentView, setCurrentView] = useState<AppView>(() => {
    const saved = localStorage.getItem('horizon_current_view');
    return saved ? (saved as AppView) : AppView.CHAT;
  });
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [isProcessingFiles, setIsProcessingFiles] = useState(false);
  const [processingStatus, setProcessingStatus] = useState<string>("");
  // Per-chat streaming state: tracks which sessions are currently streaming
  const [streamingSessionIds, setStreamingSessionIds] = useState<Set<string>>(new Set());
  // Per-chat abort controllers: allows stopping generation per session independently
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  // Per-chat request IDs: guards against race conditions from stale streams
  const activeRequestIdsRef = useRef<Map<string, string>>(new Map());
  const isRetryingRef = useRef(false);
  
  // Chat attachment state — pending files/images staged by user before send
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  
  // Ref to hold the actual session ID (for temp session resolution)
  const currentSessionIdRef = useRef<string | null>(null);

  // Helper to update both state and ref
  const updateCurrentSessionId = useCallback((id: string | null) => {
    setCurrentSessionId(id);
    currentSessionIdRef.current = id;
    // Persist to localStorage
    if (id) {
      localStorage.setItem('horizon_current_session_id', id);
    } else {
      localStorage.removeItem('horizon_current_session_id');
    }
  }, []);

  // Get files from global data context (used for dbFiles in chat)
  const { files: globalFiles, cases } = useData();
  const { activeMatter, setActiveMatter, clearActiveMatter } = useMatter();

  // Per-chat matter sync: tracks what case_id the current session expects
  // so we can distinguish session-switch syncs from user-initiated matter changes
  const sessionMatterRef = useRef<string | null>(null);
  
  // Convert global files to DbFile format for chat
  const dbFiles: DbFile[] = globalFiles.map(f => ({
    id: f.id,
    filename: f.name,
    status: f.status || 'uploaded',
    case_id: f.case_id,
    folder_id: f.folder_id,
    created_at: f.created_at || new Date().toISOString()
  }));

  // Sidebar State
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => {
    return typeof window !== 'undefined' ? window.innerWidth >= 768 : true;
  });
  
  // Session State — loaded from DB, local state is a cache
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(() => {
    const saved = localStorage.getItem('horizon_current_session_id');
    return saved || null;
  });
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [loadedSessionIds, setLoadedSessionIds] = useState<Set<string>>(new Set());
  
  // Settings State
  type ThemePreference = 'system' | 'light' | 'dark';
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem('horizon_theme') as ThemePreference | null;
    if (saved && ['system', 'light', 'dark'].includes(saved)) return saved;
    // Migrate from old key
    const old = localStorage.getItem('horizon_dark_mode');
    if (old !== null) {
      const migrated: ThemePreference = old === 'true' ? 'dark' : 'light';
      localStorage.setItem('horizon_theme', migrated);
      localStorage.removeItem('horizon_dark_mode');
      return migrated;
    }
    return 'system';
  });

  const [systemDark, setSystemDark] = useState(() =>
    window.matchMedia('(prefers-color-scheme: dark)').matches
  );
  
  const [temperature, setTemperature] = useState(() => {
    const saved = localStorage.getItem('horizon_temperature');
    return saved ? parseFloat(saved) : 0.3;
  });

  const [mode, setMode] = useState<HorizonMode>(() => {
    const saved = localStorage.getItem('horizon_mode');
    return (saved as HorizonMode) || 'general';
  });

  // Auto-detected mode from classifier (shown as banner suggestion)
  const [detectedMode, setDetectedMode] = useState<HorizonMode | null>(null);

  // Per-mode sub-option selections (toggleable workflow modifiers)
  const [activeSubOptions, setActiveSubOptions] = useState<Record<HorizonMode, string[]>>(() => {
    const saved = localStorage.getItem('horizon_sub_options');
    if (saved) {
      try { return JSON.parse(saved); } catch { /* fall through */ }
    }
    return getAllDefaultSubOptions();
  });

  // Advanced action flags — persist across messages within the browser session
  const [actionFlags, setActionFlagsRaw] = useState<LegalActionFlags>(() => {
    const saved = sessionStorage.getItem('horizon_action_flags');
    if (saved) {
      try { return { ...DEFAULT_LEGAL_ACTION_FLAGS, ...JSON.parse(saved) }; } catch { /* fall through */ }
    }
    return { ...DEFAULT_LEGAL_ACTION_FLAGS };
  });
  const setActionFlags = useCallback((flags: LegalActionFlags) => {
    setActionFlagsRaw(flags);
    sessionStorage.setItem('horizon_action_flags', JSON.stringify(flags));
  }, []);
  
  const [language, setLanguage] = useState(() => {
    const saved = localStorage.getItem('horizon_language');
    return saved || 'en';
  });

  // Listen for system theme changes
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Compute effective dark mode
  const darkMode = themePreference === 'dark' || (themePreference === 'system' && systemDark);

  // Apply dark mode to document
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  // Computed: Current Messages
  const currentMessages = sessions.find(s => s.id === currentSessionId)?.messages || [];

  // Persist active chat in sessionStorage for tab-session continuity.
  // Expired snapshots are ignored on next app load.
  useEffect(() => {
    if (!user?.id) {
      clearChatSnapshot();
      return;
    }

    if (!currentSessionId) {
      clearChatSnapshot();
      return;
    }

    const activeSession = sessions.find(s => s.id === currentSessionId);
    if (!activeSession) return;

    writeChatSnapshot({
      userId: user.id,
      sessionId: currentSessionId,
      messages: activeSession.messages,
      savedAt: Date.now(),
    });
  }, [user?.id, currentSessionId, sessions]);

  // --- Effects ---

  // Auth Initialization
  useEffect(() => {
    const checkUser = async () => {
      try {
        const currentUser = await getUser();
        setUser(currentUser);
      } catch (e) {
        console.error("Auth check failed", e);
      } finally {
        setIsLoadingAuth(false);
      }
    };
    
    checkUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (!session) {
        // When logged out, reset view to Landing Page
        setAuthMode(null); 
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // Persist current view to localStorage
  useEffect(() => {
    localStorage.setItem('horizon_current_view', currentView);
  }, [currentView]);

  // Load sessions from DB when user logs in
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const loadSessions = async () => {
      setIsLoadingSessions(true);
      try {
        const dbSessions = await chatService.fetchSessions();
        if (cancelled) return;

        const snapshot = readChatSnapshot(user.id);
        const savedSessionId = localStorage.getItem('horizon_current_session_id');

        if (dbSessions.length > 0) {
          const snapshotSessionExists = Boolean(
            snapshot?.sessionId && dbSessions.some(s => s.id === snapshot.sessionId)
          );
          const savedSessionExists = Boolean(
            savedSessionId && dbSessions.some(s => s.id === savedSessionId)
          );

          const hydratedSessions = snapshotSessionExists && snapshot
            ? dbSessions.map(s => s.id === snapshot.sessionId ? { ...s, messages: snapshot.messages } : s)
            : dbSessions;

          setSessions(hydratedSessions);

          // Priority: saved session > snapshot session > null
          if (savedSessionExists && savedSessionId) {
            updateCurrentSessionId(savedSessionId);
            // Sync matter from restored session
            const restoredSession = hydratedSessions.find(s => s.id === savedSessionId);
            sessionMatterRef.current = restoredSession?.case_id || null;
            if (snapshotSessionExists && snapshot && savedSessionId === snapshot.sessionId) {
              setLoadedSessionIds(new Set([savedSessionId]));
            } else {
              // Saved session is different from snapshot - need to load its messages
              setLoadedSessionIds(new Set());
              // Auto-load messages for the restored session
              const msgs = await chatService.fetchMessages(savedSessionId);
              setSessions(prev => prev.map(s => s.id === savedSessionId ? { ...s, messages: msgs } : s));
              setLoadedSessionIds(new Set([savedSessionId]));
            }
          } else if (snapshotSessionExists && snapshot) {
            updateCurrentSessionId(snapshot.sessionId);
            // Sync matter from snapshot session
            const snapshotSession = hydratedSessions.find(s => s.id === snapshot.sessionId);
            sessionMatterRef.current = snapshotSession?.case_id || null;
            setLoadedSessionIds(new Set([snapshot.sessionId]));
          } else {
            // No valid session: open fresh chat composer
            updateCurrentSessionId(null);
            setLoadedSessionIds(new Set());
          }
        } else {
          // No existing sessions: keep empty list and wait for first user message
          setSessions([]);
          updateCurrentSessionId(null);
          setLoadedSessionIds(new Set());
        }
        // Don't override currentView here - respect persisted view from localStorage
      } catch (e) {
        console.error('Failed to load sessions:', e);
      } finally {
        if (!cancelled) setIsLoadingSessions(false);
      }
    };

    loadSessions();
    return () => { cancelled = true; };
  }, [user?.id]);

  // Files are now loaded via DataContext - no need for separate loading logic here

  // --- PER-CHAT MATTER SYNC ---
  // When the user changes the active matter (via MatterSwitcher or any UI),
  // propagate that change to the current session's case_id.
  // Session-switch syncs set sessionMatterRef first, so the guard skips them.
  useEffect(() => {
    if (!currentSessionId || currentSessionId.startsWith('temp-')) return;
    const newCaseId = activeMatter?.id || null;
    if (newCaseId === sessionMatterRef.current) return; // Already in sync (from session switch)

    sessionMatterRef.current = newCaseId;
    setSessions(prev => prev.map(s =>
      s.id === currentSessionId ? { ...s, case_id: newCaseId || undefined } : s
    ));
    chatService.updateSession(currentSessionId, { case_id: newCaseId });
  }, [activeMatter?.id, currentSessionId]);

  // Load subscription status when user logs in
  useEffect(() => {
    if (!user) {
      setBillingStatus(null);
      setFeatureFlags(null);
      setShowPricingOverlay(false);
      return;
    }
    let cancelled = false;

    const loadBilling = async () => {
      setIsLoadingSubscription(true);
      try {
        const [status, features] = await Promise.all([
          getBillingStatus(),
          getFeatures(),
        ]);
        if (cancelled) return;
        setBillingStatus(status);
        setFeatureFlags(features);

        // Only show pricing overlay if billing is actually configured and
        // the user genuinely has no active subscription.
        // Don't block if billing APIs are unreachable or billing isn't set up yet.
        const billingConfigured = (status as any)?.billingEnabled !== false;
        const statusKnown = status?.status && !['unavailable', 'none'].includes(status.status);
        if (billingConfigured && status?.hasSubscription === false && !statusKnown) {
          // Billing configured but no subscription — show overlay only if we got
          // a definitive "no subscription" (not a fallback/error response)
          // For now, don't auto-block — let users access via Settings > Choose a Plan
        } else if (billingConfigured && status?.hasSubscription && !['active', 'trialing'].includes(status.status)) {
          // Has subscription but it's suspended/past_due/canceled
          setShowPricingOverlay(true);
        } else {
          setShowPricingOverlay(false);
        }
      } catch {
        // Silent — backend may not be running yet; server enforces billing
      } finally {
        if (!cancelled) setIsLoadingSubscription(false);
      }
    };

    // Handle checkout success redirect
    const params = new URLSearchParams(window.location.search);
    if (params.get('checkout') === 'success') {
      // Clear the URL param
      window.history.replaceState({}, '', window.location.pathname);
      // Refresh billing after a short delay to let webhook process
      setTimeout(loadBilling, 2000);
    } else {
      loadBilling();
    }

    return () => { cancelled = true; };
  }, [user?.id]);

  // Refresh billing status periodically (every 5 minutes)
  useEffect(() => {
    if (!user) return;
    const interval = setInterval(async () => {
      try {
        const status = await getBillingStatus();
        setBillingStatus(status);
        // Only dismiss overlay if subscription is genuinely active
        if (status?.hasSubscription && ['active', 'trialing'].includes(status.status)) {
          setShowPricingOverlay(false);
        }
      } catch { /* silent */ }
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [user?.id]);

  // --- Handlers ---

  const handleLogout = async () => {
    try {
      await signOut();
      setUser(null);
      setAuthMode(null);
      
      // Clear local state — DB data stays intact for next login
      setSessions([]);
      updateCurrentSessionId(null);
      setFiles([]);
      setLoadedSessionIds(new Set());
      clearChatSnapshot();
      
      localStorage.removeItem('horizon_current_view');
      localStorage.removeItem('horizon_current_session_id');
    } catch (e) {
      console.error("Logout failed", e);
    }
  };

  const toggleSidebar = () => setIsSidebarOpen(prev => !prev);

  const handleFilesSelected = async (selectedFiles: File[], caseId?: string, folderId?: string) => {
    setIsProcessingFiles(true);
    setProcessingStatus("Reading files...");
    
    try {
      // Process files locally (read content)
      const processed = await Promise.all(selectedFiles.map(processFile));
      
      // Attach case_id, folder_id, and tenant_id to each file
      const filesWithMetadata = processed.map(file => ({
        ...file,
        case_id: caseId,
        folder_id: folderId,
        tenant_id: activeMatter?.tenant_id || '' // Use active matter's tenant or empty
      }));
      
      setFiles(prev => [...prev, ...filesWithMetadata]);
      
      // Navigation Logic - stay in vault if already there
      if (currentView !== AppView.VAULT) {
        if (sessions.length === 0) {
          handleNewChat();
        } else if (!currentSessionId) {
          const mostRecent = sessions[0].id;
          updateCurrentSessionId(mostRecent);
          setCurrentView(AppView.CHAT);
        } else {
          setCurrentView(AppView.CHAT);
        }
      }
      // If in vault, stay in vault - no view change
      
      // Files will auto-refresh via DataContext polling for processing status
    } catch (error) {
      console.error("File processing failed", error);
      alert("Failed to process some files.");
    } finally {
      setIsProcessingFiles(false);
      setProcessingStatus("");
    }
  };

  const handleRemoveFile = (id: string) => {
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const [newChatCounter, setNewChatCounter] = useState(0);

  const handleNewChat = () => {
    console.log('[handleNewChat] Resetting UI for new chat (session will be created on first message)...');
    
    // UI-only reset - no DB operation until first message is sent
    updateCurrentSessionId(null);
    // Track current matter for the new chat (prevents stale sync on first message)
    sessionMatterRef.current = activeMatter?.id || null;
    clearChatSnapshot();
    setCurrentView(AppView.CHAT);
    setMode('general');
    localStorage.setItem('horizon_mode', 'general');
    setDetectedMode(null);
    setNewChatCounter(c => c + 1);
    if (window.innerWidth < 768) setIsSidebarOpen(false);
  };

  const handleSelectSession = async (id: string) => {
    console.log(`[handleSelectSession] Selecting session ${id}, loaded: ${loadedSessionIds.has(id)}`);
    
    // FIX: Load messages BEFORE switching to prevent race condition
    if (!loadedSessionIds.has(id)) {
      console.log(`[handleSelectSession] Loading messages for session ${id}...`);
      const msgs = await chatService.fetchMessages(id);
      console.log(`[handleSelectSession] Loaded ${msgs.length} messages, setting to state`);
      setSessions(prev => prev.map(s => s.id === id ? { ...s, messages: msgs } : s));
      setLoadedSessionIds(prev => new Set(prev).add(id));
    } else {
      console.log(`[handleSelectSession] Session ${id} already loaded, using cached messages`);
    }

    // Sync matter context to this session's case_id (before switching ID to prevent effect mismatch)
    const session = sessions.find(s => s.id === id);
    const sessionCaseId = session?.case_id || null;
    sessionMatterRef.current = sessionCaseId; // Guard: prevent sync effect from writing back
    if (sessionCaseId) {
      const matter = cases.find(c => c.id === sessionCaseId);
      setActiveMatter(matter || null);
    } else {
      clearActiveMatter();
    }

    // Now switch to the session (messages are already loaded)
    updateCurrentSessionId(id);
    setCurrentView(AppView.CHAT);
    if (window.innerWidth < 768) setIsSidebarOpen(false);
  };

  const handleDeleteSession = async (id: string) => {
    // OPTIMISTIC UI: Remove immediately, rollback on failure
    const deletedSession = sessions.find(s => s.id === id);
    if (!deletedSession) return;

    // Determine next session to switch to if deleting current
    let nextSessionId: string | null = null;
    if (currentSessionId === id) {
      const remaining = sessions.filter(s => s.id !== id);
      nextSessionId = remaining.length > 0 ? remaining[0].id : null;
    }

    // Immediately update UI
    setSessions(prev => prev.filter(s => s.id !== id));
    if (currentSessionId === id) {
      if (nextSessionId) {
        updateCurrentSessionId(nextSessionId);
        setCurrentView(AppView.CHAT);
      } else {
        // Create new session optimistically
        handleNewChat();
      }
    }

    // Background: Delete from DB
    const success = await chatService.deleteSession(id);
    if (!success) {
      console.error('[handleDeleteSession] Failed to delete from DB, rolling back');
      // Rollback: restore deleted session
      setSessions(prev => {
        const restored = [...prev, deletedSession].sort((a, b) => {
          if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
          return b.timestamp - a.timestamp;
        });
        return restored;
      });
      if (currentSessionId === id) {
        updateCurrentSessionId(id);
      }
      alert('Failed to delete chat. Please try again.');
    }
  };

  const handleRenameSession = async (id: string, newTitle: string) => {
    // OPTIMISTIC UI: Update immediately, rollback on failure
    const oldTitle = sessions.find(s => s.id === id)?.title;
    if (!oldTitle) return;

    // Immediately update UI
    setSessions(prev => prev.map(s => 
      s.id === id ? { ...s, title: newTitle } : s
    ));

    // Background: Update in DB
    const success = await chatService.updateSession(id, { title: newTitle });
    if (!success) {
      console.error('[handleRenameSession] Failed to update DB, rolling back');
      // Rollback: restore old title
      setSessions(prev => prev.map(s => 
        s.id === id ? { ...s, title: oldTitle } : s
      ));
      alert('Failed to rename chat. Please try again.');
    }
  };

  const handlePinSession = async (id: string) => {
    // OPTIMISTIC UI: Update immediately, rollback on failure
    const session = sessions.find(s => s.id === id);
    if (!session) return;
    const newPinned = !session.pinned;

    // Immediately update UI and re-sort
    setSessions(prev => {
      const updated = prev.map(s => 
        s.id === id ? { ...s, pinned: newPinned } : s
      );
      // Re-sort: pinned first, then by timestamp
      return updated.sort((a, b) => {
        if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
        return b.timestamp - a.timestamp;
      });
    });

    // Background: Update in DB
    const success = await chatService.updateSession(id, { is_pinned: newPinned });
    if (!success) {
      console.error('[handlePinSession] Failed to update DB, rolling back');
      // Rollback: restore old pinned state and re-sort
      setSessions(prev => {
        const restored = prev.map(s => 
          s.id === id ? { ...s, pinned: !newPinned } : s
        );
        return restored.sort((a, b) => {
          if (a.pinned !== b.pinned) return b.pinned ? 1 : -1;
          return b.timestamp - a.timestamp;
        });
      });
      alert('Failed to pin/unpin chat. Please try again.');
    }
  };

  const handleThemeChange = (pref: 'system' | 'light' | 'dark') => {
    setThemePreference(pref);
    localStorage.setItem('horizon_theme', pref);
  };

  const toggleDarkMode = () => {
    const cycle: Record<string, 'system' | 'light' | 'dark'> = { system: 'light', light: 'dark', dark: 'system' };
    handleThemeChange(cycle[themePreference]);
  };

  const handleTemperatureChange = (value: number) => {
    setTemperature(value);
    localStorage.setItem('horizon_temperature', String(value));
  };

  const handleModeChange = (value: HorizonMode) => {
    setMode(value);
    localStorage.setItem('horizon_mode', value);
    // Clear any pending detection when user manually selects a mode
    setDetectedMode(null);
  };

  const handleSubOptionToggle = (optionId: string) => {
    setActiveSubOptions(prev => {
      const modeOptions = HORIZON_MODES[mode];
      const currentOptions = prev[mode] || [];
      const isActive = currentOptions.includes(optionId);

      let newOptions: string[];
      if (isActive) {
        // Deselect
        newOptions = currentOptions.filter(id => id !== optionId);
      } else {
        // Select — handle mutual exclusivity
        const optionDef = modeOptions.subOptions?.find(o => o.id === optionId);
        const exclusions = optionDef?.exclusiveWith || [];
        newOptions = [...currentOptions.filter(id => !exclusions.includes(id)), optionId];
      }

      const next = { ...prev, [mode]: newOptions };
      localStorage.setItem('horizon_sub_options', JSON.stringify(next));
      return next;
    });
  };

  const handleAcceptDetectedMode = () => {
    if (detectedMode) {
      setMode(detectedMode);
      localStorage.setItem('horizon_mode', detectedMode);
      setDetectedMode(null);
    }
  };

  const handleDismissDetectedMode = () => {
    setDetectedMode(null);
  };

  const handleLanguageChange = (value: string) => {
    setLanguage(value);
    localStorage.setItem('horizon_language', value);
  };

  // Auto-name chat based on first user message
  const autoNameChat = async (sessionId: string, firstMessage: string) => {
    let title = firstMessage.substring(0, 40);
    const lastSpace = title.lastIndexOf(' ');
    if (lastSpace > 20) {
      title = title.substring(0, lastSpace);
    }
    title = title.trim() + (firstMessage.length > 40 ? '...' : '');
    
    await chatService.updateSession(sessionId, { title });
    setSessions(prev => prev.map(s => 
      s.id === sessionId && (s.title.startsWith('Case Analysis') || s.title === 'New Chat')
        ? { ...s, title } 
        : s
    ));
  };

  // Stop generation handler — scoped to current session only
  const handleStopGeneration = useCallback(() => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return;
    const controller = abortControllersRef.current.get(sessionId);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(sessionId);
    }
    activeRequestIdsRef.current.delete(sessionId);
    setStreamingSessionIds(prev => {
      const next = new Set(prev);
      next.delete(sessionId);
      return next;
    });
  }, []);

  // Edit and resend message handler
  const handleEditMessage = async (messageId: string, newContent: string) => {
    if (!currentSessionId) return;
    
    // Delete this message and everything after it from DB
    const msg = sessions.find(s => s.id === currentSessionId)?.messages.find(m => m.id === messageId);
    if (msg?.dbId) {
      await chatService.deleteMessagesFrom(currentSessionId, msg.dbId);
    }

    // Remove from local state
    setSessions(prev => prev.map(session => {
      if (session.id === currentSessionId) {
        const msgIndex = session.messages.findIndex(m => m.id === messageId);
        if (msgIndex === -1) return session;
        return { ...session, messages: session.messages.slice(0, msgIndex) };
      }
      return session;
    }));
    
    // Send the new message
    setTimeout(() => {
      handleSendMessage(newContent);
    }, 100);
  };

  // Regenerate: Retry as a branch action (preserves later messages)
  const handleRegenerateMessage = async (messageId: string) => {
    // Prevent double-click/concurrent retries
    if (isRetryingRef.current) {
      console.log('[handleRegenerateMessage] Retry already in progress, ignoring');
      return;
    }
    
    if (!currentSessionId) return;
    const session = sessions.find(s => s.id === currentSessionId);
    if (!session) return;

    const aiMsgIndex = session.messages.findIndex(m => m.id === messageId);
    if (aiMsgIndex === -1) return;

    const aiMsg = session.messages[aiMsgIndex];

    // Find the paired user message (the one immediately before this AI message)
    let userMsg: ChatMessage | undefined;
    for (let i = aiMsgIndex - 1; i >= 0; i--) {
      if (session.messages[i].role === Role.USER) {
        userMsg = session.messages[i];
        break;
      }
    }
    if (!userMsg) return;

    // Mark retry in progress
    isRetryingRef.current = true;

    try {
      // Delete ONLY the user message and its paired AI response from DB
      const idsToDelete = [userMsg.dbId, aiMsg.dbId].filter(id => id !== undefined) as string[];
      if (idsToDelete.length > 0) {
        await chatService.deleteSpecificMessages(idsToDelete);
      }

      // Remove ONLY these two messages from local state, keep everything else
      setSessions(prev => prev.map(s => {
        if (s.id === currentSessionId) {
          return {
            ...s,
            messages: s.messages.filter(m => m.id !== userMsg!.id && m.id !== aiMsg.id)
          };
        }
        return s;
      }));

      // Re-send as a NEW message at the bottom (branch action)
      setTimeout(() => {
        handleSendMessage(userMsg!.content);
        isRetryingRef.current = false;
      }, 100);
    } catch (error) {
      console.error('[handleRegenerateMessage] Error during retry:', error);
      isRetryingRef.current = false;
    }
  };

  const handleSendMessage = async (text: string, selectedFileIds?: string[], actionFlags?: LegalActionFlags) => {
    // Reset detected mode from previous query
    setDetectedMode(null);
    
    // ========================================================================
    // SESSION RESOLUTION — optimistic (non-blocking) for new chats
    // ========================================================================
    let sessionId = currentSessionId;
    let isNewSession = false;
    
    // Mutable ref for the session ID — starts as temp/real, updated to real by background promise
    const liveSessionId = { current: sessionId || '' };
    // Helper: match session regardless of whether temp→real swap has been processed
    const isCurrentSession = (s: { id: string }) => s.id === liveSessionId.current || s.id === sessionId;
    
    // sessionReadyPromise resolves with the real DB session ID.
    // For existing sessions it resolves immediately; for new ones it resolves
    // once the background createSession call completes.
    let sessionReadyPromise: Promise<string | null>;
    
    if (!sessionId) {
      isNewSession = true;
      console.log('[handleSendMessage] No active session, creating optimistic session...');
      
      // Auto-generate title from first message
      let title = text.substring(0, 40);
      const lastSpace = title.lastIndexOf(' ');
      if (lastSpace > 20) {
        title = title.substring(0, lastSpace);
      }
      title = title.trim() + (text.length > 40 ? '...' : '');
      
      // Use a temporary ID so the UI can render immediately
      const tempId = `temp-${generateId()}`;
      sessionId = tempId;
      liveSessionId.current = tempId;
      
      // Optimistic session object for sidebar
      const optimisticSession: ChatSession = {
        id: tempId,
        title: title || 'New Chat',
        messages: [],
        timestamp: Date.now(),
        pinned: false,
        messageCount: 0,
        case_id: activeMatter?.id,
      };
      
      setSessions(prev => [optimisticSession, ...prev]);
      updateCurrentSessionId(tempId);
      setLoadedSessionIds(prev => new Set(prev).add(tempId));
      
      // Fire DB session creation in background — do NOT await
      sessionReadyPromise = (async () => {
        try {
          const newSession = await chatService.createSession(title, activeMatter?.id);
          if (!newSession) {
            console.error('[handleSendMessage] Background session creation failed');
            return null;
          }
          console.log('[handleSendMessage] Background session created:', newSession.id);
          const realId = newSession.id;
          
          // Update live ref BEFORE state swap so streaming callbacks pick up the new ID
          liveSessionId.current = realId;
          
          // Transfer per-session streaming state from temp ID to real ID
          const tempController = abortControllersRef.current.get(tempId);
          if (tempController) {
            abortControllersRef.current.set(realId, tempController);
            abortControllersRef.current.delete(tempId);
          }
          const tempRequestId = activeRequestIdsRef.current.get(tempId);
          if (tempRequestId) {
            activeRequestIdsRef.current.set(realId, tempRequestId);
            activeRequestIdsRef.current.delete(tempId);
          }
          setStreamingSessionIds(prev => {
            if (prev.has(tempId)) {
              const next = new Set(prev);
              next.delete(tempId);
              next.add(realId);
              return next;
            }
            return prev;
          });
          
          // Swap temp ID → real ID everywhere
          setSessions(prev => prev.map(s =>
            s.id === tempId ? { ...s, id: realId } : s
          ));
          updateCurrentSessionId(realId);
          setLoadedSessionIds(prev => {
            const next = new Set(prev);
            next.delete(tempId);
            next.add(realId);
            return next;
          });
          
          return realId;
        } catch (err) {
          console.error('[handleSendMessage] Background session creation error:', err);
          return null;
        }
      })();
    } else if (sessionId?.startsWith('temp-')) {
      // Legacy temp session — wait for it to resolve
      console.log('[handleSendMessage] Temp session detected, waiting for DB sync...');
      const startTime = Date.now();
      while (currentSessionIdRef.current?.startsWith('temp-') && Date.now() - startTime < 5000) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      sessionId = currentSessionIdRef.current;
      if (!sessionId || sessionId.startsWith('temp-')) {
        console.error('[handleSendMessage] Timeout waiting for real session');
        alert('Failed to send message. Please try again.');
        return;
      }
      sessionReadyPromise = Promise.resolve(sessionId);
    } else {
      // Existing real session — ready immediately
      sessionReadyPromise = Promise.resolve(sessionId);
    }
    
    if (!sessionId) return;

    // ========================================================================
    // BUILD UI MESSAGES IMMEDIATELY — zero delay
    // ========================================================================
    // Convert pending attachments to ChatAttachment for immediate display on user message
    const userAttachments: import('./types').ChatAttachment[] = pendingAttachments.length > 0
      ? pendingAttachments.map(a => ({
          id: a.id,
          filename: a.filename,
          mime_type: a.mime_type,
          size: a.size,
          storage_path: '',  // Will be populated by backend SSE event
          type: a.type,
          thumbnail_url: a.preview_url, // Keep blob URL for image preview
        }))
      : undefined;

    const userMsg: ChatMessage = {
      id: generateId(),
      role: Role.USER,
      content: text,
      timestamp: Date.now(),
      ...(userAttachments && { attachments: userAttachments }),
    };

    const modelMsgId = generateId();
    const modelMsg: ChatMessage = {
      id: modelMsgId,
      role: Role.MODEL,
      content: '', 
      timestamp: Date.now() + 1,
      isThinking: true,
    };

    setSessions(prev => prev.map(session => {
      if (session.id === sessionId) {
        return {
          ...session,
          messages: [...session.messages, userMsg, modelMsg]
        };
      }
      return session;
    }));

    // Save user message to DB in background (chained to session ready)
    // Do NOT await — streaming starts immediately below
    const userDbIdPromise = sessionReadyPromise.then(async (realSessionId) => {
      if (!realSessionId) return null;
      
      const userDbId = await chatService.saveMessage(realSessionId, {
        role: 'user',
        content: text,
      });
      if (userDbId) {
        setSessions(prev => prev.map(s => {
          if (isCurrentSession(s)) {
            return { ...s, messages: s.messages.map(m => m.id === userMsg.id ? { ...m, dbId: userDbId } : m) };
          }
          return s;
        }));
      }
      return userDbId;
    });

    // Note: Auto-naming now happens during session creation in the first message block above
    // (no need for separate autoNameChat call)

    // Per-chat streaming: mark THIS session as streaming
    const streamSessionId = sessionId!;
    // Expose session ID globally so openaiService can include it in request payload
    (window as any).__currentSessionId = streamSessionId;
    const requestId = generateId();
    activeRequestIdsRef.current.set(streamSessionId, requestId);
    setStreamingSessionIds(prev => new Set(prev).add(streamSessionId));

    // Create new abort controller scoped to this chat session
    const abortController = new AbortController();
    abortControllersRef.current.set(streamSessionId, abortController);

    let accumulatedThinking = "";
    let accumulatedContent = "";
    let sources: SourceCitation[] = [];
    let wasError = false;
    let wasRateLimit = false;
    let alreadySavedModel = false;
    let hasSubstantiveWork = false;
    let fileExportRequested = false;
    let fileExportFormat: 'word' | 'pdf' = 'word';

    // Helper: check if this request is still the active one for this session (race guard)
    // Check both original and live session IDs in case of temp→real swap
    const isStaleRequest = () => {
      const liveId = liveSessionId.current;
      return activeRequestIdsRef.current.get(liveId) !== requestId
        && activeRequestIdsRef.current.get(streamSessionId) !== requestId;
    };

    try {
      const currentSession = sessions.find(s => isCurrentSession(s));
      const history = currentSession ? currentSession.messages : [];

      // Choose streaming endpoint: attachments go through Express backend, plain messages direct to edge function
      const hasAttachments = pendingAttachments.length > 0;
      const stream = hasAttachments
        ? sendMessageWithAttachments(text, history, pendingAttachments, selectedFileIds, temperature, abortController.signal, mode, activeSubOptions[mode], activeMatter, actionFlags)
        : sendMessageToHorizonStream(text, history, files, selectedFileIds, undefined, temperature, abortController.signal, mode, activeSubOptions[mode], activeMatter, actionFlags);

      // Clear pending attachments immediately after starting the stream — they're in-flight via FormData
      // NOTE: Do NOT revoke blob URLs here — they're referenced by msg.attachments[].thumbnail_url for display
      if (hasAttachments) {
        setPendingAttachments([]);
      }

      for await (const chunk of stream) {
        // Race condition guard: ignore chunks from stale/superseded requests
        if (isStaleRequest()) {
          console.log('[handleSendMessage] Ignoring stale chunk for session:', streamSessionId);
          break;
        }
        if (chunk.type === 'attachments' && chunk.attachments) {
          // Store attachments metadata in the user message
          setSessions(prev => prev.map(s => {
            if (isCurrentSession(s)) {
              return {
                ...s,
                messages: s.messages.map(m => 
                  m.id === userMsg.id 
                    ? { ...m, attachments: chunk.attachments } 
                    : m
                )
              };
            }
            return s;
          }));
        } else if (chunk.type === 'state' && chunk.state) {
          // Pipeline state updates (classifying, searching, synthesizing, etc.)
          if (chunk.state === 'rag_debug') {
            console.warn('[RAG DEBUG]', chunk.detail);
            continue;
          }

          // Handle auto-detected mode from classifier
          if (chunk.state === 'detected_mode' && chunk.detail) {
            console.log('[AUTO_DETECT] Mode detected:', chunk.detail);
            setDetectedMode(chunk.detail as HorizonMode);
            // Fall through — also show in research panel
          }

          // --- SUBSTANTIVE PROCESSING GATE ---
          // Determine if this state represents substantive work.
          // Primary: use backend-provided `substantive` flag (authority routing sends
          // the correct flag per event). Fallback: known state names for resilience.
          // NOTE: 'authority_routing' and 'authority_fallback' are NOT in the
          // hardcoded set — their substantiveness is controlled by the backend flag
          // (false for conversational, true for active-matter queries).
          const KNOWN_SUBSTANTIVE_STATES = new Set([
            'searching_documents', 'vector_search_started', 'vector_search_completed',
            'context_retrieved', 'no_documents_found', 'executing_tools',
            'querying_intelligence', 'intelligence_retrieved',
          ]);

          // Dedicated state labels shown as standalone UI (not in ResearchPanel)
          const STANDALONE_STATE_LABELS: Record<string, string> = {
            'creating_document': chunk.detail || 'Creating file...',
          };
          const standaloneLabel = STANDALONE_STATE_LABELS[chunk.state];
          if (standaloneLabel) {
            flushSync(() => {
              setSessions(prev => prev.map(s => {
                if (isCurrentSession(s)) {
                  return {
                    ...s,
                    messages: s.messages.map(m =>
                      m.id === modelMsgId
                        ? { ...m, stateLabel: standaloneLabel, isThinking: true }
                        : m
                    )
                  };
                }
                return s;
              }));
            });
            continue;
          }
          const isSubstantive = chunk.substantive === true || KNOWN_SUBSTANTIVE_STATES.has(chunk.state);
          if (isSubstantive) {
            hasSubstantiveWork = true;
          }

          // Build enriched mode labels with human-readable names and sub-option details
          let modeStateLabel = '';
          if (chunk.state === 'mode_active' && chunk.detail) {
            const mk = chunk.detail as HorizonMode;
            const mc = HORIZON_MODES[mk];
            if (mc) {
              const subLabels = (activeSubOptions[mode] || [])
                .map(id => mc.subOptions?.find(o => o.id === id)?.label)
                .filter(Boolean);
              modeStateLabel = subLabels.length > 0
                ? `⚙ ${mc.label} · ${subLabels.join(', ')}`
                : `⚙ ${mc.label}`;
            }
          } else if (chunk.state === 'detected_mode' && chunk.detail) {
            const mk = chunk.detail as HorizonMode;
            const mc = HORIZON_MODES[mk];
            modeStateLabel = mc ? `✨ Auto-detected: ${mc.label}` : `✨ Auto-detected: ${chunk.detail}`;
          }

          // Map state to user-friendly labels
          const stateLabel = modeStateLabel || {
            'classifying_query': 'Analyzing query...',
            'creating_document': chunk.detail || 'Creating document...',
            'mode_active': chunk.detail ? `Mode: ${chunk.detail}` : 'Mode active',
            'detected_mode': chunk.detail ? `Auto-detected: ${chunk.detail}` : 'Mode detected',
            'mode_info': chunk.detail ? `⚙ ${chunk.detail}` : 'Mode active',
            'authority_routing': chunk.detail ? `⚖ ${chunk.detail}` : 'Routing query...',
            'authority_fallback': chunk.detail ? `⚠ ${chunk.detail}` : 'No internal data found',
            'searching_documents': 'Searching documents...',
            'vector_search_started': chunk.detail ? `Searching: ${chunk.detail}` : 'Vector search...',
            'vector_search_completed': 'Search complete',
            'context_retrieved': chunk.detail ? `Found relevant content in ${chunk.detail}` : 'Context retrieved',
            'no_documents_found': 'No relevant documents found',
            'synthesizing_response': 'Generating response...',
            'executing_tools': 'Executing actions...',
            'querying_intelligence': 'Querying matter intelligence...',
            'intelligence_retrieved': chunk.detail ? `Intelligence: ${chunk.detail}` : 'Intelligence retrieved',
          }[chunk.state] || chunk.state;
          
          // Only accumulate substantive states into thinking (visible in ResearchPanel)
          if (isSubstantive) {
            accumulatedThinking += (accumulatedThinking ? '\n' : '') + stateLabel;
          }
          
          flushSync(() => {
            setSessions(prev => prev.map(s => {
              if (isCurrentSession(s)) {
                return {
                  ...s,
                  messages: s.messages.map(m => 
                    m.id === modelMsgId 
                      ? { ...m, thinking: accumulatedThinking, isThinking: true, hasSubstantiveWork } 
                      : m
                  )
                };
              }
              return s;
            }));
          });
        } else if (chunk.type === 'file_requested') {
          // Backend signals: pipeline will generate content, auto-export it as file when done
          fileExportRequested = true;
          fileExportFormat = (chunk.fileRequestedFormat as 'word' | 'pdf') || 'word';
          console.log('[FILE_REQUESTED] Will auto-export after pipeline, format:', fileExportFormat);
        } else if (chunk.type === 'content' && chunk.content) {
          // Content arrived — accumulate always, but suppress display if file export in progress
          accumulatedContent += chunk.content;
          
          if (!fileExportRequested) {
            // Normal: display content as it streams
            flushSync(() => {
              setSessions(prev => prev.map(s => {
                if (isCurrentSession(s)) {
                  return {
                    ...s,
                    messages: s.messages.map(m => 
                      m.id === modelMsgId 
                        ? { ...m, content: accumulatedContent, isThinking: false, thinking: accumulatedThinking, hasSubstantiveWork, stateLabel: undefined } 
                        : m
                    )
                  };
                }
                return s;
              }));
            });
          }
          // When fileExportRequested: content accumulates silently, message stays in thinking state
        } else if (chunk.type === 'sources' && chunk.sources) {
          sources = chunk.sources;
          setSessions(prev => prev.map(s => {
            if (isCurrentSession(s)) {
              return {
                ...s,
                messages: s.messages.map(m => 
                  m.id === modelMsgId 
                    ? { ...m, sources } 
                    : m
                )
              };
            }
            return s;
          }));
        } else if (chunk.type === 'validation' && chunk.validation) {
          // Validation data — backend now only emits this for true absence scenarios.
          // Log internally but do NOT display confidence labels to users.
          // This prevents misleading "Low confidence" when documents contributed.
          const { confidence, warnings } = chunk.validation;
          console.log(`[Validation] confidence=${confidence} warnings=${warnings?.join('; ')}`);
          // Only surface in research panel if there's a genuine absence warning
          if (warnings && warnings.length > 0 && confidence === 'low') {
            const absenceNote = warnings.filter((w: string) => w.includes('No document') || w.includes('No structured')).join('; ');
            if (absenceNote) {
              accumulatedThinking += (accumulatedThinking ? '\n' : '') + absenceNote;
              flushSync(() => {
                setSessions(prev => prev.map(s => {
                  if (isCurrentSession(s)) {
                    return {
                      ...s,
                      messages: s.messages.map(m => 
                        m.id === modelMsgId 
                          ? { ...m, thinking: accumulatedThinking, hasSubstantiveWork } 
                          : m
                      )
                    };
                  }
                  return s;
                }));
              });
            }
          }
        }
        // ── AGENTIC ARCHITECTURE SSE EVENTS ──
        else if (chunk.type === 'agent_plan') {
          // Orchestrator produced a plan — log for debugging, show intent in research panel
          const planData = chunk as any;
          console.log(`[AGENT_PLAN] intent=${planData.intent} retrieval=${planData.requires_retrieval} tools=${planData.tools_requested?.join(',')}`);
          const intentLabels: Record<string, string> = {
            qa: '❓ Question Answering',
            draft: '📝 Drafting',
            review: '📋 Contract Review',
            compare: '🔄 Document Comparison',
            summarize: '📄 Summary',
            research: '🔍 Legal Research',
            workspace: '🗂️ Workspace Management',
            export: '📥 Export',
            other: '💬 General',
          };
          const intentLabel = intentLabels[planData.intent] || planData.intent;
          accumulatedThinking += (accumulatedThinking ? '\n' : '') + `🧠 Agent Plan: ${intentLabel}`;
          if (planData.tools_requested?.length > 0) {
            accumulatedThinking += `\n🔧 Tools: ${planData.tools_requested.join(', ')}`;
          }
          hasSubstantiveWork = true;
          flushSync(() => {
            setSessions(prev => prev.map(s => {
              if (isCurrentSession(s)) {
                return { ...s, messages: s.messages.map(m => m.id === modelMsgId ? { ...m, thinking: accumulatedThinking, isThinking: true, hasSubstantiveWork } : m) };
              }
              return s;
            }));
          });
        }
        else if (chunk.type === 'tool_gateway') {
          const gwData = chunk as any;
          const status = gwData.allowed ? '✅' : (gwData.requires_confirmation ? '⏳' : '❌');
          console.log(`[TOOL_GATEWAY] ${gwData.tool}: ${status} ${gwData.reason}`);
          accumulatedThinking += `\n${status} Gateway: ${gwData.tool} — ${gwData.reason}`;
          flushSync(() => {
            setSessions(prev => prev.map(s => {
              if (isCurrentSession(s)) {
                return { ...s, messages: s.messages.map(m => m.id === modelMsgId ? { ...m, thinking: accumulatedThinking, isThinking: true, hasSubstantiveWork } : m) };
              }
              return s;
            }));
          });
        }
        else if (chunk.type === 'clarifying_questions') {
          // Agent has questions — these are also emitted as content, so just log
          const cqData = chunk as any;
          console.log(`[CLARIFYING] ${cqData.questions?.length || 0} question(s)`);
        }
        else if (chunk.type === 'verification') {
          const vData = chunk as any;
          console.log(`[VERIFIER] verdict=${vData.verdict} risk=${vData.risk_level} reasons=${vData.reasons?.length}`);
          if (vData.verdict === 'fail' && vData.reasons?.length > 0) {
            accumulatedThinking += `\n⚠ Verification: ${vData.reasons.join('; ')}`;
            flushSync(() => {
              setSessions(prev => prev.map(s => {
                if (isCurrentSession(s)) {
                  return { ...s, messages: s.messages.map(m => m.id === modelMsgId ? { ...m, thinking: accumulatedThinking, hasSubstantiveWork } : m) };
                }
                return s;
              }));
            });
          }
        }
        // File export event — backend found exportable content, trigger download instantly
        else if (chunk.type === 'file_export' && chunk.exportMarkdown) {
          const fmt = chunk.exportFormat || 'word';
          const title = chunk.exportTitle || 'Document';
          exportChat(chunk.exportMarkdown, fmt, {
            title,
            matter: activeMatter?.name,
            caseNumber: activeMatter?.case_number,
          }).catch(err => console.error('[FILE_EXPORT] Download failed:', err));
        }
      }

    } catch (error) {
      // Check if it was an abort
      if (error instanceof Error && error.name === 'AbortError') {
        console.log('Generation stopped by user in session:', streamSessionId);
        alreadySavedModel = true;
        const stoppedContent = accumulatedContent || '(Generation stopped)';
        
        // Clear UI immediately — no delay
        setSessions(prev => prev.map(s => {
          if (isCurrentSession(s)) {
            return { ...s, messages: s.messages.map(m => m.id === modelMsgId
              ? { ...m, content: stoppedContent, isThinking: false, hasSubstantiveWork, stateLabel: undefined }
              : m
            )};
          }
          return s;
        }));
        // Clear streaming state for this session only (use live ID in case temp→real swap)
        const abortCleanupId = liveSessionId.current || streamSessionId;
        abortControllersRef.current.delete(abortCleanupId);
        abortControllersRef.current.delete(streamSessionId);
        activeRequestIdsRef.current.delete(abortCleanupId);
        activeRequestIdsRef.current.delete(streamSessionId);
        setStreamingSessionIds(prev => {
          const next = new Set(prev);
          next.delete(abortCleanupId);
          next.delete(streamSessionId);
          return next;
        });
        
        // Save partial model response to DB in background (wait for session to be ready)
        sessionReadyPromise.then(async (realId) => {
          if (!realId) return;
          await userDbIdPromise; // ensure user msg saved first
          const modelDbId = await chatService.saveMessage(realId, {
            role: 'model',
            content: stoppedContent,
            sources: sources.length > 0 ? sources : undefined,
            thinking: accumulatedThinking || undefined,
          });
          if (modelDbId) {
            setSessions(prev => prev.map(s => {
              if (isCurrentSession(s)) {
                return { ...s, messages: s.messages.map(m => m.id === modelMsgId ? { ...m, dbId: modelDbId } : m) };
              }
              return s;
            }));
          }
        });
        return;
      }
      
      console.error("Chat Error", error);
      wasError = true;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      wasRateLimit = errorMessage.toLowerCase().includes('rate limit');
      const displayMessage = wasRateLimit
        ? `⚠️ ${errorMessage}`
        : (errorMessage || "I apologize, but I encountered an error while processing your request.");
      accumulatedContent = accumulatedContent || displayMessage;
      setSessions(prev => prev.map(s => {
        if (isCurrentSession(s)) {
          return {
            ...s,
            messages: s.messages.map(m => 
              m.id === modelMsgId 
                ? { ...m, isError: true, isRateLimit: wasRateLimit, content: accumulatedContent } 
                : m
            )
          };
        }
        return s;
      }));
    } finally {
      // Clear streaming state for this session (use live ID in case temp→real swap happened)
      const cleanupId = liveSessionId.current || streamSessionId;
      abortControllersRef.current.delete(cleanupId);
      abortControllersRef.current.delete(streamSessionId); // also clean temp ID if still there
      activeRequestIdsRef.current.delete(cleanupId);
      activeRequestIdsRef.current.delete(streamSessionId);
      setStreamingSessionIds(prev => {
        const next = new Set(prev);
        next.delete(cleanupId);
        next.delete(streamSessionId);
        return next;
      });

      // Save the completed model message to DB in background
      // Wait for session creation + user message save to complete first
      if (!alreadySavedModel) {
        // Auto-export: if file was requested, clean content and trigger download
        if (fileExportRequested && accumulatedContent) {
          // Clean AI preamble/closing from content for file export
          let exportContent = accumulatedContent;
          const markerIdx = exportContent.indexOf('<!-- HORIZON_EXPORT');
          if (markerIdx >= 0) {
            const markerEndIdx = exportContent.indexOf('-->', markerIdx);
            if (markerEndIdx >= 0) exportContent = exportContent.substring(markerEndIdx + 3).trim();
          }
          // Strip trailing AI commentary
          exportContent = exportContent.replace(/\n{2,}(?:Please review|Let me know|Feel free|I hope this|If you (?:need|want|have|would)|Note that|You can|Sources?:|This (?:draft|document|motion|memo|brief|letter) (?:is|covers|addresses|should)|Would you like)[\s\S]*$/i, '');
          exportContent = exportContent.replace(/\n---\s*$/, '').trim();

          // Extract title from marker
          const titleMatch = accumulatedContent.match(/<!--\s*HORIZON_EXPORT\s+title="([^"]+)"\s*-->/);
          const exportTitle = titleMatch?.[1] || 'Document';

          // Trigger download
          exportChat(exportContent, fileExportFormat, {
            title: exportTitle,
            matter: activeMatter?.name,
            caseNumber: activeMatter?.case_number,
          }).catch(err => console.error('[AUTO-EXPORT] Download failed:', err));

          // Replace message content with confirmation (not the full draft text)
          accumulatedContent = `Your document "${exportTitle}" has been downloaded as ${fileExportFormat === 'pdf' ? 'PDF' : 'Word'}.`;
        }

        // Clear isThinking in UI immediately
        setSessions(prev => prev.map(s => {
          if (isCurrentSession(s)) {
            return { ...s, messages: s.messages.map(m => m.id === modelMsgId 
              ? { ...m, content: fileExportRequested ? accumulatedContent : m.content, isThinking: false, hasSubstantiveWork, stateLabel: undefined } 
              : m) };
          }
          return s;
        }));
        
        // DB save runs in background — does NOT block user
        sessionReadyPromise.then(async (realId) => {
          if (!realId) {
            console.error('[handleSendMessage] Session creation failed, cannot save model message');
            return;
          }
          await userDbIdPromise; // ensure user msg saved first
          const modelDbId = await chatService.saveMessage(realId, {
            role: 'model',
            content: accumulatedContent,
            sources: sources.length > 0 ? sources : undefined,
            thinking: accumulatedThinking || undefined,
            isError: wasError,
          });
          if (modelDbId) {
            setSessions(prev => prev.map(s => {
              if (isCurrentSession(s)) {
                return { ...s, messages: s.messages.map(m => m.id === modelMsgId ? { ...m, dbId: modelDbId } : m) };
              }
              return s;
            }));
          }
        });
      }
    }
  };

  if (isLoadingAuth) {
    return (
      <div className="flex items-center justify-center h-screen bg-white dark:bg-gray-900">
        <div className="w-10 h-10 border-4 border-steel-blue border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  // --- Authenticated View (Main App) ---
  if (user) {
    return (
      <div className="flex h-screen overflow-hidden bg-white dark:bg-gray-900 text-charcoal dark:text-gray-100 font-sans">
        
        {isSidebarOpen && (
          <div 
            className="fixed inset-0 bg-black/50 z-20 md:hidden"
            onClick={() => setIsSidebarOpen(false)}
          />
        )}

        <Sidebar 
          files={files}
          sessions={sessions}
          currentSessionId={currentSessionId}
          currentView={currentView}
          isOpen={isSidebarOpen}
          onToggle={toggleSidebar}
          onRemoveFile={handleRemoveFile}
          onFilesSelected={handleFilesSelected}
          onSelectSession={handleSelectSession}
          onNewChat={handleNewChat}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onPinSession={handlePinSession}
          cases={cases}
          onShareSession={(id) => {
            // TODO: Implement share functionality
            const session = sessions.find(s => s.id === id);
            if (session) {
              navigator.clipboard.writeText(`Shared chat: ${session.title}`);
              alert('Share link copied to clipboard!');
            }
          }}
          onOpenVault={() => {
            setCurrentView(AppView.VAULT);
            if (window.innerWidth < 768) setIsSidebarOpen(false);
          }}
          onOpenIntelligence={() => {
            setCurrentView(AppView.INTELLIGENCE);
            if (window.innerWidth < 768) setIsSidebarOpen(false);
          }}
          onOpenSettings={() => {
            setCurrentView(AppView.SETTINGS);
            if (window.innerWidth < 768) {
              setIsSidebarOpen(false);
            }
          }}
          onLogout={handleLogout}
          userEmail={user?.email}
          planName={billingStatus?.plan?.displayName || undefined}
          creditPercent={billingStatus?.credits?.percent}
        />

        <main className="flex-1 flex flex-col h-full w-full relative min-w-0 transition-all duration-300">
          <header className="h-14 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between px-4 bg-white dark:bg-gray-800 flex-shrink-0">
            {/* Left: Hamburger + Title */}
            <div className="flex items-center gap-2">
              {!isSidebarOpen && (
                <button 
                  onClick={() => setIsSidebarOpen(true)}
                  className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors"
                  title="Open Sidebar"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                  </svg>
                </button>
              )}
              <span className="text-base font-medium text-gray-900 dark:text-white">Horizon</span>
              {processingStatus && (
                <span className="ml-2 text-xs text-gray-500 dark:text-gray-400 animate-pulse">{processingStatus}</span>
              )}
            </div>

            {/* Center: Matter Switcher */}
            <div className="flex items-center gap-3">
              {(currentView === AppView.CHAT || currentView === AppView.INTELLIGENCE) && <MatterSwitcher />}
            </div>

            {/* Right: User actions */}
            <div className="flex items-center gap-2">
              {/* This space can hold user avatar or other icons */}
            </div>
          </header>

          <div className="flex-1 overflow-hidden relative">
            <div key={currentView} className="h-full animate-cross-fade">
            <Suspense fallback={<ViewSkeleton />}>
            {currentView === AppView.VAULT ? (
              <Vault 
                files={files}
                onFilesSelected={handleFilesSelected}
                onRemoveFile={handleRemoveFile}
                isProcessing={isProcessingFiles}
                onNavigateToChat={() => setCurrentView(AppView.CHAT)}
              />
            ) : currentView === AppView.SETTINGS ? (
              <Settings 
                themePreference={themePreference}
                onThemeChange={handleThemeChange}
                temperature={temperature}
                onTemperatureChange={handleTemperatureChange}
                language={language}
                onLanguageChange={handleLanguageChange}
                onClose={() => setCurrentView(AppView.CHAT)}
                billingStatus={billingStatus}
                onOpenPricing={() => setShowPricingOverlay(true)}
              />
            ) : currentView === AppView.UPLOAD ? (
              <div className="h-full overflow-y-auto p-4">
                <FileUploader 
                  onFilesSelected={handleFilesSelected} 
                  isProcessing={isProcessingFiles} 
                />
                {files.length > 0 && sessions.length > 0 && (
                   <div className="text-center mt-8">
                     <button 
                       onClick={() => setCurrentView(AppView.CHAT)}
                       className="text-charcoal-muted dark:text-gray-400 hover:underline"
                     >
                       Back to Chat
                     </button>
                   </div>
                )}
              </div>
            ) : currentView === AppView.INTELLIGENCE ? (
              <MatterBrief 
                onNavigateToChat={() => setCurrentView(AppView.CHAT)}
              />
            ) : (
              // Show loading screen while restoring saved chat session
              isLoadingSessions && currentSessionId ? (
                <div className="flex items-center justify-center h-full bg-white dark:bg-gray-900">
                  <div className="text-center">
                    <div className="w-10 h-10 mx-auto border-4 border-steel-blue dark:border-indigo-bright border-t-transparent rounded-full animate-spin mb-4"></div>
                    <p className="text-sm text-gray-500 dark:text-gray-400">Loading conversation...</p>
                  </div>
                </div>
              ) : (
                <ChatInterface 
                  files={files}
                  dbFiles={dbFiles}
                  messages={currentMessages}
                  isTyping={currentSessionId ? streamingSessionIds.has(currentSessionId) : false}
                  onSendMessage={handleSendMessage}
                  onStopGeneration={handleStopGeneration}
                  onEditMessage={handleEditMessage}
                  onRegenerateMessage={handleRegenerateMessage}
                  onBackToUpload={() => setCurrentView(AppView.UPLOAD)}
                  onOpenVault={() => setCurrentView(AppView.VAULT)}
                  hasFiles={files.length > 0 || dbFiles.length > 0}
                  currentSessionId={currentSessionId}
                  mode={mode}
                  onModeChange={handleModeChange}
                  detectedMode={detectedMode}
                  onAcceptDetectedMode={handleAcceptDetectedMode}
                  onDismissDetectedMode={handleDismissDetectedMode}
                  activeSubOptions={activeSubOptions[mode] || []}
                  onSubOptionToggle={handleSubOptionToggle}
                  newChatCounter={newChatCounter}
                  actionFlags={actionFlags}
                  onActionFlagsChange={setActionFlags}
                  pendingAttachments={pendingAttachments}
                  onPendingAttachmentsChange={setPendingAttachments}
                  allowedModes={featureFlags?.allowedModes}
                  creditWarning={billingStatus?.credits?.warning}
                  creditPercent={billingStatus?.credits?.percent}
                />
              )
            )}
            </Suspense>
            </div>
          </div>
        </main>

        {/* Pricing Overlay — shown when no active subscription */}
        {showPricingOverlay && (
          <Suspense fallback={<ViewSkeleton />}>
            <PricingOverlay
              isBlocking={
                billingStatus?.hasSubscription === true &&
                !['active', 'trialing'].includes(billingStatus?.status || '')
              }
              currentPlan={billingStatus?.plan?.name}
              onClose={() => setShowPricingOverlay(false)}
            />
          </Suspense>
        )}
      </div>
    );
  }

  // --- Unauthenticated Views ---

  if (authMode) {
    return (
      <Suspense fallback={<ViewSkeleton />}>
        <AuthPage 
          onAuthSuccess={() => {}} 
          onBackToHome={() => setAuthMode(null)}
          initialMode={authMode}
        />
      </Suspense>
    );
  }

  // Default: Landing Page
  return (
    <Suspense fallback={<ViewSkeleton />}>
      <LandingPage 
        onLoginClick={() => setAuthMode('login')}
        onBookCallClick={() => setAuthMode('book-call')}
        darkMode={darkMode}
        themePreference={themePreference}
        onToggleDarkMode={toggleDarkMode}
      />
    </Suspense>
  );
};

// Main App component that wraps everything with DataProvider
const App: React.FC = () => {
  const [userId, setUserId] = useState<string | null>(null);

  useEffect(() => {
    // Get initial user
    supabase.auth.getUser().then(({ data: { user } }) => {
      setUserId(user?.id ?? null);
    });

    // Subscribe to auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUserId(session?.user?.id ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <DataProvider userId={userId}>
      <MatterProvider>
        <AppContent />
      </MatterProvider>
    </DataProvider>
  );
};

export default App;