/**
 * IntelligenceDashboard — Matter Intelligence Dashboard
 *
 * Displays extracted legal intelligence for the active matter:
 * - Overview: counts, high-risk alerts, upcoming obligations
 * - Entities: parties, organizations, statutes, etc.
 * - Risks: risk matrix with severity breakdown
 * - Obligations: compliance tracker with status
 * - Timeline: chronological view of matter events
 * - Summary: AI-generated matter summary
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useMatter } from '../contexts/MatterContext';
import * as intel from '../services/intelligenceService';
import * as cache from '../services/cacheService';
import { exportIntelligence } from '../services/exportService';
import ExtractionProgress from './ExtractionProgress';
import RiskMatrixChart from './charts/RiskMatrixChart';
import ComplianceChart from './charts/ComplianceChart';
import TimelineChart from './charts/TimelineChart';

type Tab = 'overview' | 'entities' | 'risks' | 'obligations' | 'timeline' | 'summary';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'entities', label: 'Entities' },
  { id: 'risks', label: 'Risks' },
  { id: 'obligations', label: 'Obligations' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'summary', label: 'Summary' },
];

// ─── Severity / Status color utilities ────────────────────────

function severityColor(s: string): string {
  switch (s?.toLowerCase()) {
    case 'critical': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'high': return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
    case 'medium': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
    case 'low': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

function statusColor(s: string): string {
  switch (s?.toLowerCase()) {
    case 'completed': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    case 'overdue': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'pending': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
    case 'active': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

function entityTypeColor(t: string): string {
  switch (t?.toLowerCase()) {
    case 'party': return 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300';
    case 'court': return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300';
    case 'statute': return 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300';
    case 'defined_term': return 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300';
    case 'judge': return 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300';
    case 'jurisdiction': return 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300';
    case 'regulatory_body': return 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300';
    case 'witness': return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    case 'law_firm': return 'bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300';
    case 'government_agency': return 'bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300';
    case 'law_enforcement': return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'contract': return 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300';
    case 'evidence': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
    case 'location': return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300';
    case 'vehicle': return 'bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300';
    case 'publication': return 'bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/30 dark:text-fuchsia-300';
    default: return 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  }
}

// ─── Pill badge component ─────────────────────────────────────

const Badge: React.FC<{ text: string; className?: string }> = ({ text, className = '' }) => (
  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${className}`}>
    {text}
  </span>
);

// ─── Stat Card with staggered animation ──────────────────────

const StatCard: React.FC<{
  label: string;
  value: number;
  icon: React.ReactNode;
  color: string;
  onClick?: () => void;
  delay?: number;
}> = ({ label, value, icon, color, onClick, delay = 0 }) => (
  <button
    onClick={onClick}
    style={{ animationDelay: `${delay}ms` }}
    className={`flex items-center gap-3 p-4 rounded-xl border transition-all duration-200 hover:shadow-md active:scale-[0.97] animate-fade-slide-up ${
      onClick ? 'cursor-pointer' : 'cursor-default'
    } bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800`}
  >
    <div className={`flex items-center justify-center w-10 h-10 rounded-lg ${color}`}>
      {icon}
    </div>
    <div className="text-left">
      <p className="text-2xl font-bold text-gray-900 dark:text-white">{value}</p>
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
    </div>
  </button>
);

// ─── Loading Skeleton with shimmer ────────────────────────────

const Skeleton: React.FC<{ lines?: number; className?: string }> = ({ lines = 3, className = '' }) => (
  <div className={`space-y-3 ${className}`}>
    {Array.from({ length: lines }).map((_, i) => (
      <div key={i} className={`h-4 bg-gradient-to-r from-gray-200 via-gray-100 to-gray-200 dark:from-gray-800 dark:via-gray-700 dark:to-gray-800 rounded animate-shimmer bg-[length:200%_100%] ${
        i === 0 ? 'w-3/4' : i === lines - 1 ? 'w-1/2' : 'w-full'
      }`} />
    ))}
  </div>
);

// ─── Card skeleton ────────────────────────────────────────────

const CardSkeleton: React.FC<{ count?: number }> = ({ count = 5 }) => (
  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="p-4 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 animate-pulse" style={{ animationDelay: `${i * 60}ms` }}>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-gray-200 dark:bg-gray-800" />
          <div className="flex-1">
            <div className="h-6 bg-gray-200 dark:bg-gray-800 rounded w-12 mb-1" />
            <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-16" />
          </div>
        </div>
      </div>
    ))}
  </div>
);

// ─── List skeleton ────────────────────────────────────────────

const ListSkeleton: React.FC<{ count?: number }> = ({ count = 4 }) => (
  <div className="space-y-2">
    {Array.from({ length: count }).map((_, i) => (
      <div key={i} className="p-4 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 animate-pulse" style={{ animationDelay: `${i * 80}ms` }}>
        <div className="flex items-start gap-3">
          <div className="w-16 h-5 rounded-full bg-gray-200 dark:bg-gray-800" />
          <div className="flex-1">
            <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-3/4 mb-2" />
            <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-1/2" />
          </div>
        </div>
      </div>
    ))}
  </div>
);

// ─── Empty state ──────────────────────────────────────────────

const EmptyState: React.FC<{ message: string; action?: { label: string; onClick: () => void } }> = ({ message, action }) => (
  <div className="flex flex-col items-center justify-center py-16 text-center animate-fade-in">
    <div className="w-16 h-16 mb-4 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
      <svg className="w-8 h-8 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
      </svg>
    </div>
    <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 max-w-sm">{message}</p>
    {action && (
      <button
        onClick={action.onClick}
        className="px-4 py-2 text-sm font-medium text-white bg-gray-900 dark:bg-white dark:text-gray-900 rounded-lg hover:opacity-90 transition-all duration-200 active:scale-[0.97]"
      >
        {action.label}
      </button>
    )}
  </div>
);

// ─── Animated content wrapper for tab transitions ─────────────

const AnimatedContent: React.FC<{ children: React.ReactNode; tab: string }> = ({ children, tab }) => {
  const [visible, setVisible] = useState(false);
  const prevTab = useRef(tab);

  useEffect(() => {
    if (prevTab.current !== tab) {
      setVisible(false);
      const timer = setTimeout(() => setVisible(true), 30);
      prevTab.current = tab;
      return () => clearTimeout(timer);
    } else {
      setVisible(true);
    }
  }, [tab]);

  return (
    <div className={`transition-all duration-300 ease-out ${
      visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
    }`}>
      {children}
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ═══════════════════════════════════════════════════════════════

interface DashboardProps {
  onNavigateToChat: () => void;
}

const IntelligenceDashboard: React.FC<DashboardProps> = ({ onNavigateToChat }) => {
  const { activeMatter } = useMatter();
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [showExtractionProgress, setShowExtractionProgress] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Data state — initialized from cache for instant display
  const [overview, setOverview] = useState<intel.MatterOverview | null>(null);
  const [entities, setEntities] = useState<intel.EntityItem[]>([]);
  const [canonicalEntities, setCanonicalEntities] = useState<intel.CanonicalEntityItem[]>([]);
  const [risks, setRisks] = useState<intel.RiskItem[]>([]);
  const [obligations, setObligations] = useState<intel.ObligationItem[]>([]);
  const [timeline, setTimeline] = useState<intel.TimelineEntry[]>([]);
  const [summary, setSummary] = useState<intel.MatterSummary | null>(null);
  const [compliance, setCompliance] = useState<intel.ComplianceResult | null>(null);
  const [riskMatrix, setRiskMatrix] = useState<intel.RiskMatrixResult | null>(null);
  const [loadedTabs, setLoadedTabs] = useState<Set<Tab>>(new Set());

  const caseId = activeMatter?.id;
  const fetchingRef = useRef<Set<Tab>>(new Set());

  // Helper: restore tab state from cache
  const restoreTabFromCache = useCallback((tab: Tab, matterId: string): boolean => {
    switch (tab) {
      case 'overview': {
        const { data } = cache.getCachedIntelligence<intel.MatterOverview>(matterId, 'overview');
        if (data) { setOverview(data); return true; }
        return false;
      }
      case 'entities': {
        const { data: ent } = cache.getCachedIntelligence<intel.EntityItem[]>(matterId, 'entities');
        const { data: can } = cache.getCachedIntelligence<intel.CanonicalEntityItem[]>(matterId, 'canonical_entities');
        if (ent) { setEntities(ent); setCanonicalEntities(can || []); return true; }
        return false;
      }
      case 'risks': {
        const { data: r } = cache.getCachedIntelligence<intel.RiskItem[]>(matterId, 'risks');
        const { data: m } = cache.getCachedIntelligence<intel.RiskMatrixResult>(matterId, 'risk_matrix');
        if (r) { setRisks(r); setRiskMatrix(m); return true; }
        return false;
      }
      case 'obligations': {
        const { data: o } = cache.getCachedIntelligence<intel.ObligationItem[]>(matterId, 'obligations');
        const { data: c } = cache.getCachedIntelligence<intel.ComplianceResult>(matterId, 'compliance');
        if (o) { setObligations(o); setCompliance(c); return true; }
        return false;
      }
      case 'timeline': {
        const { data } = cache.getCachedIntelligence<intel.TimelineEntry[]>(matterId, 'timeline');
        if (data) { setTimeline(data); return true; }
        return false;
      }
      case 'summary': {
        const { data } = cache.getCachedIntelligence<intel.MatterSummary | null>(matterId, 'summary');
        if (data) { setSummary(data); return true; }
        return false;
      }
    }
    return false;
  }, []);

  // On matter change: restore all cached tabs instantly, reset fresh-fetch status
  useEffect(() => {
    setLoadedTabs(new Set());
    fetchingRef.current.clear();

    if (!caseId) {
      setOverview(null); setEntities([]); setCanonicalEntities([]);
      setRisks([]); setObligations([]); setTimeline([]);
      setSummary(null); setCompliance(null); setRiskMatrix(null);
      return;
    }

    // Restore every tab from cache for instant switching
    for (const tab of TABS) {
      restoreTabFromCache(tab.id, caseId);
    }
  }, [caseId, restoreTabFromCache]);

  // Fetch fresh data for a tab — stale-while-revalidate
  const fetchTabData = useCallback(async (tab: Tab, force = false) => {
    if (!caseId) return;
    if (fetchingRef.current.has(tab)) return; // already in-flight

    // Check cache freshness
    const primaryCacheKey = tab === 'entities' ? 'entities'
      : tab === 'risks' ? 'risks'
      : tab === 'obligations' ? 'obligations'
      : tab;
    const { status } = cache.getCachedIntelligence(caseId, primaryCacheKey);

    // If fresh and already marked loaded, skip entirely
    if (!force && status === 'fresh' && loadedTabs.has(tab)) return;

    // Determine loading vs syncing
    const hasData = status !== 'empty';
    if (!force && hasData) {
      // Background sync — don't show skeleton
      if (!cache.shouldRefetch(status) && !cache.shouldBackgroundRefetch(status) && loadedTabs.has(tab)) return;
      setSyncing(true);
    } else if (!hasData) {
      // First load — show skeleton
      setLoading(true);
    } else {
      setSyncing(true);
    }

    fetchingRef.current.add(tab);
    setError(null);

    try {
      switch (tab) {
        case 'overview': {
          const data = await intel.getOverview(caseId);
          setOverview(data);
          cache.setCachedIntelligence(caseId, 'overview', data);
          break;
        }
        case 'entities': {
          const [data, canonical] = await Promise.all([
            intel.getEntities(caseId),
            intel.getCanonicalEntities(caseId),
          ]);
          setEntities(data);
          setCanonicalEntities(canonical);
          cache.setCachedIntelligence(caseId, 'entities', data);
          cache.setCachedIntelligence(caseId, 'canonical_entities', canonical);
          break;
        }
        case 'risks': {
          const [riskData, matrixData] = await Promise.all([
            intel.getRisks(caseId),
            intel.getRiskMatrix(caseId),
          ]);
          setRisks(riskData);
          setRiskMatrix(matrixData);
          cache.setCachedIntelligence(caseId, 'risks', riskData);
          cache.setCachedIntelligence(caseId, 'risk_matrix', matrixData);
          break;
        }
        case 'obligations': {
          const [oblData, compData] = await Promise.all([
            intel.getObligations(caseId),
            intel.getCompliance(caseId),
          ]);
          setObligations(oblData);
          setCompliance(compData);
          cache.setCachedIntelligence(caseId, 'obligations', oblData);
          cache.setCachedIntelligence(caseId, 'compliance', compData);
          break;
        }
        case 'timeline': {
          const data = await intel.getTimeline(caseId);
          setTimeline(data);
          cache.setCachedIntelligence(caseId, 'timeline', data);
          break;
        }
        case 'summary': {
          const data = await intel.getSummary(caseId);
          setSummary(data);
          cache.setCachedIntelligence(caseId, 'summary', data);
          break;
        }
      }
      setLoadedTabs(prev => new Set([...prev, tab]));
    } catch (err: any) {
      console.error(`Intelligence fetch error (${tab}):`, err);
      // Only show error if we have no cached data to display
      if (status === 'empty') {
        setError(err.message || 'Failed to load intelligence data');
      }
    } finally {
      setLoading(false);
      setSyncing(false);
      fetchingRef.current.delete(tab);
    }
  }, [caseId, loadedTabs]);

  // Fetch current tab on mount / tab switch
  useEffect(() => {
    fetchTabData(activeTab);
  }, [activeTab, fetchTabData]);

  // Prefetch adjacent tabs for instant switching
  useEffect(() => {
    if (!caseId) return;
    const idx = TABS.findIndex(t => t.id === activeTab);
    const prefetchTargets = [TABS[idx - 1]?.id, TABS[idx + 1]?.id].filter(Boolean) as Tab[];

    const timer = setTimeout(() => {
      prefetchTargets.forEach(tab => {
        if (!loadedTabs.has(tab)) {
          fetchTabData(tab);
        }
      });
    }, 400);

    return () => clearTimeout(timer);
  }, [activeTab, caseId, loadedTabs, fetchTabData]);

  // Generate summary
  const handleGenerateSummary = async () => {
    if (!caseId) return;
    setLoading(true);
    try {
      await intel.generateSummary(caseId);
      const data = await intel.getSummary(caseId);
      setSummary(data);
      cache.setCachedIntelligence(caseId, 'summary', data);
      setLoadedTabs(prev => new Set([...prev, 'summary']));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  // Reprocess documents
  const handleReprocess = async () => {
    if (!caseId) return;
    setLoading(true);
    setError(null);
    try {
      await intel.reprocessMatter(caseId);
      // Show progress tracker
      setShowExtractionProgress(true);
      setLoading(false);
    } catch (err: any) {
      setError(err.message);
      setLoading(false);
    }
  };

  const handleExtractionComplete = () => {
    setShowExtractionProgress(false);
    // Invalidate all cached intelligence for this matter
    cache.invalidateIntelligence(caseId!);
    setLoadedTabs(new Set());
    fetchTabData('overview', true);
  };

  const handleExtractionError = (errorMsg: string) => {
    setError(errorMsg);
  };

  // ─── No matter selected ──────────────────────────────────────

  // Check if we have any data (cached or fresh) for a tab — used to decide skeleton vs content
  const hasDataForTab = useCallback((tab: Tab): boolean => {
    switch (tab) {
      case 'overview': return overview !== null;
      case 'entities': return entities.length > 0 || canonicalEntities.length > 0;
      case 'risks': return risks.length > 0;
      case 'obligations': return obligations.length > 0;
      case 'timeline': return timeline.length > 0;
      case 'summary': return summary !== null;
      default: return false;
    }
  }, [overview, entities, canonicalEntities, risks, obligations, timeline, summary]);

  // Tab-specific loading skeletons
  const renderLoadingSkeleton = (tab: Tab) => {
    switch (tab) {
      case 'overview':
        return (
          <div className="space-y-6 animate-fade-in">
            <CardSkeleton count={5} />
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
                <Skeleton lines={4} />
              </div>
              <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4">
                <Skeleton lines={4} />
              </div>
            </div>
          </div>
        );
      case 'entities':
        return (
          <div className="space-y-4 animate-fade-in">
            <div className="flex gap-2">
              {[1, 2, 3, 4].map(i => (
                <div key={i} className="h-7 w-20 rounded-full bg-gray-200 dark:bg-gray-800 animate-pulse" />
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {[1, 2, 3, 4, 5, 6].map(i => (
                <div key={i} className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 animate-pulse" style={{ animationDelay: `${i * 60}ms` }}>
                  <div className="h-5 w-20 rounded-full bg-gray-200 dark:bg-gray-800 mb-2" />
                  <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-3/4" />
                </div>
              ))}
            </div>
          </div>
        );
      case 'risks':
      case 'obligations':
        return <ListSkeleton count={4} />;
      case 'timeline':
        return (
          <div className="relative pl-6 animate-fade-in">
            <div className="absolute left-2.5 top-2 bottom-2 w-px bg-gray-200 dark:bg-gray-800" />
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="relative mb-4 ml-2" style={{ animationDelay: `${i * 80}ms` }}>
                <div className="absolute -left-[14px] top-1.5 w-3 h-3 rounded-full bg-gray-200 dark:bg-gray-800" />
                <div className="p-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 animate-pulse">
                  <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-1/4 mb-2" />
                  <div className="h-3 bg-gray-100 dark:bg-gray-800 rounded w-3/4" />
                </div>
              </div>
            ))}
          </div>
        );
      case 'summary':
        return (
          <div className="max-w-3xl space-y-4 animate-fade-in">
            <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
              <Skeleton lines={6} />
            </div>
          </div>
        );
      default:
        return <Skeleton lines={6} />;
    }
  };

  if (!activeMatter) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="text-center max-w-md animate-fade-in">
          <div className="w-20 h-20 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-800 dark:to-gray-700 flex items-center justify-center">
            <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">Matter Intelligence</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
            Select a matter from the top bar to view extracted legal intelligence, risk analysis, obligation tracking, and AI-generated summaries.
          </p>
          <button
            onClick={onNavigateToChat}
            className="px-4 py-2 text-sm font-medium text-white bg-gray-900 dark:bg-white dark:text-gray-900 rounded-lg hover:opacity-90 transition-all duration-200"
          >
            Go to Chat
          </button>
        </div>
      </div>
    );
  }

  // ─── Main Dashboard ───────────────────────────────────────────

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900 dark:text-white flex items-center gap-2">
              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              Intelligence — {activeMatter.name}
            </h1>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {activeMatter.matter_ref || activeMatter.case_number || activeMatter.id.slice(0, 8)}
              {activeMatter.matter_type && ` · ${activeMatter.matter_type}`}
              {activeMatter.client_name && ` · ${activeMatter.client_name}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {syncing && (
              <span className="flex items-center gap-1.5 text-[10px] text-gray-400 animate-fade-in">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                Syncing
              </span>
            )}
            <button
              onClick={handleReprocess}
              disabled={loading}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all duration-200 disabled:opacity-50 active:scale-[0.97]"
            >
              Reprocess
            </button>
            <button
              onClick={() => exportIntelligence(activeMatter.id, 'word').catch(e => console.error('Export error:', e))}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all duration-200 active:scale-[0.97]"
            >
              Export Word
            </button>
            <button
              onClick={() => exportIntelligence(activeMatter.id, 'pdf').catch(e => console.error('Export error:', e))}
              className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 transition-all duration-200 active:scale-[0.97]"
            >
              Export PDF
            </button>
          </div>
        </div>
      </div>

      {/* Tabs with animated indicator */}
      <div className="flex-shrink-0 px-6 border-b border-gray-200 dark:border-gray-800 relative">
        <nav className="flex gap-1 -mb-px overflow-x-auto" aria-label="Intelligence tabs">
          {TABS.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`relative flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium transition-all duration-200 whitespace-nowrap ${
                activeTab === tab.id
                  ? 'text-gray-900 dark:text-white'
                  : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
              }`}
            >
              {tab.label}
              {loadedTabs.has(tab.id) && tab.id !== activeTab && (
                <span className="w-1 h-1 rounded-full bg-green-400 flex-shrink-0" />
              )}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-gray-900 dark:bg-white rounded-full transition-all duration-300" />
              )}
            </button>
          ))}
        </nav>
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex-shrink-0 mx-6 mt-4 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-sm text-red-800 dark:text-red-300 flex items-center justify-between animate-fade-slide-down">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-3 text-red-500 hover:text-red-700 transition-colors">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Extraction progress (when active) */}
      {showExtractionProgress && caseId && (
        <div className="flex-shrink-0 mx-6 mt-4">
          <ExtractionProgress
            caseId={caseId}
            onComplete={handleExtractionComplete}
            onError={handleExtractionError}
          />
        </div>
      )}

      {/* Tab Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        {loading && !hasDataForTab(activeTab) ? (
          renderLoadingSkeleton(activeTab)
        ) : (
          <AnimatedContent tab={activeTab}>
            {activeTab === 'overview' && <OverviewTab overview={overview} onNavigateTab={setActiveTab} />}
            {activeTab === 'entities' && <EntitiesTab entities={entities} canonicalEntities={canonicalEntities} />}
            {activeTab === 'risks' && <RisksTab risks={risks} matrix={riskMatrix} />}
            {activeTab === 'obligations' && <ObligationsTab obligations={obligations} compliance={compliance} />}
            {activeTab === 'timeline' && <TimelineTab events={timeline} />}
            {activeTab === 'summary' && <SummaryTab summary={summary} onGenerate={handleGenerateSummary} loading={loading} />}
          </AnimatedContent>
        )}
      </div>
    </div>
  );
};

// ═══════════════════════════════════════════════════════════════
// TAB COMPONENTS
// ═══════════════════════════════════════════════════════════════

// ─── SVG icons for stat cards ─────────────────────────────────

const EntitiesIcon = () => (
  <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
  </svg>
);

const ClausesIcon = () => (
  <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
  </svg>
);

const ObligationsIcon = () => (
  <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
  </svg>
);

const DatesIcon = () => (
  <svg className="w-5 h-5 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

const RisksIcon = () => (
  <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
  </svg>
);

// ─── Overview Tab ─────────────────────────────────────────────

const OverviewTab: React.FC<{
  overview: intel.MatterOverview | null;
  onNavigateTab: (tab: Tab) => void;
}> = ({ overview, onNavigateTab }) => {
  if (!overview) return <EmptyState message="No intelligence data available. Upload documents and process them to see extracted insights." />;

  const i = overview.intelligence;

  return (
    <div className="space-y-6">
      {/* Stat cards with staggered animation */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <StatCard label="Entities" value={i.entity_count} icon={<EntitiesIcon />} color="bg-blue-50 dark:bg-blue-900/20" onClick={() => onNavigateTab('entities')} delay={0} />
        <StatCard label="Clauses" value={i.clause_count} icon={<ClausesIcon />} color="bg-purple-50 dark:bg-purple-900/20" delay={60} />
        <StatCard label="Obligations" value={i.obligation_count} icon={<ObligationsIcon />} color="bg-amber-50 dark:bg-amber-900/20" onClick={() => onNavigateTab('obligations')} delay={120} />
        <StatCard label="Key Dates" value={i.date_count} icon={<DatesIcon />} color="bg-teal-50 dark:bg-teal-900/20" onClick={() => onNavigateTab('timeline')} delay={180} />
        <StatCard label="Risks" value={i.risk_count} icon={<RisksIcon />} color="bg-red-50 dark:bg-red-900/20" onClick={() => onNavigateTab('risks')} delay={240} />
      </div>

      {/* Alerts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* High Risks */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 animate-fade-slide-up" style={{ animationDelay: '80ms' }}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            High-Risk Alerts
            {overview.alerts.high_risks.length > 0 && (
              <Badge text={String(overview.alerts.high_risks.length)} className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" />
            )}
          </h3>
          {overview.alerts.high_risks.length === 0 ? (
            <p className="text-xs text-gray-400">No high-risk items found</p>
          ) : (
            <ul className="space-y-2">
              {overview.alerts.high_risks.map(r => (
                <li key={r.id} className="flex items-start gap-2 text-sm">
                  <Badge text={r.severity} className={severityColor(r.severity)} />
                  <span className="text-gray-700 dark:text-gray-300">{r.risk_description}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Upcoming Obligations */}
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 animate-fade-slide-up" style={{ animationDelay: '160ms' }}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Upcoming Obligations
            {overview.alerts.upcoming_obligations.length > 0 && (
              <Badge text={String(overview.alerts.upcoming_obligations.length)} className="bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" />
            )}
          </h3>
          {overview.alerts.upcoming_obligations.length === 0 ? (
            <p className="text-xs text-gray-400">No upcoming obligations</p>
          ) : (
            <ul className="space-y-2">
              {overview.alerts.upcoming_obligations.map(o => (
                <li key={o.id} className="text-sm">
                  <div className="flex items-center gap-2">
                    <Badge text={o.status} className={statusColor(o.status)} />
                    {o.due_date && (
                      <span className="text-xs text-gray-400">
                        {new Date(o.due_date).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <p className="text-gray-700 dark:text-gray-300 mt-0.5">{o.obligation_text}</p>
                  {o.obligor && (
                    <p className="text-xs text-gray-400 mt-0.5">{o.obligor}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Recent Extractions */}
      {overview.recent_extractions.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 animate-fade-slide-up" style={{ animationDelay: '240ms' }}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3 flex items-center gap-2">
            <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Recent Extractions
          </h3>
          <div className="space-y-1.5">
            {overview.recent_extractions.map(j => (
              <div key={j.id} className="flex items-center gap-3 text-xs">
                <Badge text={j.status} className={j.status === 'completed' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300' : j.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700'} />
                <span className="text-gray-500">{new Date(j.created_at).toLocaleString()}</span>
                <span className="text-gray-400 font-mono">{j.id.slice(0, 8)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Entities Tab ─────────────────────────────────────────────

const EntitiesTab: React.FC<{ entities: intel.EntityItem[]; canonicalEntities: intel.CanonicalEntityItem[] }> = ({ entities, canonicalEntities }) => {
  const [typeFilter, setTypeFilter] = useState('');
  const [viewMode, setViewMode] = useState<'raw' | 'canonical'>('canonical');

  const types = useMemo(() => {
    const items = viewMode === 'canonical' ? canonicalEntities : entities;
    const set = new Set(items.map(e => e.entity_type));
    return Array.from(set).sort();
  }, [entities, canonicalEntities, viewMode]);

  const filteredEntities = typeFilter ? entities.filter(e => e.entity_type === typeFilter) : entities;
  const filteredCanonical = typeFilter ? canonicalEntities.filter(e => e.entity_type === typeFilter) : canonicalEntities;

  if (entities.length === 0 && canonicalEntities.length === 0) {
    return <EmptyState message="No entities extracted yet. Process documents to identify parties, organizations, statutes, and other key entities." />;
  }

  const verificationBadge = (status: string) => {
    switch (status) {
      case 'user_verified': return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300';
      case 'auto_verified': return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300';
      case 'rejected': return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300';
      default: return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
    }
  };

  return (
    <div className="space-y-4">
      {/* View mode toggle + filter pills */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => { setTypeFilter(''); }}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 ${
              !typeFilter ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900 shadow-sm' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            All ({viewMode === 'canonical' ? canonicalEntities.length : entities.length})
          </button>
          {types.map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(typeFilter === t ? '' : t)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 ${
                typeFilter === t ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900 shadow-sm' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
              }`}
            >
              {t.replace(/_/g, ' ')} ({(viewMode === 'canonical' ? canonicalEntities : entities).filter(e => e.entity_type === t).length})
            </button>
          ))}
        </div>

        {canonicalEntities.length > 0 && (
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
            <button
              onClick={() => setViewMode('canonical')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                viewMode === 'canonical' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              Canonical ({canonicalEntities.length})
            </button>
            <button
              onClick={() => setViewMode('raw')}
              className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
                viewMode === 'raw' ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm' : 'text-gray-500 dark:text-gray-400'
              }`}
            >
              Raw ({entities.length})
            </button>
          </div>
        )}
      </div>

      {/* Canonical entity cards */}
      {viewMode === 'canonical' && canonicalEntities.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredCanonical.map((entity, idx) => (
            <div key={entity.id} className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 animate-fade-slide-up transition-all duration-200 hover:shadow-sm" style={{ animationDelay: `${Math.min(idx * 30, 300)}ms` }}>
              <div className="flex items-center gap-2 mb-1.5">
                <Badge text={entity.entity_type.replace(/_/g, ' ')} className={entityTypeColor(entity.entity_type)} />
                <Badge text={entity.verification_status.replace(/_/g, ' ')} className={verificationBadge(entity.verification_status)} />
                {entity.confidence != null && (
                  <span className="text-[10px] text-gray-400">{Math.round(entity.confidence * 100)}%</span>
                )}
              </div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">{entity.canonical_name}</p>
              {entity.aliases.length > 0 && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  aka: {entity.aliases.slice(0, 3).join(', ')}{entity.aliases.length > 3 ? ` +${entity.aliases.length - 3}` : ''}
                </p>
              )}
              <div className="flex items-center gap-2 mt-1.5">
                <span className="text-[10px] text-gray-400">{entity.mention_count} mention{entity.mention_count !== 1 ? 's' : ''}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* Raw entity cards */
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filteredEntities.map((entity, idx) => (
            <div key={entity.id} className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 animate-fade-slide-up transition-all duration-200 hover:shadow-sm" style={{ animationDelay: `${Math.min(idx * 30, 300)}ms` }}>
              <div className="flex items-center gap-2 mb-1.5">
                <Badge text={entity.entity_type.replace(/_/g, ' ')} className={entityTypeColor(entity.entity_type)} />
                {entity.confidence != null && (
                  <span className="text-[10px] text-gray-400">{Math.round(entity.confidence * 100)}%</span>
                )}
                {entity.canonical_entity_id && (
                  <span className="w-1.5 h-1.5 rounded-full bg-green-400" title="Linked to canonical entity" />
                )}
              </div>
              <p className="text-sm font-medium text-gray-900 dark:text-white">{entity.entity_value}</p>
              {entity.normalized_value && entity.normalized_value !== entity.entity_value && <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{entity.normalized_value}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Risks Tab ────────────────────────────────────────────────

const RisksTab: React.FC<{ risks: intel.RiskItem[]; matrix: intel.RiskMatrixResult | null }> = ({ risks, matrix }) => {
  const [severityFilter, setSeverityFilter] = useState('');

  const filtered = severityFilter ? risks.filter(r => r.severity === severityFilter) : risks;

  if (risks.length === 0) {
    return <EmptyState message="No risks identified. Process documents to detect potential legal risks and their severity." />;
  }

  return (
    <div className="space-y-5">
      {/* Risk Matrix Chart */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 animate-fade-slide-up">
        <RiskMatrixChart risks={risks} onFilterSeverity={(s) => setSeverityFilter(s === severityFilter ? '' : s || '')} />
      </div>

      {/* Risk Matrix Summary */}
      {matrix?.summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(['critical', 'high', 'medium', 'low'] as const).map((level, idx) => (
            <button
              key={level}
              onClick={() => setSeverityFilter(severityFilter === level ? '' : level)}
              style={{ animationDelay: `${idx * 60}ms` }}
              className={`p-3 rounded-xl border text-center transition-all duration-200 animate-fade-slide-up active:scale-[0.97] ${
                severityFilter === level ? 'ring-2 ring-gray-900 dark:ring-white shadow-sm' : ''
              } border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 hover:shadow-sm`}
            >
              <p className={`text-2xl font-bold ${
                level === 'critical' ? 'text-red-600' :
                level === 'high' ? 'text-orange-600' :
                level === 'medium' ? 'text-yellow-600' : 'text-green-600'
              }`}>
                {matrix.summary[level]}
              </p>
              <p className="text-xs text-gray-500 capitalize">{level}</p>
            </button>
          ))}
        </div>
      )}

      {/* Risk list */}
      <div className="space-y-2">
        {filtered.map((risk, idx) => (
          <div key={risk.id} className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 animate-fade-slide-up transition-all duration-200 hover:shadow-sm" style={{ animationDelay: `${Math.min(idx * 40, 300)}ms` }}>
            <div className="flex items-start gap-3">
              <Badge text={risk.severity} className={severityColor(risk.severity)} />
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-900 dark:text-white">{risk.risk_description}</p>
                {risk.risk_type && (
                  <p className="text-xs text-gray-500 mt-1">Category: {risk.risk_type}</p>
                )}
                {risk.recommendation && (
                  <div className="mt-2 p-2 rounded bg-green-50 dark:bg-green-900/10 border border-green-200 dark:border-green-800">
                    <p className="text-xs text-green-800 dark:text-green-300">
                      <span className="font-medium">Recommendation:</span> {risk.recommendation}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── Obligations Tab ──────────────────────────────────────────

const ObligationsTab: React.FC<{ obligations: intel.ObligationItem[]; compliance: intel.ComplianceResult | null }> = ({ obligations, compliance }) => {
  const [statusFilter, setStatusFilter] = useState('');

  const filtered = statusFilter ? obligations.filter(o => o.status === statusFilter) : obligations;

  if (obligations.length === 0) {
    return <EmptyState message="No obligations extracted yet. Process contracts or legal documents to identify duties, deadlines, and responsibilities." />;
  }

  return (
    <div className="space-y-5">
      {/* Compliance Chart */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 animate-fade-slide-up">
        <ComplianceChart obligations={obligations} />
      </div>

      {/* Compliance Summary */}
      {compliance?.summary && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 animate-fade-slide-up">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Compliance Rate</h3>
            <span className={`text-lg font-bold ${
              compliance.summary.compliance_rate >= 80 ? 'text-green-600' :
              compliance.summary.compliance_rate >= 50 ? 'text-yellow-600' : 'text-red-600'
            }`}>
              {Math.round(compliance.summary.compliance_rate)}%
            </span>
          </div>
          {/* Progress bar */}
          <div className="w-full h-2 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all duration-700 ease-out ${
                compliance.summary.compliance_rate >= 80 ? 'bg-green-500' :
                compliance.summary.compliance_rate >= 50 ? 'bg-yellow-500' : 'bg-red-500'
              }`}
              style={{ width: `${compliance.summary.compliance_rate}%` }}
            />
          </div>
          <div className="grid grid-cols-4 gap-2 mt-3 text-center">
            <div>
              <p className="text-lg font-bold text-gray-900 dark:text-white">{compliance.summary.total}</p>
              <p className="text-[10px] text-gray-400">Total</p>
            </div>
            <div>
              <p className="text-lg font-bold text-green-600">{compliance.summary.completed}</p>
              <p className="text-[10px] text-gray-400">Completed</p>
            </div>
            <div>
              <p className="text-lg font-bold text-yellow-600">{compliance.summary.pending}</p>
              <p className="text-[10px] text-gray-400">Pending</p>
            </div>
            <div>
              <p className="text-lg font-bold text-red-600">{compliance.summary.overdue}</p>
              <p className="text-[10px] text-gray-400">Overdue</p>
            </div>
          </div>
        </div>
      )}

      {/* Filter */}
      <div className="flex flex-wrap gap-2">
        {['', 'pending', 'active', 'completed', 'overdue'].map(s => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-all duration-200 ${
              statusFilter === s ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900 shadow-sm' : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700'
            }`}
          >
            {s || 'All'}
          </button>
        ))}
      </div>

      {/* Obligation list */}
      <div className="space-y-2">
        {filtered.map((obl, idx) => (
          <div key={obl.id} className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 animate-fade-slide-up transition-all duration-200 hover:shadow-sm" style={{ animationDelay: `${Math.min(idx * 40, 300)}ms` }}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-sm text-gray-900 dark:text-white">{obl.obligation_text}</p>
                <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                  <Badge text={obl.status} className={statusColor(obl.status)} />
                  {obl.obligation_type && <Badge text={obl.obligation_type.replace(/_/g, ' ')} className="bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400" />}
                  {obl.obligor && (
                    <span className="text-xs text-gray-500">{obl.obligor}</span>
                  )}
                </div>
              </div>
              {obl.due_date && (
                <div className="text-right flex-shrink-0">
                  <p className="text-xs font-medium text-gray-900 dark:text-white">
                    {new Date(obl.due_date).toLocaleDateString()}
                  </p>
                  <p className="text-[10px] text-gray-400">Due date</p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// ─── Timeline Tab ─────────────────────────────────────────────

const TimelineTab: React.FC<{ events: intel.TimelineEntry[] }> = ({ events }) => {
  if (events.length === 0) {
    return <EmptyState message="No timeline events found. Process documents to extract key dates, deadlines, and milestones." />;
  }

  // Sort by date
  const sorted = [...events].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  return (
    <div className="space-y-5">
      {/* Interactive Timeline Chart */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 animate-fade-slide-up">
        <TimelineChart events={events} />
      </div>

      <div className="relative pl-6">
        {/* Vertical line */}
        <div className="absolute left-2.5 top-2 bottom-2 w-px bg-gray-200 dark:bg-gray-800" />

        <div className="space-y-4">
          {sorted.map((event, idx) => {
            const isPast = new Date(event.date) < new Date();
            return (
              <div key={idx} className="relative animate-fade-slide-up" style={{ animationDelay: `${Math.min(idx * 50, 400)}ms` }}>
                {/* Dot */}
                <div className={`absolute -left-[14px] top-1.5 w-3 h-3 rounded-full border-2 transition-all duration-300 ${
                  isPast
                    ? 'bg-gray-900 dark:bg-white border-gray-900 dark:border-white'
                    : 'bg-white dark:bg-gray-900 border-gray-400 dark:border-gray-600'
                }`} />

                <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3 ml-2 transition-all duration-200 hover:shadow-sm">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-xs font-medium text-gray-900 dark:text-white">
                      {new Date(event.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                    </span>
                    <Badge text={event.type.replace(/_/g, ' ')} className="bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" />
                    {event.category && <Badge text={event.category.replace(/_/g, ' ')} className="bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" />}
                  </div>
                  <p className="text-sm text-gray-700 dark:text-gray-300">{event.description}</p>
                  {event.source_file_id && (
                    <p className="text-[10px] text-gray-400 mt-1">Source: {event.source_file_id.slice(0, 8)}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ─── Summary Tab ──────────────────────────────────────────────

const SummaryTab: React.FC<{
  summary: intel.MatterSummary | null;
  onGenerate: () => void;
  loading: boolean;
}> = ({ summary, onGenerate, loading }) => {
  if (!summary) {
    return (
      <EmptyState
        message="No AI summary generated yet. Generate one to get a comprehensive overview of this matter's intelligence."
        action={{ label: 'Generate Summary', onClick: onGenerate }}
      />
    );
  }

  const content = summary.content || {};
  const summaryText = content.summary_text as string | undefined;
  const keyFindings = (content.key_findings || []) as string[];
  const riskSummary = content.risk_summary as string | undefined;

  return (
    <div className="max-w-3xl space-y-5">
      {/* Stale warning */}
      {summary.stale && (
        <div className="px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-300 flex items-center justify-between animate-fade-slide-down">
          <span>This summary may be outdated. New documents have been processed since it was generated.</span>
          <button
            onClick={onGenerate}
            disabled={loading}
            className="ml-3 px-3 py-1 text-xs font-medium bg-amber-200 dark:bg-amber-800 text-amber-900 dark:text-amber-100 rounded-lg hover:bg-amber-300 dark:hover:bg-amber-700 disabled:opacity-50 transition-all duration-200"
          >
            Refresh
          </button>
        </div>
      )}

      {/* Summary text */}
      {summaryText && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 animate-fade-slide-up">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Matter Summary</h3>
            <span className="text-[10px] text-gray-400">
              Generated {new Date(summary.generated_at).toLocaleString()}
            </span>
          </div>
          <div className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap">
            {summaryText}
          </div>
        </div>
      )}

      {/* Key findings */}
      {keyFindings.length > 0 && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 animate-fade-slide-up" style={{ animationDelay: '80ms' }}>
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-3">Key Findings</h3>
          <ul className="space-y-2">
            {keyFindings.map((finding, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                <span className="flex-shrink-0 w-5 h-5 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-[10px] font-bold text-gray-500">
                  {i + 1}
                </span>
                {finding}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Risk Summary */}
      {riskSummary && (
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/10 p-5 animate-fade-slide-up" style={{ animationDelay: '160ms' }}>
          <h3 className="text-sm font-semibold text-red-900 dark:text-red-300 mb-2">Risk Summary</h3>
          <p className="text-sm text-red-800 dark:text-red-200 leading-relaxed">{riskSummary}</p>
        </div>
      )}

      {/* Regenerate */}
      <div className="flex justify-end">
        <button
          onClick={onGenerate}
          disabled={loading}
          className="px-4 py-2 text-xs font-medium rounded-lg bg-gray-900 dark:bg-white text-white dark:text-gray-900 hover:opacity-90 transition-all duration-200 disabled:opacity-50 active:scale-[0.97]"
        >
          {loading ? 'Generating...' : 'Regenerate Summary'}
        </button>
      </div>
    </div>
  );
};

export default IntelligenceDashboard;
