/**
 * Matter Context — Global active-matter state for Horizon
 *
 * Provides a persistent "workspace context" that determines:
 * - Which matter's documents are used for RAG in chat
 * - Default matter for uploads
 * - Scope for AI tools
 *
 * Persists the active matter ID to localStorage so it survives page reloads.
 * Also syncs to chat_sessions.case_id via chatService for cross-device persistence.
 */

import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { Case } from '../types';
import { useData } from './DataContext';

const STORAGE_KEY = 'horizon_active_matter_id';

interface MatterContextState {
  /** The currently selected matter (null = global / no scope) */
  activeMatter: Case | null;
  /** Set the active matter (persists to localStorage) */
  setActiveMatter: (matter: Case | null) => void;
  /** Clear the active matter selection */
  clearActiveMatter: () => void;
  /** True when active matter has status 'closed' — uploads/edits disabled */
  isReadOnly: boolean;
  /** True when active matter is archived — hidden from default views */
  isArchived: boolean;
}

const MatterContext = createContext<MatterContextState | null>(null);

export const MatterProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { cases } = useData();
  const [activeMatter, setActiveMatterState] = useState<Case | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Restore from localStorage on mount (after cases are loaded)
  useEffect(() => {
    if (cases.length === 0 && !initialized) return; // Wait for cases to load

    const storedId = localStorage.getItem(STORAGE_KEY);
    if (storedId) {
      const found = cases.find(c => c.id === storedId);
      if (found) {
        setActiveMatterState(found);
      } else {
        // Matter no longer exists or user lost access — clean up
        localStorage.removeItem(STORAGE_KEY);
        setActiveMatterState(null);
      }
    }
    setInitialized(true);
  }, [cases.length > 0]); // Re-run when cases first become available

  // Keep activeMatter in sync with cases data (e.g., after edits)
  useEffect(() => {
    if (!activeMatter) return;
    const updated = cases.find(c => c.id === activeMatter.id);
    if (updated) {
      // Sync any field changes (name, status, etc.)
      if (JSON.stringify(updated) !== JSON.stringify(activeMatter)) {
        setActiveMatterState(updated);
      }
    } else {
      // Matter was deleted
      localStorage.removeItem(STORAGE_KEY);
      setActiveMatterState(null);
    }
  }, [cases, activeMatter?.id]);

  const setActiveMatter = useCallback((matter: Case | null) => {
    setActiveMatterState(matter);
    if (matter) {
      localStorage.setItem(STORAGE_KEY, matter.id);
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  const clearActiveMatter = useCallback(() => {
    setActiveMatterState(null);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const isReadOnly = activeMatter?.status === 'closed';
  const isArchived = !!activeMatter?.archived_at;

  return (
    <MatterContext.Provider value={{
      activeMatter,
      setActiveMatter,
      clearActiveMatter,
      isReadOnly,
      isArchived,
    }}>
      {children}
    </MatterContext.Provider>
  );
};

/**
 * Hook to access the global matter context.
 * Must be used within a MatterProvider (which itself must be within a DataProvider).
 */
export function useMatter(): MatterContextState {
  const context = useContext(MatterContext);
  if (!context) {
    throw new Error('useMatter must be used within a MatterProvider');
  }
  return context;
}
