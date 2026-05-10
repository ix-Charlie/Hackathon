import { UploadedFile, ChatMessage, Role, SourceCitation, HorizonMode, LegalActionFlags, Case, PendingAttachment } from '../types';
import { supabase } from './supabaseClient';
import { SUPABASE_URL, BACKEND_API_URL } from './config';

// Re-export SourceCitation for consumers
export type { SourceCitation };

// Stream chunk can be text content, state updates, source citations, validation, attachments, or agent events
export interface StreamChunk {
  type: 'content' | 'sources' | 'state' | 'validation' | 'attachments' | 'agent_task' | 'tool_progress' | 'artifact' | 'file_export' | 'file_requested' | 'warning' | 'agent_plan' | 'tool_gateway' | 'clarifying_questions' | 'verification';
  content?: string;
  sources?: SourceCitation[];
  state?: string;
  detail?: string;
  substantive?: boolean; // True only for RAG, tools, reasoning — not orchestration
  validation?: {
    confidence: 'high' | 'medium' | 'low';
    has_document_context: boolean;
    has_structured_data: boolean;
    data_points_used: number;
    source_count: number;
    warnings?: string[];
  };
  attachments?: Array<{
    id: string;
    filename: string;
    mime_type: string;
    size: number;
    type: 'file' | 'image';
    storage_path: string;
  }>;
  // Agent pipeline events
  agentTaskType?: string;
  toolName?: string;
  toolRound?: number;
  toolMessage?: string;
  // Artifact created event
  artifactId?: string;
  artifactTitle?: string;
  artifactDocumentType?: string;
  // File export event — backend found exportable content, frontend should trigger download
  exportMarkdown?: string;
  exportTitle?: string;
  exportFormat?: 'word' | 'pdf';
  // File requested event — backend signals that auto-export should happen after pipeline
  fileRequestedFormat?: 'word' | 'pdf';
  // Agentic architecture events
  agentPlan?: {
    intent: string;
    requires_retrieval: boolean;
    tools_requested: string[];
    citations_required: boolean;
    execution_budget: { max_tool_calls: number; max_rounds: number; max_docs: number };
  };
  toolGateway?: {
    tool: string;
    allowed: boolean;
    reason: string;
    requires_confirmation: boolean;
  };
  clarifyingQuestions?: string[];
  verification?: {
    verdict: 'pass' | 'fail';
    reasons: string[];
    risk_level: string;
  };
}

/**
 * Sends a message to Horizon via Supabase Edge Function.
 * The Edge Function handles OpenAI API calls securely on the server side.
 * 
 * @param currentMessage - The user's message
 * @param history - Previous messages in the conversation
 * @param files - Legacy: Full file content (for backward compatibility)
 * @param file_ids - RAG mode: Specific file IDs to search in (optional, searches all if not provided)
 * @param temperature - Model temperature (0.1-1.0) for creativity control
 * @param mode - Horizon mode for structured legal workflows (default: 'general')
 * @param subOptions - Active sub-option IDs that modify output behavior within the mode
 * @param actionFlags - Legal action flags (web search, jurisdiction, deep analysis, etc.)
 */
export const sendMessageToHorizonStream = async function* (
  currentMessage: string,
  history: ChatMessage[],
  files: UploadedFile[],
  file_ids?: string[],
  _showThinking?: boolean, // Deprecated — kept for backward compat, ignored
  temperature?: number,
  signal?: AbortSignal,
  mode?: HorizonMode,
  subOptions?: string[],
  activeMatter?: Case | null,
  actionFlags?: LegalActionFlags
): AsyncGenerator<StreamChunk> {
  try {
    // Get the current session token
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    
    if (!session || !session.access_token) {
      console.error('No valid session or access token');
      throw new Error("Not authenticated. Please sign in again.");
    }

    // Call the edge function
    const response = await fetch(`${SUPABASE_URL}/functions/v1/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        message: currentMessage,
        history: history.map(msg => ({
          role: msg.role === Role.USER ? 'user' : 'model',
          content: msg.content
        })),
        // Only send files that the Edge Function can inline-read (text/csv/base64 with valid MIME).
        // Binary formats like .msg are handled via RAG (file_ids + document_chunks), not direct content.
        files: files.filter(f => f.name && f.mimeType && f.data && ![
          'application/vnd.ms-outlook',
        ].includes(f.mimeType)),
        file_ids: file_ids,
        case_id: activeMatter?.id,
        session_id: (window as any).__currentSessionId,
        // Send matter metadata so the LLM knows which case is active
        ...(activeMatter && {
          case_name: activeMatter.name,
          case_client: activeMatter.client_name,
          case_description: activeMatter.description,
          case_number: activeMatter.case_number,
          case_matter_type: activeMatter.matter_type,
        }),
        use_rag: true,
        temperature: temperature,
        mode: mode || 'general',
        sub_options: subOptions || [],
        // Runtime context: user timezone for deterministic temporal reasoning
        user_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        // Legal Action Flags — execution modifiers from the action menu
        ...(actionFlags && {
          web_search: actionFlags.web_search_enabled,
          jurisdiction: actionFlags.jurisdiction,
          deep_analysis: actionFlags.deep_analysis,
          strict_citations: actionFlags.strict_citations,
          privilege_review: actionFlags.privilege_review,
          fast_mode: actionFlags.fast_mode,
        }),
      }),
      signal, // Add abort signal
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(errorData.error || `Request failed with status ${response.status}`);
    }

    // Stream the response
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("No response body");
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      
      // Process each line in the buffer
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep the last incomplete line in the buffer

      for (const line of lines) {
        if (line.trim() === '' || line.trim() === 'data: [DONE]') continue;
        console.log('[STREAM] Received line:', line);
        try {
          if (line.startsWith('data: ')) {
            const jsonStr = line.substring(6);
            const data = JSON.parse(jsonStr);
            
            // Source citations from RAG
            if (data.type === 'sources' && data.sources) {
              console.log('[STREAM] Yielding sources:', data.sources);
              yield { type: 'sources', sources: data.sources };
            }
            // Validation metadata (confidence, warnings)
            else if (data.type === 'validation') {
              console.log('[STREAM] Validation:', data.confidence, 'warnings:', data.warnings?.length || 0);
              yield { type: 'validation', validation: {
                confidence: data.confidence,
                has_document_context: data.has_document_context,
                has_structured_data: data.has_structured_data,
                data_points_used: data.data_points_used,
                source_count: data.source_count,
                warnings: data.warnings,
              }};
            }
            // Pipeline state updates (classifying, searching, synthesizing, etc.)
            else if (data.type === 'state' && data.value) {
              console.log('[STREAM] State:', data.value, 'substantive:', data.substantive ?? false, data.detail || '');
              yield { type: 'state', state: data.value, detail: data.detail, substantive: data.substantive === true };
            }
            // Content chunks (new format)
            else if (data.type === 'content' && data.content) {
              yield { type: 'content', content: data.content };
            }
            // Agent task type event — pipeline classification
            else if (data.type === 'agent_task' && data.task_type) {
              console.log('[STREAM] Agent task type:', data.task_type);
              yield { type: 'agent_task', agentTaskType: data.task_type };
            }
            // Tool progress event — per-tool execution updates
            else if (data.type === 'tool_progress') {
              console.log('[STREAM] Tool progress:', data.tool, 'round:', data.round);
              yield { type: 'tool_progress', toolName: data.tool, toolRound: data.round, toolMessage: data.message };
            }
            // Artifact created event — legal document saved to artifact store
            else if (data.type === 'artifact' && data.artifact_id) {
              console.log('[STREAM] Artifact created:', data.artifact_id, data.title);
              yield { type: 'artifact', artifactId: data.artifact_id, artifactTitle: data.title, artifactDocumentType: data.document_type };
            }
            // File export event — backend found exportable content, trigger download
            else if (data.type === 'file_export' && data.markdown) {
              console.log('[STREAM] File export:', data.title, data.format);
              yield { type: 'file_export', exportMarkdown: data.markdown, exportTitle: data.title || 'Document', exportFormat: data.format || 'word' };
            }
            // File requested event — pipeline will produce content, auto-export after
            else if (data.type === 'file_requested') {
              console.log('[STREAM] File requested, format:', data.format);
              yield { type: 'file_requested', fileRequestedFormat: data.format || 'word' };
            }
            // OpenAI streaming format fallback
            else if (data.choices && data.choices[0]?.delta?.content) {
              yield { type: 'content', content: data.choices[0].delta.content };
            }
          }
        } catch (parseError) {
          console.error('Error parsing stream chunk:', parseError);
        }
      }
    }

    // Process any remaining data in the buffer
    if (buffer.trim() && buffer.startsWith('data: ')) {
      try {
        const jsonStr = buffer.substring(6);
        const data = JSON.parse(jsonStr);
        
        if (data.type === 'sources' && data.sources) {
          yield { type: 'sources', sources: data.sources };
        }
        else if (data.type === 'content' && data.content) {
          yield { type: 'content', content: data.content };
        }
        else if (data.choices && data.choices[0]?.delta?.content) {
          yield { type: 'content', content: data.choices[0].delta.content };
        }
      } catch (parseError) {
        console.error('Error parsing final chunk:', parseError);
      }
    }

  } catch (error) {
    console.error("Edge Function Error:", error);
    throw error;
  }
};

/**
 * Sends a message with file/image attachments via the Express backend.
 * The backend:
 *   1. Uploads files to Supabase Storage (chat-temp/)
 *   2. Extracts text from documents / runs Vision API on images
 *   3. Proxies the enriched request to the Edge Function
 *   4. Streams the SSE response back
 */
export const sendMessageWithAttachments = async function* (
  currentMessage: string,
  history: ChatMessage[],
  attachments: PendingAttachment[],
  file_ids?: string[],
  temperature?: number,
  signal?: AbortSignal,
  mode?: HorizonMode,
  subOptions?: string[],
  activeMatter?: Case | null,
  actionFlags?: LegalActionFlags
): AsyncGenerator<StreamChunk> {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error('Not authenticated. Please sign in again.');
  }

  // Build multipart form data
  const formData = new FormData();
  formData.append('message', currentMessage);
  formData.append('history', JSON.stringify(
    history.map(msg => ({
      role: msg.role === Role.USER ? 'user' : 'model',
      content: msg.content,
    }))
  ));

  // Append each attachment file
  for (const att of attachments) {
    formData.append('attachments', att.file, att.filename);
  }

  if (file_ids?.length) formData.append('file_ids', JSON.stringify(file_ids));
  // Include session_id for pending action tracking
  const currentSessionId = (window as any).__currentSessionId;
  if (currentSessionId) formData.append('session_id', currentSessionId);
  if (activeMatter?.id) {
    formData.append('case_id', activeMatter.id);
    if (activeMatter.name) formData.append('case_name', activeMatter.name);
    if (activeMatter.client_name) formData.append('case_client', activeMatter.client_name);
    if (activeMatter.description) formData.append('case_description', activeMatter.description);
    if (activeMatter.case_number) formData.append('case_number', activeMatter.case_number);
    if (activeMatter.matter_type) formData.append('case_matter_type', activeMatter.matter_type);
  }
  formData.append('mode', mode || 'general');
  if (subOptions?.length) formData.append('sub_options', JSON.stringify(subOptions));
  if (temperature !== undefined) formData.append('temperature', String(temperature));
  formData.append('user_timezone', Intl.DateTimeFormat().resolvedOptions().timeZone);

  if (actionFlags) {
    if (actionFlags.web_search_enabled) formData.append('web_search', 'true');
    if (actionFlags.jurisdiction) formData.append('jurisdiction', actionFlags.jurisdiction);
    if (actionFlags.deep_analysis) formData.append('deep_analysis', 'true');
    if (actionFlags.strict_citations) formData.append('strict_citations', 'true');
    if (actionFlags.privilege_review) formData.append('privilege_review', 'true');
    if (actionFlags.fast_mode) formData.append('fast_mode', 'true');
  }

  const response = await fetch(`${BACKEND_API_URL}/api/chat`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      // No Content-Type — browser sets multipart boundary automatically
    },
    body: formData,
    signal,
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(errorData.error || `Request failed with status ${response.status}`);
  }

  // Stream SSE from backend (same format as edge function)
  const reader = response.body?.getReader();
  if (!reader) throw new Error('No response body');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim() === '' || line.trim() === 'data: [DONE]') continue;
      try {
        if (line.startsWith('data: ')) {
          const data = JSON.parse(line.substring(6));

          if (data.type === 'attachments' && data.attachments) {
            yield { type: 'attachments', attachments: data.attachments };
          } else if (data.type === 'sources' && data.sources) {
            yield { type: 'sources', sources: data.sources };
          } else if (data.type === 'validation') {
            yield { type: 'validation', validation: {
              confidence: data.confidence,
              has_document_context: data.has_document_context,
              has_structured_data: data.has_structured_data,
              data_points_used: data.data_points_used,
              source_count: data.source_count,
              warnings: data.warnings,
            }};
          } else if (data.type === 'state' && data.value) {
            yield { type: 'state', state: data.value, detail: data.detail, substantive: data.substantive === true };
          } else if (data.type === 'content' && data.content) {
            yield { type: 'content', content: data.content };
          } else if (data.type === 'agent_task' && data.task_type) {
            yield { type: 'agent_task', agentTaskType: data.task_type };
          } else if (data.type === 'tool_progress') {
            yield { type: 'tool_progress', toolName: data.tool, toolRound: data.round, toolMessage: data.message };
          } else if (data.type === 'artifact' && data.artifact_id) {
            yield { type: 'artifact', artifactId: data.artifact_id, artifactTitle: data.title, artifactDocumentType: data.document_type };
          } else if (data.type === 'file_export' && data.markdown) {
            yield { type: 'file_export', exportMarkdown: data.markdown, exportTitle: data.title || 'Document', exportFormat: data.format || 'word' };
          } else if (data.type === 'file_requested') {
            yield { type: 'file_requested', fileRequestedFormat: data.format || 'word' };
          } else if (data.choices && data.choices[0]?.delta?.content) {
            yield { type: 'content', content: data.choices[0].delta.content };
          }
        }
      } catch (parseError) {
        console.error('Error parsing stream chunk:', parseError);
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim() && buffer.startsWith('data: ')) {
    try {
      const data = JSON.parse(buffer.substring(6));
      if (data.type === 'sources' && data.sources) {
        yield { type: 'sources', sources: data.sources };
      } else if (data.type === 'content' && data.content) {
        yield { type: 'content', content: data.content };
      }
    } catch {
      // ignore
    }
  }
};