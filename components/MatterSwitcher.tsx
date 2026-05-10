/**
 * MatterSwitcher — Global persistent matter context selector
 *
 * Renders as a button in the top navigation bar that opens a popover panel
 * with search, type/status filters, and a scrollable list of matters.
 * Selecting a matter sets the global active-matter context used by Chat, Upload, and AI tools.
 */

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Case } from '../types';
import { useData } from '../contexts/DataContext';
import { useMatter } from '../contexts/MatterContext';
import { MATTER_TYPES, MATTER_STATUSES, getMatterTypeConfig, getMatterStatusConfig } from '../constants';

const MatterSwitcher: React.FC = () => {
  const { cases } = useData();
  const { activeMatter, setActiveMatter, clearActiveMatter } = useMatter();
  const [isOpen, setIsOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [isMobileViewport, setIsMobileViewport] = useState(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 767px)').matches;
  });
  const panelRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<number | null>(null);
  const PANEL_ANIM_MS = 320;

  const openPanel = () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    setIsClosing(false);
    setIsOpen(true);
  };

  const closePanel = () => {
    if (!isOpen || isClosing) return;
    setIsClosing(true);
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(() => {
      setIsOpen(false);
      setIsClosing(false);
      closeTimerRef.current = null;
    }, PANEL_ANIM_MS);
  };

  // Track mobile breakpoint changes
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(max-width: 767px)');
    const handleChange = (event: MediaQueryListEvent) => setIsMobileViewport(event.matches);
    setIsMobileViewport(media.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  // Prevent page scroll while mobile matter panel is open
  useEffect(() => {
    if (!(isOpen && isMobileViewport)) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isOpen, isMobileViewport]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        closePanel();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [isOpen, closePanel]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, closePanel]);

  // Filter matters
  const filteredMatters = useMemo(() => {
    return cases.filter(c => {
      // Always exclude General Documents from matter selection - it's not a real matter
      if (c.name === 'General Documents') return false;

      // Default: hide archived unless explicitly filtering for them
      if (!statusFilter && c.archived_at) return false;

      if (search) {
        const q = search.toLowerCase();
        const match = c.name.toLowerCase().includes(q) ||
          (c.client_name || '').toLowerCase().includes(q) ||
          (c.matter_ref || '').toLowerCase().includes(q) ||
          (c.case_number || '').toLowerCase().includes(q);
        if (!match) return false;
      }
      if (typeFilter && c.matter_type !== typeFilter) return false;
      if (statusFilter) {
        const s = c.archived_at ? 'archived' : (c.status === 'closed' ? 'closed' : 'active');
        if (s !== statusFilter) return false;
      }
      return true;
    });
  }, [cases, search, typeFilter, statusFilter]);

  const handleSelect = (matter: Case) => {
    setActiveMatter(matter);
    closePanel();
    setSearch('');
  };

  const handleClear = () => {
    clearActiveMatter();
    closePanel();
    setSearch('');
  };

  const statusBadge = (matter: Case) => {
    const s = matter.archived_at ? 'archived' : (matter.status === 'closed' ? 'closed' : 'active');
    const cfg = getMatterStatusConfig(s);
    if (!cfg) return null;
    return (
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${cfg.color} ${cfg.textColor}`}>
        {cfg.label}
      </span>
    );
  };

  const typeBadge = (matter: Case) => {
    if (!matter.matter_type) return null;
    const cfg = getMatterTypeConfig(matter.matter_type);
    if (!cfg) return null;
    return (
      <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${cfg.color} ${cfg.textColor}`}>
        {cfg.label}
      </span>
    );
  };

  return (
    <div className="relative">
      {/* Trigger Button */}
      <button
        ref={buttonRef}
        onClick={() => {
          if (isOpen && !isClosing) {
            closePanel();
          } else {
            openPanel();
          }
        }}
        className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all text-sm font-medium max-w-[240px] ${
          activeMatter
            ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/30'
            : 'bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600'
        }`}
      >
        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <span className="truncate">
          {activeMatter ? activeMatter.name : 'Select Matter'}
        </span>
        <svg className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isOpen && isMobileViewport && (
        <div
          className={`fixed inset-0 z-40 bg-black/40 md:hidden transition-opacity duration-300 ${isClosing ? 'opacity-0' : 'opacity-100'}`}
          onClick={closePanel}
          aria-hidden="true"
        />
      )}

      {/* Popover Panel */}
      {isOpen && (
        <div
          ref={panelRef}
          className={`bg-white dark:bg-gray-800 rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 z-50 overflow-hidden transition-all duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
            isClosing ? 'opacity-0 scale-95 pointer-events-none -translate-y-1' : 'opacity-100 scale-100 translate-y-0 animate-popover-in [animation-duration:320ms]'
          } ${
            isMobileViewport
              ? 'fixed top-16 left-2 right-2 w-auto mt-0 max-h-[calc(100dvh-5rem)] flex flex-col md:hidden'
              : 'absolute top-full left-0 mt-2 w-[380px] origin-top-left'
          }`}
        >
          {/* Search & Filters */}
          <div className="p-3 border-b border-gray-100 dark:border-gray-700 space-y-2">
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search matters..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-full pl-9 pr-3 py-2 text-sm border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-gray-900 dark:text-white rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                autoFocus={!isMobileViewport}
              />
            </div>
            <div className="flex gap-2">
              <select
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
                className="flex-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg appearance-none bg-no-repeat bg-[right_0.5rem_center] bg-[length:1rem] pr-7"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%236b7280'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")` }}
              >
                <option value="">All Types</option>
                {MATTER_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="flex-1 px-2 py-1.5 text-xs border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg appearance-none bg-no-repeat bg-[right_0.5rem_center] bg-[length:1rem] pr-7"
                style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%236b7280'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")` }}
              >
                <option value="">All Statuses</option>
                {MATTER_STATUSES.map(s => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Matter List */}
          <div className={`${isMobileViewport ? 'max-h-[min(56dvh,420px)] overflow-y-auto overscroll-contain touch-pan-y' : 'max-h-[320px] overflow-y-auto'}`}>
            {filteredMatters.length === 0 ? (
              <div className="p-6 text-center text-sm text-gray-500 dark:text-gray-400">
                <p className="mb-1">No matters found</p>
                <p className="text-xs">Try adjusting your filters</p>
              </div>
            ) : (
              filteredMatters.map(matter => (
                <button
                  key={matter.id}
                  onClick={() => handleSelect(matter)}
                  className={`w-full text-left px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors border-b border-gray-50 dark:border-gray-700/50 last:border-b-0 ${
                    activeMatter?.id === matter.id ? 'bg-blue-50 dark:bg-blue-900/20' : ''
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-medium text-sm text-gray-900 dark:text-white truncate mr-2">
                      {matter.name}
                    </span>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {typeBadge(matter)}
                      {statusBadge(matter)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    {matter.client_name && (
                      <span className="truncate">{matter.client_name}</span>
                    )}
                    {matter.matter_ref && (
                      <span className="font-mono text-gray-400 dark:text-gray-500">{matter.matter_ref}</span>
                    )}
                    {matter.case_number && !matter.matter_ref && (
                      <span className="font-mono text-gray-400 dark:text-gray-500">{matter.case_number}</span>
                    )}
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Footer */}
          {activeMatter && (
            <div className="p-2 border-t border-gray-100 dark:border-gray-700">
              <button
                onClick={handleClear}
                className="w-full px-3 py-1.5 text-xs text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors font-medium"
              >
                Switch to global mode
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default MatterSwitcher;
