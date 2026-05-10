import React, { useState, useEffect, useRef } from 'react';
import { Case, MatterType, MatterStatus } from '../types';
import { MATTER_TYPES, MATTER_STATUSES, getMatterTypeConfig, getMatterStatusConfig } from '../constants';
import * as caseService from '../services/caseService';
import { useData } from '../contexts/DataContext';
import { useMatter } from '../contexts/MatterContext';

interface EditMatterDrawerProps {
  matter: Case;
  open: boolean;
  onClose: () => void;
}

type ConfirmAction = 'close' | 'archive' | 'reopen' | null;

const EditMatterDrawer: React.FC<EditMatterDrawerProps> = ({ matter, open, onClose }) => {
  const { updateCase: updateCaseInContext, removeCase } = useData();
  const { activeMatter, clearActiveMatter } = useMatter();

  // Form state
  const [name, setName] = useState(matter.name);
  const [clientName, setClientName] = useState(matter.client_name || '');
  const [description, setDescription] = useState(matter.description || '');
  const [matterType, setMatterType] = useState<MatterType>(matter.matter_type || 'other');
  const [status, setStatus] = useState<MatterStatus>(matter.status);

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [isPerformingAction, setIsPerformingAction] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

  // Reset form when matter changes
  useEffect(() => {
    setName(matter.name);
    setClientName(matter.client_name || '');
    setDescription(matter.description || '');
    setMatterType(matter.matter_type || 'other');
    setStatus(matter.status);
    setSaveError(null);
    setSaveSuccess(false);
    setConfirmAction(null);
  }, [matter.id, matter.name, matter.client_name, matter.description, matter.matter_type, matter.status]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirmAction) {
          setConfirmAction(null);
        } else {
          handleClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, confirmAction, isClosing]);

  // Auto-dismiss success message
  useEffect(() => {
    if (saveSuccess) {
      const timer = setTimeout(() => setSaveSuccess(false), 2500);
      return () => clearTimeout(timer);
    }
  }, [saveSuccess]);

  const hasChanges = 
    name !== matter.name ||
    clientName !== (matter.client_name || '') ||
    description !== (matter.description || '') ||
    matterType !== (matter.matter_type || 'other');

  const handleSave = async () => {
    if (!name.trim()) {
      setSaveError('Matter name is required');
      return;
    }

    setIsSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    try {
      const updated = await caseService.updateCase(matter.id, {
        name: name.trim(),
        client_name: clientName.trim() || undefined,
        description: description.trim() || undefined,
        matter_type: matterType,
      });

      if (updated) {
        updateCaseInContext(matter.id, updated);
        setSaveSuccess(true);
      } else {
        setSaveError('Failed to update matter. Please try again.');
      }
    } catch (err) {
      setSaveError('An unexpected error occurred.');
      console.error('Error saving matter:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleStatusAction = async (action: ConfirmAction) => {
    if (!action) return;
    setIsPerformingAction(true);
    setSaveError(null);

    try {
      let updated: Case | null = null;

      switch (action) {
        case 'close':
          updated = await caseService.closeCase(matter.id);
          break;
        case 'archive':
          updated = await caseService.archiveCase(matter.id);
          break;
        case 'reopen':
          updated = await caseService.reopenCase(matter.id);
          break;
      }

      if (updated) {
        updateCaseInContext(matter.id, updated);
        setStatus(updated.status);
        setConfirmAction(null);
        setSaveSuccess(true);
      } else {
        setSaveError(`Failed to ${action} matter. Please try again.`);
      }
    } catch (err) {
      setSaveError(`An unexpected error occurred while trying to ${action}.`);
      console.error(`Error ${action} matter:`, err);
    } finally {
      setIsPerformingAction(false);
    }
  };

  if (!open) return null;

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      onClose();
    }, 250);
  };

  const typeConfig = getMatterTypeConfig(matterType);
  const statusConfig = getMatterStatusConfig(status);
  const isReadOnly = status === 'closed' || status === 'archived';

  return (
    <>
      {/* Backdrop */}
      <div 
        className={`fixed inset-0 bg-black/40 backdrop-blur-sm z-50 transition-opacity duration-250 ${isClosing ? 'opacity-0' : 'animate-backdrop-in'}`}
        onClick={handleClose}
      />

      {/* Drawer */}
      <div
        ref={drawerRef}
        className={`fixed right-0 top-0 h-full w-full max-w-lg bg-white dark:bg-gray-900 shadow-2xl z-50 flex flex-col ${isClosing ? 'animate-slide-out-right' : 'animate-slide-in-right'}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-700">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              {matter.name === 'General Documents' ? 'Edit General Documents' : 'Edit Matter'}
            </h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              {matter.matter_ref || matter.case_number || matter.id.slice(0, 8)}
            </p>
          </div>
          <button
            onClick={handleClose}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Status Banner */}
          {isReadOnly && (
            <div className={`flex items-center gap-3 px-4 py-3 rounded-lg ${
              status === 'closed' 
                ? 'bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700' 
                : 'bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800'
            }`}>
              <svg className="w-5 h-5 text-gray-500 dark:text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
              <div>
                <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  This matter is {status === 'closed' ? 'closed' : 'archived'}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {status === 'closed' ? 'No new uploads or edits allowed.' : 'Hidden from default views. Reopen to make changes.'}
                </p>
              </div>
            </div>
          )}

          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Matter Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={isReadOnly}
              className={`w-full px-3.5 py-2.5 rounded-lg border text-sm transition-colors ${
                isReadOnly
                  ? 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 cursor-not-allowed'
                  : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600 focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
              }`}
              placeholder="e.g., Smith v. Jones"
            />
          </div>

          {/* Client Name */}
          {matter.name !== 'General Documents' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Client Name
            </label>
            <input
              type="text"
              value={clientName}
              onChange={e => setClientName(e.target.value)}
              disabled={isReadOnly}
              className={`w-full px-3.5 py-2.5 rounded-lg border text-sm transition-colors ${
                isReadOnly
                  ? 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 cursor-not-allowed'
                  : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600 focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
              }`}
              placeholder="e.g., Acme Corporation"
            />
          </div>
          )}

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Description
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              disabled={isReadOnly}
              rows={3}
              className={`w-full px-3.5 py-2.5 rounded-lg border text-sm transition-colors resize-none ${
                isReadOnly
                  ? 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 cursor-not-allowed'
                  : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600 focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
              }`}
              placeholder="Brief description of this matter..."
            />
          </div>

          {/* Matter Type */}
          {matter.name !== 'General Documents' && (
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Matter Type
            </label>
            <div className="relative">
              <select
                value={matterType}
                onChange={e => setMatterType(e.target.value as MatterType)}
                disabled={isReadOnly}
                className={`w-full appearance-none px-3.5 py-2.5 pr-10 rounded-lg border text-sm transition-colors ${
                  isReadOnly
                    ? 'bg-gray-50 dark:bg-gray-800 text-gray-500 dark:text-gray-400 border-gray-200 dark:border-gray-700 cursor-not-allowed'
                    : 'bg-white dark:bg-gray-800 text-gray-900 dark:text-white border-gray-300 dark:border-gray-600 focus:ring-2 focus:ring-blue-500 focus:border-blue-500'
                }`}
              >
                {MATTER_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
              <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
          )}

          {/* Current Status (read-only display) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
              Status
            </label>
            <div className="flex items-center gap-3">
              <span className={`inline-flex items-center px-3 py-1.5 rounded-full text-xs font-medium ${statusConfig.color} ${statusConfig.textColor}`}>
                {statusConfig.label}
              </span>
              {matter.archived_at && (
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  Archived {new Date(matter.archived_at).toLocaleDateString()}
                </span>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
              {matter.name === 'General Documents' ? 'Workspace Actions' : 'Matter Actions'}
            </h3>
            <div className="space-y-2">
              {/* Close Matter */}
              {status === 'active' && (
                <button
                  onClick={() => setConfirmAction('close')}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left"
                >
                  <svg className="w-5 h-5 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      {matter.name === 'General Documents' ? 'Close General Documents' : 'Close Matter'}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Mark as closed — no new files or edits</p>
                  </div>
                </button>
              )}

              {/* Archive Matter */}
              {(status === 'active' || status === 'closed') && (
                <button
                  onClick={() => setConfirmAction('archive')}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-left"
                >
                  <svg className="w-5 h-5 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                      {matter.name === 'General Documents' ? 'Archive General Documents' : 'Archive Matter'}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Hide from default views, can be restored later</p>
                  </div>
                </button>
              )}

              {/* Reopen Matter */}
              {(status === 'closed' || status === 'archived') && (
                <button
                  onClick={() => setConfirmAction('reopen')}
                  className="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-green-200 dark:border-green-800 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors text-left"
                >
                  <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-green-700 dark:text-green-400">
                      {matter.name === 'General Documents' ? 'Reopen General Documents' : 'Reopen Matter'}
                    </p>
                    <p className="text-xs text-gray-500 dark:text-gray-400">Restore to active status — allows uploads and edits</p>
                  </div>
                </button>
              )}
            </div>
          </div>

          {/* Matter Info (read-only) */}
          <div className="border-t border-gray-200 dark:border-gray-700 pt-4">
            <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">Details</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">ID</span>
                <span className="text-gray-700 dark:text-gray-300 font-mono text-xs">
                  {matter.matter_ref || matter.id.slice(0, 12)}
                </span>
              </div>
              {matter.case_number && (
                <div className="flex justify-between">
                  <span className="text-gray-500 dark:text-gray-400">Case Number</span>
                  <span className="text-gray-700 dark:text-gray-300">{matter.case_number}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Created</span>
                <span className="text-gray-700 dark:text-gray-300">
                  {new Date(matter.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500 dark:text-gray-400">Last Updated</span>
                <span className="text-gray-700 dark:text-gray-300">
                  {new Date(matter.updated_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer — Save / Error / Success */}
        <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4 space-y-3">
          {saveError && (
            <div className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {saveError}
            </div>
          )}
          {saveSuccess && (
            <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-3 py-2 rounded-lg">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Changes saved successfully
            </div>
          )}

          {!isReadOnly && (
            <div className="flex gap-3">
              <button
                onClick={handleClose}
                className="flex-1 px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving || !hasChanges || !name.trim()}
                className={`flex-1 px-4 py-2.5 text-sm font-medium text-white rounded-lg transition-colors flex items-center justify-center gap-2 ${
                  isSaving || !hasChanges || !name.trim()
                    ? 'bg-blue-400 cursor-not-allowed'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {isSaving ? (
                  <>
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Saving…
                  </>
                ) : 'Save Changes'}
              </button>
            </div>
          )}

          {isReadOnly && (
            <button
              onClick={handleClose}
              className="w-full px-4 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
            >
              Close
            </button>
          )}
        </div>
      </div>

      {/* Confirmation Dialog */}
      {confirmAction && (
        <>
          <div className="fixed inset-0 bg-black/50 z-[60]" onClick={() => setConfirmAction(null)} />
          <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-[60] w-full max-w-md bg-white dark:bg-gray-900 rounded-xl shadow-2xl p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
              {confirmAction === 'close' && (matter.name === 'General Documents' ? 'Close General Documents?' : 'Close this matter?')}
              {confirmAction === 'archive' && (matter.name === 'General Documents' ? 'Archive General Documents?' : 'Archive this matter?')}
              {confirmAction === 'reopen' && (matter.name === 'General Documents' ? 'Reopen General Documents?' : 'Reopen this matter?')}
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
              {confirmAction === 'close' && (matter.name === 'General Documents' 
                ? 'Closing General Documents will prevent any new file uploads or document edits. You can reopen it later.'
                : 'Closing this matter will prevent any new file uploads or document edits. You can reopen it later.')}
              {confirmAction === 'archive' && (matter.name === 'General Documents'
                ? 'Archiving General Documents will hide it from default views. All data is preserved and can be restored.'
                : 'Archiving will hide this matter from default views. All data is preserved and can be restored.')}
              {confirmAction === 'reopen' && (matter.name === 'General Documents'
                ? 'This will restore General Documents to active status, allowing file uploads and edits.'
                : 'This will restore the matter to active status, allowing file uploads and edits.')}
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={() => setConfirmAction(null)}
                disabled={isPerformingAction}
                className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleStatusAction(confirmAction)}
                disabled={isPerformingAction}
                className={`px-4 py-2 text-sm font-medium text-white rounded-lg transition-colors flex items-center gap-2 ${
                  confirmAction === 'reopen'
                    ? 'bg-green-600 hover:bg-green-700'
                    : confirmAction === 'archive'
                    ? 'bg-yellow-600 hover:bg-yellow-700'
                    : 'bg-gray-600 hover:bg-gray-700'
                }`}
              >
                {isPerformingAction && (
                  <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                )}
                {confirmAction === 'close' && (matter.name === 'General Documents' ? 'Close' : 'Close Matter')}
                {confirmAction === 'archive' && (matter.name === 'General Documents' ? 'Archive' : 'Archive Matter')}
                {confirmAction === 'reopen' && (matter.name === 'General Documents' ? 'Reopen' : 'Reopen Matter')}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
};

export default EditMatterDrawer;
