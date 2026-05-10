import { supabase } from './supabaseClient';
import { ChatSession, ChatMessage, Role, SourceCitation } from '../types';

// ============================================================================
// HELPERS
// ============================================================================

async function getUserContext(): Promise<{ userId: string; tenantId: string } | null> {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    console.error('[chatService] No authenticated user');
    return null;
  }

  const { data, error } = await supabase
    .from('tenant_members')
    .select('tenant_id')
    .eq('user_id', user.id)
    .single();

  if (error || !data?.tenant_id) {
    console.error('[chatService] No tenant found for user:', user.id, error);
    return null;
  }
  return { userId: user.id, tenantId: data.tenant_id };
}

// ============================================================================
// DB ROW → FRONTEND TYPE CONVERTERS
// ============================================================================

interface DbChatSession {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message_preview: string | null;
  is_pinned: boolean;
  is_archived: boolean;
  case_id: string | null;
}

const SESSION_COLUMNS = 'id, tenant_id, user_id, title, created_at, updated_at, message_count, last_message_preview, is_pinned, is_archived, case_id';

interface DbChatMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  sources: any | null;
  thinking_process: string | null;
  is_error: boolean;
}

function dbSessionToFrontend(row: DbChatSession): ChatSession {
  return {
    id: row.id,
    title: row.title || 'New Chat',
    messages: [], // loaded lazily on session select
    timestamp: new Date(row.created_at).getTime(),
    pinned: row.is_pinned,
    messageCount: row.message_count || 0,
    lastPreview: row.last_message_preview || undefined,
    case_id: row.case_id || undefined,
  };
}

function dbMessageToFrontend(row: DbChatMessage): ChatMessage {
  const sources: SourceCitation[] | undefined = row.sources
    ? (Array.isArray(row.sources) ? row.sources : [])
    : undefined;

  // Support both 'model' and 'assistant' role names for backward compatibility
  const isAssistant = row.role === 'model' || row.role === 'assistant';

  // Infer hasSubstantiveWork from thinking content or sources — ensures ResearchPanel
  // renders correctly for historical messages loaded from DB.
  // Messages with RAG sources or substantive thinking steps had real processing.
  const hasSubstantiveWork = !!(row.thinking_process && row.thinking_process.length > 0)
    || (Array.isArray(row.sources) && row.sources.length > 0);

  return {
    id: String(row.id), // DB bigint → string for React keys
    role: row.role === 'user' ? Role.USER : Role.MODEL,
    content: row.content || '',
    timestamp: new Date(row.created_at).getTime(),
    sources,
    thinking: row.thinking_process || undefined,
    isThinking: false,
    isError: row.is_error || false,
    hasSubstantiveWork,
  };
}

// ============================================================================
// SESSION OPERATIONS
// ============================================================================

/**
 * Fetch all non-archived sessions for the current user.
 * Returns sessions sorted by pinned first, then updated_at descending.
 */
export async function fetchSessions(): Promise<ChatSession[]> {
  const ctx = await getUserContext();
  if (!ctx) return [];

  const { data, error } = await supabase
    .from('chat_sessions')
    .select(SESSION_COLUMNS)
    .eq('tenant_id', ctx.tenantId)
    .eq('user_id', ctx.userId)
    .eq('is_archived', false)
    .order('is_pinned', { ascending: false })
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('Error fetching chat sessions:', error);
    return [];
  }

  return (data || []).map(dbSessionToFrontend);
}

/**
 * Create a new chat session in the database.
 * Returns the created session with its DB-generated UUID.
 */
export async function createSession(title: string, caseId?: string): Promise<ChatSession | null> {
  const ctx = await getUserContext();
  if (!ctx) return null;

  const insertPayload: any = {
    tenant_id: ctx.tenantId,
    user_id: ctx.userId,
    title,
  };
  if (caseId) insertPayload.case_id = caseId;

  const { data, error } = await supabase
    .from('chat_sessions')
    .insert(insertPayload)
    .select(SESSION_COLUMNS)
    .single();

  if (error) {
    console.error('Error creating chat session:', error);
    return null;
  }

  return dbSessionToFrontend(data);
}

/**
 * Update session fields (title, is_pinned, is_archived).
 */
export async function updateSession(
  sessionId: string,
  updates: { title?: string; is_pinned?: boolean; is_archived?: boolean; case_id?: string | null }
): Promise<boolean> {
  const ctx = await getUserContext();
  if (!ctx) return false;

  const { error } = await supabase
    .from('chat_sessions')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('tenant_id', ctx.tenantId)
    .eq('user_id', ctx.userId);

  if (error) {
    console.error('Error updating chat session:', error);
    return false;
  }
  return true;
}

/**
 * Delete a chat session. Messages are cascade-deleted by the DB.
 */
export async function deleteSession(sessionId: string): Promise<boolean> {
  const ctx = await getUserContext();
  if (!ctx) return false;

  const { data, error } = await supabase
    .from('chat_sessions')
    .delete()
    .select('id')
    .eq('id', sessionId)
    .eq('tenant_id', ctx.tenantId)
    .eq('user_id', ctx.userId);

  if (error) {
    console.error('Error deleting chat session:', error);
    return false;
  }

  if (!data || data.length === 0) {
    console.warn('[chatService.deleteSession] No chat session rows deleted:', {
      sessionId,
      tenantId: ctx.tenantId,
      userId: ctx.userId,
    });
    return false;
  }

  return true;
}

// ============================================================================
// MESSAGE OPERATIONS
// ============================================================================

/**
 * Fetch all messages for a session, ordered chronologically.
 */
export async function fetchMessages(sessionId: string): Promise<ChatMessage[]> {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('id, session_id, role, content, created_at, sources, thinking_process, is_error')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching chat messages:', error);
    return [];
  }

  console.log(`[fetchMessages] Loaded ${data?.length || 0} messages for session ${sessionId}`);
  if (data && data.length > 0) {
    console.log('[fetchMessages] Sample message roles:', data.map(m => ({ id: m.id, role: m.role })));
  }

  return (data || []).map(dbMessageToFrontend);
}

/**
 * Save a single message to the database.
 * Returns the DB-generated id (as string) or null on failure.
 */
export async function saveMessage(
  sessionId: string,
  msg: {
    role: 'user' | 'model';
    content: string;
    sources?: SourceCitation[];
    thinking?: string;
    isError?: boolean;
  }
): Promise<string | null> {
  console.log('[saveMessage] Attempting to save:', { 
    sessionId, 
    role: msg.role, 
    contentLength: msg.content.length,
    hasSources: !!msg.sources,
    hasThinking: !!msg.thinking 
  });

  // Database uses 'assistant' instead of 'model' due to check constraint
  const dbRole = msg.role === 'model' ? 'assistant' : msg.role;

  const { data, error } = await supabase
    .from('chat_messages')
    .insert({
      session_id: sessionId,
      role: dbRole,
      content: msg.content,
      sources: msg.sources && msg.sources.length > 0 ? msg.sources : null,
      thinking_process: msg.thinking || null,
      is_error: msg.isError || false,
    })
    .select('id')
    .single();

  if (error) {
    console.error('[saveMessage] ERROR saving chat message:', error);
    console.error('[saveMessage] Failed payload:', { sessionId, role: dbRole, contentPreview: msg.content.substring(0, 50) });
    return null;
  }

  console.log('[saveMessage] Successfully saved message:', { id: data.id, role: dbRole });
  return String(data.id);
}

/**
 * Update a message (used to finalize model response after streaming).
 */
export async function updateMessage(
  messageId: string,
  updates: {
    content?: string;
    sources?: SourceCitation[];
    thinking?: string;
    isError?: boolean;
  }
): Promise<boolean> {
  const payload: any = {};
  if (updates.content !== undefined) payload.content = updates.content;
  if (updates.sources !== undefined) payload.sources = updates.sources.length > 0 ? updates.sources : null;
  if (updates.thinking !== undefined) payload.thinking_process = updates.thinking;
  if (updates.isError !== undefined) payload.is_error = updates.isError;

  const { error } = await supabase
    .from('chat_messages')
    .update(payload)
    .eq('id', parseInt(messageId, 10));

  if (error) {
    console.error('Error updating chat message:', error);
    return false;
  }
  return true;
}

/**
 * Delete specific messages by their IDs.
 * Used for retry: removes only the selected message pair without affecting later messages.
 */
export async function deleteSpecificMessages(messageIds: string[]): Promise<boolean> {
  if (messageIds.length === 0) return true;

  const numericIds = messageIds.map(id => parseInt(id, 10)).filter(id => !isNaN(id));
  if (numericIds.length === 0) return true;

  const { error } = await supabase
    .from('chat_messages')
    .delete()
    .in('id', numericIds);

  if (error) {
    console.error('Error deleting specific messages:', error);
    return false;
  }
  return true;
}

/**
 * Delete all messages in a session that were created at or after a given message.
 * Used for edit-and-resend: removes the edited message and everything after it.
 */
export async function deleteMessagesFrom(sessionId: string, messageId: string): Promise<boolean> {
  // First get the timestamp of this message
  const { data: msg, error: fetchErr } = await supabase
    .from('chat_messages')
    .select('created_at')
    .eq('id', parseInt(messageId, 10))
    .single();

  if (fetchErr || !msg) {
    console.error('Error finding message for delete:', fetchErr);
    return false;
  }

  // Delete this message and everything after it in the same session
  const { error } = await supabase
    .from('chat_messages')
    .delete()
    .eq('session_id', sessionId)
    .gte('created_at', msg.created_at);

  if (error) {
    console.error('Error deleting messages:', error);
    return false;
  }
  return true;
}
