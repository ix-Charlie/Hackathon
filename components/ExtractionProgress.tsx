/**
 * ExtractionProgress — Real-time extraction job progress tracker
 * 
 * Polls the extraction-status endpoint and displays live progress.
 * Auto-dismisses when all jobs complete.
 */

import { useEffect, useState, useCallback } from 'react';
import * as intel from '../services/intelligenceService';

interface ExtractionProgressProps {
  caseId: string;
  onComplete?: () => void;
  onError?: (error: string) => void;
}

interface JobStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
}

export default function ExtractionProgress({ caseId, onComplete, onError }: ExtractionProgressProps) {
  const [stats, setStats] = useState<JobStats>({ pending: 0, processing: 0, completed: 0, failed: 0, total: 0 });
  const [isPolling, setIsPolling] = useState(true);

  const fetchStatus = useCallback(async () => {
    try {
      const jobs = await intel.getExtractionStatus(caseId);
      
      // Count jobs by status
      const newStats: JobStats = {
        pending: 0,
        processing: 0,
        completed: 0,
        failed: 0,
        total: jobs.length,
      };

      for (const job of jobs) {
        switch (job.status) {
          case 'pending':
            newStats.pending++;
            break;
          case 'processing':
            newStats.processing++;
            break;
          case 'completed':
            newStats.completed++;
            break;
          case 'failed':
            newStats.failed++;
            break;
        }
      }

      setStats(newStats);

      // Stop polling if all jobs are done (completed or failed)
      const allDone = newStats.pending === 0 && newStats.processing === 0;
      if (allDone && newStats.total > 0) {
        setIsPolling(false);
        onComplete?.();
      }

      // Report errors if any failed
      if (newStats.failed > 0 && allDone) {
        onError?.(`${newStats.failed} extraction job${newStats.failed > 1 ? 's' : ''} failed`);
      }
    } catch (err) {
      console.error('Failed to fetch extraction status:', err);
      onError?.(err instanceof Error ? err.message : 'Failed to fetch status');
      setIsPolling(false);
    }
  }, [caseId, onComplete, onError]);

  // Initial fetch + polling
  useEffect(() => {
    if (!isPolling) return;

    fetchStatus();
    const interval = setInterval(fetchStatus, 2500); // Poll every 2.5s

    return () => clearInterval(interval);
  }, [isPolling, fetchStatus]);

  // Don't render if no jobs
  if (stats.total === 0) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800">
        <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <span className="text-xs font-medium text-blue-700 dark:text-blue-400">
          Queuing extraction jobs...
        </span>
      </div>
    );
  }

  const progressPercent = stats.total > 0
    ? Math.round(((stats.completed + stats.failed) / stats.total) * 100)
    : 0;

  const isActive = stats.pending > 0 || stats.processing > 0;

  return (
    <div className="space-y-2 animate-fade-in">
      {/* Progress bar */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 bg-gray-200 dark:bg-gray-800 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-blue-500 to-blue-600 dark:from-blue-600 dark:to-blue-500 transition-all duration-500 ease-out"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
        <span className="text-sm font-semibold text-gray-900 dark:text-white min-w-[45px] text-right">
          {progressPercent}%
        </span>
      </div>

      {/* Status breakdown */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-4">
          {stats.processing > 0 && (
            <span className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
              {stats.processing} processing
            </span>
          )}
          {stats.pending > 0 && (
            <span className="text-gray-500 dark:text-gray-400">
              {stats.pending} pending
            </span>
          )}
          {stats.completed > 0 && (
            <span className="flex items-center gap-1.5 text-green-600 dark:text-green-400">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
              </svg>
              {stats.completed} completed
            </span>
          )}
          {stats.failed > 0 && (
            <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
              </svg>
              {stats.failed} failed
            </span>
          )}
        </div>

        {!isActive && (
          <span className="text-green-600 dark:text-green-400 font-medium">
            ✓ Done
          </span>
        )}
      </div>

      {/* Active indicator */}
      {isActive && (
        <div className="flex items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500">
          <span className="w-1 h-1 rounded-full bg-blue-400 animate-pulse" />
          Extraction in progress — intelligence will update automatically
        </div>
      )}
    </div>
  );
}
