import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { UploadedFile, ChatSession, AppView, Case } from '../types';

interface SidebarProps {
  files: UploadedFile[];
  sessions: ChatSession[];
  currentSessionId: string | null;
  currentView: AppView;
  isOpen: boolean;
  onToggle: () => void;
  onRemoveFile: (id: string) => void;
  onFilesSelected: (files: File[]) => void;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  onDeleteSession: (id: string) => void;
  onRenameSession: (id: string, newTitle: string) => void;
  onPinSession: (id: string) => void;
  onShareSession?: (id: string) => void;
  onOpenVault: () => void;
  onOpenIntelligence: () => void;
  onOpenSettings: () => void;
  onLogout: () => void;
  userEmail?: string;
  planName?: string;
  creditPercent?: number;
  /** All matters for looking up session case_id → matter name */
  cases?: Case[];
}

const Sidebar: React.FC<SidebarProps> = ({ 
  files, 
  sessions,
  currentSessionId,
  currentView,
  isOpen,
  onToggle,
  onRemoveFile, 
  onFilesSelected,
  onSelectSession,
  onNewChat,
  onDeleteSession,
  onRenameSession,
  onPinSession,
  onShareSession,
  onOpenVault,
  onOpenIntelligence,
  onOpenSettings,
  onLogout,
  userEmail,
  planName,
  creditPercent,
  cases = [],
}) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [allCollapsed, setAllCollapsed] = useState(false);

  // Build case_id → name lookup for matter badges
  const caseNameMap = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const c of cases) map.set(c.id, c.name);
    return map;
  }, [cases]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(Array.from(e.target.files));
      e.target.value = "";
    }
  };

  // Sort sessions: pinned first, then by timestamp
  const sortedSessions = [...sessions].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.timestamp - a.timestamp;
  });

  return (
    <>
      {/* Sidebar Container */}
      <aside 
        className={`
          fixed inset-y-0 left-0 z-30 w-72 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800
          transition-transform duration-300 ease-in-out will-change-transform flex flex-col overflow-hidden
          md:static md:transition-[width,transform]
          ${isOpen
            ? 'translate-x-0 md:w-72'
            : '-translate-x-full pointer-events-none md:translate-x-0 md:w-0 md:border-none md:pointer-events-auto'
          }
        `}
      >
        <div className={`flex flex-col h-full w-72`}> 
          {/* Header */}
          <div className="px-3 pt-3 pb-2 flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-2">
              <img src="/horizon-logo-white.webp" alt="Horizon Logo" width={28} height={28} decoding="async" fetchPriority="high" className="w-7 h-7 rounded-lg dark:hidden" />
              <img src="/horizon-logo-black.webp" alt="Horizon Logo" width={28} height={28} decoding="async" fetchPriority="high" className="w-7 h-7 rounded-lg hidden dark:block" />
              <span className="text-base font-medium text-gray-900 dark:text-white">Horizon</span>
            </div>
            <button 
              onClick={onToggle}
              className="p-1.5 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-white hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
              title="Close Sidebar"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
            </button>
          </div>

          {/* Navigation Buttons */}
          <div className="px-3 py-2 space-y-1">
            {/* New Chat */}
            <button
              onClick={onNewChat}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-800 transition-all active:scale-[0.98]"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
              New chat
            </button>

            {/* Search Chats */}
            <div className="relative">
              <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                placeholder="Search chats"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-3 py-2.5 rounded-lg text-sm bg-transparent text-gray-700 dark:text-gray-200 placeholder-gray-400 hover:bg-gray-200 dark:hover:bg-gray-800 focus:bg-white dark:focus:bg-gray-800 focus:outline-none focus:ring-1 focus:ring-gray-300 dark:focus:ring-gray-600 transition-colors"
              />
            </div>

            {/* Vault */}
            <button
              onClick={onOpenVault}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all active:scale-[0.98] ${
                currentView === AppView.VAULT
                  ? 'bg-gray-200 dark:bg-gray-800 text-gray-900 dark:text-white'
                  : 'text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-800'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
              Vault
            </button>

            {/* Matter Brief */}
            <button
              onClick={onOpenIntelligence}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all active:scale-[0.98] ${
                currentView === AppView.INTELLIGENCE
                  ? 'bg-gray-200 dark:bg-gray-800 text-gray-900 dark:text-white'
                  : 'text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-800'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              Matter Brief
            </button>
          </div>

          {/* Divider */}
          <div className="mx-3 my-2 border-t border-gray-200 dark:border-gray-800" />

          {/* Chat Sessions */}
          <div className="flex-1 overflow-y-auto px-3">
            <div className="flex items-center justify-between px-2 py-1.5">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">Your chats</p>
              <button
                onClick={() => setAllCollapsed(!allCollapsed)}
                className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
                title={allCollapsed ? "Expand all" : "Collapse all"}
              >
                {allCollapsed ? 'Expand' : 'Collapse'}
              </button>
            </div>
            <ul className="space-y-0.5">
              {(searchQuery.trim()
                ? sortedSessions.filter(s => s.title.toLowerCase().includes(searchQuery.toLowerCase()))
                : sortedSessions
              ).map(session => (
                <SessionItem 
                  key={session.id} 
                  session={session} 
                  isActive={session.id === currentSessionId}
                  collapsed={allCollapsed}
                  matterName={session.case_id ? caseNameMap.get(session.case_id) : undefined}
                  onSelect={() => onSelectSession(session.id)}
                  onDelete={() => onDeleteSession(session.id)}
                  onRename={(newTitle) => onRenameSession(session.id, newTitle)}
                  onPin={() => onPinSession(session.id)}
                  onShare={onShareSession ? () => onShareSession(session.id) : undefined}
                />
              ))}
              {(searchQuery.trim()
                ? sortedSessions.filter(s => s.title.toLowerCase().includes(searchQuery.toLowerCase()))
                : sortedSessions
              ).length === 0 && (
                <li className="text-sm text-gray-400 px-2 py-4 text-center">
                  {searchQuery ? 'No chats found' : 'No chats yet'}
                </li>
              )}
            </ul>
          </div>

          {/* Settings & User */}
          <div className="px-3 py-3 border-t border-gray-200 dark:border-gray-800 space-y-1">
            <button
              onClick={onOpenSettings}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all active:scale-[0.98] ${
                currentView === AppView.SETTINGS
                  ? 'bg-gray-200 dark:bg-gray-800 text-gray-900 dark:text-white'
                  : 'text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-800'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </button>

            {/* User profile */}
            <div className="flex items-center gap-3 px-3 py-2">
              <div className="w-8 h-8 bg-orange-500 rounded-full flex items-center justify-center text-white text-xs font-bold">
                {userEmail ? userEmail.slice(0, 2).toUpperCase() : 'U'}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-gray-900 dark:text-white truncate">
                  {userEmail ? userEmail.split('@')[0] : 'User'}
                </p>
                <p className="text-xs text-gray-500 dark:text-gray-400">{planName || 'No Plan'}</p>
                {typeof creditPercent === 'number' && (
                  <div className="mt-1 w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        creditPercent >= 90 ? 'bg-red-500' : creditPercent >= 70 ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                      style={{ width: `${Math.min(creditPercent, 100)}%` }}
                    />
                  </div>
                )}
              </div>
              <button 
                onClick={onLogout}
                className="p-1.5 rounded-lg text-gray-400 hover:text-red-500 hover:bg-gray-200 dark:hover:bg-gray-800 transition-colors"
                title="Sign Out"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
};

// Session Item with 3-dot menu
const SessionItem: React.FC<{
  session: ChatSession;
  isActive: boolean;
  collapsed: boolean;
  matterName?: string;
  onSelect: () => void;
  onDelete: () => void;
  onRename: (newTitle: string) => void;
  onPin: () => void;
  onShare?: () => void;
}> = ({ session, isActive, collapsed, matterName, onSelect, onDelete, onRename, onPin, onShare }) => {
  const [showMenu, setShowMenu] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(session.title);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleMenuClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowMenu(!showMenu);
  };

  const handleRename = () => {
    setShowMenu(false);
    setIsRenaming(true);
  };

  const handleRenameSubmit = () => {
    if (renameValue.trim()) {
      onRename(renameValue.trim());
    }
    setIsRenaming(false);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      setRenameValue(session.title);
      setIsRenaming(false);
    }
  };

  const handlePin = () => {
    setShowMenu(false);
    onPin();
  };

  const handleShare = () => {
    setShowMenu(false);
    if (onShare) onShare();
  };

  const handleDelete = () => {
    setShowMenu(false);
    setShowDeleteConfirm(true);
  };

  const confirmDelete = () => {
    setShowDeleteConfirm(false);
    onDelete();
  };

  const cancelDelete = () => {
    setShowDeleteConfirm(false);
  };

  // Close menu when clicking outside
  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  // Animated collapse for non-active sessions
  const isHidden = collapsed && !isActive;

  return (
    <>
      <li 
        onClick={onSelect}
        className={`
          group relative flex items-center justify-between rounded-lg cursor-pointer text-sm 
          transition-[max-height,opacity,padding] duration-300 ease-in-out origin-top
          ${isHidden 
            ? 'max-h-0 opacity-0 py-0 px-2 overflow-hidden pointer-events-none' 
            : `${matterName ? 'max-h-20' : 'max-h-14'} opacity-100 py-2 px-2`
          }
          ${isActive 
            ? 'bg-gray-200 dark:bg-gray-800 text-gray-900 dark:text-white' 
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
          }
        `}
      >
      {isRenaming ? (
        <input
          type="text"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRenameSubmit}
          onKeyDown={handleRenameKeyDown}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          autoFocus
        />
      ) : (
        <div className="flex flex-col truncate flex-1 pr-2">
          <div className="flex items-center gap-1.5 truncate">
            {session.pinned && (
              <svg className="w-3.5 h-3.5 flex-shrink-0 text-amber-500" fill="currentColor" viewBox="0 0 20 20">
                <path d="M10 2a1 1 0 011 1v1.323l3.954 1.582 1.599-.8a1 1 0 01.894 1.79l-1.233.616 1.738 5.42a1 1 0 01-.285 1.05A3.989 3.989 0 0115 15a3.989 3.989 0 01-2.667-1.019 1 1 0 01-.285-1.05l1.715-5.349L11 6.477V16h2a1 1 0 110 2H7a1 1 0 110-2h2V6.477L6.237 7.582l1.715 5.349a1 1 0 01-.285 1.05A3.989 3.989 0 015 15a3.989 3.989 0 01-2.667-1.019 1 1 0 01-.285-1.05l1.738-5.42-1.233-.617a1 1 0 01.894-1.788l1.599.799L9 4.323V3a1 1 0 011-1z" />
              </svg>
            )}
            <span className="truncate">{session.title || 'New chat'}</span>
          </div>
          {matterName && (
            <span className="text-[10px] text-blue-500 dark:text-blue-400 truncate mt-0.5">
              {matterName}
            </span>
          )}
        </div>
      )}
      
      {/* 3-dot menu button */}
      <div className="relative flex-shrink-0" ref={menuRef}>
        <button 
          onClick={handleMenuClick}
          className={`
            p-1 rounded-lg hover:bg-gray-300 dark:hover:bg-gray-700
            text-gray-400 opacity-100 md:opacity-0 md:group-hover:opacity-100
            ${showMenu ? 'opacity-100' : ''}
            transition-opacity
          `}
        >
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM16 12a2 2 0 100-4 2 2 0 000 4z" />
          </svg>
        </button>
        
        {/* Dropdown Menu - ChatGPT style */}
        {showMenu && (
          <div className="absolute right-0 top-full mt-1 w-48 bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 z-50 py-1 overflow-hidden animate-popover-in origin-top-right">
            {/* Share */}
            {onShare && (
              <button
                onClick={handleShare}
                className="w-full px-4 py-2.5 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-3"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Share
              </button>
            )}
            
            {/* Rename */}
            <button
              onClick={handleRename}
              className="w-full px-4 py-2.5 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-3"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
              Rename
            </button>
            
            {/* Pin */}
            <button
              onClick={handlePin}
              className="w-full px-4 py-2.5 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center gap-3"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
              </svg>
              {session.pinned ? 'Unpin chat' : 'Pin chat'}
            </button>
            
            {/* Divider */}
            <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
            
            {/* Delete */}
            <button
              onClick={handleDelete}
              className="w-full px-4 py-2.5 text-left text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-3"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
              Delete
            </button>
          </div>
        )}
      </div>
    </li>

      {/* Delete Confirmation Modal - Rendered via Portal */}
      {showDeleteConfirm && createPortal(
        <div 
          className="fixed inset-0 bg-black/60 backdrop-blur-[0.5px] flex items-center justify-center z-[100] animate-backdrop-in" 
          onClick={cancelDelete}
        >
          <div 
            className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl p-6 max-w-md w-full mx-4 border border-gray-200 dark:border-gray-700 animate-scale-in"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">
              Delete chat?
            </h3>
            <p className="text-[15px] text-gray-600 dark:text-gray-400 mb-8 leading-relaxed">
              This will delete <span className="font-semibold text-gray-900 dark:text-white">{session.title}.</span>
            </p>
            <div className="flex gap-3 justify-end">
              <button
                onClick={cancelDelete}
                className="px-5 py-2.5 text-sm font-medium text-gray-700 dark:text-gray-200 bg-transparent hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors shadow-sm"
              >
                Delete
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};

const FileItem: React.FC<{ file: UploadedFile; onRemove: (id: string) => void }> = ({ file, onRemove }) => {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleRemoveClick = () => {
    if (confirmDelete) {
      onRemove(file.id);
    } else {
      setConfirmDelete(true);
      setTimeout(() => setConfirmDelete(false), 3000);
    }
  };

  return (
    <li className="group flex items-center justify-between p-2 rounded-md hover:bg-white dark:hover:bg-gray-700 transition-colors">
      <div className="flex items-center gap-2 overflow-hidden">
        <svg className="w-4 h-4 text-charcoal-muted dark:text-gray-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <span className="text-sm text-charcoal-secondary dark:text-gray-300 truncate" title={file.name}>{file.name}</span>
      </div>
      <button 
        onClick={handleRemoveClick}
        className={`
          text-charcoal-muted dark:text-gray-400 hover:text-semantic-error transition-all ml-2
          ${confirmDelete ? 'opacity-100 text-semantic-error' : 'opacity-0 group-hover:opacity-100'}
        `}
        title="Remove file"
      >
        {confirmDelete ? (
          <span className="text-xs font-bold px-1">Sure?</span>
        ) : (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        )}
      </button>
    </li>
  );
};

export default Sidebar;
