/**
 * MatterBrief — Intelligence hub with two modes:
 *
 * 1. **Command Center** (no matter selected):
 *    Portfolio-wide dashboard built entirely from cached DataContext data.
 *    Shows all matters as cards, portfolio stats, status distribution,
 *    and "needs attention" highlights — zero API/LLM calls.
 *
 * 2. **Single-Matter Brief** (matter selected):
 *    Conversational-first intelligence card that surfaces:
 *      - Executive Summary
 *      - Key Parties
 *      - Critical Risks
 *      - Upcoming Deadlines
 *      - Quick Actions
 */

import React, { useState, useEffect, useCallback, useRef, useMemo, useLayoutEffect } from 'react';
import { useMatter } from '../contexts/MatterContext';
import { useData } from '../contexts/DataContext';
import { Case, MatterType, MatterStatus, UploadedFile, Folder } from '../types';
import * as intel from '../services/intelligenceService';
import * as cache from '../services/cacheService';
import ExtractionProgress from './ExtractionProgress';

// ═══════════════════════════════════════════════════════════════
// COMMAND CENTER — Portfolio-wide dashboard (zero API calls)
// ═══════════════════════════════════════════════════════════════

/** Matter type display config */
const MATTER_TYPE_META: Record<string, { label: string; icon: string; color: string }> = {
  litigation:  { label: 'Litigation',  icon: '⚖️', color: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300' },
  transaction: { label: 'Transaction', icon: '📝', color: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300' },
  compliance:  { label: 'Compliance',  icon: '✅', color: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300' },
  regulatory:  { label: 'Regulatory',  icon: '🏛️', color: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300' },
  advisory:    { label: 'Advisory',    icon: '💼', color: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300' },
  ip:          { label: 'IP',          icon: '🔒', color: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300' },
  employment:  { label: 'Employment',  icon: '👥', color: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300' },
  other:       { label: 'Other',       icon: '📋', color: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300' },
};

const STATUS_META: Record<string, { label: string; dot: string }> = {
  active:   { label: 'Active',   dot: 'bg-green-500' },
  archived: { label: 'Archived', dot: 'bg-gray-400' },
  closed:   { label: 'Closed',   dot: 'bg-red-400' },
};

/** How long ago in human-readable form */
function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Format date for display */
function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

interface CommandCenterProps {
  onNavigateToChat: () => void;
}

const CommandCenter: React.FC<CommandCenterProps> = ({ onNavigateToChat }) => {
  const { 
    cases, 
    folders, 
    files, 
    isInitialLoad,
    isSyncingCases,
    isSyncingFolders,
    isSyncingFiles,
    refreshAll,
  } = useData();
  const { setActiveMatter } = useMatter();
  const [statusFilter, setStatusFilter] = useState<MatterStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<MatterType | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'name' | 'files'>('updated');
  const [hasInitialAnimationPlayed, setHasInitialAnimationPlayed] = useState(false);
  const cardPositionsRef = useRef<Map<string, DOMRect>>(new Map());
  const cardsRef = useRef<Map<string, HTMLElement>>(new Map());
  
  // Syncing indicator
  const isSyncing = isSyncingCases || isSyncingFolders || isSyncingFiles;
  
  // Handle manual sync
  const handleSync = async () => {
    await refreshAll(true);
  };
  
  // Auto-sync on mount (check cache, refresh if stale)
  useEffect(() => {
    refreshAll(false); // false = only refresh if cache is stale
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived data ──────────────────────────────────────────
  const enrichedMatters = useMemo(() => {
    return cases
      .filter(c => c.name !== 'General Documents')
      .map(c => {
        const matterFiles = files.filter(f => f.case_id === c.id);
        const matterFolders = folders.filter(f => f.case_id === c.id);
        const processingFiles = matterFiles.filter(f => f.status === 'processing' || f.status === 'uploaded');
        const readyFiles = matterFiles.filter(f => f.status === 'ready');
        const failedFiles = matterFiles.filter(f => f.status === 'failed');
        return {
          ...c,
          fileCount: matterFiles.length,
          folderCount: matterFolders.length,
          processingCount: processingFiles.length,
          readyCount: readyFiles.length,
          failedCount: failedFiles.length,
          hasIssues: failedFiles.length > 0 || (matterFiles.length === 0 && c.status === 'active'),
        };
      });
  }, [cases, files, folders]);

  const filteredMatters = useMemo(() => {
    let result = enrichedMatters;
    if (statusFilter !== 'all') result = result.filter(c => c.status === statusFilter);
    if (typeFilter !== 'all') result = result.filter(c => c.matter_type === typeFilter);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.client_name || '').toLowerCase().includes(q) ||
        (c.case_number || '').toLowerCase().includes(q) ||
        (c.matter_ref || '').toLowerCase().includes(q) ||
        (c.description || '').toLowerCase().includes(q)
      );
    }
    // Sort
    result = [...result].sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'files') return b.fileCount - a.fileCount;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
    return result;
  }, [enrichedMatters, statusFilter, typeFilter, searchQuery, sortBy]);

  // Mark initial animation as played after cards are rendered
  useEffect(() => {
    if (!isInitialLoad && filteredMatters.length > 0 && !hasInitialAnimationPlayed) {
      const timer = setTimeout(() => {
        setHasInitialAnimationPlayed(true);
      }, 250 + Math.min(filteredMatters.length, 12) * 50 + 400); // Wait for all animations to complete
      return () => clearTimeout(timer);
    }
  }, [isInitialLoad, filteredMatters.length, hasInitialAnimationPlayed]);

  // FLIP animation for smooth card reordering (after initial animation)
  useLayoutEffect(() => {
    if (!hasInitialAnimationPlayed || cardsRef.current.size === 0) return;

    const cards = cardsRef.current;
    const oldPositions = cardPositionsRef.current;

    // First: capture old positions (already stored)
    // Last: get new positions after re-render
    const newPositions = new Map<string, DOMRect>();
    cards.forEach((card, id) => {
      newPositions.set(id, card.getBoundingClientRect());
    });

    // Invert: calculate deltas and apply inverse transforms
    cards.forEach((card, id) => {
      const oldPos = oldPositions.get(id);
      const newPos = newPositions.get(id);
      
      if (oldPos && newPos) {
        const deltaX = oldPos.left - newPos.left;
        const deltaY = oldPos.top - newPos.top;
        
        if (deltaX !== 0 || deltaY !== 0) {
          // Apply inverse transform instantly (no transition)
          card.style.transition = 'none';
          card.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
          
          // Force reflow
          card.offsetHeight;
          
          // Play: animate to natural position
          card.style.transition = 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
          card.style.transform = 'translate(0, 0)';
        }
      }
    });

    // Store new positions for next time
    cardPositionsRef.current = newPositions;

    // Cleanup
    const timer = setTimeout(() => {
      cards.forEach((card) => {
        card.style.transition = '';
      });
    }, 400);

    return () => clearTimeout(timer);
  }, [filteredMatters, hasInitialAnimationPlayed]);

  // Capture card positions before re-render (for FLIP animation)
  useLayoutEffect(() => {
    if (!hasInitialAnimationPlayed) return;

    const cards = cardsRef.current;
    const positions = new Map<string, DOMRect>();
    
    cards.forEach((card, id) => {
      positions.set(id, card.getBoundingClientRect());
    });
    
    cardPositionsRef.current = positions;
  });

  // ── Portfolio stats ───────────────────────────────────────
  const stats = useMemo(() => {
    const active = enrichedMatters.filter(c => c.status === 'active').length;
    const closed = enrichedMatters.filter(c => c.status === 'closed').length;
    const archived = enrichedMatters.filter(c => c.status === 'archived').length;
    const totalFiles = files.filter(f => f.case_id && cases.some(c => c.id === f.case_id && c.name !== 'General Documents')).length;
    const processing = files.filter(f => f.status === 'processing' || f.status === 'uploaded').length;
    const failed = files.filter(f => f.status === 'failed').length;
    const emptyActive = enrichedMatters.filter(c => c.status === 'active' && c.fileCount === 0).length;
    return { total: enrichedMatters.length, active, closed, archived, totalFiles, processing, failed, emptyActive };
  }, [enrichedMatters, files, cases]);

  // ── Type distribution ─────────────────────────────────────
  const typeDistribution = useMemo(() => {
    const dist: Record<string, number> = {};
    enrichedMatters.forEach(c => {
      const t = c.matter_type || 'other';
      dist[t] = (dist[t] || 0) + 1;
    });
    return Object.entries(dist)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count, meta: MATTER_TYPE_META[type] || MATTER_TYPE_META.other }));
  }, [enrichedMatters]);

  // ── Attention items ───────────────────────────────────────
  const attentionItems = useMemo(() => {
    const items: { id: string; type: 'warning' | 'error' | 'info'; label: string; matterId?: string; matterName?: string }[] = [];
    enrichedMatters.forEach(c => {
      if (c.failedCount > 0) {
        items.push({ id: `fail-${c.id}`, type: 'error', label: `${c.failedCount} failed document${c.failedCount > 1 ? 's' : ''}`, matterId: c.id, matterName: c.name });
      }
      if (c.status === 'active' && c.fileCount === 0) {
        items.push({ id: `empty-${c.id}`, type: 'warning', label: 'No documents uploaded', matterId: c.id, matterName: c.name });
      }
      if (c.processingCount > 0) {
        items.push({ id: `proc-${c.id}`, type: 'info', label: `${c.processingCount} document${c.processingCount > 1 ? 's' : ''} processing`, matterId: c.id, matterName: c.name });
      }
    });
    return items.slice(0, 8);
  }, [enrichedMatters]);

  // ── Recent activity ───────────────────────────────────────
  const recentActivity = useMemo(() => {
    const events: { id: string; type: 'matter' | 'file'; action: string; name: string; time: string; matterId?: string }[] = [];
    // Recent matter updates
    enrichedMatters
      .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
      .slice(0, 5)
      .forEach(c => {
        const isNew = new Date(c.created_at).getTime() === new Date(c.updated_at).getTime();
        events.push({
          id: `m-${c.id}`,
          type: 'matter',
          action: isNew ? 'Created' : 'Updated',
          name: c.name,
          time: c.updated_at,
          matterId: c.id,
        });
      });
    // Recent files
    files
      .filter(f => f.case_id && f.created_at)
      .sort((a, b) => new Date(b.created_at || '').getTime() - new Date(a.created_at || '').getTime())
      .slice(0, 5)
      .forEach(f => {
        const matterName = cases.find(c => c.id === f.case_id)?.name;
        if (matterName && matterName !== 'General Documents') {
          events.push({
            id: `f-${f.id}`,
            type: 'file',
            action: f.status === 'ready' ? 'Processed' : f.status === 'processing' ? 'Processing' : f.status === 'failed' ? 'Failed' : 'Uploaded',
            name: f.name,
            time: f.created_at || '',
            matterId: f.case_id,
          });
        }
      });
    return events
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 8);
  }, [enrichedMatters, files, cases]);

  const handleSelectMatter = (matter: Case) => {
    setActiveMatter(matter);
  };

  // ── Loading state ─────────────────────────────────────────
  if (isInitialLoad) {
    return (
      <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
        <div className="max-w-6xl mx-auto px-4 py-6 sm:px-6 lg:px-8 space-y-6">
          <div className="animate-pulse space-y-6">
            <div className="h-8 w-48 bg-gray-200 dark:bg-gray-700 rounded-lg" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map(i => <div key={i} className="h-24 bg-gray-200 dark:bg-gray-700 rounded-xl" />)}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3, 4, 5, 6].map(i => <div key={i} className="h-40 bg-gray-200 dark:bg-gray-700 rounded-xl" />)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Empty portfolio ───────────────────────────────────────
  if (enrichedMatters.length === 0) {
    return (
      <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
        <div className="max-w-6xl mx-auto px-4 py-6 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center justify-center py-24 animate-card-in">
            <div className="w-20 h-20 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center mb-6">
              <span className="text-4xl">📁</span>
            </div>
            <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
              No matters yet
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center max-w-sm mb-6">
              Create your first matter to start organizing cases, uploading documents, and generating intelligence.
            </p>
            <button
              onClick={onNavigateToChat}
              className="px-4 py-2 text-sm rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:opacity-90 transition-opacity"
            >
              Go to Chat
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
      <div className="max-w-6xl mx-auto px-4 py-6 sm:px-6 lg:px-8 space-y-6">

        {/* ═══ Header ═══ */}
        <div className="flex items-center justify-between animate-card-in opacity-0" style={{ animationDelay: '0ms' }}>
          <div className="flex items-center gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                  Command Center
                </h1>
                {isSyncing && (
                  <div className="flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
                    <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    <span>Syncing...</span>
                  </div>
                )}
              </div>
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                Portfolio overview — {stats.total} matter{stats.total !== 1 ? 's' : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleSync}
              disabled={isSyncing}
              className="text-sm px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center gap-2"
              title="Refresh all data"
            >
              <svg className={`w-4 h-4 ${isSyncing ? 'animate-spin' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              {isSyncing ? 'Syncing...' : 'Sync'}
            </button>
            <button
              onClick={onNavigateToChat}
              className="text-sm px-3 py-1.5 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:opacity-90 transition-opacity"
            >
              Open Chat
            </button>
          </div>
        </div>

        {/* ═══ Portfolio KPI Cards ═══ */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 animate-card-in opacity-0" style={{ animationDelay: '50ms' }}>
          {[
            { label: 'Active Matters', value: stats.active, icon: '📂', accent: stats.active > 0 },
            { label: 'Total Documents', value: stats.totalFiles, icon: '📄', accent: false },
            { label: 'Processing', value: stats.processing, icon: '⏳', accent: stats.processing > 0, pulse: stats.processing > 0 },
            { label: 'Needs Attention', value: attentionItems.length, icon: '🔔', accent: attentionItems.length > 0, alert: attentionItems.length > 0 },
          ].map((kpi) => (
            <div
              key={kpi.label}
              className={`rounded-xl border px-4 py-3 transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 cursor-default ${
                kpi.alert
                  ? 'border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-900/10'
                  : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xl">{kpi.icon}</span>
                {kpi.pulse && <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse-dot" />}
              </div>
              <p className={`text-2xl font-bold mt-1 ${
                kpi.accent ? 'text-gray-900 dark:text-gray-100' : 'text-gray-700 dark:text-gray-300'
              }`}>
                {kpi.value}
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{kpi.label}</p>
            </div>
          ))}
        </div>

        {/* ═══ Attention Required ═══ */}
        {attentionItems.length > 0 && (
          <section className="rounded-xl border border-amber-200 dark:border-amber-800/60 bg-white dark:bg-gray-800 overflow-hidden animate-card-in opacity-0" style={{ animationDelay: '100ms' }}>
            <div className="px-4 py-2.5 border-b border-amber-100 dark:border-amber-900/30 bg-amber-50/50 dark:bg-amber-900/10">
              <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
                Attention Required
              </h2>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {attentionItems.map(item => (
                <button
                  key={item.id}
                  onClick={() => {
                    const matter = cases.find(c => c.id === item.matterId);
                    if (matter) handleSelectMatter(matter);
                  }}
                  className="w-full px-4 py-2.5 flex items-center gap-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors group"
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    item.type === 'error' ? 'bg-red-500' : item.type === 'warning' ? 'bg-amber-500' : 'bg-blue-500'
                  }`} />
                  <span className="text-sm text-gray-800 dark:text-gray-200 font-medium truncate">
                    {item.matterName}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400 flex-shrink-0">
                    {item.label}
                  </span>
                  <svg className="w-3.5 h-3.5 text-gray-400 ml-auto opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* ═══ Status & Type Overview Row ═══ */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 animate-card-in opacity-0" style={{ animationDelay: '150ms' }}>
          {/* Status Distribution */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Status Distribution</h3>
            <div className="space-y-2.5">
              {(['active', 'archived', 'closed'] as const).map(status => {
                const count = status === 'active' ? stats.active : status === 'archived' ? stats.archived : stats.closed;
                const pct = stats.total > 0 ? (count / stats.total) * 100 : 0;
                const meta = STATUS_META[status];
                return (
                  <button
                    key={status}
                    onClick={() => setStatusFilter(prev => prev === status ? 'all' : status)}
                    className={`w-full flex items-center gap-3 group text-left rounded-lg px-2 py-1.5 transition-colors ${
                      statusFilter === status ? 'bg-gray-100 dark:bg-gray-700' : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                    }`}
                  >
                    <span className={`w-2.5 h-2.5 rounded-full ${meta.dot}`} />
                    <span className="text-sm text-gray-700 dark:text-gray-300 flex-1">{meta.label}</span>
                    <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 w-8 text-right">{count}</span>
                    <div className="w-20 h-1.5 bg-gray-100 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-500 ${meta.dot}`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Type Distribution */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 px-4 py-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 mb-3">Matter Types</h3>
            {typeDistribution.length > 0 ? (
              <div className="space-y-2">
                {typeDistribution.map(({ type, count, meta }) => (
                  <button
                    key={type}
                    onClick={() => setTypeFilter(prev => prev === type ? 'all' : type as MatterType)}
                    className={`w-full flex items-center gap-2.5 text-left rounded-lg px-2 py-1.5 transition-colors ${
                      typeFilter === type ? 'bg-gray-100 dark:bg-gray-700' : 'hover:bg-gray-50 dark:hover:bg-gray-700/30'
                    }`}
                  >
                    <span className="text-sm">{meta.icon}</span>
                    <span className="text-sm text-gray-700 dark:text-gray-300 flex-1">{meta.label}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${meta.color}`}>{count}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-4">No types assigned</p>
            )}
          </div>
        </div>

        {/* ═══ Search & Filter Bar ═══ */}
        <div className="flex flex-col sm:flex-row gap-3 animate-card-in opacity-0" style={{ animationDelay: '200ms' }}>
          {/* Search */}
          <div className="relative flex-1">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search matters, clients, or references..."
              className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-300 dark:focus:ring-gray-600 transition-shadow"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-400"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>

          {/* Sort */}
          <div className="flex items-center gap-1.5 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-0.5">
            {([
              { key: 'updated' as const, label: 'Recent' },
              { key: 'name' as const, label: 'Name' },
              { key: 'files' as const, label: 'Files' },
            ]).map(opt => (
              <button
                key={opt.key}
                onClick={() => setSortBy(opt.key)}
                className={`px-2.5 py-1.5 text-xs rounded-md font-medium transition-colors ${
                  sortBy === opt.key
                    ? 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Active filter chips */}
          {(statusFilter !== 'all' || typeFilter !== 'all') && (
            <button
              onClick={() => { setStatusFilter('all'); setTypeFilter('all'); }}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Clear filters
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* ═══ Matter Cards Grid ═══ */}
        {filteredMatters.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredMatters.map((matter, idx) => {
              const typeMeta = MATTER_TYPE_META[matter.matter_type || 'other'] || MATTER_TYPE_META.other;
              const statusMeta = STATUS_META[matter.status] || STATUS_META.active;
              
              // Determine accent color and status indicator
              const accentInfo = matter.hasIssues 
                ? { 
                    border: 'border-l-amber-500 dark:border-l-amber-400', 
                    bg: 'bg-amber-50 dark:bg-amber-900/10',
                    badge: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
                    icon: '⚠️',
                    label: 'Needs Attention'
                  }
                : matter.status === 'active'
                ? { 
                    border: 'border-l-emerald-500 dark:border-l-emerald-400', 
                    bg: 'bg-emerald-50/50 dark:bg-emerald-900/5',
                    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
                    icon: '✓',
                    label: 'Active'
                  }
                : matter.status === 'closed'
                ? { 
                    border: 'border-l-gray-400 dark:border-l-gray-600', 
                    bg: 'bg-gray-50 dark:bg-gray-800/50',
                    badge: 'bg-gray-100 text-gray-600 dark:bg-gray-700/50 dark:text-gray-400',
                    icon: '■',
                    label: 'Closed'
                  }
                : { 
                    border: 'border-l-gray-300 dark:border-l-gray-700', 
                    bg: 'bg-gray-50/50 dark:bg-gray-800/30',
                    badge: 'bg-gray-100 text-gray-500 dark:bg-gray-700/30 dark:text-gray-500',
                    icon: '📦',
                    label: 'Archived'
                  };

              // Only apply animation on initial render
              const shouldAnimate = !hasInitialAnimationPlayed;
              const animationClasses = shouldAnimate ? 'animate-card-in opacity-0' : '';
              const animationStyle = shouldAnimate ? { animationDelay: `${250 + idx * 50}ms` } : {};

              return (
                <button
                  key={matter.id}
                  ref={(el) => {
                    if (el) cardsRef.current.set(matter.id, el);
                    else cardsRef.current.delete(matter.id);
                  }}
                  onClick={() => handleSelectMatter(matter)}
                  className={`relative text-left rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden transition-all duration-200 hover:shadow-lg hover:-translate-y-1 hover:border-gray-300 dark:hover:border-gray-600 group border-l-4 ${accentInfo.border} ${animationClasses}`}
                  style={animationStyle}
                >
                  {/* Subtle background tint matching accent */}
                  <div className={`absolute inset-0 ${accentInfo.bg} pointer-events-none opacity-40`} />

                  <div className="relative px-4 py-3.5 flex flex-col" style={{ minHeight: '180px' }}>
                    {/* Row 1: Status Badge + Type Badge */}
                    <div className="flex items-center justify-between gap-2 mb-2.5">
                      <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-semibold ${accentInfo.badge}`}>
                        <span>{accentInfo.icon}</span>
                        {accentInfo.label}
                      </span>
                      <span className={`flex-shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${typeMeta.color}`}>
                        <span>{typeMeta.icon}</span>
                        {typeMeta.label}
                      </span>
                    </div>

                    {/* Row 2: Name */}
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate group-hover:text-gray-700 dark:group-hover:text-white transition-colors mb-2">
                      {matter.name}
                    </h3>

                    {/* Row 3: Matter Reference (always allocate space) */}
                    <div className="mb-2.5 h-[14px]">
                      {matter.matter_ref ? (
                        <span className="text-[11px] text-gray-400 dark:text-gray-500 font-mono">
                          {matter.matter_ref}
                        </span>
                      ) : (
                        <span className="text-[11px] text-transparent select-none">-</span>
                      )}
                    </div>

                    {/* Row 4: Client info (always allocate space) */}
                    <div className="mb-3 h-[16px]">
                      {matter.client_name ? (
                        <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
                          <span className="text-gray-400 dark:text-gray-500">Client:</span>{' '}
                          {matter.client_name}
                        </p>
                      ) : (
                        <span className="text-xs text-transparent select-none">-</span>
                      )}
                    </div>

                    {/* Row 5: Stats (files, folders) */}
                    <div className="flex items-center gap-3 mb-3 pt-2 border-t border-gray-100 dark:border-gray-700/50">
                      <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400" title={`${matter.fileCount} documents`}>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                        </svg>
                        <span>{matter.fileCount}</span>
                      </div>
                      <div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400" title={`${matter.folderCount} folders`}>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
                        </svg>
                        <span>{matter.folderCount}</span>
                      </div>
                    </div>

                    {/* Row 6: Processing/failed badges (always allocate space) */}
                    <div className="mb-auto min-h-[20px] flex items-start">
                      {(matter.processingCount > 0 || matter.failedCount > 0) && (
                        <div className="flex items-center gap-2 flex-wrap">
                          {matter.processingCount > 0 && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse-dot" />
                              {matter.processingCount} processing
                            </span>
                          )}
                          {matter.failedCount > 0 && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-50 text-red-700 dark:bg-red-900/30 dark:text-red-300">
                              {matter.failedCount} failed
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Row 7: Footer (time) - always at bottom */}
                    <div className="flex items-center justify-between text-[10px] text-gray-400 dark:text-gray-500 mt-2">
                      <span>{timeAgo(matter.updated_at)}</span>
                      <span className="opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 dark:text-gray-400">
                        View Brief →
                      </span>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-16 animate-card-in">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              No matters match your filters.
            </p>
            <button
              onClick={() => { setStatusFilter('all'); setTypeFilter('all'); setSearchQuery(''); }}
              className="mt-2 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 underline"
            >
              Clear all filters
            </button>
          </div>
        )}

        {/* ═══ Recent Activity Timeline ═══ */}
        {recentActivity.length > 0 && (
          <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden animate-card-in opacity-0" style={{ animationDelay: `${250 + Math.min(filteredMatters.length, 6) * 50 + 50}ms` }}>
            <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-700/50">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Recent Activity</h3>
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-800">
              {recentActivity.map((event, idx) => (
                <button
                  key={event.id}
                  onClick={() => {
                    if (event.matterId) {
                      const matter = cases.find(c => c.id === event.matterId);
                      if (matter) handleSelectMatter(matter);
                    }
                  }}
                  className="w-full px-4 py-2.5 flex items-center gap-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors group"
                >
                  <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
                    event.type === 'matter'
                      ? 'bg-indigo-50 dark:bg-indigo-900/30'
                      : event.action === 'Failed'
                        ? 'bg-red-50 dark:bg-red-900/30'
                        : 'bg-gray-100 dark:bg-gray-700'
                  }`}>
                    <span className="text-xs">
                      {event.type === 'matter' ? '📂' : event.action === 'Failed' ? '❌' : event.action === 'Processing' ? '⏳' : '📄'}
                    </span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-800 dark:text-gray-200 truncate">{event.name}</p>
                    <p className="text-[10px] text-gray-400 dark:text-gray-500">
                      {event.action} · {timeAgo(event.time)}
                    </p>
                  </div>
                  <svg className="w-3.5 h-3.5 text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Footer spacing */}
        <div className="h-8" />
      </div>
    </div>
  );
};

// ── Color utilities ──

function severityColor(s: string): string {
  switch (s?.toLowerCase()) {
    case 'critical': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300 border-red-200 dark:border-red-800';
    case 'high': return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300 border-orange-200 dark:border-orange-800';
    case 'medium': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300 border-yellow-200 dark:border-yellow-800';
    case 'low': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300 border-green-200 dark:border-green-800';
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-200 dark:border-gray-700';
  }
}

function entityTypeIcon(t: string): string {
  switch (t?.toLowerCase()) {
    case 'party': return '👤';
    case 'court': return '⚖️';
    case 'statute': return '📜';
    case 'judge': return '🧑‍⚖️';
    case 'jurisdiction': return '🌍';
    case 'witness': return '🗣️';
    case 'law_firm': return '🏢';
    case 'government_agency': return '🏛️';
    case 'law_enforcement': return '🚔';
    case 'location': return '📍';
    default: return '📋';
  }
}

// ── Types ──

interface MatterBriefProps {
  onNavigateToChat: () => void;
}

interface BriefData {
  summary: intel.MatterSummary | null;
  entities: intel.CanonicalEntityItem[];
  risks: intel.RiskItem[];
  obligations: intel.ObligationItem[];
  dates: intel.DateItem[];
  overview: intel.MatterOverview | null;
}

// ── Component ──

const MatterBrief: React.FC<MatterBriefProps> = ({ onNavigateToChat }) => {
  const { activeMatter, clearActiveMatter } = useMatter();
  const [data, setData] = useState<BriefData>({
    summary: null, entities: [], risks: [], obligations: [], dates: [], overview: null,
  });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [showExtractionProgress, setShowExtractionProgress] = useState(false);
  const [downloadingReport, setDownloadingReport] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const caseId = activeMatter?.id;
  const fetchingRef = useRef(false);

  const loadData = useCallback(async (force = false) => {
    if (!caseId || fetchingRef.current) return;

    // ─── 1. Load from cache immediately (instant load) ───
    const cachedData = cache.getCachedIntelligence<BriefData>(caseId, 'matter_brief');
    const cacheStatus = cachedData.status;

    if (cachedData.data && cacheStatus !== 'empty') {
      setData(cachedData.data);
      setLoading(false);
    }

    // ─── 2. Decide if we need to fetch (fresh data or force refresh) ───
    const needsFetch = force || cache.shouldRefetch(cacheStatus);
    const needsBackgroundSync = !force && cache.shouldBackgroundRefetch(cacheStatus);

    if (!needsFetch && !needsBackgroundSync) {
      setLoading(false);
      return;
    }

    // ─── 3. Fetch data (loading or background sync) ───
    fetchingRef.current = true;

    if (needsFetch && !cachedData.data) {
      setLoading(true);
    } else {
      setSyncing(true);
    }

    setError(null);

    try {
      const [summaryRes, entitiesRes, risksRes, obligationsRes, datesRes, overviewRes] = await Promise.allSettled([
        intel.getSummary(caseId),
        intel.getCanonicalEntities(caseId),
        intel.getRisks(caseId),
        intel.getObligations(caseId),
        intel.getDates(caseId),
        intel.getOverview(caseId),
      ]);

      const freshData: BriefData = {
        summary: summaryRes.status === 'fulfilled' ? summaryRes.value : null,
        entities: entitiesRes.status === 'fulfilled' ? entitiesRes.value : [],
        risks: risksRes.status === 'fulfilled' ? risksRes.value : [],
        obligations: obligationsRes.status === 'fulfilled' ? obligationsRes.value : [],
        dates: datesRes.status === 'fulfilled' ? datesRes.value : [],
        overview: overviewRes.status === 'fulfilled' ? overviewRes.value : null,
      };

      setData(freshData);
      cache.setCachedIntelligence(caseId, 'matter_brief', freshData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load brief');
    } finally {
      setLoading(false);
      setSyncing(false);
      fetchingRef.current = false;
    }
  }, [caseId]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleGenerateSummary = async () => {
    if (!caseId) return;
    setGeneratingSummary(true);
    try {
      await intel.generateSummary(caseId);
      // Invalidate cache and force refresh
      cache.invalidateIntelligence(caseId);
      setTimeout(() => loadData(true), 2000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate summary');
    } finally {
      setGeneratingSummary(false);
    }
  };

  const handleReprocess = async () => {
    if (!caseId) return;
    setReprocessing(true);
    setError(null);
    try {
      await intel.reprocessMatter(caseId);
      // Show progress tracker
      setShowExtractionProgress(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to queue extraction jobs');
      setReprocessing(false);
    }
  };

  const handleExtractionComplete = () => {
    setReprocessing(false);
    setShowExtractionProgress(false);
    // Invalidate cache and force refresh
    cache.invalidateIntelligence(caseId!);
    setTimeout(() => loadData(true), 1000);
  };

  const handleExtractionError = (errorMsg: string) => {
    setError(errorMsg);
  };

  const handleDownloadReport = async () => {
    if (!caseId) return;
    setDownloadingReport(true);
    setError(null);
    try {
      const report = await intel.getFullReport(caseId);
      const matterName = activeMatter?.name || activeMatter?.case_number || 'Matter';
      const ts = new Date().toISOString().split('T')[0];

      // ── Format report as professional Markdown ──
      const lines: string[] = [];
      lines.push(`# Full Intelligence Report — ${matterName}`);
      lines.push(`Generated: ${(report as any).generated_at || new Date().toISOString()}\n`);
      lines.push('---\n');

      // Compliance
      const comp = (report as any).compliance || report.compliance;
      if (comp) {
        lines.push('## Obligation Compliance\n');
        const s = comp.summary || {};
        lines.push(`| Metric | Count |`);
        lines.push(`| --- | --- |`);
        lines.push(`| Total Obligations | ${s.total ?? '—'} |`);
        lines.push(`| Fulfilled | ${s.fulfilled ?? '—'} |`);
        lines.push(`| Overdue | ${s.overdue ?? '—'} |`);
        lines.push(`| Upcoming | ${s.upcoming ?? '—'} |`);
        lines.push('');
        if (comp.obligations?.length) {
          lines.push('### Obligation Details\n');
          comp.obligations.forEach((o: any, i: number) => {
            lines.push(`${i + 1}. **${o.obligation_text || o.text || 'Obligation'}**`);
            if (o.due_date) lines.push(`   - Due: ${o.due_date.split('T')[0]}`);
            if (o.status) lines.push(`   - Status: ${o.status}`);
            if (o.obligor) lines.push(`   - Obligor: ${o.obligor}`);
            if (o.obligee) lines.push(`   - Obligee: ${o.obligee}`);
            lines.push('');
          });
        }
      }

      // Risk Matrix
      const rm = (report as any).risk_matrix || report.riskMatrix;
      if (rm) {
        lines.push('## Risk Matrix\n');
        lines.push(`**Overall Risk Score:** ${rm.risk_score ?? '—'} / 100`);
        lines.push(`**Total Risks:** ${rm.total_risks ?? '—'}\n`);
        if (rm.severity_breakdown) {
          lines.push('| Severity | Count |');
          lines.push('| --- | --- |');
          Object.entries(rm.severity_breakdown).forEach(([sev, count]) => {
            lines.push(`| ${sev} | ${count} |`);
          });
          lines.push('');
        }
        if (rm.risks?.length) {
          lines.push('### Risk Details\n');
          rm.risks.forEach((r: any, i: number) => {
            lines.push(`${i + 1}. **[${(r.severity || '').toUpperCase()}]** ${r.risk_description || r.description || 'Risk'}`);
            if (r.recommendation) lines.push(`   - Recommendation: ${r.recommendation}`);
            if (r.category) lines.push(`   - Category: ${r.category}`);
            lines.push('');
          });
        }
      }

      // Timeline
      const tl = (report as any).timeline;
      if (tl) {
        lines.push('## Timeline\n');
        const events = tl.events || tl.timeline || [];
        if (events.length) {
          lines.push('| Date | Event | Type |');
          lines.push('| --- | --- | --- |');
          events.forEach((e: any) => {
            const date = (e.date || e.date_value || '').split('T')[0];
            lines.push(`| ${date} | ${e.description || e.event || '—'} | ${e.date_type || e.type || '—'} |`);
          });
          lines.push('');
        }
      }

      // Conflicts
      const conf = (report as any).conflicts;
      if (conf?.conflicts?.length) {
        lines.push('## Conflict Analysis\n');
        conf.conflicts.forEach((c: any, i: number) => {
          lines.push(`${i + 1}. **${c.type || 'Conflict'}** — ${c.description || c.conflict || ''}`);
          if (c.documents?.length) lines.push(`   - Documents: ${c.documents.join(', ')}`);
          if (c.severity) lines.push(`   - Severity: ${c.severity}`);
          lines.push('');
        });
      }

      lines.push('---\n');
      lines.push(`*Report generated by Maks Legal Intelligence Platform*`);

      // Trigger download
      const content = lines.join('\n');
      const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${matterName.replace(/[^a-zA-Z0-9-_ ]/g, '')}_Full_Report_${ts}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate report');
    } finally {
      setDownloadingReport(false);
    }
  };

  // Derived data
  const criticalRisks = data.risks.filter(r => r.severity === 'critical' || r.severity === 'high').slice(0, 5);
  const topEntities = data.entities
    .filter(e => e.verification_status !== 'rejected')
    .sort((a, b) => b.mention_count - a.mention_count)
    .slice(0, 12);
  const upcomingDates = data.dates
    .filter(d => d.date_value >= new Date().toISOString().split('T')[0])
    .sort((a, b) => a.date_value.localeCompare(b.date_value))
    .slice(0, 5);
  const overdueObligations = data.obligations
    .filter(o => o.due_date && o.due_date < new Date().toISOString() && o.status !== 'fulfilled' && o.status !== 'completed')
    .slice(0, 5);
  const hasAnyData = data.entities.length > 0 || data.risks.length > 0 || data.obligations.length > 0 || data.dates.length > 0;
  const summaryContent = data.summary?.content as Record<string, any> | null;

  // Risk score (0-100): weighted by severity
  const riskScore = useMemo(() => {
    if (data.risks.length === 0) return 0;
    const weights: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
    let total = 0;
    for (const r of data.risks) total += weights[r.severity?.toLowerCase()] || 1;
    return Math.round((total / (data.risks.length * 4)) * 100);
  }, [data.risks]);

  // Compliance rate
  const complianceRate = useMemo(() => {
    if (data.obligations.length === 0) return null;
    const completed = data.obligations.filter(o => o.status === 'completed' || o.status === 'fulfilled').length;
    return Math.round((completed / data.obligations.length) * 100);
  }, [data.obligations]);

  if (!activeMatter || activeMatter.name === 'General Documents') {
    return <CommandCenter onNavigateToChat={onNavigateToChat} />;
  }

  return (
    <div className="h-full overflow-y-auto bg-gray-50 dark:bg-gray-900">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">

        {/* ── Header ── */}
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <button
                onClick={() => clearActiveMatter()}
                className="p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 transition-colors group"
                title="Back to Command Center"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
                </svg>
              </button>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Matter Brief
              </h1>
              {syncing && (
                <div className="flex items-center gap-1.5 text-xs text-gray-400 dark:text-gray-500">
                  <svg className="animate-spin h-3.5 w-3.5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <span>Syncing...</span>
                </div>
              )}
            </div>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 ml-11">
              {activeMatter.name || activeMatter.case_number || 'Untitled Matter'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onNavigateToChat}
              className="text-sm px-3 py-1.5 rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:opacity-90 transition-opacity"
            >
              Ask about this matter
            </button>
          </div>
        </div>

        {/* ── Error ── */}
        {error && (
          <div className="p-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300">
            {error}
            <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
          </div>
        )}

        {/* ── Loading ── */}
        {loading && (
          <div className="space-y-4">
            {[1, 2, 3].map(i => (
              <div key={i} className="animate-pulse rounded-lg bg-gray-100 dark:bg-gray-800 h-24" />
            ))}
          </div>
        )}

        {!loading && (
          <>
            {/* ── Executive Summary ── */}
            <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden animate-fade-slide-up transition-all duration-200 hover:shadow-md">
              <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
                <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Executive Summary</h2>
              </div>
              <div className="px-4 py-3">
                {summaryContent ? (
                  <div className="space-y-2">
                    {summaryContent.executive_summary ? (
                      <>
                        <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                          {summaryContent.executive_summary}
                        </p>
                        {summaryContent.key_findings && Array.isArray(summaryContent.key_findings) && summaryContent.key_findings.length > 0 && (
                          <div className="mt-3">
                            <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1.5">Key Findings</p>
                            <ul className="space-y-1">
                              {summaryContent.key_findings.map((f: string, i: number) => (
                                <li key={i} className="text-sm text-gray-600 dark:text-gray-400 flex gap-2">
                                  <span className="text-gray-400 dark:text-gray-600 mt-0.5">•</span>
                                  <span>{f}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {data.summary?.stale && (
                          <p className="text-xs text-amber-600 dark:text-amber-400 mt-2 italic">
                            This summary may be outdated — new documents have been processed since it was generated.
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                        {String(summaryContent.summary_text || summaryContent)}
                      </p>
                    )}
                  </div>
                ) : hasAnyData ? (
                  <div className="text-center py-4">
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                      Documents have been processed. Generate an executive summary?
                    </p>
                    <button
                      onClick={handleGenerateSummary}
                      disabled={generatingSummary}
                      className="px-4 py-2 text-sm rounded-lg bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:opacity-90 transition-opacity disabled:opacity-50"
                    >
                      {generatingSummary ? 'Generating...' : 'Generate Summary'}
                    </button>
                  </div>
                ) : (
                  <p className="text-sm text-gray-400 dark:text-gray-500 text-center py-4">
                    No intelligence data yet. Upload documents to generate a matter brief.
                  </p>
                )}
              </div>
            </section>

            {/* ── Intelligence Overview Stats ── */}
            {hasAnyData && (
              <div className="space-y-3" style={{ animationDelay: '50ms' }}>
                {/* Risk Score & Compliance Rate badges */}
                {(data.risks.length > 0 || complianceRate !== null) && (
                  <div className="flex gap-3">
                    {data.risks.length > 0 && (
                      <div className={`flex-1 rounded-lg border px-3 py-2.5 animate-card-in opacity-0 ${
                        riskScore >= 75 ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10' :
                        riskScore >= 50 ? 'border-orange-200 dark:border-orange-800 bg-orange-50 dark:bg-orange-900/10' :
                        riskScore >= 25 ? 'border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/10' :
                        'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10'
                      }`}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-500 dark:text-gray-400">Risk Score</span>
                          <span className={`text-lg font-bold ${
                            riskScore >= 75 ? 'text-red-600' : riskScore >= 50 ? 'text-orange-600' : riskScore >= 25 ? 'text-yellow-600' : 'text-green-600'
                          }`}>{riskScore}/100</span>
                        </div>
                        <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full mt-1.5 overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-700 ${
                            riskScore >= 75 ? 'bg-red-500' : riskScore >= 50 ? 'bg-orange-500' : riskScore >= 25 ? 'bg-yellow-500' : 'bg-green-500'
                          }`} style={{ width: `${riskScore}%` }} />
                        </div>
                      </div>
                    )}
                    {complianceRate !== null && (
                      <div className={`flex-1 rounded-lg border px-3 py-2.5 animate-card-in opacity-0 ${
                        complianceRate >= 80 ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/10' :
                        complianceRate >= 50 ? 'border-yellow-200 dark:border-yellow-800 bg-yellow-50 dark:bg-yellow-900/10' :
                        'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10'
                      }`} style={{ animationDelay: '25ms' }}>
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-gray-500 dark:text-gray-400">Compliance</span>
                          <span className={`text-lg font-bold ${
                            complianceRate >= 80 ? 'text-green-600' : complianceRate >= 50 ? 'text-yellow-600' : 'text-red-600'
                          }`}>{complianceRate}%</span>
                        </div>
                        <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full mt-1.5 overflow-hidden">
                          <div className={`h-full rounded-full transition-all duration-700 ${
                            complianceRate >= 80 ? 'bg-green-500' : complianceRate >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                          }`} style={{ width: `${complianceRate}%` }} />
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: 'Entities', value: data.entities.length, icon: '👤' },
                  { label: 'Risks', value: data.risks.length, icon: '⚠️', alert: criticalRisks.length > 0 },
                  { label: 'Obligations', value: data.obligations.length, icon: '⚖️', alert: overdueObligations.length > 0 },
                  { label: 'Key Dates', value: data.dates.length, icon: '📅' },
                ].map((stat, idx) => (
                  <div
                    key={stat.label}
                    className={`rounded-lg border px-3 py-2.5 transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 cursor-default animate-card-in opacity-0 ${
                      stat.alert
                        ? 'border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10'
                        : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
                    }`}
                    style={{ animationDelay: `${idx * 75}ms` }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="text-base">{stat.icon}</span>
                      <span className="text-lg font-semibold text-gray-900 dark:text-gray-100">{stat.value}</span>
                    </div>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{stat.label}</p>
                  </div>
                ))}
                </div>
              </div>
            )}

            {/* ── Key Parties ── */}
            {topEntities.length > 0 && (
              <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden animate-fade-slide-up transition-all duration-200 hover:shadow-md" style={{ animationDelay: '100ms' }}>
                <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Key Parties & Entities</h2>
                </div>
                <div className="px-4 py-3">
                  <div className="flex flex-wrap gap-2">
                    {topEntities.map(entity => (
                      <div
                        key={entity.id}
                        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-sm transition-all duration-200 hover:shadow-sm hover:-translate-y-0.5"
                        title={`${entity.entity_type} · ${entity.mention_count} mentions · ${entity.verification_status}`}
                      >
                        <span className="text-xs">{entityTypeIcon(entity.entity_type)}</span>
                        <span className="text-gray-800 dark:text-gray-200 font-medium">{entity.canonical_name}</span>
                        <span className="text-[10px] text-gray-400 dark:text-gray-500">
                          {entity.entity_type.replace(/_/g, ' ')}
                        </span>
                        {entity.verification_status === 'auto_verified' || entity.verification_status === 'user_verified' ? (
                          <svg className="w-3 h-3 text-green-500" fill="currentColor" viewBox="0 0 20 20">
                            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                          </svg>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {/* ── Critical Risks ── */}
            {criticalRisks.length > 0 && (
              <section className="rounded-xl border border-red-200 dark:border-red-800 bg-white dark:bg-gray-800 overflow-hidden animate-fade-slide-up transition-all duration-200 hover:shadow-md" style={{ animationDelay: '150ms' }}>
                <div className="px-4 py-3 border-b border-red-100 dark:border-red-900/50 bg-red-50 dark:bg-red-900/10">
                  <h2 className="text-sm font-semibold text-red-800 dark:text-red-300 flex items-center gap-1.5">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-2.694-.833-3.464 0L3.34 16.5c-.77.833.192 2.5 1.732 2.5z" />
                    </svg>
                    Critical & High Risks ({criticalRisks.length})
                  </h2>
                </div>
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                  {criticalRisks.map(risk => (
                    <div key={risk.id} className="px-4 py-3">
                      <div className="flex items-start gap-2">
                        <span className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase ${severityColor(risk.severity)}`}>
                          {risk.severity}
                        </span>
                        <div className="min-w-0">
                          <p className="text-sm text-gray-800 dark:text-gray-200">{risk.risk_description}</p>
                          {risk.recommendation && (
                            <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                              <span className="font-medium">Recommendation:</span> {risk.recommendation}
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── Overdue Obligations ── */}
            {overdueObligations.length > 0 && (
              <section className="rounded-xl border border-amber-200 dark:border-amber-800 bg-white dark:bg-gray-800 overflow-hidden animate-fade-slide-up transition-all duration-200 hover:shadow-md" style={{ animationDelay: '200ms' }}>
                <div className="px-4 py-3 border-b border-amber-100 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-900/10">
                  <h2 className="text-sm font-semibold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    Overdue Obligations ({overdueObligations.length})
                  </h2>
                </div>
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                  {overdueObligations.map(obl => (
                    <div key={obl.id} className="px-4 py-3">
                      <p className="text-sm text-gray-800 dark:text-gray-200">{obl.obligation_text}</p>
                      <div className="flex items-center gap-3 mt-1 text-xs text-gray-500 dark:text-gray-400">
                        {obl.due_date && <span className="text-red-600 dark:text-red-400 font-medium">Due: {obl.due_date.split('T')[0]}</span>}
                        {obl.obligor && <span>By: {obl.obligor}</span>}
                        {obl.obligee && <span>To: {obl.obligee}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── Upcoming Deadlines ── */}
            {upcomingDates.length > 0 && (
              <section className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 overflow-hidden animate-fade-slide-up transition-all duration-200 hover:shadow-md" style={{ animationDelay: '250ms' }}>
                <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800">
                  <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">Upcoming Deadlines</h2>
                </div>
                <div className="divide-y divide-gray-100 dark:divide-gray-800">
                  {upcomingDates.map(d => (
                    <div key={d.id} className="px-4 py-2.5 flex items-center gap-3">
                      <div className="flex-shrink-0 w-16 text-center">
                        <span className="text-xs font-mono font-medium text-gray-600 dark:text-gray-300">
                          {d.date_value.split('T')[0]}
                        </span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm text-gray-800 dark:text-gray-200">{d.description}</p>
                        <span className="text-[10px] text-gray-400 dark:text-gray-500 uppercase">{d.date_type.replace(/_/g, ' ')}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* ── Extraction Progress (when active) ── */}
            {showExtractionProgress && caseId && (
              <section className="pb-4 animate-fade-in">
                <ExtractionProgress
                  caseId={caseId}
                  onComplete={handleExtractionComplete}
                  onError={handleExtractionError}
                />
              </section>
            )}

            {/* ── Quick Actions ── */}
            <section className="flex flex-wrap gap-2 pt-2 pb-8 animate-fade-in" style={{ animationDelay: '300ms' }}>
              {!summaryContent && hasAnyData && (
                <button
                  onClick={handleGenerateSummary}
                  disabled={generatingSummary}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all duration-200 hover:shadow-sm disabled:opacity-50"
                >
                  {generatingSummary ? 'Generating...' : '✨ Generate Summary'}
                </button>
              )}
              <button
                onClick={handleReprocess}
                disabled={reprocessing}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all duration-200 hover:shadow-sm disabled:opacity-50"
              >
                {reprocessing ? 'Queuing...' : '🔄 Reprocess Documents'}
              </button>
              <button
                onClick={onNavigateToChat}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all duration-200 hover:shadow-sm"
              >
                💬 Ask about this matter
              </button>
              {hasAnyData && (
                <button
                  onClick={handleDownloadReport}
                  disabled={downloadingReport}
                  className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all duration-200 hover:shadow-sm disabled:opacity-50"
                >
                  {downloadingReport ? 'Generating...' : '📥 Download Full Report'}
                </button>
              )}
              <button
                onClick={() => {
                  if (caseId) {
                    cache.invalidateIntelligence(caseId);
                    loadData(true);
                  }
                }}
                className="text-xs px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-all duration-200 hover:shadow-sm"
              >
                ↻ Refresh
              </button>
            </section>
          </>
        )}
      </div>
    </div>
  );
};

export default MatterBrief;
