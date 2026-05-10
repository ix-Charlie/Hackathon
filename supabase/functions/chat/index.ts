// @deno-types="https://deno.land/x/types/index.d.ts"

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0";

// ── Modular prompt imports ──
import { RESPONSE_FORMAT_BLOCK, CASE_LISTING_FORMAT, STRUCTURED_DATA_BLOCK } from './prompts/formatting.ts';
import { ACTION_FLAG_PROMPTS } from './prompts/actionFlags.ts';
import { MODE_CONFIGS, getModeConfig, DEFAULT_SUB_OPTIONS, MODE_LABELS, SUB_OPTION_LABELS } from './prompts/modes.ts';
import type { HorizonMode, ModeConfig } from './prompts/modes.ts';
import { buildArchitecturalRules, buildSystemPrompt } from './prompts/system.ts';
import { buildOrchestratorPrompt } from './prompts/orchestrator.ts';

// CORS headers for browser requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

interface ChatRequest {
  message: string;
  history: Array<{ role: string; content: string }>;
  files?: Array<{ id: string; name: string; mimeType: string; data: string }>;
  file_ids?: string[];
  session_id?: string;
  case_id?: string;
  // Matter metadata — sent by frontend so the LLM knows the active matter
  case_name?: string;
  case_client?: string;
  case_description?: string;
  case_number?: string;
  case_matter_type?: string;
  use_rag?: boolean;
  temperature?: number;
  mode?: string; // HorizonMode: 'general' | 'legal_research' | 'contract_review' | 'multi_document' | 'summary' | 'drafting'
  sub_options?: string[];
  // Advanced action flags — mode-independent toggles from the chat UI
  deep_analysis?: boolean;
  strict_citations?: boolean;
  privilege_review?: boolean;
  fast_mode?: boolean;
  // Runtime context — injected by the frontend for deterministic reasoning
  user_timezone?: string; // IANA format, e.g. 'Asia/Karachi'
  // Chat attachments — injected by Express backend after file processing
  attachment_context?: string; // Extracted text / Vision results for attached files
  chat_attachments?: Array<{
    id: string;
    filename: string;
    mime_type: string;
    size: number;
    type: 'file' | 'image';
    storage_path: string;
  }>;
}

// ============================================================================
// RUNTIME CONTEXT INJECTION — Deterministic system context for every LLM call
// ============================================================================

interface RuntimeContextInput {
  // Temporal
  userTimezone?: string;
  // Tenant
  tenantId?: string;
  tenantName?: string;
  tenantPlan?: string;
  environment: string;
  // User
  userId: string;
  userEmail?: string;
  userRole?: string; // 'lawyer' | 'admin' | 'viewer' | 'owner'
  // Matter / file selection
  matterId?: string;
  matterName?: string;
  fileIds?: string[];
  multiFileMode: boolean;
  ragScope: 'restricted_to_selected_file' | 'restricted_to_selected_matter' | 'none';
  // Retrieval state (populated after retrieval)
  retrievalExecuted: boolean;
  documentsRetrieved: number;
  structuredQueryExecuted: boolean;
  structuredDataPoints: number;
  csvEngineActivated: boolean;
  // Intelligence mode flags
  activeModes: Record<string, boolean>;
  // Active action flags
  activeActionFlags: string[];
}

/**
 * Builds a deterministic runtime context system message injected at the TOP
 * of every OpenAI request. Ensures the model never operates in an
 * informational vacuum — it always knows the current time, tenant, matter,
 * retrieval state, permissions, and behavioral constraints.
 *
 * NOTE: This context is server-side only — it is never exposed to the user.
 */
function buildRuntimeContext(ctx: RuntimeContextInput): string {
  const now = new Date();
  const utcISO = now.toISOString();
  const unixTimestamp = Math.floor(now.getTime() / 1000);

  // ── Temporal context ──────────────────────────────────────────────────────
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  let temporalBlock = `## TEMPORAL CONTEXT (AUTHORITATIVE — DO NOT GUESS)
Current UTC time: ${utcISO}
Unix timestamp: ${unixTimestamp}
Server weekday (UTC): ${weekdays[now.getUTCDay()]}`;

  if (ctx.userTimezone) {
    try {
      const localFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: ctx.userTimezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false, weekday: 'long',
        timeZoneName: 'short',
      });
      const localParts = localFormatter.formatToParts(now);
      const getPart = (type: string) => localParts.find(p => p.type === type)?.value || '';
      const localDateStr = `${getPart('year')}-${getPart('month')}-${getPart('day')}`;
      const localTimeStr = `${getPart('hour')}:${getPart('minute')}:${getPart('second')}`;
      const localWeekday = getPart('weekday');
      const tzAbbr = getPart('timeZoneName');
      temporalBlock += `\nUser timezone: ${ctx.userTimezone}\nLocal time: ${localDateStr} ${localTimeStr} ${tzAbbr}\nLocal date: ${localDateStr}\nLocal weekday: ${localWeekday}`;
    } catch (_e) {
      temporalBlock += `\nUser timezone: ${ctx.userTimezone} (could not resolve local time)`;
    }
  }

  // ── Tenant context ────────────────────────────────────────────────────────
  const tenantBlock = `## TENANT CONTEXT
Tenant: ${ctx.tenantName || 'Unknown'}
Tenant ID: ${ctx.tenantId || 'unknown'}
Environment: ${ctx.environment}
Plan Tier: ${ctx.tenantPlan || 'standard'}`;

  // ── Matter / file selection context ────────────────────────────────────────
  let matterBlock = '## MATTER SELECTION CONTEXT\n';
  if (ctx.matterId) {
    matterBlock += `Selected Matter: ${ctx.matterName || 'Unknown'}\nMatter ID: ${ctx.matterId}\n`;
    if (ctx.fileIds && ctx.fileIds.length > 0) {
      matterBlock += `Selected File IDs: ${ctx.fileIds.join(', ')}\nMulti-file mode: ${ctx.multiFileMode}\n`;
    }
    matterBlock += `RAG Scope: ${ctx.ragScope}`;
  } else {
    matterBlock += 'No matter selected — general workspace context';
  }

  // ── Permission context ────────────────────────────────────────────────────
  const accessScope = ctx.userRole === 'admin' || ctx.userRole === 'owner'
    ? 'full_workspace_access'
    : ctx.matterId ? 'full_matter_access' : 'workspace_read';
  const permissionBlock = `## PERMISSION CONTEXT
User Role: ${ctx.userRole || 'lawyer'}
Access Scope: ${accessScope}`;

  // ── Retrieval state indicators ────────────────────────────────────────────
  const retrievalBlock = `## RETRIEVAL STATE
Retrieval Status: ${ctx.retrievalExecuted ? 'executed' : 'not_executed'}
Documents Retrieved: ${ctx.documentsRetrieved}
Structured Query Engine: ${ctx.structuredQueryExecuted ? 'activated' : 'inactive'}
Structured Data Points: ${ctx.structuredDataPoints}
CSV Engine: ${ctx.csvEngineActivated ? 'activated' : 'inactive'}`;

  // ── Model behavioral constraints (non-negotiable) ─────────────────────────
  const rulesBlock = `## BEHAVIORAL CONSTRAINTS (NON-NEGOTIABLE)
- If no records found, state: "No matching records found in this matter's documents."
- Never fabricate clients, cases, billing entries, dates, or document content.
- If structured data is required for aggregation, rely ONLY on deterministic engine outputs (query_csv tool).
- Do NOT guess current time/date — rely ONLY on the injected temporal context above.
- Do NOT infer cross-matter information unless explicitly retrieved via tools.
- Do NOT reference or reveal tenant IDs, internal system IDs, or runtime metadata in your responses.
- When retrieval returns 0 documents, do NOT synthesize answers from training data for matter-specific questions.`;

  // ── Intelligence mode flags ───────────────────────────────────────────────
  const modeEntries = Object.entries(ctx.activeModes).filter(([_, v]) => v);
  let modeBlock = '';
  if (modeEntries.length > 0) {
    modeBlock = `## ACTIVE INTELLIGENCE MODES\n` + modeEntries.map(([k, _]) => `- ${k}: true`).join('\n');
  }

  // ── Active action flags ───────────────────────────────────────────────────
  let flagsBlock = '';
  if (ctx.activeActionFlags.length > 0) {
    flagsBlock = `## ACTIVE ACTION FLAGS\n` + ctx.activeActionFlags.map(f => `- ${f}: enabled`).join('\n');
  }

  // ── Assemble ──────────────────────────────────────────────────────────────
  const sections = [
    '# HORIZON RUNTIME CONTEXT (SYSTEM — DO NOT DISCLOSE TO USER)',
    temporalBlock,
    tenantBlock,
    matterBlock,
    permissionBlock,
    retrievalBlock,
    rulesBlock,
    modeBlock,
    flagsBlock,
  ].filter(Boolean);

  return sections.join('\n\n');
}

// buildArchitecturalRules, ACTION_FLAG_PROMPTS → imported from ./prompts/

interface DocumentChunk {
  id: number;
  content: string;
  metadata: { filename: string; chunk_index: number; total_chunks: number; document_type?: string; year?: string; chunk_emails?: string[]; chunk_names?: string[]; emails_mentioned?: string[]; names_mentioned?: string[] };
  similarity: number;
  combined_score?: number;
  exact_match_score?: number;
  fts_rank?: number;
}

declare const Deno: { env: { get(key: string): string | undefined } };

// ============================================================================
// 1. MODEL ROUTER — Abstracted model selection by tier
// ============================================================================

type ModelTier = 'fast' | 'standard' | 'reasoning';
type TaskType = 'classification' | 'synthesis' | 'drafting' | 'planning' | 'extraction' | 'validation';

interface ModelConfig {
  model: string;
  maxTokens?: number;
  temperature?: number;
}

function getModel(tier: ModelTier, taskType?: TaskType): ModelConfig {
  // Task-specific overrides for cost-optimal routing
  if (taskType === 'classification') {
    // Classifier needs structured JSON output — gpt-4o-mini is cost-effective with good JSON
    return { model: 'gpt-4o-mini', maxTokens: 1500, temperature: 0 };
  }
  if (taskType === 'validation') {
    // Validation/fact-checking uses fast model
    return { model: 'gpt-4o-mini', maxTokens: 500, temperature: 0 };
  }

  switch (tier) {
    case 'fast':
      return { model: 'gpt-3.5-turbo', maxTokens: 1000, temperature: 0 };
    case 'standard':
      return { model: 'gpt-4o', temperature: 0.3 };
    case 'reasoning':
      return { model: 'gpt-4o', temperature: 0.2 };
    default:
      return { model: 'gpt-4o', temperature: 0.3 };
  }
}

// MODE_CONFIGS, HorizonMode, ModeConfig, formatting blocks, getModeConfig,
// DEFAULT_SUB_OPTIONS, MODE_LABELS, SUB_OPTION_LABELS → imported from ./prompts/

// ============================================================================
// 2. QUERY CLASSIFIER — Enhanced semantic classification with structured data routing
// ============================================================================

interface QueryClassification {
  domain: 'legal' | 'non_legal';
  complexity: 'simple' | 'multi_source' | 'analytical' | 'drafting';
  requires_reasoning: boolean;
  requires_planning: boolean;
  search_intent: boolean;
  requires_structured_data: boolean;
  structured_intents: StructuredIntent[];
  tasks: ClassifiedTask[];
  suggested_mode?: HorizonMode;
  agent_task_type?: AgentTaskType;
}

type AgentTaskType =
  | 'legal_research'
  | 'document_drafting'
  | 'contract_review'
  | 'case_summary'
  | 'litigation_strategy'
  | 'deposition_analysis'
  | 'document_export'
  | 'general_chat'
  | 'workspace_management';

/**
 * Structured data intent — routes to matter intelligence tables
 * instead of (or in addition to) vector search
 */
type StructuredIntentType =
  | 'entity_lookup'       // Who are the parties? Find a person/org
  | 'obligation_tracking' // What are the obligations? What's due?
  | 'date_tracking'       // When is X due? Show me deadlines
  | 'risk_assessment'     // What are the risks? Show critical issues
  | 'clause_analysis'     // Find indemnification clause, termination clause, etc.
  | 'timeline'            // Show me a timeline, chronological overview
  | 'cross_reference'     // Compare across documents, find conflicts
  | 'matter_summary'      // Give me an overview of this matter
  | 'csv_query'           // Filter/aggregate CSV/Excel data
  | 'csv_summary';        // Describe the structure/content of CSV/Excel data

interface StructuredIntent {
  type: StructuredIntentType;
  params: Record<string, string>;
}

interface ClassifiedTask {
  query: string;
  type: 'document' | 'general' | 'drafting' | 'tool' | 'structured';
  label: string;
  structured_intent?: StructuredIntent;
}

// ============================================================================
// AGENTIC ARCHITECTURE — Core types for orchestrator, gateway, and verifier
// ============================================================================

/**
 * AgentPlan — produced by the orchestrator LLM as its first action.
 * Replaces the rigid classifier → pipeline routing with agent-driven planning.
 */
interface AgentPlan {
  intent: 'draft' | 'review' | 'compare' | 'summarize' | 'qa' | 'research' | 'workspace' | 'export' | 'other';
  requires_retrieval: boolean;
  requires_structured_data: boolean;
  structured_intents: StructuredIntent[];
  doc_scope: 'selected_docs' | 'workspace' | 'none';
  citations_required: boolean;
  jurisdiction: { value: string | null; confidence: number };
  clarifying_questions: string[];
  tools_requested: ToolRequest[];
  execution_budget: { max_tool_calls: number; max_rounds: number; max_docs: number };
}

interface ToolRequest {
  name: string;
  args: Record<string, any>;
  reason: string;
}

/**
 * Tool Gateway — deterministic policy engine input/output.
 * The agent requests tools; the gateway allows or denies each request.
 */
interface ToolGatewayContext {
  tenantId: string;
  userId: string;
  userRole?: string;
  matterId?: string;
  jurisdiction?: string;
  sessionId?: string;
  budgetRemaining: { tool_calls: number; rounds: number };
  featureFlags: Record<string, string>;
}

interface ToolGatewayDecision {
  tool_name: string;
  allowed: boolean;
  reason: string;
  modified_args?: Record<string, any>;
  requires_confirmation?: boolean;
  confirmation_prompt?: string;
}

/**
 * PendingAction — persisted per session for multi-turn confirmation flows.
 * action_type=clarification means "yes" does NOT trigger tool execution.
 */
type PendingActionStatus = 'active' | 'consumed' | 'expired' | 'cancelled';
type PendingActionType = 'tool_confirmation' | 'parameter_blocked' | 'clarification';

interface PendingAction {
  id: string;
  session_id: string;
  status: PendingActionStatus;
  action_type: PendingActionType;
  tool_name: string | null;
  tool_args: Record<string, any> | null;
  requires_confirmation: boolean;
  originating_message_id: number | null;
  user_prompt_summary: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

/**
 * Verifier — hybrid rule-based + LLM verification of agent outputs.
 */
type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

interface VerifierResult {
  verdict: 'pass' | 'fail';
  reasons: string[];
  retry_hint: string | null;
  risk_level: RiskLevel;
}

/**
 * Audit logging — per-request run and per-tool task tracking.
 * Uses existing agent_runs + agent_tasks tables from migration 021.
 */
interface AgentRunRecord {
  id?: string;
  tenant_id: string;
  session_id: string | null;
  case_id: string | null;
  user_id: string;
  status: string;
  user_query: string;
  task_graph: any;
  metadata: Record<string, any>;
}

// ============================================================================
// CONVERSATIONAL GATE — Lightweight LLM triage (replaces regex patterns)
// Single fast call that BOTH classifies AND responds for conversational queries.
// Eliminates classifier, RAG, DB queries, and main LLM call for chitchat.
// ============================================================================

/**
 * Lightweight context for the conversational gate.
 * Contains enough information for the gate LLM to answer quick contextual
 * questions (date, time, identity, active matter) without spinning up
 * the full retrieval pipeline.
 */
interface GateContext {
  userTimezone?: string;
  userEmail?: string;
  userRole?: string;
  tenantName?: string;
  matterName?: string;
  matterClient?: string;
}

/**
 * Builds a compact context block injected into the conversational gate's
 * system prompt. Keeps it minimal to stay within the fast-path token budget
 * while ensuring the model can answer date/time, identity, and active-matter
 * questions accurately.
 */
function buildGateContextBlock(ctx: GateContext): string {
  const now = new Date();
  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  const lines: string[] = [];
  lines.push('--- SYSTEM FACTS (use these to answer, never guess) ---');
  lines.push(`Current UTC: ${now.toISOString()}`);
  lines.push(`UTC weekday: ${weekdays[now.getUTCDay()]}`);

  if (ctx.userTimezone) {
    try {
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: ctx.userTimezone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
        weekday: 'long', timeZoneName: 'short',
      });
      const p = fmt.formatToParts(now);
      const g = (t: string) => p.find(x => x.type === t)?.value || '';
      lines.push(`User timezone: ${ctx.userTimezone}`);
      lines.push(`User local date: ${g('year')}-${g('month')}-${g('day')} (${g('weekday')})`);
      lines.push(`User local time: ${g('hour')}:${g('minute')} ${g('timeZoneName')}`);
    } catch (_) {
      lines.push(`User timezone: ${ctx.userTimezone} (resolution failed)`);
    }
  }

  if (ctx.userEmail) lines.push(`User: ${ctx.userEmail}`);
  if (ctx.userRole) lines.push(`Role: ${ctx.userRole}`);
  if (ctx.tenantName) lines.push(`Organization: ${ctx.tenantName}`);
  if (ctx.matterName) {
    lines.push(`Active matter: ${ctx.matterName}`);
    if (ctx.matterClient) lines.push(`Client: ${ctx.matterClient}`);
  }
  lines.push('--- END SYSTEM FACTS ---');
  return lines.join('\n');
}

async function conversationalGate(
  message: string,
  apiKey: string,
  history?: Array<{ role: string; content: string }>,
  gateCtx?: GateContext,
): Promise<{ conversational: boolean; response?: string }> {
  try {
    const gateModel = getModel('fast', 'classification');
    const abortCtrl = new AbortController();
    const timeout = setTimeout(() => abortCtrl.abort(), 4000); // 4s hard cap

    const contextBlock = gateCtx ? buildGateContextBlock(gateCtx) : '';

    const msgs: Array<{ role: string; content: string }> = [
      {
        role: 'system',
        content: `You are a triage gate for Horizon, a legal AI assistant. Your job: classify the user's message and, if conversational, respond immediately.

${contextBlock}

CLASSIFICATION RULES:
CONVERSATIONAL — greetings, thanks, goodbyes, chitchat, acknowledgements, small talk, AND quick factual lookups answerable from the SYSTEM FACTS above (date, time, day, timezone, identity, active matter name/client).
SUBSTANTIVE — anything requiring document retrieval, legal analysis, case file search, drafting, entity extraction, comparison, contract review, or any work that needs the full pipeline.

ALWAYS SUBSTANTIVE (never conversational):
- Any request to draft, write, create, or generate a document
- Any request for a Word document, PDF, .docx, or file download
- "give me a word file", "create a docx", "draft a motion", "write me a letter"
- "give me the word file", "export as word", "download as pdf"
- Questions about document content or legal analysis
- Even if the request seems simple or short — if it mentions drafting, Word, PDF, docx, or document creation, it is ALWAYS SUBSTANTIVE.

RESPONSE RULES (for CONVERSATIONAL only):
- Respond as Horizon — brief, warm, professional.
- For date/time/day questions: use ONLY the SYSTEM FACTS above. Never say you lack access to the date.
- For identity/matter questions: use the SYSTEM FACTS. If a fact is not listed, say you don't have that information.
- Never fabricate information not in SYSTEM FACTS.

Return JSON ONLY — no markdown, no explanation:
{"conversational":true,"response":"your brief response"}
{"conversational":false}`,
      },
    ];

    // Add last 2 history turns for context (resolves follow-ups)
    if (history && history.length > 0) {
      for (const msg of history.slice(-2)) {
        msgs.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.content.substring(0, 150) });
      }
    }
    msgs.push({ role: 'user', content: message });

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: abortCtrl.signal,
      body: JSON.stringify({
        model: gateModel.model,
        temperature: 0,
        max_tokens: 250,
        response_format: { type: 'json_object' },
        messages: msgs,
      }),
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      console.error('[GATE] API error:', resp.status);
      return { conversational: false };
    }

    const data = await resp.json();
    const rawContent = data.choices?.[0]?.message?.content;
    if (!rawContent) {
      console.error('[GATE] No content in response');
      return { conversational: false };
    }
    const result = JSON.parse(rawContent);
    console.log('[GATE]', result.conversational ? 'CONVERSATIONAL' : 'SUBSTANTIVE', result.response ? `response=${result.response.substring(0, 50)}` : '');
    if (result.conversational === true && typeof result.response === 'string' && result.response.length > 0) {
      return { conversational: true, response: result.response };
    }
    return { conversational: false };
  } catch (error: any) {
    console.error('[GATE] Error:', error.name === 'AbortError' ? 'timeout' : error.message);
    return { conversational: false }; // fail open → full pipeline
  }
}

async function classifyQuery(
  message: string,
  apiKey: string,
  _hasDocuments: boolean,
  conversationHistory?: Array<{ role: string; content: string }>,
): Promise<QueryClassification> {
  // NOTE: Conversational detection is handled upstream by conversationalGate().
  // If we reach here, the query has been determined to be substantive.

  // Semantic classification via fast model
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15s for complex multi-part queries

    const classifierModel = getModel('fast', 'classification');
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: classifierModel.model,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are a query classifier for a legal AI assistant. The user has uploaded legal documents (contracts, case files, CVs, letters, etc.). The system has extracted structured intelligence from documents: entities, clauses, obligations, dates, risks, and cross-references. Classify the user's query and determine the best retrieval strategy.

Return JSON:
{
  "domain": "legal" or "non_legal",
  "complexity": "simple" | "multi_source" | "analytical" | "drafting",
  "requires_reasoning": true/false,
  "requires_planning": true/false,
  "search_intent": true/false,
  "requires_structured_data": true/false,
  "structured_intents": [
    { "type": "entity_lookup"|"obligation_tracking"|"date_tracking"|"risk_assessment"|"clause_analysis"|"timeline"|"cross_reference"|"matter_summary", "params": {} }
  ],
  "suggested_mode": "legal_research" | "contract_review" | "multi_document" | "summary" | "drafting" | null,
  "agent_task_type": "legal_research" | "document_drafting" | "contract_review" | "case_summary" | "litigation_strategy" | "deposition_analysis" | "document_export" | "general_chat" | "workspace_management",
  "tasks": [
    { "query": "optimized search query", "type": "document"|"general"|"drafting"|"tool"|"structured", "label": "3-6 word description" }
  ]
}

CLASSIFICATION RULES:
- domain: If the query could relate to uploaded documents, people in documents, legal matters, or anything that might be in case files → "legal". Only pure chitchat or completely off-topic → "non_legal".
- complexity:
  - "simple": Single question, single source needed
  - "multi_source": Multiple distinct questions or needs info from multiple documents
  - "analytical": Requires comparing, analyzing, evaluating evidence or arguments
  - "drafting": Requires generating/writing a document, letter, contract, memo
- requires_reasoning: true if analytical comparison, legal argument construction, or multi-step analysis needed
- requires_planning: true if drafting or multi-step workflow needed
- search_intent: true if the answer might be in uploaded documents. Default to TRUE for any person name, any "who is", any reference to facts, evidence, dates, clauses, etc. Only false for pure general knowledge or greetings.

STRUCTURED DATA RULES:
- requires_structured_data: true when the query can be answered (partly or fully) from structured matter intelligence tables
- structured_intents: Array of intents to route to specific data stores:
  - "entity_lookup": "Who are the parties?", "Find mentions of [person/org]". Params: { "entity_type": "person"|"organization"|"party"|"jurisdiction" (optional), "name": "search term" (optional) }
  - "obligation_tracking": "What are our obligations?", "What's due this month?", "Compliance status". Params: { "status": "pending"|"completed" (optional), "responsible_party": "name" (optional) }
  - "date_tracking": "When is the deadline?", "Show me key dates", "What's coming up?". Params: { "date_type": "deadline"|"effective_date"|"filing_date" (optional), "upcoming_only": "true"|"false" (optional) }
  - "risk_assessment": "What are the risks?", "Show critical issues", "Risk summary". Params: { "severity": "critical"|"high"|"medium"|"low" (optional), "category": "category name" (optional) }
  - "clause_analysis": "Find the indemnification clause", "Show termination provisions", "Non-compete terms". Params: { "clause_type": "indemnification"|"termination"|"non_compete"|"liability"|"confidentiality"|"force_majeure" (optional) }
  - "timeline": "Show me a timeline", "Chronological overview", "Sequence of events". Params: {}
  - "cross_reference": "Compare across documents", "Find conflicts between agreements". Params: {}
  - "matter_summary": "Give me an overview", "Summarize this matter", "Brief me on the case". Params: {}
  - "csv_query": "How much has X paid?", "Total amount for Y", "Filter rows where Z", "Show all entries for client W", "What is the sum/average/count of column?". Use this whenever the query requires filtering, aggregating, or looking up specific rows from CSV/Excel/spreadsheet data. Params: { "search_term": "keyword to filter by" (optional), "aggregation": "sum"|"avg"|"count"|"count_distinct"|"min"|"max" (optional), "column_hint": "column name to aggregate" (optional), "date_start": "YYYY-MM-DD for date range start" (optional), "date_end": "YYYY-MM-DD for date range end" (optional) }
  - "csv_summary": "What is this spreadsheet about?", "Describe the docket file", "What data do we have in the Excel?", "Summarize the CSV columns". Use this when the user wants to understand the STRUCTURE or content overview of a CSV/Excel file — NOT when they want specific values. Params: { "filename_hint": "partial filename if mentioned" (optional) }
- A query can have BOTH search_intent=true AND requires_structured_data=true (hybrid retrieval)
- Example: "What risks does the indemnification clause create?" → requires_structured_data: true, structured_intents: [{ type: "clause_analysis", params: { clause_type: "indemnification" } }, { type: "risk_assessment", params: {} }], search_intent: true
- Example: "How much has Lyndsy paid us in total?" → requires_structured_data: true, structured_intents: [{ type: "csv_query", params: { search_term: "Lyndsy", aggregation: "sum", column_hint: "amount" } }], search_intent: false
- Example: "Show all meetings from January" → requires_structured_data: true, structured_intents: [{ type: "csv_query", params: { search_term: "January" } }], search_intent: false
- Example: "What is this docket about?" → requires_structured_data: true, structured_intents: [{ type: "csv_summary", params: {} }], search_intent: false
- Example: "How many unique attorneys billed in Q1 2024?" → requires_structured_data: true, structured_intents: [{ type: "csv_query", params: { aggregation: "count_distinct", column_hint: "attorney", date_start: "2024-01-01", date_end: "2024-03-31" } }], search_intent: false
- Any query about totals, counts, sums, averages, or filtering rows in spreadsheet data → csv_query intent
- Any query about what a spreadsheet/CSV/Excel contains, its structure, or a general overview → csv_summary intent

SUGGESTED_MODE RULES (for auto-detection):
- "legal_research": Analytical queries requiring IRAC analysis, legal argument construction, case law evaluation, or multi-step legal reasoning
- "contract_review": Queries about contract clauses, terms, obligations, risks, amendments, or anything referencing a specific contract/agreement
- "multi_document": Queries that explicitly compare, cross-reference, or request side-by-side analysis across 2+ documents
- "summary": Queries asking to summarize, extract key facts, provide an overview, or brief a document
- "drafting": Queries asking to write, draft, generate, or create a legal document (motion, memo, letter, contract)
- null: Simple factual lookups, general questions, or queries that don't clearly fit a specialized mode

AGENT_TASK_TYPE RULES (pipeline routing):
- "document_drafting": User wants to draft/write/generate a NEW legal document (motion, memo, brief, letter, contract) from scratch. The user is asking for CONTENT CREATION — new text that doesn't exist yet.
- "legal_research": Analytical legal research, case law analysis, IRAC-style reasoning
- "contract_review": Reviewing, analyzing, or comparing contract terms and clauses
- "case_summary": Summarizing a case, matter, or set of documents
- "litigation_strategy": Developing strategy, assessing evidence strength, settlement analysis
- "deposition_analysis": Analyzing deposition testimony, finding contradictions
- "document_export": User wants to DOWNLOAD or EXPORT a previous response as a file (Word, PDF, docx). Use this when conversation history already contains a draft/document and user is asking for a file version of it. Examples: "give me a word file", "download as docx", "export that as PDF", "just give me the word file no need drafting again", "word file please", "can I get that as a document?", "give me that draft in word". The KEY signal is: the content already exists in the conversation — user just wants to download it.
- "workspace_management": Creating cases, folders, or managing workspace structure
- "general_chat": Everything else — general questions, simple lookups, greetings

DOCUMENT_EXPORT vs DOCUMENT_DRAFTING — DECISION GUIDE:
- Look at conversation history. If a previous assistant message already contains a substantial draft/document → "document_export"
- If user says "give me word/docx/pdf" WITHOUT asking for new content → "document_export"
- If user says "draft a motion AND give me word" (new content) → "document_drafting"
- If there is NO previous draft in history and user asks for a file → "document_drafting"
- When in doubt and history has a long assistant response: prefer "document_export"

TASK DECOMPOSITION RULES:
- For each distinct question/topic, create a separate task
- "query" should be a short search-optimized string (NOT the full message)
- Task types:
  - "document": Needs searching uploaded documents via vector/keyword search
  - "structured": Can be answered from structured matter intelligence (entities, clauses, obligations, dates, risks). Should have a corresponding structured_intent.
  - "general": ONLY for questions IMPOSSIBLE to answer from documents (e.g. "what is the capital of France")
  - "drafting": Requires writing/generating content. Should ALSO include document/structured tasks for factual background.
  - "tool": ONLY for explicit workspace management: "create a case", "list my cases", "show me folders"
- ALWAYS classify person names as "document" — even if famous. Documents may contain info about them.
- Maximum 8 tasks

CRITICAL DRAFTING RULE: When user asks to draft based on documents:
  - Create ONE "drafting" task for the writing request
  - Create SEPARATE "document" or "structured" tasks for factual background
  - Example: "Draft motion based on Fourth Amendment violations" → tasks: [{ type: "document", query: "Fourth Amendment violation seizure" }, { type: "drafting", query: "motion to suppress evidence" }]

STRUCTURED + DOCUMENT HYBRID: Many queries benefit from BOTH structured data AND document search:
  - "What are the risks in section 5?" → structured (risk_assessment) + document search
  - "Who signed the agreement and what are their obligations?" → structured (entity_lookup + obligation_tracking) + document search
  - Default to including document search alongside structured queries for comprehensive results

CRITICAL: When in doubt about task type, default to "document". It is better to search and find nothing than to skip relevant content.

PRONOUN / CONTEXT RESOLUTION: If the user message contains pronouns (she, he, they, it, them, those, that, etc.) or short follow-ups ("show them all", "how much?", "and the total?"), look at the CONVERSATION CONTEXT below to resolve who/what they refer to. Classify based on the RESOLVED meaning, not the literal pronoun. If the conversation discussed CSV/spreadsheet data or used query_csv results, classify follow-ups about the same topic as csv_query.`
          },
          // Inject last 4 conversation turns for context resolution
          ...(conversationHistory && conversationHistory.length > 0
            ? [
                { role: 'user' as const, content: `CONVERSATION CONTEXT (last ${Math.min(conversationHistory.length, 4)} messages for pronoun/reference resolution):\n${conversationHistory.slice(-4).map(m => `${m.role}: ${m.content.substring(0, 200)}`).join('\n')}` },
                { role: 'assistant' as const, content: 'I will use this context to resolve pronouns and references in the current query.' },
              ]
            : []),
          { role: 'user', content: message }
        ],
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      console.error('Classifier error:', await response.text());
      return fallbackClassification(message);
    }

    const data = await response.json();
    const result = JSON.parse(data.choices[0].message.content);
    console.log('Classification:', JSON.stringify(result, null, 2));

    // Validate suggested_mode
    const validSuggestedModes: HorizonMode[] = ['legal_research', 'contract_review', 'multi_document', 'summary', 'drafting'];
    const suggestedMode = validSuggestedModes.includes(result.suggested_mode) ? result.suggested_mode : undefined;

    // Validate agent_task_type
    const validAgentTaskTypes: AgentTaskType[] = ['legal_research', 'document_drafting', 'contract_review', 'case_summary', 'litigation_strategy', 'deposition_analysis', 'document_export', 'general_chat', 'workspace_management'];
    const rawAgentTask = validAgentTaskTypes.includes(result.agent_task_type) ? result.agent_task_type as AgentTaskType : undefined;

    const classificationResult: QueryClassification = {
      domain: result.domain || 'legal',
      complexity: result.complexity || 'simple',
      requires_reasoning: result.requires_reasoning === true,
      requires_planning: result.requires_planning === true,
      search_intent: result.search_intent !== false, // Default TRUE
      requires_structured_data: result.requires_structured_data === true,
      structured_intents: (result.structured_intents || []).filter((si: any) => si.type),
      tasks: (result.tasks || []).filter((t: any) => t.query && t.type && t.label),
      suggested_mode: suggestedMode,
      agent_task_type: rawAgentTask,
    };

    // If classifier didn't provide agent_task_type, infer it
    if (!classificationResult.agent_task_type) {
      classificationResult.agent_task_type = inferAgentTaskType(classificationResult);
    }

    return classificationResult;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.log('Classifier timed out, using fallback');
    } else {
      console.error('Classifier error:', error);
    }
    return fallbackClassification(message);
  }
}

function fallbackClassification(message: string): QueryClassification {
  // Robust fallback: split multi-part queries locally using commas, "and", question marks
  // This ensures multi-RAG still works even if the classifier times out
  const parts = message
    .split(/(?:,\s*(?:and\s+)?|\band\s+(?:also\s+)?|\balso\s+|\?\s*)/i)
    .map(p => p.trim())
    .filter(p => p.length > 3); // drop tiny fragments

  const tasks: ClassifiedTask[] = parts.length > 1
    ? parts.map((part, i) => ({
        query: part,
        type: 'document' as const,
        label: `Sub-query ${i + 1}`,
      }))
    : [{ query: message, type: 'document' as const, label: 'Searching documents' }];

  console.log(`Fallback classification: split into ${tasks.length} tasks`);
  return {
    domain: 'legal',
    complexity: tasks.length > 1 ? 'multi_source' : 'simple',
    requires_reasoning: false,
    requires_planning: false,
    search_intent: true,
    requires_structured_data: false,
    structured_intents: [],
    tasks,
  };
}

// ============================================================================
// 2B. AGENT TASK TYPE INFERENCE & PIPELINE CONFIGS
// ============================================================================

function inferAgentTaskType(classification: QueryClassification): AgentTaskType {
  // If classifier provided it, use it
  if (classification.agent_task_type) return classification.agent_task_type;

  // Infer from complexity/mode/tasks
  if (classification.complexity === 'drafting' || classification.suggested_mode === 'drafting') return 'document_drafting';
  if (classification.suggested_mode === 'legal_research') return 'legal_research';
  if (classification.suggested_mode === 'contract_review') return 'contract_review';
  if (classification.suggested_mode === 'summary') return 'case_summary';
  if (classification.suggested_mode === 'multi_document') return 'litigation_strategy';

  const taskTypes = classification.tasks.map(t => t.type);
  if (taskTypes.includes('tool')) return 'workspace_management';
  if (taskTypes.includes('drafting')) return 'document_drafting';
  if (classification.complexity === 'analytical') return 'legal_research';
  return 'general_chat';
}

interface AgentPipelineConfig {
  toolNames: string[];       // Which tools this pipeline can access (empty = all)
  maxToolRounds: number;     // Max tool-call rounds for this pipeline
  systemPromptAddition: string; // Extra system prompt injected for this task type
}

const AGENT_PIPELINE_CONFIGS: Record<AgentTaskType, AgentPipelineConfig> = {
  document_drafting: {
    toolNames: ['search_documents', 'search_case_law', 'retrieve_statute'],
    maxToolRounds: 3,
    systemPromptAddition: `You are drafting a legal document. Follow this process:

STEP 1 — RESEARCH:
- Use search_documents/search_case_law/retrieve_statute to gather facts, arguments, and authorities from the matter's uploaded documents
- Extract: party names, court, file numbers, key facts, relevant case law, statutory provisions
- If the matter context already provides sufficient information, proceed to Step 2

STEP 2 — DRAFT:
- Output the COMPLETE document directly in your response as well-formatted Markdown
- The user will review it in chat, request edits, and only later ask for a file download
- Do NOT create files or artifacts — just output the text

DOCUMENT QUALITY RULES (STRICT):
1. NEVER include "Prepared by: Horizon AI" or any AI branding. Documents must appear as if drafted by the lawyer/firm.
2. NEVER reference source filenames (e.g. "as per Form_7A.pdf"). Reference by legal title (e.g. "the Statement of Claim").
3. Use NUMBERED PARAGRAPHS (1, 2, 3...) in court filings — NOT bullet points.
4. Do NOT use horizontal rules (---). Use proper section headings.
5. Cite case law by CASE NAME, COURT, and YEAR — never the filename.
6. Do NOT leave [INSERT: ...] placeholders when you have the actual information from documents.
7. Use CORRECT legal terminology for the jurisdiction.
8. Include ALL required structural elements for the document type.
9. The signature block should use the LAWYER'S name and firm from the matter context — NEVER "Horizon AI".
10. Begin your response with <!-- HORIZON_EXPORT title="Document Title" --> so the platform can offer download later if requested.`,
  },
  legal_research: {
    toolNames: ['search_documents', 'search_case_law', 'retrieve_statute', 'query_csv'],
    maxToolRounds: 3,
    systemPromptAddition: `You are conducting legal research. Apply IRAC methodology:
- Issue: Clearly state the legal question
- Rule: Identify applicable statutes, regulations, and case law
- Application: Analyze how the rules apply to the facts
- Conclusion: Provide a well-reasoned conclusion with confidence level
Use multiple search rounds if initial results are insufficient.`,
  },
  contract_review: {
    toolNames: ['search_documents', 'extract_contract_clauses', 'compare_documents', 'query_csv'],
    maxToolRounds: 3,
    systemPromptAddition: `You are reviewing a contract. Focus on:
- Key terms and definitions
- Rights and obligations of each party
- Risk areas (indemnification, liability caps, termination triggers)
- Missing or unusual provisions
Flag any provisions that deviate from market standard.`,
  },
  case_summary: {
    toolNames: ['search_documents', 'query_csv', 'get_images'],
    maxToolRounds: 2,
    systemPromptAddition: `Provide a comprehensive yet concise summary. Include: key parties, timeline of events, core legal issues, and current status. Cite specific documents where possible.`,
  },
  litigation_strategy: {
    toolNames: ['search_documents', 'search_case_law', 'retrieve_statute', 'compare_documents'],
    maxToolRounds: 3,
    systemPromptAddition: `You are developing litigation strategy. Consider:
- Strength of evidence and potential weaknesses
- Applicable legal standards and burden of proof
- Comparable case outcomes
- Risk assessment and settlement considerations`,
  },
  deposition_analysis: {
    toolNames: ['search_documents', 'extract_contract_clauses', 'query_csv'],
    maxToolRounds: 2,
    systemPromptAddition: `Analyze deposition testimony for key admissions, contradictions, and areas requiring follow-up. Cross-reference with documentary evidence.`,
  },
  document_export: {
    toolNames: ['search_documents'],
    maxToolRounds: 1,
    systemPromptAddition: `The user wants to download a previous response as a file. Output the content with <!-- HORIZON_EXPORT title="Document Title" --> at the start. The platform handles file generation.`,
  },
  general_chat: {
    toolNames: [],  // Empty = all tools available
    maxToolRounds: 2,
    systemPromptAddition: `When drafting legal documents: use numbered paragraphs (not bullets), never reference filenames (use legal document titles), never include AI branding, and use jurisdiction-appropriate legal terminology. Output drafts as text in chat — do NOT create files unless the user explicitly asks for a file/Word/PDF download.`,
  },
  workspace_management: {
    toolNames: ['list_cases', 'get_case_details', 'list_folders', 'list_files', 'create_case', 'create_folder', 'rename_case', 'update_case'],
    maxToolRounds: 2,
    systemPromptAddition: `You are performing workspace operations.

MANDATORY TOOL EXECUTION RULES:
1. For create/rename/update user requests, you MUST call the corresponding mutation tool before answering:
   - create_case for creating matters/cases
   - create_folder for creating folders
   - rename_case for renaming
   - update_case for metadata updates
2. NEVER claim an item was created/updated/renamed unless the relevant tool returned success=true.
3. If a required field is missing from tool results (e.g., missing_required_fields), ask the user ONLY for those fields and do not claim completion.
4. For nested folder creation, resolve parent with list_folders/get_case_details first if needed, then call create_folder with parent_folder_id or parent_folder_name.
5. If a requested operation fails, explain the exact tool error and propose the minimum next input needed.
6. For multi-step requests (e.g., "create X then create Y inside X"), execute ALL requested steps with tool calls before giving the final response. Do not stop after partial completion.`,
  },
};

function getToolsForPipeline(agentTaskType: AgentTaskType, allTools: any[]): any[] {
  const config = AGENT_PIPELINE_CONFIGS[agentTaskType];
  if (!config || config.toolNames.length === 0) return allTools;
  return allTools.filter((t: any) => config.toolNames.includes(t.function.name));
}

// ============================================================================
// 3A. AUTHORITY ROUTING — Enterprise-grade query routing hierarchy
// ============================================================================

/**
 * Authority levels in strict priority order.
 * Internal data ALWAYS outranks general knowledge.
 */
type AuthorityLevel = 'structured_db' | 'document_corpus' | 'general_knowledge' | 'conversational';

interface AuthorityRoutingDecision {
  primaryAuthority: AuthorityLevel;
  shouldQueryStructuredDB: boolean;
  shouldRunRAG: boolean;
  shouldAllowGeneralKnowledge: boolean;
  fallbackRequired: boolean;
  routingReason: string;
}

/**
 * Determine authority routing for the query.
 * CRITICAL RULE: When a matter is active (hasCaseId), ALL non-conversational
 * queries MUST search internal data first. The classifier's opinion on
 * search_intent is irrelevant — internal data always has priority.
 */
function determineAuthorityRouting(
  classification: QueryClassification,
  hasCaseId: boolean,
  hasRAGEnabled: boolean,
  _userMessage: string = '',
): AuthorityRoutingDecision {
  // ── Workspace actions (tool operations) ──
  // Workspace management should never trigger RAG by default.
  if (classification.agent_task_type === 'workspace_management'
      || classification.tasks.some(t => t.type === 'tool')) {
    return {
      primaryAuthority: 'general_knowledge',
      shouldQueryStructuredDB: false,
      shouldRunRAG: false,
      shouldAllowGeneralKnowledge: true,
      fallbackRequired: false,
      routingReason: 'Workspace action — retrieval disabled',
    };
  }

  // ── Conversational queries ──
  // NOTE: Most conversational queries are caught upstream by conversationalGate()
  // and never reach here. This is a safety net for edge cases where the
  // classifier returns non_legal with no intent (e.g., gate timeout/failure).
  const classifierSaysConv = classification.domain === 'non_legal'
    && classification.tasks.length === 0
    && !classification.search_intent
    && !classification.requires_structured_data;

  if (classifierSaysConv) {
    return {
      primaryAuthority: 'conversational',
      shouldQueryStructuredDB: false,
      shouldRunRAG: false,
      shouldAllowGeneralKnowledge: true,
      fallbackRequired: false,
      routingReason: 'Non-legal query with no document intent — general knowledge',
    };
  }

  // ── Structured data intent ──
  // CSV queries work tenant-wide (no case_id needed) — the csv_datasets table
  // is always filtered by tenant_id for security.
  if (classification.requires_structured_data) {
    return {
      primaryAuthority: 'structured_db',
      shouldQueryStructuredDB: true,
      shouldRunRAG: hasRAGEnabled, // always supplement with RAG when available
      shouldAllowGeneralKnowledge: !hasCaseId, // allow fallback when no matter selected
      fallbackRequired: false,
      routingReason: `Structured intents: [${classification.structured_intents.map(si => si.type).join(', ')}]${hasCaseId ? '' : ' (tenant-wide)'}`,
    };
  }

  // ── MANDATORY RAG: Active matter = always search matter documents ──
  if (hasCaseId && hasRAGEnabled) {
    return {
      primaryAuthority: 'document_corpus',
      shouldQueryStructuredDB: classification.requires_structured_data,
      shouldRunRAG: true,
      shouldAllowGeneralKnowledge: false,
      fallbackRequired: false,
      routingReason: 'Active matter — mandatory RAG before any general knowledge',
    };
  }

  // ── No active matter — retrieval only when explicitly requested ──
  // Agent/classification must signal search intent. We do NOT auto-run tenant-wide
  // RAG for arbitrary prompts (prevents noisy research panel for workspace/general asks).
  if (hasRAGEnabled && classification.search_intent) {
    return {
      primaryAuthority: 'document_corpus',
      shouldQueryStructuredDB: false,
      shouldRunRAG: true,
      shouldAllowGeneralKnowledge: true,
      fallbackRequired: false,
      routingReason: 'No active matter + explicit search intent — tenant-wide document search',
    };
  }

  // ── No RAG capability at all — general knowledge is the only option ──
  return {
    primaryAuthority: 'general_knowledge',
    shouldQueryStructuredDB: false,
    shouldRunRAG: false,
    shouldAllowGeneralKnowledge: true,
    fallbackRequired: false,
    routingReason: 'No RAG available — general knowledge only',
  };
}

/**
 * Build the authority enforcement block appended to the system prompt.
 * This is the PRIMARY mechanism preventing the LLM from bypassing authority rules.
 */
function buildAuthorityBlock(
  routing: AuthorityRoutingDecision,
  hasRAGContext: boolean,
  hasStructuredData: boolean,
): string {
  if (routing.primaryAuthority === 'conversational') return '';

  if (routing.primaryAuthority === 'structured_db' || routing.primaryAuthority === 'document_corpus') {
    let block = `\n\n## ⚖ AUTHORITY HIERARCHY (MANDATORY — DO NOT OVERRIDE)
You are operating under a strict authority hierarchy. These rules are non-negotiable.

### Priority Order (highest → lowest):
1. **Structured matter intelligence** (DB-extracted entities, clauses, obligations, dates, risks)
2. **Document corpus** (RAG-retrieved excerpts from uploaded files)
3. **General knowledge** (your training data) — ONLY as explicitly labelled fallback

### Rules:
- NEVER answer from general knowledge when internal data is available on the topic.
- NEVER silently blend general knowledge with internal data.
- If internal data answers the query → use ONLY internal data. Cite specific documents/data points.
- If internal data is ABSENT or insufficient → you MUST explicitly state:
  "This matter's documents do not contain information regarding [topic]."
  Then optionally: "Based on publicly available information: [answer]"
- NEVER fabricate internal references or invent document content.`;

    if (hasRAGContext) {
      block += `\n- Document excerpts were provided — treat them as PRIMARY evidence.`;
    } else if (!hasStructuredData) {
      block += `\n- The initial broad document search found no direct matches for this query.
- **BEFORE stating absence**, you MUST use the \`search_documents\` tool with alternative keywords, synonyms, or related terms to verify.
- Only after the tool search ALSO returns no results may you state:
  "This matter's documents do not contain information regarding [topic]."
- NEVER conclude absence based solely on the initial search — ALWAYS verify with the search_documents tool.`;
    }

    block += `\n`;
    return block;
  }

  // General knowledge mode (no active matter)
  return '';
}

/**
 * Assess whether RAG found nothing relevant (for fallback handling).
 * Returns true if the query went through RAG but found no useful results.
 */
function assessFallbackNeeded(
  ragResult: RAGResult,
  structuredResult: StructuredDataResult,
  routing: AuthorityRoutingDecision,
): boolean {
  if (routing.primaryAuthority === 'conversational' || routing.primaryAuthority === 'general_knowledge') {
    return false; // no fallback assessment needed
  }
  const hasRAGContent = ragResult.sourceChunks.length > 0 && ragResult.sourceChunks.some(c => c.similarity >= 0.45);
  const hasStructuredContent = structuredResult.dataPoints > 0;
  return !hasRAGContent && !hasStructuredContent;
}

// ============================================================================
// 3B. EMBEDDING HELPER
// ============================================================================

async function generateQueryEmbedding(query: string, apiKey: string): Promise<number[] | null> {
  try {
    const response = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: query }),
      signal: AbortSignal.timeout(15_000), // 15s timeout — embeddings should be fast
    });
    if (!response.ok) { console.error('Embedding error:', await response.text()); return null; }
    const data = await response.json();
    return data.data[0].embedding;
  } catch (error: any) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      console.error('Embedding timed out after 15s');
    } else {
      console.error('Embedding failed:', error);
    }
    return null;
  }
}

// ============================================================================
// 3C. FILE OWNERSHIP VALIDATION — Matter isolation guard
// ============================================================================

/**
 * Validates that ALL requested file_ids actually belong to the specified case
 * and tenant. This is a security-critical check that prevents cross-matter
 * data leakage via crafted file_ids in the request payload.
 */
async function validateFileOwnership(
  fileIds: string[],
  caseId: string,
  tenantId: string,
  supabaseClient: any,
): Promise<{ valid: boolean; invalidFileIds: string[] }> {
  if (!fileIds.length) return { valid: true, invalidFileIds: [] };
  
  const { data: validFiles, error } = await supabaseClient
    .from('vault_assets')
    .select('id')
    .in('id', fileIds)
    .eq('case_id', caseId)
    .eq('tenant_id', tenantId);

  if (error) {
    console.error('[FILE_VALIDATION] Query failed:', error);
    // Fail closed — if we can't verify, reject
    return { valid: false, invalidFileIds: fileIds };
  }

  const validIdSet = new Set((validFiles || []).map((f: any) => f.id));
  const invalidFileIds = fileIds.filter(id => !validIdSet.has(id));
  
  console.log(`[FILE_VALIDATION] requested=${fileIds.length} valid=${validIdSet.size} invalid=${invalidFileIds.length} case_id=${caseId}`);
  return { valid: invalidFileIds.length === 0, invalidFileIds };
}

// ============================================================================
// 4. SSE STATE EMITTER — Structured event streaming
// ============================================================================

function emitState(encoder: TextEncoder, controller: ReadableStreamDefaultController, state: string, detail?: string, substantive: boolean = false) {
  const event: Record<string, any> = { type: 'state', value: state, substantive };
  if (detail) event.detail = detail;
  controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
}

function emitContent(encoder: TextEncoder, controller: ReadableStreamDefaultController, content: string) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'content', content })}\n\n`));
}

function emitFileExport(encoder: TextEncoder, controller: ReadableStreamDefaultController, markdown: string, title: string, format: 'word' | 'pdf') {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'file_export', markdown, title, format })}\n\n`));
}

/**
 * Cleans assistant message content for file export:
 * 1. Extracts content starting from HORIZON_EXPORT marker (strips AI preamble)
 * 2. Removes trailing AI commentary ("Please review...", "Let me know...")
 * 3. Strips trailing markdown separators
 */
function cleanExportContent(raw: string): string {
  let content = raw;

  // Strip everything BEFORE the HORIZON_EXPORT marker (AI preamble)
  const markerIdx = content.indexOf('<!-- HORIZON_EXPORT');
  if (markerIdx >= 0) {
    const markerEndIdx = content.indexOf('-->', markerIdx);
    if (markerEndIdx >= 0) {
      content = content.substring(markerEndIdx + 3).trim();
    }
  }

  // Strip trailing AI conversational text
  content = content.replace(/\n{2,}(?:Please review|Let me know|Feel free|I hope this|If you (?:need|want|have|would)|Note that|You can|Sources?:|This (?:draft|document|motion|memo|brief|letter) (?:is|covers|addresses|should)|Would you like)[\s\S]*$/i, '');

  // Strip trailing --- separators
  content = content.replace(/\n---\s*$/, '');

  return content.trim();
}

/**
 * Passes raw/unstructured text through LLM to format it as a properly structured
 * Markdown document suitable for Word/PDF export. Preserves ALL original content
 * while adding proper headings, sections, numbered paragraphs, and spacing.
 * Falls back to original content if LLM call fails.
 */
async function formatDocumentForExport(
  rawContent: string,
  title: string,
  apiKey: string,
): Promise<string> {
  try {
    const abortCtrl = new AbortController();
    const timeout = setTimeout(() => abortCtrl.abort(), 30000); // 30s for formatting

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: abortCtrl.signal,
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 8000,
        messages: [
          {
            role: 'system',
            content: `You are a legal document formatter. Your ONLY job is to take raw/unstructured text and output it as a properly structured Markdown document for Word export.

RULES:
1. PRESERVE every single word, sentence, and paragraph of the original text. Do NOT add, remove, summarize, or rephrase ANY content.
2. Add proper Markdown structure:
   - Use # for the document title (e.g., "# MOTION TO DISMISS")
   - Use ## for major sections (e.g., "## INTRODUCTION", "## STATEMENT OF FACTS")
   - Use ### for sub-sections where appropriate
   - Use proper numbered lists (1., 2., etc.) for numbered paragraphs
   - Use proper indentation for sub-numbered items (e.g., 2.1, 4.1.1)
   - Preserve paragraph breaks between distinct paragraphs
3. For court document headers (court name, case number, parties), format them as centered/bold text using **bold**
4. For signature blocks, dates, and certificates of service, preserve them as distinct sections
5. Do NOT wrap output in code blocks or add any commentary
6. Output ONLY the formatted Markdown document — nothing else
7. Bullet points (●) in the original should become proper Markdown headings (##) if they are section titles`,
          },
          {
            role: 'user',
            content: `Format this document for Word export. Preserve ALL content exactly:\n\n${rawContent}`,
          },
        ],
      }),
    });
    clearTimeout(timeout);

    if (!resp.ok) {
      console.error('[FORMAT] API error:', resp.status);
      return rawContent; // Fallback to original
    }

    const data = await resp.json();
    const formatted = data.choices?.[0]?.message?.content;
    if (formatted && formatted.length > rawContent.length * 0.5) {
      console.log(`[FORMAT] Formatted ${rawContent.length} chars → ${formatted.length} chars`);
      return formatted.trim();
    }
    console.warn('[FORMAT] Formatted content too short, using original');
    return rawContent;
  } catch (error: any) {
    console.error('[FORMAT] Error:', error.message);
    return rawContent; // Fallback to original
  }
}

/**
 * Scans conversation history AND the current user message to find the best exportable content.
 * Priority:
 *   1) Content embedded in the current user message (user pasted a draft + asked for file)
 *   2) Last assistant message with HORIZON_EXPORT marker
 *   3) Longest assistant message over 500 chars
 * Returns CLEANED content ready for file export.
 */
function findExportableMessage(
  history: Array<{ role: string; content: string }>,
  currentUserMessage?: string,
): { content: string; title: string } | null {

  // Pass 0: Check if the current user message itself contains substantial content.
  // If the user pasted a document into chat + asked for a file, the content is HERE.
  if (currentUserMessage) {
    // Strip the file-request portion to isolate the document content
    const fileRequestPatterns = /\b(?:give\s+me\s+(?:this\s+)?(?:in\s+)?(?:a\s+)?(?:word|docx|pdf)\s*(?:file|document|format)?|(?:word|docx|pdf)\s*(?:file|document)|download\s+(?:as\s+)?(?:word|docx|pdf)|export\s+(?:as\s+)?(?:word|docx|pdf)|convert\s+(?:to\s+)?(?:word|docx|pdf)|make\s+(?:it\s+)?(?:a\s+)?(?:word|docx|pdf))\b[^.]*?(?:\.|$)/gi;
    const stripped = currentUserMessage.replace(fileRequestPatterns, '').trim();
    // If after stripping the file request, there's still substantial text (>300 chars), it IS the content
    if (stripped.length > 300) {
      const titleMatch = stripped.match(/^#+\s+(.+)/m)
        || stripped.match(/(MOTION\s+TO\s+\w+|BRIEF\s+(?:IN\s+)?(?:SUPPORT|OPPOSITION)\s+OF\s+[\w\s]+|MEMORANDUM\s+(?:OF|IN)\s+[\w\s]+|NOTICE\s+OF\s+[\w\s]+|COMPLAINT|PETITION|AFFIDAVIT|DECLARATION|SUBPOENA|SUMMONS|MOTION\s+FOR\s+[\w\s]+)/i)
        || stripped.match(/^([A-Z][A-Z\s]{3,})$/m);
      return { content: cleanExportContent(stripped), title: titleMatch ? titleMatch[1].trim().substring(0, 80) : 'Document' };
    }
  }

  if (!history || history.length === 0) return null;

  // Pass 1: Find messages with HORIZON_EXPORT marker (scan from newest to oldest)
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;
    const markerMatch = msg.content.match(/<!--\s*HORIZON_EXPORT\s+title="([^"]+)"\s*-->/);
    if (markerMatch) {
      return { content: cleanExportContent(msg.content), title: markerMatch[1] };
    }
  }

  // Pass 2: Find longest assistant message (likely the draft)
  let best: { content: string; title: string } | null = null;
  let bestLen = 500;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant' && msg.role !== 'model') continue;
    const len = (msg.content || '').length;
    if (len > bestLen) {
      bestLen = len;
      const headingMatch = msg.content.match(/^#+\s+(.+)/m) || msg.content.match(/^([A-Z][A-Z\s]+)$/m);
      best = { content: cleanExportContent(msg.content), title: headingMatch ? headingMatch[1].trim() : 'Document' };
    }
  }

  return best;
}

/**
 * Finds a working document in conversation history for edit/modification scenarios.
 * Returns the RAW content (not cleaned) so the AI can modify it precisely.
 * Priority: 1) Last assistant message with HORIZON_EXPORT marker, 2) Longest assistant message >500 chars
 */
function findWorkingDocument(history: Array<{ role: string; content: string }>): { content: string; title: string } | null {
  if (!history || history.length === 0) return null;

  // Pass 1: Message with HORIZON_EXPORT marker (most recent first)
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant') continue;
    const markerMatch = msg.content.match(/<!--\s*HORIZON_EXPORT\s+title="([^"]+)"\s*-->/);
    if (markerMatch) {
      // Return content from marker onwards (strip AI preamble but keep document intact)
      const markerIdx = msg.content.indexOf('<!-- HORIZON_EXPORT');
      const content = markerIdx >= 0 ? msg.content.substring(markerIdx) : msg.content;
      return { content: content.replace(/\n*\*\*Sources?:\*\*[\s\S]*$/i, '').trim(), title: markerMatch[1] };
    }
  }

  // Pass 2: Longest assistant message (>500 chars)
  let best: { content: string; title: string } | null = null;
  let bestLen = 500;
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role !== 'assistant' && msg.role !== 'model') continue;
    const len = (msg.content || '').length;
    if (len > bestLen) {
      bestLen = len;
      const headingMatch = msg.content.match(/^#+\s+(.+)/m) || msg.content.match(/^([A-Z][A-Z\s]+)$/m);
      const content = msg.content.replace(/\n*\*\*Sources?:\*\*[\s\S]*$/i, '').trim();
      best = { content, title: headingMatch ? headingMatch[1].trim() : 'Document' };
    }
  }

  return best;
}

function emitSources(encoder: TextEncoder, controller: ReadableStreamDefaultController, sources: any[]) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'sources', sources })}\n\n`));
}

function emitValidation(encoder: TextEncoder, controller: ReadableStreamDefaultController, validation: {
  confidence: 'high' | 'medium' | 'low';
  has_document_context: boolean;
  has_structured_data: boolean;
  data_points_used: number;
  source_count: number;
  warnings?: string[];
}) {
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'validation', ...validation })}\n\n`));
}

/**
 * Assess context confidence before LLM call
 * Returns confidence level and any warnings about data quality
 */
function assessContextConfidence(
  ragResult: RAGResult,
  structuredResult: StructuredDataResult,
  classification: QueryClassification,
): { confidence: 'high' | 'medium' | 'low'; warnings: string[] } {
  const warnings: string[] = [];
  let score = 0;

  // Score based on RAG quality
  if (ragResult.sourceChunks.length > 0) {
    const avgSimilarity = ragResult.sourceChunks.reduce((sum, c) => sum + (c.similarity || 0), 0) / ragResult.sourceChunks.length;
    if (avgSimilarity > 0.8) score += 3;
    else if (avgSimilarity > 0.6) score += 2;
    else {
      score += 1;
      warnings.push('Document matches have low relevance scores');
    }
  } else if (classification.search_intent) {
    warnings.push('No document matches found for this query');
  }

  // Score based on structured data
  if (structuredResult.dataPoints > 0) {
    score += 2;
    if (structuredResult.dataPoints > 5) score += 1;
  } else if (classification.requires_structured_data) {
    warnings.push('No structured intelligence data available — extraction may not have completed');
  }

  // Penalize for complex queries with thin context
  if ((classification.complexity === 'analytical' || classification.complexity === 'multi_source') && score < 3) {
    warnings.push('Complex query with limited supporting data — response may be incomplete');
  }

  const confidence = score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low';
  return { confidence, warnings };
}

// ============================================================================
// 5. FUNCTION CALLING: Tool Definitions
// ============================================================================

const HORIZON_TOOLS = [
  {
    type: "function",
    function: {
      name: "list_cases",
      description: "List all cases for the current user. Use this when the user asks to see their cases, case list, or what cases they have.",
      parameters: { type: "object", properties: { limit: { type: "number", description: "Maximum number of cases to return. Default is 20." } }, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "get_case_details",
      description: "Get details of a specific case by name or ID.",
      parameters: { type: "object", properties: { case_name: { type: "string" }, case_id: { type: "string" } }, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "list_folders",
      description: "List all folders in a specific case.",
      parameters: { type: "object", properties: { case_id: { type: "string" }, case_name: { type: "string" } }, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List all files, optionally filtered by case or folder.",
      parameters: { type: "object", properties: { case_id: { type: "string" }, case_name: { type: "string" }, folder_id: { type: "string" }, limit: { type: "number" } }, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "create_case",
      description: "Create a new case/matter. If required fields are missing, collect them from the user before retrying.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Case/matter name (required)" },
          client_name: { type: "string", description: "Client name" },
          case_number: { type: "string", description: "Case number/reference" },
          description: { type: "string", description: "Matter description" },
          matter_type: { type: "string", description: "Matter type (e.g., litigation, arbitration, corporate, other)" },
          matter_ref: { type: "string", description: "Internal matter reference code" },
          status: { type: "string", description: "Initial status (defaults to active)" },
        },
        required: ["name"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_folder",
      description: "Create a new folder inside a case.",
      parameters: { type: "object", properties: { case_id: { type: "string" }, case_name: { type: "string" }, name: { type: "string", description: "Folder name (required)" }, folder_type: { type: "string" }, description: { type: "string" }, parent_folder_name: { type: "string" }, parent_folder_id: { type: "string" } }, required: ["name"] }
    }
  },
  {
    type: "function",
    function: {
      name: "search_documents",
      description: "Search across all uploaded documents for specific content.",
      parameters: { type: "object", properties: { query: { type: "string", description: "The search query" }, case_id: { type: "string" }, limit: { type: "number" } }, required: ["query"] }
    }
  },
  {
    type: "function",
    function: {
      name: "query_csv",
      description: "Query structured CSV/Excel datasets with deterministic filtering and aggregation. Use for any question about totals, sums, counts, averages, filtering rows, or looking up specific entries in spreadsheet data. Returns exact computed results — not estimates. IMPORTANT: For currency, date, and duration columns, use the '__n' suffixed column name for numeric comparisons (e.g., 'Amount__n' for the numeric version of 'Amount'). The schema description will tell you which columns have __n versions.",
      parameters: {
        type: "object",
        properties: {
          search_term: { type: "string", description: "Text to search for across all text columns using fuzzy matching. Good for name lookups." },
          filters: {
            type: "array",
            description: "AND filters — ALL must match. [{ column, operator, value, value2? }]. Operators: eq, neq, contains, fuzzy (trigram similarity), gt, gte, lt, lte, in (pipe-separated values), date_range (value=start, value2=end, ISO format YYYY-MM-DD).",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                operator: { type: "string", enum: ["eq", "neq", "contains", "fuzzy", "gt", "gte", "lt", "lte", "in", "date_range"] },
                value: { type: "string" },
                value2: { type: "string", description: "End value for date_range operator" }
              },
              required: ["column", "operator", "value"]
            }
          },
          or_filters: {
            type: "array",
            description: "OR filters — ANY match passes - used in combination with AND filters. Same schema as filters.",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                operator: { type: "string", enum: ["eq", "neq", "contains", "fuzzy", "gt", "gte", "lt", "lte", "in", "date_range"] },
                value: { type: "string" },
                value2: { type: "string" }
              },
              required: ["column", "operator", "value"]
            }
          },
          aggregations: {
            type: "array",
            description: "Aggregations to compute: [{ column, function }]. Functions: sum, avg, count, count_distinct, min, max. Use column__n for currency/duration columns.",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                function: { type: "string", enum: ["sum", "avg", "count", "count_distinct", "min", "max"] }
              },
              required: ["column", "function"]
            }
          },
          group_by: { type: "string", description: "Column name to group results by" },
          order_by: { type: "string", description: "Column name to sort results by" },
          order_dir: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default: asc)" },
          dataset_id: { type: "string", description: "Specific dataset ID (optional — auto-detected if omitted)" },
          limit: { type: "number", description: "Max rows to return (default 50)" }
        },
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "rename_case",
      description: "Rename an existing case.",
      parameters: { type: "object", properties: { case_id: { type: "string" }, case_name: { type: "string" }, new_name: { type: "string", description: "New name (required)" } }, required: ["new_name"] }
    }
  },
  {
    type: "function",
    function: {
      name: "update_case",
      description: "Update case details (case number, client name, description).",
      parameters: { type: "object", properties: { case_id: { type: "string" }, case_name: { type: "string" }, case_number: { type: "string" }, client_name: { type: "string" }, description: { type: "string" } }, required: [] }
    }
  },
  {
    type: "function",
    function: {
      name: "get_images",
      description: "Get all images — both standalone uploads and images extracted from documents (PDFs, DOCX, XLSX). Optionally filter by parent document or case.",
      parameters: { type: "object", properties: { document_name: { type: "string", description: "Filter to images extracted from this document" }, case_name: { type: "string", description: "Filter by case/matter name" }, case_id: { type: "string", description: "Filter by case ID" }, file_id: { type: "string", description: "Parent document ID to get extracted images from" }, limit: { type: "number", description: "Max results (default 10)" } }, required: [] }
    }
  },
  // ── Legal Analysis Tools (Phase 3) ──
  {
    type: "function",
    function: {
      name: "create_legal_document",
      description: "Create a legal document artifact (motion, memo, brief, letter, contract draft, etc.) that can be downloaded as Word or PDF. Use this when the user asks you to draft, write, or generate a legal document.",
      parameters: { type: "object", properties: { title: { type: "string", description: "Document title" }, document_type: { type: "string", enum: ["motion", "legal_memo", "contract", "research_report", "case_brief", "letter", "deposition_summary", "litigation_strategy", "compliance_report", "discovery_plan", "settlement_agreement", "other"], description: "Type of legal document" }, content: { type: "string", description: "Full markdown content of the document" }, jurisdiction: { type: "string", description: "Applicable jurisdiction (e.g., 'California', 'SDNY')" }, court: { type: "string", description: "Court name if applicable" } }, required: ["title", "document_type", "content"] }
    }
  },
  {
    type: "function",
    function: {
      name: "search_case_law",
      description: "Search for relevant case law and legal precedents from uploaded documents. Returns cases with citations, holdings, and relevance scores.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Legal issue or topic to search for" }, jurisdiction: { type: "string", description: "Limit to specific jurisdiction" }, date_range: { type: "string", description: "Date range filter (e.g., 'last 5 years', '2020-2024')" }, limit: { type: "number", description: "Max results (default 10)" } }, required: ["query"] }
    }
  },
  {
    type: "function",
    function: {
      name: "retrieve_statute",
      description: "Search for statutory provisions, regulations, and legislative text from uploaded documents.",
      parameters: { type: "object", properties: { query: { type: "string", description: "Statute name, section number, or topic" }, jurisdiction: { type: "string", description: "Jurisdiction for the statute" }, limit: { type: "number", description: "Max results (default 5)" } }, required: ["query"] }
    }
  },
  {
    type: "function",
    function: {
      name: "extract_contract_clauses",
      description: "Extract and analyze specific clauses from contracts in the matter. Searches structured clause data first, then falls back to document search.",
      parameters: { type: "object", properties: { clause_type: { type: "string", description: "Type of clause (e.g., 'indemnification', 'termination', 'non_compete', 'confidentiality', 'force_majeure', 'liability')" }, document_name: { type: "string", description: "Specific document to analyze" } }, required: ["clause_type"] }
    }
  },
  {
    type: "function",
    function: {
      name: "compare_documents",
      description: "Compare content across two or more documents in the matter. Finds overlapping and conflicting provisions.",
      parameters: { type: "object", properties: { query: { type: "string", description: "What aspect to compare (e.g., 'liability provisions', 'payment terms')" }, document_names: { type: "array", items: { type: "string" }, description: "Names of documents to compare (if empty, compares all relevant)" }, limit: { type: "number", description: "Max results per document (default 5)" } }, required: ["query"] }
    }
  }
];

// ============================================================================
// 6. TOOL EXECUTOR
// ============================================================================

interface ToolExecutionContext {
  supabaseClient: any;
  tenantId: string;
  userId: string;
  openaiApiKey: string;
  caseId?: string;   // Active matter — enforced on all tool queries
  fileIds?: string[]; // File scope — tools must not search outside these
}

async function executeTool(toolName: string, args: Record<string, any>, context: ToolExecutionContext): Promise<{ success: boolean; result: any; error?: string }> {
  const { supabaseClient, tenantId, userId, openaiApiKey } = context;
  console.log(`Executing tool: ${toolName}`, args);

  try {
    switch (toolName) {
      case 'list_cases': {
        const limit = args.limit || 20;
        const { data: cases, error } = await supabaseClient.from('cases').select('id, name, client_name, case_number, description, status, created_at').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(limit);
        if (error) throw error;
        return { success: true, result: { count: cases?.length || 0, cases: cases || [], message: cases?.length ? `Found ${cases.length} case(s).` : 'No cases found.' } };
      }
      case 'get_case_details': {
        let query = supabaseClient.from('cases').select('id, name, client_name, case_number, description, created_at').eq('tenant_id', tenantId);
        if (args.case_id) query = query.eq('id', args.case_id);
        else if (args.case_name) query = query.ilike('name', `%${args.case_name}%`);
        else return { success: false, result: null, error: 'Please provide a case name or ID.' };
        const { data: caseData, error } = await query.limit(1).maybeSingle();
        if (error) throw error;
        if (!caseData) return { success: false, result: null, error: 'Case not found.' };
        const [{ count: folderCount }, { count: fileCount }] = await Promise.all([
          supabaseClient.from('folders').select('id', { count: 'exact', head: true }).eq('case_id', caseData.id),
          supabaseClient.from('vault_assets').select('id', { count: 'exact', head: true }).eq('case_id', caseData.id)
        ]);
        return { success: true, result: { ...caseData, folder_count: folderCount || 0, file_count: fileCount || 0 } };
      }
      case 'list_folders': {
        // MATTER ISOLATION: Server-side caseId takes priority over LLM args
        let caseId = context.caseId || args.case_id || args.matter_id;
        const listFoldersCaseName = args.case_name || args.matter_name || args.case || args.matter;
        if (!caseId && listFoldersCaseName) {
          const { data: c } = await supabaseClient
            .from('cases')
            .select('id')
            .eq('tenant_id', tenantId)
            .ilike('name', `%${listFoldersCaseName}%`)
            .limit(1)
            .maybeSingle();
          if (!c) return { success: false, result: null, error: `Case "${listFoldersCaseName}" not found.` };
          caseId = c.id;
        }
        if (!caseId) return { success: false, result: null, error: 'Please specify a case.' };
        const { data: folders, error } = await supabaseClient.from('folders').select('id, name, folder_type, description, created_at').eq('case_id', caseId).order('created_at', { ascending: false });
        if (error) throw error;
        return { success: true, result: { count: folders?.length || 0, folders: folders || [], message: folders?.length ? `Found ${folders.length} folder(s).` : 'No folders found.' } };
      }
      case 'list_files': {
        const limit = args.limit || 50;
        let query = supabaseClient
          .from('vault_assets')
          .select('id, filename, filetype, status, case_id, folder_id, created_at')
          .eq('tenant_id', tenantId)
          .order('created_at', { ascending: false })
          .limit(limit);

        // MATTER ISOLATION: Server-side caseId takes priority over LLM args.
        const listFilesCaseId = context.caseId || args.case_id || args.matter_id;
        const listFilesCaseName = args.case_name || args.matter_name || args.case || args.matter;
        if (listFilesCaseId) {
          query = query.eq('case_id', listFilesCaseId);
        } else if (listFilesCaseName) {
          const { data: c } = await supabaseClient
            .from('cases')
            .select('id')
            .eq('tenant_id', tenantId)
            .ilike('name', `%${listFilesCaseName}%`)
            .limit(1)
            .maybeSingle();
          if (c) query = query.eq('case_id', c.id);
        }
        if (args.folder_id) query = query.eq('folder_id', args.folder_id);

        const { data: files, error } = await query;
        if (error) throw error;
        return {
          success: true,
          result: {
            count: files?.length || 0,
            files: (files || []).map((f: any) => ({
              id: f.id,
              name: f.filename,
              type: f.filetype,
              status: f.status,
              created_at: f.created_at,
            })),
            message: files?.length ? `Found ${files.length} file(s).` : 'No files found.',
          },
        };
      }
      case 'create_case': {
        // New clean implementation: direct insert with deterministic validation
        // and DB-error parsing for compulsory columns.
        const trimmedName = typeof args.name === 'string' ? args.name.trim() : '';
        if (!trimmedName) {
          return {
            success: false,
            result: { missing_required_fields: ['name'] },
            error: 'Matter name is required. Ask the user for the matter/case name and retry.',
          };
        }

        const insertPayload: Record<string, any> = {
          tenant_id: tenantId,
          name: trimmedName,
          created_by: userId,
          status: args.status || 'active',
          client_name: args.client_name ?? null,
          case_number: args.case_number ?? null,
          description: args.description ?? null,
          matter_type: args.matter_type ?? null,
          matter_ref: args.matter_ref ?? null,
        };

        const { data: newCase, error } = await supabaseClient
          .from('cases')
          .insert(insertPayload)
          .select()
          .single();

        if (error) {
          const code = String((error as any).code || '');
          const message = String((error as any).message || '');
          const details = String((error as any).details || '');
          const lower = `${message} ${details}`.toLowerCase();

          // Postgres NOT NULL violation: extract missing column name.
          if (code === '23502') {
            const columnMatch = lower.match(/column\s+"?([a-z0-9_]+)"?\s+of\s+relation/i)
              || lower.match(/null value in column\s+"?([a-z0-9_]+)"?/i);
            const missingCol = columnMatch?.[1] || 'unknown_required_field';
            return {
              success: false,
              result: { missing_required_fields: [missingCol] },
              error: `Cannot create matter yet. Missing required field: ${missingCol}. Ask the user for this value and retry create_case.`,
            };
          }

          // Constraint violation (check/unique) with actionable guidance.
          if (code === '23514' || code === '23505') {
            return {
              success: false,
              result: { db_code: code },
              error: `Cannot create matter due to a database constraint (${code}): ${message || details || 'constraint violation'}. Ask the user to adjust values and retry.`,
            };
          }

          throw error;
        }

        return {
          success: true,
          result: {
            case: newCase,
            message: `Created matter "${trimmedName}" successfully.`,
          },
        };
      }
      case 'create_folder': {
        const folderName = args.name || args.folder_name || args.new_folder_name || args.child_folder_name || args.folder || args.folderName;
        if (!folderName || String(folderName).trim().length === 0) {
          return { success: false, result: null, error: 'Folder name is required. Provide `name` (or folder_name/new_folder_name).' };
        }

        let caseId = context.caseId || args.case_id || args.matter_id;
        const caseName = args.case_name || args.matter_name || args.case || args.matter || args.caseName || args.matterName;
        if (!caseId && caseName) {
          const { data: c } = await supabaseClient.from('cases').select('id').eq('tenant_id', tenantId).ilike('name', `%${caseName}%`).limit(1).maybeSingle();
          if (!c) return { success: false, result: null, error: `Case "${caseName}" not found.` };
          caseId = c.id;
        }
        if (!caseId) return { success: false, result: null, error: 'Please specify which case.' };

        let parentFolderId = args.parent_folder_id || args.parent_id || args.parentFolderId || null;
        const parentFolderName = args.parent_folder_name || args.parent_name || args.inside_folder || args.in_folder || args.parentFolderName || args.parentFolder;
        if (!parentFolderId && parentFolderName) {
          const { data: pf } = await supabaseClient
            .from('folders')
            .select('id, name')
            .eq('tenant_id', tenantId)
            .eq('case_id', caseId)
            .ilike('name', `%${parentFolderName}%`)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();
          if (!pf) {
            const { data: available } = await supabaseClient
              .from('folders')
              .select('name')
              .eq('tenant_id', tenantId)
              .eq('case_id', caseId)
              .order('created_at', { ascending: false })
              .limit(10);
            const availableNames = (available || []).map((f: any) => f.name).filter(Boolean);
            return {
              success: false,
              result: { available_folders: availableNames },
              error: `Parent folder "${parentFolderName}" not found in this case.${availableNames.length ? ` Available folders: ${availableNames.join(', ')}` : ''}`,
            };
          }
          parentFolderId = pf.id;
        }

        const { data: newFolder, error } = await supabaseClient
          .from('folders')
          .insert({
            tenant_id: tenantId,
            case_id: caseId,
            name: String(folderName).trim(),
            folder_type: args.folder_type || null,
            description: args.description || null,
            parent_folder_id: parentFolderId,
            created_by: userId,
          })
          .select()
          .single();
        if (error) throw error;
        return { success: true, result: { folder: newFolder, message: `Created folder "${String(folderName).trim()}" successfully.` } };
      }
      case 'search_documents': {
        if (!args.query) return { success: false, result: null, error: 'Search query is required.' };
        const embedding = await generateQueryEmbedding(args.query, openaiApiKey);
        if (!embedding) return { success: false, result: null, error: 'Failed to process search query.' };
        // MATTER ISOLATION: Always scope to active matter. Server-side caseId
        // takes priority over LLM-provided args.case_id to prevent prompt injection.
        const effectiveCaseId = context.caseId || args.case_id;
        const rpcSearchParams: any = {
          query_embedding: embedding,
          query_text: args.query,
          p_tenant_id: tenantId,
          match_count: args.limit || 10,
          similarity_threshold: 0.2,
        };
        if (effectiveCaseId) rpcSearchParams.p_case_id = effectiveCaseId;
        if (context.fileIds && context.fileIds.length > 0) rpcSearchParams.p_file_ids = context.fileIds;
        console.log(`[SEARCH_DOCUMENTS] matter_scoped=${!!effectiveCaseId} file_scoped=${!!(context.fileIds?.length)} case_id=${effectiveCaseId || 'none'}`);
        const { data: chunks, error } = await supabaseClient.rpc('match_documents_hybrid', rpcSearchParams);
        if (error) throw error;
        const fileResults = new Map<string, { filename: string; excerpts: string[]; similarity: number }>();
        for (const chunk of (chunks || [])) {
          const filename = chunk.metadata?.filename || 'Unknown';
          if (!fileResults.has(filename)) fileResults.set(filename, { filename, excerpts: [], similarity: chunk.similarity });
          const entry = fileResults.get(filename)!;
          if (entry.excerpts.length < 2) entry.excerpts.push(chunk.content.substring(0, 200) + '...');
        }
        return { success: true, result: { query: args.query, count: fileResults.size, results: Array.from(fileResults.values()), message: fileResults.size ? `Found content in ${fileResults.size} document(s).` : 'No matching content found.' } };
      }
      case 'rename_case': {
        if (!args.new_name) return { success: false, result: null, error: 'New name is required.' };
        let caseId = args.case_id;
        if (!caseId && args.case_name) {
          const { data: c } = await supabaseClient.from('cases').select('id').eq('tenant_id', tenantId).ilike('name', `%${args.case_name}%`).limit(1).maybeSingle();
          if (!c) return { success: false, result: null, error: `Case "${args.case_name}" not found.` };
          caseId = c.id;
        }
        if (!caseId) return { success: false, result: null, error: 'Please specify which case.' };
        const { data: updated, error } = await supabaseClient.from('cases').update({ name: args.new_name }).eq('id', caseId).eq('tenant_id', tenantId).select().single();
        if (error) throw error;
        return { success: true, result: { case: updated, message: `Renamed case to "${args.new_name}".` } };
      }
      case 'update_case': {
        if (!args.case_number && !args.client_name && !args.description) return { success: false, result: null, error: 'Please specify a field to update.' };
        let caseId = args.case_id;
        if (!caseId && args.case_name) {
          const { data: c } = await supabaseClient.from('cases').select('id').eq('tenant_id', tenantId).ilike('name', `%${args.case_name}%`).limit(1).maybeSingle();
          if (!c) return { success: false, result: null, error: `Case "${args.case_name}" not found.` };
          caseId = c.id;
        }
        if (!caseId) return { success: false, result: null, error: 'Please specify which case.' };
        const updateData: Record<string, string> = {};
        if (args.case_number) updateData.case_number = args.case_number;
        if (args.client_name) updateData.client_name = args.client_name;
        if (args.description) updateData.description = args.description;
        const { data: updated, error } = await supabaseClient.from('cases').update(updateData).eq('id', caseId).eq('tenant_id', tenantId).select().single();
        if (error) throw error;
        const updates = [];
        if (args.case_number) updates.push(`case number: ${args.case_number}`);
        if (args.client_name) updates.push(`client: ${args.client_name}`);
        if (args.description) updates.push(`description updated`);
        return { success: true, result: { case: updated, message: `Updated case — ${updates.join(', ')}.` } };
      }
      case 'query_csv': {
        // ═══════════════════════════════════════════════════════════════════
        // Enterprise CSV Query — deterministic filtering with retry cascade
        // Supports both matter-scoped (case_id) and tenant-wide queries.
        // ═══════════════════════════════════════════════════════════════════
        const effectiveCaseId = context.caseId || args.case_id;

        // ── 1. Dataset discovery ──────────────────────────────────────────
        let datasetId = args.dataset_id;
        let datasetFilename = 'Unknown';
        let datasetSchema: any[] = [];
        let schemaDescription = '';

        if (!datasetId) {
          let dsQuery = supabaseClient
            .from('csv_datasets')
            .select('id, filename, schema, schema_description, row_count, column_count')
            .eq('tenant_id', tenantId);
          if (effectiveCaseId) dsQuery = dsQuery.eq('case_id', effectiveCaseId);
          const { data: datasets } = await dsQuery;

          if (!datasets || datasets.length === 0) {
            return { success: true, result: { message: 'No CSV/Excel datasets found. Upload a spreadsheet first.' } };
          }

          // Smart dataset selection: match by filename hint in search_term, else largest
          let ds = datasets.sort((a: any, b: any) => b.row_count - a.row_count)[0];
          if (args.search_term && datasets.length > 1) {
            const hint = args.search_term.toLowerCase();
            const match = datasets.find((d: any) => d.filename.toLowerCase().includes(hint));
            if (match) ds = match;
          }
          datasetId = ds.id;
          datasetFilename = ds.filename;
          datasetSchema = ds.schema;
          schemaDescription = ds.schema_description || '';
        } else {
          const { data: ds } = await supabaseClient
            .from('csv_datasets')
            .select('filename, schema, schema_description')
            .eq('id', datasetId)
            .eq('tenant_id', tenantId)
            .single();
          if (ds) {
            datasetFilename = ds.filename;
            datasetSchema = ds.schema;
            schemaDescription = ds.schema_description || '';
          }
        }

        // ── 2. Column validation — fuzzy-match LLM-guessed column names ──
        const validColumns = new Set((datasetSchema as any[]).map((c: any) => c.columnName));
        // Also include __n variants
        for (const c of datasetSchema as any[]) {
          if (['currency', 'date', 'duration'].includes(c.inferredType)) {
            validColumns.add(`${c.columnName}__n`);
          }
        }

        function fixColumnName(guessedCol: string): string {
          if (validColumns.has(guessedCol)) return guessedCol;
          // Case-insensitive match
          for (const vc of validColumns) {
            if (vc.toLowerCase() === guessedCol.toLowerCase()) return vc;
          }
          // Partial match (column name contains guess or vice versa)
          const lower = guessedCol.toLowerCase();
          for (const vc of validColumns) {
            if (vc.toLowerCase().includes(lower) || lower.includes(vc.toLowerCase())) return vc;
          }
          return guessedCol; // Return as-is, RPC will handle gracefully
        }

        // Fix column names in filters
        const fixedFilters = (args.filters || []).map((f: any) => ({
          ...f,
          column: fixColumnName(f.column),
        }));

        const fixedOrFilters = (args.or_filters || []).map((f: any) => ({
          ...f,
          column: fixColumnName(f.column),
        }));

        const fixedAggregations = (args.aggregations || []).map((a: any) => ({
          ...a,
          column: fixColumnName(a.column),
        }));

        // ── 3. Build query — search_term → single OR-based call ────────
        // Use 'contains' (LIKE) first — it's fast. Only fall back to 'fuzzy'
        // (trigram similarity) if contains returns 0 results.
        let andFilters: any[] = fixedFilters;
        let orFilters: any[] = fixedOrFilters;

        if (args.search_term && andFilters.length === 0 && orFilters.length === 0) {
          // Skip very short or pronoun search terms — they match too broadly
          const isUsefulSearchTerm = args.search_term.length >= 3
            && !/^(he|she|her|him|his|it|its|they|them|their|we|us|our|you|your|me|my|the|a|an)$/i.test(args.search_term);

          if (isUsefulSearchTerm) {
            // Convert search_term to OR filters across all text/categorical columns.
            // Use 'fuzzy' (trigram similarity) by default for name-like terms — it's
            // more robust than ILIKE '%name%' because names may appear in different
            // formats (e.g., "Lyndsy v. Crown" vs "Pieters" vs "845CV-25").
            // For longer phrases (>20 chars), use 'contains' as it's faster and precise.
            const searchOp = args.search_term.length <= 20 ? 'fuzzy' : 'contains';
            const textCols = (datasetSchema as any[]).filter((c: any) =>
              ['free_text', 'categorical'].includes(c.inferredType)
            );
            orFilters = textCols.map((col: any) => ({
              column: col.columnName,
              operator: searchOp,
              value: args.search_term,
            }));
          } else {
            console.log(`[QUERY_CSV_TOOL] Skipping too-short/pronoun search term: "${args.search_term}"`);
            // Return all rows without filtering — let aggregations work on the full dataset
          }
        }

        // ── 4. Execute query with retry cascade ──────────────────────────
        const fixedOrderBy = args.order_by ? fixColumnName(args.order_by) : null;
        const fixedGroupBy = args.group_by ? fixColumnName(args.group_by) : null;

        const executeQuery = async (pFilters: any[], pOrFilters: any[]) => {
          const { data: qr, error: qErr } = await supabaseClient.rpc('query_csv_dataset', {
            p_dataset_id: datasetId,
            p_tenant_id: tenantId,
            p_filters: pFilters,
            p_or_filters: pOrFilters,
            p_aggregations: fixedAggregations,
            p_group_by: fixedGroupBy,
            p_order_by: fixedOrderBy,
            p_order_dir: args.order_dir || 'asc',
            p_limit: args.limit || 50,
          });
          if (qErr) throw new Error(qErr.message);
          return qr;
        };

        let queryResult: any;
        let retryNote = '';

        try {
          // Attempt 1: Query as built (contains for search_term, or explicit filters)
          queryResult = await executeQuery(andFilters, orFilters);

          // Single retry: if no results and we have a search_term, try the alternate matching strategy
          if (queryResult?.total_matches === 0 && args.search_term && orFilters.length > 0) {
            const textCols = (datasetSchema as any[]).filter((c: any) =>
              ['free_text', 'categorical'].includes(c.inferredType)
            );
            // If initial was fuzzy, retry with contains (exact substring); if initial was contains, retry with fuzzy
            const retryOp = orFilters[0]?.operator === 'fuzzy' ? 'contains' : 'fuzzy';
            const retryOrFilters = textCols.map((col: any) => ({
              column: col.columnName,
              operator: retryOp,
              value: args.search_term,
            }));
            queryResult = await executeQuery([], retryOrFilters);
            if (queryResult?.total_matches > 0) {
              retryNote = ` (${retryOp} match — primary search returned 0)`;
            }
          }

          // Auto-escalate: if very few results (≤3) and a larger dataset exists
          // from the same file, auto-retry with the detailed dataset.
          // Triggers when search_term was used OR when explicit filters returned few rows.
          const hasNameSearch = args.search_term || (args.filters || []).some(
            (f: any) => ['fuzzy', 'contains'].includes(f.operator)
          );
          if (queryResult?.total_matches <= 3 && hasNameSearch) {
            let altQuery = supabaseClient
              .from('csv_datasets')
              .select('id, filename, schema, schema_description, row_count, column_count')
              .eq('tenant_id', tenantId)
              .neq('id', datasetId)
              .order('column_count', { ascending: false });
            if (effectiveCaseId) altQuery = altQuery.eq('case_id', effectiveCaseId);
            const { data: altDatasets } = await altQuery;

            if (altDatasets && altDatasets.length > 0) {
              // Find a larger dataset from the same file
              const baseName = datasetFilename.split('.')[0].toLowerCase();
              const largerDs = altDatasets.find((d: any) =>
                d.filename.toLowerCase().includes(baseName) && d.column_count > (datasetSchema as any[]).length
              );

              if (largerDs) {
                // Extract the search name from search_term or from fuzzy/contains filters
                const searchName = args.search_term
                  || (args.filters || []).find((f: any) => ['fuzzy', 'contains'].includes(f.operator))?.value
                  || '';
                console.log(`[QUERY_CSV_TOOL] Auto-escalating: ${datasetFilename} (${(datasetSchema as any[]).length} cols) → ${largerDs.filename} sheet (${largerDs.column_count} cols), search="${searchName}"`);
                const altSchema = largerDs.schema as Array<{ columnName: string; inferredType: string }>;
                const altTextCols = altSchema.filter((c: any) =>
                  ['free_text', 'categorical'].includes(c.inferredType)
                );
                const altOrFilters = searchName ? altTextCols.map((col: any) => ({
                  column: col.columnName,
                  operator: 'fuzzy',
                  value: searchName,
                })) : [];

                const altExec = async (pFilters: any[], pOrFilters: any[]) => {
                  // Use fresh count aggregation with a column from the NEW schema
                  // (original aggregations may reference columns that don't exist in this dataset)
                  const altAgg = [{ column: altTextCols[0]?.columnName || altSchema[0]?.columnName || '*', function: 'count' as const }];
                  const { data: qr, error: qErr } = await supabaseClient.rpc('query_csv_dataset', {
                    p_dataset_id: largerDs.id,
                    p_tenant_id: tenantId,
                    p_filters: pFilters,
                    p_or_filters: pOrFilters,
                    p_aggregations: altAgg,
                    p_group_by: null,
                    p_order_by: null,
                    p_order_dir: 'asc',
                    p_limit: args.limit || 50,
                  });
                  if (qErr) throw new Error(qErr.message);
                  return qr;
                };

                try {
                  const altResult = await altExec([], altOrFilters);
                  if ((altResult?.total_matches || 0) > (queryResult?.total_matches || 0)) {
                    queryResult = altResult;
                    datasetId = largerDs.id;
                    datasetFilename = largerDs.filename;
                    datasetSchema = altSchema;
                    schemaDescription = largerDs.schema_description || '';
                    retryNote = ' (auto-switched to detailed dataset)';
                    console.log(`[QUERY_CSV_TOOL] Auto-escalation found ${altResult.total_matches} results in detailed dataset`);
                  }
                } catch (altErr: any) {
                  console.warn(`[QUERY_CSV_TOOL] Auto-escalation failed:`, altErr.message);
                }
              }
            }
          }
        } catch (err: any) {
          return { success: false, result: null, error: `CSV query failed: ${err.message}` };
        }

        // ── 5. Format result ─────────────────────────────────────────────
        const totalMatches = queryResult?.total_matches || 0;
        const rows = (queryResult?.filtered_rows || []).slice(0, args.limit || 50);
        const aggs = queryResult?.aggregations || {};
        const groups = queryResult?.groups || {};

        // Build formattedAggs with COMPUTED labels
        const formattedAggs: Record<string, string> = {};
        for (const [key, val] of Object.entries(aggs)) {
          const prettyKey = key
            .replace(/^(sum|avg|min|max|count|count_distinct)_/, (_, fn) => `${fn.toUpperCase()}: `)
            .replace(/__n$/, '');
          formattedAggs[prettyKey] = `${val} [COMPUTED — not estimated]`;
        }

        // Strip __n columns from display rows (keep originals for readability)
        const displayRows = rows.map((row: any) => {
          const clean: Record<string, any> = {};
          for (const [k, v] of Object.entries(row)) {
            if (!k.endsWith('__n')) clean[k] = v;
          }
          return clean;
        });

        // Build available columns hint for empty results
        const columnsHint = totalMatches === 0
          ? `\nAvailable columns: ${(datasetSchema as any[]).map((c: any) => `${c.columnName} (${c.inferredType})`).join(', ')}`
          : '';

        return {
          success: true,
          result: {
            dataset: datasetFilename,
            dataset_id: datasetId,
            columns: (datasetSchema as any[]).map((c: any) => c.columnName),
            schema_description: schemaDescription,
            total_matches: totalMatches,
            aggregations: formattedAggs,
            groups,
            rows: displayRows,
            message: totalMatches > 0
              ? `Found ${totalMatches} row(s) in ${datasetFilename}${retryNote}.`
              : `No matching rows found in ${datasetFilename}. Try broadening your search or using fuzzy matching.${columnsHint}`,
          }
        };
      }
      case 'get_document_images':
      case 'get_case_images':
      case 'get_images': {
        // UNIFIED IMAGE TOOL — queries vault_assets where asset_type='image'
        // Handles both standalone uploads AND images extracted from documents.
        // MATTER ISOLATION: Server-side caseId takes priority over LLM args
        let caseId = context.caseId || args.case_id;
        if (!caseId && args.case_name) {
          const { data: c } = await supabaseClient.from('cases').select('id').eq('tenant_id', tenantId).ilike('name', `%${args.case_name}%`).limit(1).maybeSingle();
          if (c) caseId = c.id;
        }

        // If a specific parent document is requested, find its ID
        let parentAssetId = args.file_id || null;
        if (!parentAssetId && args.document_name) {
          let q = supabaseClient.from('document_processing').select('asset_id, has_images, image_count, vault_assets!inner(id, filename)').eq('has_images', true).eq('vault_assets.tenant_id', tenantId);
          if (caseId) q = q.eq('vault_assets.case_id', caseId);
          q = q.ilike('vault_assets.filename', `%${args.document_name}%`);
          const { data: dpFiles } = await q.limit(1);
          if (dpFiles && dpFiles.length > 0) parentAssetId = dpFiles[0].asset_id;
        }

        const limit = args.limit || 10;
        let query = supabaseClient
          .from('vault_assets')
          .select('id, filename, filetype, storage_path, asset_type, parent_asset_id, source_page, image_index, classification, confidence_score, ocr_text, vision_summary, thumbnail_url, normalized_url, linked_case_id, match_score, link_status, created_at')
          .eq('tenant_id', tenantId)
          .eq('asset_type', 'image')
          .order('created_at', { ascending: false })
          .limit(limit);

        if (caseId) query = query.eq('case_id', caseId);
        if (parentAssetId) query = query.eq('parent_asset_id', parentAssetId);

        const { data: imageAssets, error } = await query;
        if (error) throw error;
        if (!imageAssets || imageAssets.length === 0) {
          return { success: true, result: { images: [], count: 0, message: parentAssetId ? 'No images found in this document.' : caseId ? 'No images found in this case.' : 'No images found.' } };
        }

        // Get surrounding text for extracted images (from parent document chunks)
        const extractedPageNumbers = [...new Set(imageAssets.filter((img: any) => img.parent_asset_id && img.source_page).map((img: any) => img.source_page))];
        const chunksByPage: Record<string, Record<number, string>> = {};
        if (extractedPageNumbers.length > 0) {
          const parentIdSet = new Set<string>();
          imageAssets.filter((img: any) => img.parent_asset_id).forEach((img: any) => parentIdSet.add(String(img.parent_asset_id)));
          const parentIds = Array.from(parentIdSet);
          for (const pid of parentIds) {
            const { data: chunks } = await supabaseClient.from('document_chunks').select('content, metadata').eq('file_id', pid).limit(50);
            if (chunks) {
              chunksByPage[pid] = {};
              for (const chunk of chunks) {
                const meta = chunk.metadata || {};
                const pn: number = meta.page_number || meta.page;
                if (pn) {
                  chunksByPage[pid][pn] = ((chunksByPage[pid][pn] || '') + ' ' + chunk.content.substring(0, 300));
                }
              }
            }
          }
        }

        // Look up parent document names
        const parentIds = [...new Set(imageAssets.filter((img: any) => img.parent_asset_id).map((img: any) => img.parent_asset_id))];
        const parentNames: Record<string, string> = {};
        if (parentIds.length > 0) {
          const { data: parents } = await supabaseClient.from('vault_assets').select('id, filename').in('id', parentIds);
          if (parents) for (const p of parents) parentNames[p.id] = p.filename;
        }

        const imagesWithUrls = [];
        for (const img of imageAssets) {
          // Use normalized or thumbnail URL if available, else fall back to storage_path
          const urlPath = img.normalized_url || img.thumbnail_url || img.storage_path;
          let signedUrl = null;
          if (urlPath) {
            const { data: signedData } = await supabaseClient.storage.from('documents').createSignedUrl(urlPath, 3600);
            signedUrl = signedData?.signedUrl || null;
          }
          imagesWithUrls.push({
            id: img.id,
            filename: img.filename,
            classification: img.classification,
            confidence: img.confidence_score,
            ocr_text: img.ocr_text,
            summary: img.vision_summary,
            url: signedUrl,
            link_status: img.link_status,
            source: img.parent_asset_id ? 'extracted' : 'uploaded',
            parent_document: img.parent_asset_id ? (parentNames[img.parent_asset_id] || img.parent_asset_id) : null,
            page: img.source_page,
            surrounding_text: (img.parent_asset_id && img.source_page && chunksByPage[img.parent_asset_id]) ? (chunksByPage[img.parent_asset_id][img.source_page] || '').substring(0, 500) : null,
            created_at: img.created_at
          });
        }
        return { success: true, result: { images: imagesWithUrls, count: imagesWithUrls.length, analyze_with_vision: true, message: `Found ${imagesWithUrls.length} image(s).` } };
      }

      // ── Legal Analysis Tool Handlers (Phase 3) ──

      case 'create_legal_document': {
        const { title, document_type, content: docContent, jurisdiction, court } = args;
        if (!title || !document_type || !docContent) {
          return { success: false, result: null, error: 'title, document_type, and content are required' };
        }
        // Insert into artifacts table
        const { data: artifact, error: insertErr } = await context.supabaseClient
          .from('artifacts')
          .insert({
            tenant_id: context.tenantId,
            user_id: context.userId,
            case_id: context.caseId || null,
            title,
            document_type,
            content: docContent,
            metadata: { jurisdiction: jurisdiction || null, court: court || null },
          })
          .select('id, title, document_type, created_at')
          .single();
        if (insertErr) {
          console.error('Artifact insert error:', insertErr);
          return { success: false, result: null, error: `Failed to create document: ${insertErr.message}` };
        }
        return { success: true, result: { artifact_id: artifact.id, title: artifact.title, document_type: artifact.document_type, created_at: artifact.created_at, message: `Created "${title}" (${document_type}). The user can download it as Word or PDF.` } };
      }

      case 'search_case_law': {
        const query = args.query || '';
        const limit = Math.min(args.limit || 10, 20);
        // Generate embedding for semantic search
        const embResp = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${context.openaiApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'text-embedding-3-small', input: `case law: ${query}` }),
        });
        const embData = await embResp.json();
        const queryEmb = embData?.data?.[0]?.embedding;
        if (!queryEmb) return { success: false, result: null, error: 'Failed to generate search embedding' };

        let rpcParams: Record<string, any> = {
          query_embedding: queryEmb,
          match_count: limit,
          p_tenant_id: context.tenantId,
        };
        if (context.caseId) rpcParams.p_case_id = context.caseId;
        if (context.fileIds?.length) rpcParams.p_file_ids = context.fileIds;

        const { data: chunks, error: searchErr } = await context.supabaseClient.rpc('match_document_chunks', rpcParams);
        if (searchErr) return { success: false, result: null, error: searchErr.message };

        // Filter for case law relevance with keyword boosting
        const caseKeywords = /\bv\.?\s|court|judge|held|ruling|opinion|precedent|plaintiff|defendant|appellant|appellee|statute|§/i;
        const results = (chunks || [])
          .map((c: any) => ({ ...c, case_law_boost: caseKeywords.test(c.content) ? 0.1 : 0 }))
          .sort((a: any, b: any) => (b.similarity + b.case_law_boost) - (a.similarity + a.case_law_boost))
          .slice(0, limit)
          .map((c: any) => ({ content: c.content?.substring(0, 1500), filename: c.filename, similarity: +(c.similarity + c.case_law_boost).toFixed(3), page: c.page_number }));
        return { success: true, result: { cases: results, count: results.length, message: `Found ${results.length} case law reference(s).` } };
      }

      case 'retrieve_statute': {
        const query = args.query || '';
        const limit = Math.min(args.limit || 5, 15);
        const embResp = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${context.openaiApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'text-embedding-3-small', input: `statute regulation: ${query}` }),
        });
        const embData = await embResp.json();
        const queryEmb = embData?.data?.[0]?.embedding;
        if (!queryEmb) return { success: false, result: null, error: 'Failed to generate search embedding' };

        let rpcParams: Record<string, any> = {
          query_embedding: queryEmb,
          match_count: limit,
          p_tenant_id: context.tenantId,
        };
        if (context.caseId) rpcParams.p_case_id = context.caseId;
        if (context.fileIds?.length) rpcParams.p_file_ids = context.fileIds;

        const { data: chunks, error: searchErr } = await context.supabaseClient.rpc('match_document_chunks', rpcParams);
        if (searchErr) return { success: false, result: null, error: searchErr.message };

        const statuteKeywords = /§|section|subsection|chapter|title|u\.s\.c|cfr|statute|act of|public law|regulation/i;
        const results = (chunks || [])
          .map((c: any) => ({ ...c, statute_boost: statuteKeywords.test(c.content) ? 0.1 : 0 }))
          .sort((a: any, b: any) => (b.similarity + b.statute_boost) - (a.similarity + a.statute_boost))
          .slice(0, limit)
          .map((c: any) => ({ content: c.content?.substring(0, 2000), filename: c.filename, similarity: +(c.similarity + c.statute_boost).toFixed(3), page: c.page_number }));
        return { success: true, result: { statutes: results, count: results.length, message: `Found ${results.length} statutory provision(s).` } };
      }

      case 'extract_contract_clauses': {
        const clauseType = args.clause_type || 'general';
        // Try structured clause data first (matter_clauses table)
        if (context.caseId) {
          const { data: clauses } = await context.supabaseClient
            .from('matter_clauses')
            .select('*')
            .eq('tenant_id', context.tenantId)
            .eq('case_id', context.caseId)
            .ilike('clause_type', `%${clauseType}%`)
            .limit(10);
          if (clauses && clauses.length > 0) {
            return { success: true, result: { clauses: clauses.map((c: any) => ({ clause_type: c.clause_type, content: c.content?.substring(0, 2000), document: c.source_filename, page: c.page_number, risk_level: c.risk_level })), count: clauses.length, source: 'structured', message: `Found ${clauses.length} ${clauseType} clause(s) from structured data.` } };
          }
        }
        // Fallback to RAG search
        const embResp = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${context.openaiApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'text-embedding-3-small', input: `${clauseType} clause provision` }),
        });
        const embData = await embResp.json();
        const queryEmb = embData?.data?.[0]?.embedding;
        if (!queryEmb) return { success: false, result: null, error: 'Failed to generate search embedding' };

        let rpcParams: Record<string, any> = { query_embedding: queryEmb, match_count: 10, p_tenant_id: context.tenantId };
        if (context.caseId) rpcParams.p_case_id = context.caseId;
        if (context.fileIds?.length) rpcParams.p_file_ids = context.fileIds;

        const { data: chunks } = await context.supabaseClient.rpc('match_document_chunks', rpcParams);
        const clauseKeywords = new RegExp(clauseType.replace(/_/g, '[\\s_-]'), 'i');
        const results = (chunks || [])
          .filter((c: any) => c.similarity > 0.3 || clauseKeywords.test(c.content))
          .slice(0, 8)
          .map((c: any) => ({ content: c.content?.substring(0, 2000), filename: c.filename, similarity: +c.similarity.toFixed(3), page: c.page_number }));
        return { success: true, result: { clauses: results, count: results.length, source: 'document_search', message: `Found ${results.length} clause excerpt(s) via document search.` } };
      }

      case 'compare_documents': {
        const query = args.query || '';
        const limit = Math.min(args.limit || 5, 10);
        const embResp = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${context.openaiApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'text-embedding-3-small', input: query }),
        });
        const embData = await embResp.json();
        const queryEmb = embData?.data?.[0]?.embedding;
        if (!queryEmb) return { success: false, result: null, error: 'Failed to generate search embedding' };

        let rpcParams: Record<string, any> = { query_embedding: queryEmb, match_count: limit * 3, p_tenant_id: context.tenantId };
        if (context.caseId) rpcParams.p_case_id = context.caseId;
        if (context.fileIds?.length) rpcParams.p_file_ids = context.fileIds;

        const { data: chunks } = await context.supabaseClient.rpc('match_document_chunks', rpcParams);
        // Group results by document for comparison
        const grouped: Record<string, any[]> = {};
        for (const c of (chunks || [])) {
          const key = c.filename || c.asset_id || 'unknown';
          if (!grouped[key]) grouped[key] = [];
          if (grouped[key].length < limit) {
            grouped[key].push({ content: c.content?.substring(0, 1500), similarity: +c.similarity.toFixed(3), page: c.page_number });
          }
        }
        const documentNames = args.document_names as string[] | undefined;
        const filteredGroups = documentNames?.length
          ? Object.fromEntries(Object.entries(grouped).filter(([k]) => documentNames.some(n => k.toLowerCase().includes(n.toLowerCase()))))
          : grouped;
        return { success: true, result: { documents: filteredGroups, document_count: Object.keys(filteredGroups).length, message: `Compared content across ${Object.keys(filteredGroups).length} document(s).` } };
      }

      default:
        return { success: false, result: null, error: `Unknown tool: ${toolName}` };
    }
  } catch (error: any) {
    console.error(`Tool error (${toolName}):`, error);
    return { success: false, result: null, error: error.message || 'Tool execution failed.' };
  }
}

// ============================================================================
// 6b. STRUCTURED DATA RETRIEVAL — Query matter intelligence tables
// ============================================================================

interface StructuredDataResult {
  content: string;
  dataPoints: number;
  intentsResolved: string[];
}

async function retrieveStructuredData(
  classification: QueryClassification,
  tenantId: string,
  caseId: string | undefined,
  supabaseClient: any,
): Promise<StructuredDataResult> {
  if (!classification.requires_structured_data || classification.structured_intents.length === 0) {
    return { content: '', dataPoints: 0, intentsResolved: [] };
  }
  // CSV intents work tenant-wide. Other structured intents (entity_lookup,
  // obligation_search, etc.) require a case_id.
  const hasCsvIntents = classification.structured_intents.some(
    si => si.type === 'csv_query' || si.type === 'csv_summary'
  );
  if (!caseId && !hasCsvIntents) {
    return { content: '', dataPoints: 0, intentsResolved: [] };
  }

  const sections: string[] = [];
  let totalDataPoints = 0;
  const resolved: string[] = [];

  for (const intent of classification.structured_intents) {
    try {
      // Non-CSV intents (entity_lookup, obligation_search, etc.) require a case_id
      const isCsvIntent = intent.type === 'csv_query' || intent.type === 'csv_summary';
      if (!caseId && !isCsvIntent) continue;

      let result = '';
      switch (intent.type) {
        case 'entity_lookup': {
          // First try canonical_entities (supervisor-validated, deduplicated)
          // Prefer verified entities (auto_verified, user_verified) for quality
          let ceQuery = supabaseClient
            .from('canonical_entities')
            .select('canonical_name, entity_type, aliases, confidence, mention_count, verification_status')
            .eq('case_id', caseId)
            .eq('tenant_id', tenantId)
            .in('verification_status', ['auto_verified', 'user_verified', 'unverified'])
            .order('verification_status', { ascending: true }) // verified first
            .order('mention_count', { ascending: false })
            .limit(25);

          if (intent.params.entity_type) {
            ceQuery = ceQuery.eq('entity_type', intent.params.entity_type);
          }
          if (intent.params.name) {
            ceQuery = ceQuery.ilike('canonical_name', `%${intent.params.name}%`);
          }

          const { data: canonData, error: canonError } = await ceQuery;

          if (!canonError && canonData?.length > 0) {
            result = `**Entities Found (${canonData.length}, supervisor-validated):**\n`;
            result += canonData.map((e: any) =>
              `- ${e.canonical_name} (${e.entity_type}) — ${e.mention_count} mentions, confidence: ${(e.confidence * 100).toFixed(0)}%, status: ${e.verification_status}${e.aliases?.length > 0 ? '\n  Aliases: ' + e.aliases.join(', ') : ''}`
            ).join('\n');
            totalDataPoints += canonData.length;
          } else {
            // Fallback to raw matter_entities if canonical not available
            let query = supabaseClient
              .from('matter_entities')
              .select('entity_value, entity_type, normalized_value, context_snippet, confidence')
              .eq('case_id', caseId)
              .eq('tenant_id', tenantId)
              .order('confidence', { ascending: false })
              .limit(20);

            if (intent.params.entity_type) {
              query = query.eq('entity_type', intent.params.entity_type);
            }
            if (intent.params.name) {
              query = query.ilike('entity_value', `%${intent.params.name}%`);
            }

            const { data, error } = await query;
            if (!error && data?.length > 0) {
              result = `**Entities Found (${data.length}):**\n`;
              result += data.map((e: any) =>
                `- ${e.normalized_value || e.entity_value} (${e.entity_type}) — confidence: ${(e.confidence * 100).toFixed(0)}%${e.context_snippet ? '\n  Context: "' + e.context_snippet.substring(0, 150) + '..."' : ''}`
              ).join('\n');
              totalDataPoints += data.length;
            }
          }
          break;
        }

        case 'obligation_tracking': {
          let query = supabaseClient
            .from('matter_obligations')
            .select('obligation_text, obligation_type, obligor, obligee, due_date, status, recurring, condition, confidence')
            .eq('case_id', caseId)
            .eq('tenant_id', tenantId)
            .order('due_date', { ascending: true, nullsFirst: false })
            .limit(20);

          if (intent.params.status) {
            query = query.eq('status', intent.params.status);
          }
          if (intent.params.responsible_party) {
            query = query.ilike('obligor', `%${intent.params.responsible_party}%`);
          }

          const { data, error } = await query;
          if (!error && data?.length > 0) {
            const now = new Date().toISOString();
            const overdue = data.filter((o: any) => o.due_date && o.due_date < now && o.status !== 'fulfilled');
            const pending = data.filter((o: any) => !overdue.includes(o));
            result = `**Obligations (${data.length}${overdue.length > 0 ? `, ⚠ ${overdue.length} overdue` : ''}):**\n`;
            
            // Format each obligation with a clear plain-language summary
            const formatObligation = (o: any, isOverdue: boolean) => {
              const dateStr = o.due_date?.split('T')[0] || 'No date';
              const overdueTag = isOverdue ? ' ⚠ OVERDUE' : '';
              let line = `- **${o.obligation_type || 'Obligation'}**${overdueTag} — Due: ${dateStr}\n`;
              line += `  What: ${o.obligation_text}\n`;
              if (o.obligor) line += `  Who must act: ${o.obligor}\n`;
              if (o.obligee) line += `  For whom: ${o.obligee}\n`;
              if (o.condition) line += `  Trigger/Condition: ${o.condition}\n`;
              line += `  Status: ${o.status || 'pending'}${o.recurring ? ' (recurring)' : ''}`;
              return line;
            };
            
            if (overdue.length > 0) {
              result += `\n**⚠ Overdue:**\n`;
              result += overdue.map((o: any) => formatObligation(o, true)).join('\n');
            }
            if (pending.length > 0) {
              if (overdue.length > 0) result += `\n\n**Pending/Upcoming:**\n`;
              result += pending.map((o: any) => formatObligation(o, false)).join('\n');
            }
            totalDataPoints += data.length;
          }
          break;
        }

        case 'date_tracking': {
          let query = supabaseClient
            .from('matter_dates')
            .select('date_value, date_type, description, is_recurring, confidence, source_file_id')
            .eq('case_id', caseId)
            .eq('tenant_id', tenantId)
            .order('date_value', { ascending: true })
            .limit(20);

          if (intent.params.date_type) {
            query = query.eq('date_type', intent.params.date_type);
          }
          if (intent.params.upcoming_only === 'true') {
            query = query.gte('date_value', new Date().toISOString());
          }

          const { data, error } = await query;
          if (!error && data?.length > 0) {
            result = `**Key Dates (${data.length}):**\n`;
            result += data.map((d: any) =>
              `- ${d.date_value?.split('T')[0] || 'Unknown'} — ${d.date_type}: ${d.description}${d.is_recurring ? ' (recurring)' : ''}`
            ).join('\n');
            totalDataPoints += data.length;
          }
          break;
        }

        case 'risk_assessment': {
          let query = supabaseClient
            .from('matter_risks')
            .select('risk_type, risk_description, severity, recommendation, confidence, clause_id')
            .eq('case_id', caseId)
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false })
            .limit(15);

          if (intent.params.severity) {
            query = query.eq('severity', intent.params.severity);
          }
          if (intent.params.category) {
            query = query.eq('risk_type', intent.params.category);
          }

          const { data, error } = await query;
          if (!error && data?.length > 0) {
            const bySeverity: Record<string, number> = {};
            data.forEach((r: any) => { bySeverity[r.severity] = (bySeverity[r.severity] || 0) + 1; });
            result = `**Risks Identified (${data.length}) — ${Object.entries(bySeverity).map(([k, v]) => `${k}: ${v}`).join(', ')}:**\n`;
            result += data.map((r: any) =>
              `- **[${r.severity?.toUpperCase()}] ${r.risk_type || 'Risk'}**\n  Issue: ${r.risk_description}${r.recommendation ? '\n  Recommended Action: ' + r.recommendation : ''}`
            ).join('\n');
            totalDataPoints += data.length;
          }
          break;
        }

        case 'clause_analysis': {
          let query = supabaseClient
            .from('matter_clauses')
            .select('clause_type, clause_text, risk_level, risk_reason, summary, section_ref, confidence')
            .eq('case_id', caseId)
            .eq('tenant_id', tenantId)
            .order('created_at', { ascending: false })
            .limit(10);

          if (intent.params.clause_type) {
            query = query.eq('clause_type', intent.params.clause_type);
          }

          const { data, error } = await query;
          if (!error && data?.length > 0) {
            result = `**Clauses Found (${data.length}):**\n`;
            result += data.map((c: any) =>
              `- **${c.clause_type}** [Risk: ${c.risk_level || 'unknown'}]${c.section_ref ? ' (Ref: ' + c.section_ref + ')' : ''}\n  Summary: ${c.summary || 'N/A'}${c.risk_reason ? '\n  Risk reason: ' + c.risk_reason : ''}${c.clause_text && c.clause_text.length > 200 ? '\n  Full text: "' + c.clause_text.substring(0, 200) + '..."' : c.clause_text ? '\n  Full text: "' + c.clause_text + '"' : ''}`
            ).join('\n\n');
            totalDataPoints += data.length;
          }
          break;
        }

        case 'timeline': {
          // Fetch both dates and obligations with dates, merge into timeline
          const [datesRes, oblRes] = await Promise.all([
            supabaseClient
              .from('matter_dates')
              .select('date_value, date_type, description')
              .eq('case_id', caseId)
              .eq('tenant_id', tenantId)
              .order('date_value', { ascending: true }),
            supabaseClient
              .from('matter_obligations')
              .select('due_date, obligation_type, obligation_text, status')
              .eq('case_id', caseId)
              .eq('tenant_id', tenantId)
              .not('due_date', 'is', null)
              .order('due_date', { ascending: true }),
          ]);

          const timeline: { date: string; label: string }[] = [];
          (datesRes.data || []).forEach((d: any) => {
            timeline.push({ date: d.date_value, label: `[${d.date_type}] ${d.description}` });
          });
          (oblRes.data || []).forEach((o: any) => {
            timeline.push({ date: o.due_date, label: `[Obligation-${o.status}] ${o.obligation_text}` });
          });
          timeline.sort((a, b) => a.date.localeCompare(b.date));

          if (timeline.length > 0) {
            result = `**Timeline (${timeline.length} events):**\n`;
            result += timeline.map(t => `- ${t.date?.split('T')[0] || '?'}: ${t.label}`).join('\n');
            totalDataPoints += timeline.length;
          }
          break;
        }

        case 'cross_reference': {
          const { data, error } = await supabaseClient
            .from('matter_cross_references')
            .select('reference_type, source_file_id, target_file_id, description, confidence')
            .eq('case_id', caseId)
            .eq('tenant_id', tenantId)
            .order('confidence', { ascending: false })
            .limit(15);

          if (!error && data?.length > 0) {
            result = `**Cross-References (${data.length}):**\n`;
            result += data.map((cr: any) =>
              `- [${cr.reference_type}] ${cr.description} — confidence: ${(cr.confidence * 100).toFixed(0)}%`
            ).join('\n');
            totalDataPoints += data.length;
          }
          break;
        }

        case 'csv_query': {
          // ═══════════════════════════════════════════════════════════════
          // CSV pre-retrieval — LIGHTWEIGHT schema-only context
          // The actual query is handled by the query_csv tool at runtime.
          // Running the full RPC here is redundant and slow (30s+ for large
          // datasets with fuzzy matching). Instead, we inject schema info so
          // the LLM can construct accurate tool calls.
          // Supports tenant-wide when no caseId is provided.
          // ═══════════════════════════════════════════════════════════════
          let csvQ = supabaseClient
            .from('csv_datasets')
            .select('id, filename, schema, schema_description, row_count, column_count')
            .eq('tenant_id', tenantId);
          if (caseId) csvQ = csvQ.eq('case_id', caseId);
          const { data: csvDatasets, error: csvError } = await csvQ;

          if (!csvError && csvDatasets && csvDatasets.length > 0) {
            for (const ds of csvDatasets) {
              const schema = ds.schema as Array<{ columnName: string; inferredType: string }>;
              const schemaDesc = ds.schema_description || `Columns: ${schema.map((c: any) => `${c.columnName} (${c.inferredType})`).join(', ')}`;
              result += `**Dataset: ${ds.filename}** (${ds.row_count} rows × ${ds.column_count} cols, id: ${ds.id})\n`;
              result += `${schemaDesc}\n`;
              result += `→ Use the query_csv tool with dataset_id="${ds.id}" to filter/aggregate this data.\n\n`;
              totalDataPoints += 1;
            }
          } else {
            result += 'No CSV/Excel datasets found in this matter.\n';
            totalDataPoints += 1;
          }
          break;
        }

        case 'csv_summary': {
          // ═══════════════════════════════════════════════════════════════
          // CSV Summary — describe the structure and content of datasets
          // Supports tenant-wide when no caseId is provided.
          // ═══════════════════════════════════════════════════════════════
          let csvSumQ = supabaseClient
            .from('csv_datasets')
            .select('id, filename, schema, schema_description, summary, row_count, column_count, sheet_name')
            .eq('tenant_id', tenantId);
          if (caseId) csvSumQ = csvSumQ.eq('case_id', caseId);
          const { data: csvDatasets, error: csvError } = await csvSumQ;

          if (!csvError && csvDatasets && csvDatasets.length > 0) {
            const filenameHint = intent.params.filename_hint;

            // Filter by filename hint if provided
            let datasets = csvDatasets;
            if (filenameHint) {
              const filtered = csvDatasets.filter((d: any) =>
                d.filename.toLowerCase().includes(filenameHint.toLowerCase())
              );
              if (filtered.length > 0) datasets = filtered;
            }

            for (const ds of datasets) {
              const schema = ds.schema as Array<{
                columnName: string;
                inferredType: string;
                uniqueValues: number;
                nullCount: number;
                exampleValues?: string[];
              }>;
              const summary = ds.summary as any;

              result += `**📊 Dataset: ${ds.filename}${ds.sheet_name ? ` (Sheet: ${ds.sheet_name})` : ''}**\n`;
              result += `- **Size**: ${ds.row_count} rows × ${ds.column_count} columns\n`;
              if (summary.duplicateRows > 0) {
                result += `- **Duplicate Rows**: ${summary.duplicateRows}\n`;
              }

              result += `\n**Column Details:**\n`;
              for (const col of schema) {
                let line = `- **${col.columnName}** — type: ${col.inferredType}`;
                if (col.uniqueValues !== undefined) line += `, ${col.uniqueValues} unique values`;
                if (col.nullCount > 0) {
                  const pct = Math.round((col.nullCount / ds.row_count) * 100);
                  line += `, ${pct}% empty`;
                }
                result += line + '\n';

                // Show top values for categorical columns
                const stats = summary?.columnStats?.[col.columnName];
                if (stats?.topValues && col.inferredType === 'categorical' && stats.topValues.length > 0) {
                  const topVals = stats.topValues.slice(0, 5).map((tv: any) => `${tv.value} (${tv.count}×)`).join(', ');
                  result += `  Top values: ${topVals}\n`;
                }
                // Show numeric stats
                if (['integer', 'float', 'currency'].includes(col.inferredType) && stats) {
                  if (stats.mean !== undefined) {
                    result += `  Stats: mean=${stats.mean}, median=${stats.median}, min=${stats.min}, max=${stats.max}\n`;
                  }
                }
                // Show example values
                if (col.exampleValues && col.exampleValues.length > 0) {
                  result += `  Examples: ${col.exampleValues.slice(0, 3).join(', ')}\n`;
                }
              }

              result += '\n';
              totalDataPoints += schema.length + 1;
            }
          } else {
            result += 'No CSV/Excel datasets found in this matter.\n';
            totalDataPoints += 1;
          }
          break;
        }

        case 'matter_summary': {
          const { data, error } = await supabaseClient
            .from('matter_summaries')
            .select('summary_type, content, stale, generated_at')
            .eq('case_id', caseId)
            .eq('tenant_id', tenantId)
            .eq('summary_type', 'executive_brief')
            .limit(1)
            .maybeSingle();

          if (!error && data) {
            result = `**Matter Summary${data.stale ? ' (may be outdated — new documents were processed since last summary)' : ''}:**\n`;
            if (typeof data.content === 'object' && data.content) {
              // Content is a structured JSON object
              const content = data.content as Record<string, any>;
              if (content.executive_summary) result += content.executive_summary + '\n';
              if (content.key_findings && Array.isArray(content.key_findings)) {
                result += `\n**Key Findings:**\n${content.key_findings.map((f: string) => `- ${f}`).join('\n')}`;
              }
              if (content.risk_overview) {
                result += `\n\n**Risk Overview:** ${typeof content.risk_overview === 'string' ? content.risk_overview : JSON.stringify(content.risk_overview)}`;
              }
            } else {
              result += String(data.content || 'No summary content available.');
            }
            totalDataPoints += 1;
          }
          break;
        }
      }

      if (result) {
        sections.push(result);
        resolved.push(intent.type);
      }
    } catch (err) {
      console.error(`Structured intent ${intent.type} failed:`, err);
    }
  }

  const content = sections.length > 0
    ? `\n\n--- STRUCTURED MATTER INTELLIGENCE ---\n${sections.join('\n\n')}\n--- END STRUCTURED DATA ---\n`
    : '';

  console.log(`Structured data: ${totalDataPoints} data points from ${resolved.length} intents: [${resolved.join(', ')}]`);
  return { content, dataPoints: totalDataPoints, intentsResolved: resolved };
}

// ============================================================================
// 7. RAG EXECUTION ENGINE — Always-on document retrieval
// ============================================================================

interface RAGResult {
  contextContent: string;
  sourceChunks: DocumentChunk[];
  filesSearched: number;
}

async function executeRAG(
  classification: QueryClassification,
  rawMessage: string,
  tenantId: string,
  supabaseClient: any,
  openaiApiKey: string,
  fileIds?: string[],
  caseId?: string,
  encoder?: TextEncoder,
  controller?: ReadableStreamDefaultController
): Promise<RAGResult> {
  // Search ALL tasks except pure tool actions
  // Drafting tasks NEED document context for factual background
  // Names/entities classified as "general" should still get searched
  const searchableTasks = classification.tasks.filter(t => t.type !== 'tool');
  const hasMultipleTasks = searchableTasks.length > 1;

  // Build search queries: always include full message + individual task queries
  // For single-task queries, also use the classifier's optimized search query
  // (e.g., "DLA Piper franchise letter address" vs raw "address of dla piper")
  // Build and DEDUPLICATE search queries — avoid duplicate embeddings
  const rawQueries: Array<{ query: string; label: string }> = [];
  rawQueries.push({ query: rawMessage, label: 'Full query' });
  if (hasMultipleTasks) {
    for (const t of searchableTasks) rawQueries.push({ query: t.query, label: t.label });
  } else if (searchableTasks.length === 1 && searchableTasks[0].query !== rawMessage) {
    rawQueries.push({ query: searchableTasks[0].query, label: searchableTasks[0].label });
  }
  // Deduplicate by normalized query text
  const seen = new Set<string>();
  const dedupedQueries: typeof rawQueries = [];
  for (const rq of rawQueries) {
    const key = rq.query.trim().toLowerCase();
    if (!seen.has(key)) { seen.add(key); dedupedQueries.push(rq); }
  }
  const searchQueries = dedupedQueries.map(q => q.query);
  const searchLabels = dedupedQueries.map(q => q.label);

  console.log(`RAG: ${searchQueries.length} search queries, ${searchableTasks.length} searchable tasks`);

  // Emit state — tell the user how many parallel searches are running
  if (encoder && controller) {
    emitState(encoder, controller, 'vector_search_started', `${searchQueries.length} parallel searches`, true);
    for (const task of searchableTasks) {
      emitState(encoder, controller, 'vector_search_started', task.label, true);
    }
  }

  // Generate embeddings in parallel
  const embeddingPromises = searchQueries.map(q => generateQueryEmbedding(q, openaiApiKey));
  const embeddings = await Promise.all(embeddingPromises);
  const embeddingSuccessCount = embeddings.filter(Boolean).length;
  console.log(`Generated ${embeddingSuccessCount}/${searchQueries.length} embeddings`);
  if (embeddingSuccessCount === 0 && encoder && controller) {
    emitState(encoder, controller, 'rag_debug', `EMBEDDING FAILED: 0/${searchQueries.length} embeddings generated`);
  }

  // Run hybrid searches in parallel
  // In multi-query mode, use LOW threshold (0.15) and generous chunk count per query
  // so that every sub-query has a fair chance of finding results.
  // Single-query mode can afford higher threshold since it's the only search.
  const searchPromises = embeddings.map((embedding, idx) => {
    if (!embedding) return Promise.resolve({ data: null, error: { message: 'No embedding' } });
    const queryText = searchQueries[idx];
    const isFullMessage = idx === 0 && hasMultipleTasks; // First query is the raw message in multi mode
    const rpcParams: any = {
      query_embedding: embedding,
      query_text: queryText,
      p_tenant_id: tenantId,
      // Multi-query: 10 chunks per sub-query, 12 for full message; single: 20
      match_count: hasMultipleTasks ? (isFullMessage ? 12 : 10) : 20,
      // Always use low threshold — let the LLM decide relevance, not the vector DB
      similarity_threshold: 0.15,
    };
    if (fileIds && fileIds.length > 0) rpcParams.p_file_ids = fileIds;
    if (caseId) rpcParams.p_case_id = caseId;
    return supabaseClient.rpc('match_documents_hybrid', rpcParams);
  });

  const searchResults = await Promise.all(searchPromises);

  if (encoder && controller) {
    emitState(encoder, controller, 'vector_search_completed', undefined, true);
  }

  // Merge and deduplicate
  const allChunks = new Map<string, any>();
  const taskChunkGroups: Map<string, any[]> = new Map();

  searchResults.forEach((result, idx) => {
    const taskLabel = searchLabels[idx] || `Search ${idx + 1}`;
    if (result.error) {
      console.error(`RAG search ${idx + 1} error:`, result.error);
      if (encoder && controller) {
        emitState(encoder, controller, 'rag_debug', `SEARCH ERROR ${idx + 1}: ${result.error.message || JSON.stringify(result.error)}`);
      }
      return;
    }
    const chunks = result.data || [];
    console.log(`Search "${searchQueries[idx].substring(0, 40)}..." returned ${chunks.length} chunks`);
    if (encoder && controller) {
      emitState(encoder, controller, 'rag_debug', `Search ${idx + 1} returned ${chunks.length} chunks for tenant ${tenantId}`);
    }
    const taskChunks: any[] = [];
    for (const chunk of chunks) {
      const chunkId = String(chunk.id);
      if (!allChunks.has(chunkId)) { allChunks.set(chunkId, chunk); taskChunks.push(chunk); }
      else {
        const existing = allChunks.get(chunkId);
        if ((chunk.combined_score || chunk.similarity || 0) > (existing.combined_score || existing.similarity || 0)) allChunks.set(chunkId, chunk);
        taskChunks.push(chunk);
      }
    }
    taskChunkGroups.set(taskLabel, taskChunks);
  });

  // Build context
  const totalChunks = Array.from(allChunks.values());
  if (totalChunks.length === 0) {
    console.log('No relevant chunks found');
    if (encoder && controller) {
      emitState(encoder, controller, 'rag_debug', `NO CHUNKS: tenant=${tenantId}, queries=${searchQueries.length}, embeddings=${embeddingSuccessCount}`);
    }
    return { contextContent: '', sourceChunks: [], filesSearched: 0 };
  }

  const sourceChunks = totalChunks
    .sort((a, b) => (b.combined_score || b.similarity || 0) - (a.combined_score || a.similarity || 0))
    .slice(0, hasMultipleTasks ? 30 : 20)
    .filter(c => (c.combined_score || c.similarity || 0) >= 0.20); // Match search_documents tool threshold (20%+)

  const uniqueFiles = new Set<string>();
  let contextContent = '';

  if (hasMultipleTasks && taskChunkGroups.size > 1) {
    contextContent = "RELEVANT DOCUMENT EXCERPTS (organized by query topic):\n\n";
    for (const [taskLabel, chunks] of taskChunkGroups) {
      if (chunks.length === 0) continue;
      contextContent += `=== CONTEXT FOR: ${taskLabel} ===\n\n`;
      for (const chunk of chunks.slice(0, 6)) {
        const filename = chunk.metadata?.filename || 'Unknown Document';
        uniqueFiles.add(filename);
        const score = chunk.combined_score || chunk.similarity || 0;
        let header = `--- From: ${filename}`;
        if (chunk.metadata?.document_type) header += ` (${chunk.metadata.document_type})`;
        if (chunk.metadata?.year) header += ` [${chunk.metadata.year}]`;
        if (chunk.metadata?.chunk_index !== undefined) header += ` [Part ${chunk.metadata.chunk_index + 1}]`;
        if (chunk.metadata?.page_number) header += ` [Page ${chunk.metadata.page_number}]`;
        header += ` | Relevance: ${(score * 100).toFixed(1)}%`;
        if (chunk.exact_match_score && chunk.exact_match_score > 0) header += ' EXACT MATCH';
        header += ' ---\n';
        contextContent += header;
        if (chunk.metadata?.sections_referenced?.length > 0) contextContent += `Sections: ${chunk.metadata.sections_referenced.join(', ')}\n`;
        const emails = chunk.metadata?.chunk_emails || chunk.metadata?.emails_mentioned;
        const names = chunk.metadata?.chunk_names || chunk.metadata?.names_mentioned;
        if (emails?.length > 0) contextContent += `Emails found: ${emails.join(', ')}\n`;
        if (names?.length > 0) contextContent += `Names found: ${names.join(', ')}\n`;
        contextContent += `${chunk.content}\n\n`;
      }
    }
  } else {
    contextContent = "RELEVANT DOCUMENT EXCERPTS:\n\n";
    for (const chunk of sourceChunks) {
      const filename = chunk.metadata?.filename || 'Unknown Document';
      uniqueFiles.add(filename);
      const score = chunk.combined_score || chunk.similarity || 0;
      let header = `--- From: ${filename}`;
      if (chunk.metadata?.document_type) header += ` (${chunk.metadata.document_type})`;
      if (chunk.metadata?.year) header += ` [${chunk.metadata.year}]`;
      if (chunk.metadata?.chunk_index !== undefined) header += ` [Part ${chunk.metadata.chunk_index + 1}]`;
      if (chunk.metadata?.page_number) header += ` [Page ${chunk.metadata.page_number}]`;
      header += ` | Relevance: ${(score * 100).toFixed(1)}%`;
      if (chunk.exact_match_score && chunk.exact_match_score > 0) header += ' EXACT MATCH';
      header += ' ---\n';
      contextContent += header;
      if (chunk.metadata?.sections_referenced?.length > 0) contextContent += `Sections: ${chunk.metadata.sections_referenced.join(', ')}\n`;
      const emails = chunk.metadata?.chunk_emails || chunk.metadata?.emails_mentioned;
      const names = chunk.metadata?.chunk_names || chunk.metadata?.names_mentioned;
      if (emails?.length > 0) contextContent += `Emails found: ${emails.join(', ')}\n`;
      if (names?.length > 0) contextContent += `Names found: ${names.join(', ')}\n`;
      contextContent += `${chunk.content}\n\n`;
    }
  }

  console.log(`Context: ${uniqueFiles.size} files, ${sourceChunks.length} chunks, ${contextContent.length} chars`);
  return { contextContent, sourceChunks, filesSearched: uniqueFiles.size };
}

// buildSystemPrompt → imported from ./prompts/system.ts

// ============================================================================
// 10. TOOL GATEWAY — Deterministic policy engine for tool access control
// ============================================================================

/**
 * Evaluates whether a requested tool call should be allowed.
 * This is PURE DETERMINISTIC CODE — no LLM calls.
 *
 * Policy rules:
 * - Workspace mutation tools (create_case, rename_case, create_folder, etc.) require user confirmation
 *   unless the user's message explicitly asked for the action.
 * - Document tools require case_id when a matter is active.
 * - Budget enforcement: deny if remaining budget is exhausted.
 * - Feature flags: deny if tool is disabled for tenant.
 */
const WORKSPACE_MUTATION_TOOLS = new Set([
  'create_case', 'create_folder', 'rename_case', 'update_case',
]);

const DOCUMENT_SCOPED_TOOLS = new Set([
  'search_documents', 'extract_contract_clauses', 'compare_documents',
  'get_images', 'search_case_law', 'retrieve_statute',
]);

function evaluateToolGateway(
  request: ToolRequest,
  gwContext: ToolGatewayContext,
  userMessage: string,
): ToolGatewayDecision {
  const { name, args } = request;

  // 1. Budget enforcement
  if (gwContext.budgetRemaining.tool_calls <= 0) {
    return { tool_name: name, allowed: false, reason: 'Tool call budget exhausted for this turn.' };
  }

  // 2. Feature flag check
  const toolFlag = gwContext.featureFlags[`tool_${name}`];
  if (toolFlag === 'disabled') {
    return { tool_name: name, allowed: false, reason: `Tool "${name}" is disabled for this tenant.` };
  }

  // 3. Workspace mutation tools — require explicit user intent or confirmation
  if (WORKSPACE_MUTATION_TOOLS.has(name)) {
    const explicitPatterns: Record<string, RegExp> = {
      create_case: /\b(create|new|add|make|open|start)\b.*\b(case|matter)\b/i,
      create_folder: /\b(create|new|add|make)\b.*\bfolder\b/i,
      rename_case: /\b(rename|change\s+name)\b.*\b(case|matter)\b/i,
      update_case: /\b(update|edit|change|modify)\b.*\b(case|matter)\b/i,
    };
    const pattern = explicitPatterns[name];
    const userExplicitlyAsked = pattern ? pattern.test(userMessage) : false;

    if (!userExplicitlyAsked) {
      return {
        tool_name: name,
        allowed: false,
        reason: 'Workspace mutation requires explicit user request or confirmation.',
        requires_confirmation: true,
        confirmation_prompt: request.reason || `Execute ${name}?`,
      };
    }
  }

  // 4. Document-scoped tools — warn if no matter is active (still allow for tenant-wide search)
  if (DOCUMENT_SCOPED_TOOLS.has(name) && !gwContext.matterId) {
    // Allow but note that results will be tenant-wide
    return {
      tool_name: name,
      allowed: true,
      reason: 'No active matter — searching tenant-wide.',
      modified_args: { ...args },
    };
  }

  // 5. Default: allow
  return { tool_name: name, allowed: true, reason: 'Policy check passed.' };
}

/**
 * Extracts a simple two-step nested folder intent:
 * "create folder A, then create folder B inside A"
 */
function extractNestedFolderIntent(userMessage: string): { parent: string; child: string } | null {
  if (!userMessage) return null;
  const text = userMessage.replace(/\s+/g, ' ').trim();
  const m = text.match(/create\s+(?:a\s+)?folder\s+(?:named\s+)?"?([^",]+?)"?\s*,?\s*then\s+create\s+(?:a\s+)?folder\s+(?:named\s+)?"?([^",]+?)"?\s+inside\s+"?([^".]+)"?/i);
  if (!m) return null;
  const parent = (m[1] || '').trim();
  const child = (m[2] || '').trim();
  const inside = (m[3] || '').trim();
  // Parent should match the explicit inside target.
  if (!parent || !child) return null;
  if (inside && parent.toLowerCase() !== inside.toLowerCase()) {
    return { parent: inside, child };
  }
  return { parent, child };
}

// ============================================================================
// 11. AUDIT LOGGING — agent_runs + agent_tasks (migration 021)
// ============================================================================

/**
 * Creates an agent_run record at the start of a request.
 * Returns the run ID for linking agent_tasks.
 */
async function createAgentRun(
  supabaseClient: any,
  run: AgentRunRecord,
): Promise<string | null> {
  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceKey || !supabaseUrl) return null;
    const serviceClient = createClient(supabaseUrl, serviceKey);
    const { data, error } = await serviceClient
      .from('agent_runs')
      .insert({
        tenant_id: run.tenant_id,
        session_id: run.session_id,
        case_id: run.case_id,
        user_id: run.user_id,
        status: run.status,
        user_query: run.user_query.substring(0, 2000),
        task_graph: run.task_graph,
        metadata: run.metadata,
      })
      .select('id')
      .single();
    if (error) { console.error('[AUDIT] Failed to create agent_run:', error.message); return null; }
    return data?.id || null;
  } catch (e) { console.error('[AUDIT] agent_run error:', e); return null; }
}

/**
 * Updates an agent_run record status and metadata.
 */
async function updateAgentRun(
  supabaseClient: any,
  runId: string,
  updates: { status?: string; metadata?: Record<string, any>; verification_report?: any; gate_decision?: string },
): Promise<void> {
  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceKey || !supabaseUrl) return;
    const serviceClient = createClient(supabaseUrl, serviceKey);
    await serviceClient.from('agent_runs')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', runId);
  } catch (e) { console.error('[AUDIT] update agent_run error:', e); }
}

/**
 * Logs a per-tool request/decision/execution record to agent_tasks.
 */
async function logAgentTask(
  supabaseClient: any,
  runId: string,
  tenantId: string,
  task: {
    tool_name: string;
    tool_args: Record<string, any>;
    gateway_decision: ToolGatewayDecision;
    execution_result?: { success: boolean; error?: string };
    round: number;
  },
): Promise<void> {
  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceKey || !supabaseUrl) return;
    const serviceClient = createClient(supabaseUrl, serviceKey);
    await serviceClient.from('agent_tasks').insert({
      run_id: runId,
      tenant_id: tenantId,
      task_type: 'tool_call',
      task_index: task.round,
      spec: {
        tool_name: task.tool_name,
        tool_args: task.tool_args,
        gateway_allowed: task.gateway_decision.allowed,
        gateway_reason: task.gateway_decision.reason,
      },
      status: task.execution_result
        ? (task.execution_result.success ? 'completed' : 'failed')
        : (task.gateway_decision.allowed ? 'queued' : 'skipped'),
      result: task.execution_result || null,
      error: task.execution_result?.error || null,
    });
  } catch (e) { console.error('[AUDIT] agent_task error:', e); }
}

// ============================================================================
// 12. PENDING ACTION — Check, create, consume, expire
// ============================================================================

const CONFIRMATION_PATTERN = /^(yes|yeah|yep|sure|ok|okay|do\s*it|go\s*ahead|proceed|please|confirm|approved?|absolutely|definitely|yup|uh\s*huh)\s*[.!]?\s*$/i;
const MODIFICATION_PATTERN = /\b(but|instead|change|modify|update|actually|use|only|with|without)\b/i;

/**
 * Checks for an active pending action on the session.
 * Automatically expires stale actions (past expires_at).
 */
async function checkPendingAction(
  supabaseClient: any,
  sessionId: string,
): Promise<PendingAction | null> {
  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceKey || !supabaseUrl) return null;
    const serviceClient = createClient(supabaseUrl, serviceKey);

    // Expire stale actions first
    await serviceClient
      .from('session_pending_actions')
      .update({ status: 'expired' })
      .eq('session_id', sessionId)
      .eq('status', 'active')
      .lt('expires_at', new Date().toISOString());

    // Fetch remaining active action (max 1 due to unique partial index)
    const { data, error } = await serviceClient
      .from('session_pending_actions')
      .select('*')
      .eq('session_id', sessionId)
      .eq('status', 'active')
      .single();

    if (error || !data) return null;
    return data as PendingAction;
  } catch (e) { console.error('[PENDING_ACTION] check error:', e); return null; }
}

/**
 * Creates a new pending action for a session.
 * Expires any existing active action first.
 */
async function createPendingAction(
  supabaseClient: any,
  sessionId: string,
  action: {
    action_type: PendingActionType;
    tool_name?: string;
    tool_args?: Record<string, any>;
    requires_confirmation?: boolean;
    user_prompt_summary?: string;
  },
): Promise<string | null> {
  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceKey || !supabaseUrl) return null;
    const serviceClient = createClient(supabaseUrl, serviceKey);

    // Expire any existing active action
    await serviceClient
      .from('session_pending_actions')
      .update({ status: 'expired' })
      .eq('session_id', sessionId)
      .eq('status', 'active');

    const { data, error } = await serviceClient
      .from('session_pending_actions')
      .insert({
        session_id: sessionId,
        action_type: action.action_type,
        tool_name: action.tool_name || null,
        tool_args: action.tool_args || null,
        requires_confirmation: action.requires_confirmation ?? true,
        user_prompt_summary: action.user_prompt_summary || null,
      })
      .select('id')
      .single();
    if (error) { console.error('[PENDING_ACTION] create error:', error.message); return null; }
    return data?.id || null;
  } catch (e) { console.error('[PENDING_ACTION] create error:', e); return null; }
}

/**
 * Marks a pending action as consumed (executed after user confirmation).
 */
async function consumePendingAction(supabaseClient: any, actionId: string): Promise<void> {
  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceKey || !supabaseUrl) return;
    const serviceClient = createClient(supabaseUrl, serviceKey);
    await serviceClient
      .from('session_pending_actions')
      .update({ status: 'consumed', consumed_at: new Date().toISOString() })
      .eq('id', actionId);
  } catch (e) { console.error('[PENDING_ACTION] consume error:', e); }
}

/**
 * Expires a pending action (topic change or explicit cancellation).
 */
async function expirePendingAction(supabaseClient: any, actionId: string): Promise<void> {
  try {
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    if (!serviceKey || !supabaseUrl) return;
    const serviceClient = createClient(supabaseUrl, serviceKey);
    await serviceClient
      .from('session_pending_actions')
      .update({ status: 'expired' })
      .eq('id', actionId);
  } catch (e) { console.error('[PENDING_ACTION] expire error:', e); }
}

// ============================================================================
// 13. PLAN PARSER — Extract AgentPlan from orchestrator output
// ============================================================================

/**
 * Extracts the AgentPlan JSON from the orchestrator's response text.
 * The plan is wrapped in <plan>...</plan> tags.
 * Returns null if no valid plan is found.
 */
function extractAgentPlan(responseText: string): AgentPlan | null {
  const planMatch = responseText.match(/<plan>\s*([\s\S]*?)\s*<\/plan>/);
  if (!planMatch) return null;

  try {
    const raw = JSON.parse(planMatch[1]);
    // Validate and normalize required fields
    return {
      intent: raw.intent || 'other',
      requires_retrieval: !!raw.requires_retrieval,
      requires_structured_data: !!raw.requires_structured_data,
      structured_intents: Array.isArray(raw.structured_intents) ? raw.structured_intents : [],
      doc_scope: raw.doc_scope || 'none',
      citations_required: raw.citations_required !== false,
      jurisdiction: raw.jurisdiction || { value: null, confidence: 0 },
      clarifying_questions: Array.isArray(raw.clarifying_questions) ? raw.clarifying_questions : [],
      tools_requested: Array.isArray(raw.tools_requested) ? raw.tools_requested : [],
      execution_budget: {
        max_tool_calls: Math.min(raw.execution_budget?.max_tool_calls || 4, 8),
        max_rounds: Math.min(raw.execution_budget?.max_rounds || 2, 3),
        max_docs: Math.min(raw.execution_budget?.max_docs || 10, 30),
      },
    };
  } catch (e) {
    console.error('[PLAN_PARSER] Failed to parse plan JSON:', e);
    return null;
  }
}

/**
 * Strips <plan>...</plan> tags from content before streaming to the user.
 */
function stripPlanFromContent(content: string): string {
  return content.replace(/<plan>[\s\S]*?<\/plan>\s*/g, '').trim();
}

// ============================================================================
// 13B. ORCHESTRATOR PLANNING — Replace classifier with agent-driven planning
// ============================================================================

/**
 * Bridge: converts AgentPlan → QueryClassification for downstream compatibility.
 * This lets the existing authority routing, retrieval, and prompt-building code
 * work unmodified while the orchestrator drives the planning.
 */
function planToClassification(plan: AgentPlan, userMessage: string): QueryClassification {
  const intentToTaskType: Record<string, AgentTaskType> = {
    research: 'legal_research',
    review: 'contract_review',
    draft: 'document_drafting',
    summarize: 'case_summary',
    export: 'document_export',
    workspace: 'workspace_management',
    qa: 'general_chat',
    compare: 'contract_review',
    other: 'general_chat',
  };

  const complexityMap: Record<string, 'simple' | 'multi_source' | 'analytical' | 'drafting'> = {
    research: 'analytical',
    review: 'analytical',
    draft: 'drafting',
    summarize: 'multi_source',
    compare: 'analytical',
    qa: 'simple',
    export: 'simple',
    workspace: 'simple',
    other: 'simple',
  };

  const modeMap: Record<string, HorizonMode | undefined> = {
    draft: 'drafting' as HorizonMode,
    summarize: 'summary' as HorizonMode,
    review: 'contract_review' as HorizonMode,
    research: 'legal_research' as HorizonMode,
    compare: 'multi_document' as HorizonMode,
  };

  const agentTaskType = intentToTaskType[plan.intent] || 'general_chat';
  const complexity = complexityMap[plan.intent] || 'simple';

  return {
    domain: plan.intent === 'other' ? 'non_legal' : 'legal',
    complexity,
    requires_reasoning: ['research', 'review', 'compare', 'draft'].includes(plan.intent),
    requires_planning: ['draft', 'research', 'compare'].includes(plan.intent),
    search_intent: plan.requires_retrieval,
    requires_structured_data: plan.requires_structured_data,
    structured_intents: plan.structured_intents || [],
    tasks: [{ query: userMessage, type: plan.intent === 'draft' ? 'drafting' : plan.intent === 'workspace' ? 'tool' : 'document', label: plan.intent }],
    suggested_mode: modeMap[plan.intent],
    agent_task_type: agentTaskType,
  };
}

/**
 * Orchestrator planning call — lightweight gpt-4o-mini call that produces an AgentPlan.
 * Replaces classifyQuery() as the primary intelligence routing mechanism.
 * The plan drives retrieval, authority routing, and tool access via the gateway.
 */
async function getOrchestratorPlan(
  userMessage: string,
  openaiApiKey: string,
  history: Array<{ role: string; content: string }>,
  context: {
    hasActiveMatter: boolean;
    hasCsvData: boolean;
    matterName?: string;
  },
): Promise<AgentPlan | null> {
  try {
    const planPrompt = buildOrchestratorPrompt({
      hasActiveMatter: context.hasActiveMatter,
      hasCsvData: context.hasCsvData,
      hasRAGContext: false,
      hasStructuredData: false,
      matterName: context.matterName,
    });

    const planMessages: Array<{ role: string; content: string }> = [
      { role: 'system', content: planPrompt + '\n\nIMPORTANT: Output ONLY the <plan> JSON block. No tool calls, no prose, no analysis. Just the plan.' },
    ];
    // Include last 3 history messages for context
    const recentHistory = (history || []).slice(-3);
    for (const msg of recentHistory) {
      planMessages.push({ role: msg.role === 'user' ? 'user' : 'assistant', content: msg.content.substring(0, 500) });
    }
    planMessages.push({ role: 'user', content: userMessage });

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: planMessages,
        temperature: 0,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      console.error('[ORCHESTRATOR] Planning call failed:', resp.status);
      return null;
    }
    const data = await resp.json();
    const content = data.choices?.[0]?.message?.content || '';
    let plan = extractAgentPlan(content);
    if (!plan) {
      // Second-chance planner: enforce JSON object output to avoid null-plan
      // fallthrough into legacy routing states.
      const fallbackResp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${openaiApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0,
          max_tokens: 600,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content: `${planPrompt}\n\nOutput ONLY a raw JSON object matching AgentPlan schema. No tags, no markdown.`,
            },
            { role: 'user', content: userMessage },
          ],
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (fallbackResp.ok) {
        const fallbackData = await fallbackResp.json();
        const fallbackContent = fallbackData.choices?.[0]?.message?.content || '{}';
        plan = extractAgentPlan(`<plan>${fallbackContent}</plan>`);
      }
    }

    if (plan) {
      console.log(`[ORCHESTRATOR] Plan extracted: intent=${plan.intent} retrieval=${plan.requires_retrieval} tools=${plan.tools_requested.length} questions=${plan.clarifying_questions.length}`);
      return plan;
    }
    console.warn('[ORCHESTRATOR] Failed to extract plan after primary + fallback planning calls');
    return null;
  } catch (e) {
    console.error('[ORCHESTRATOR] Planning error:', e);
    return null;
  }
}

// ============================================================================
// 14. HYBRID VERIFIER — Rule-based + LLM verification
// ============================================================================

/**
 * RiskScorer — deterministic assessment of response risk level.
 * HIGH risk triggers the LLM verifier.
 */
function scoreRisk(context: {
  intent: string;
  hasActiveMatter: boolean;
  citationsRequired: boolean;
  responseText: string;
}): RiskLevel {
  const { intent, hasActiveMatter, citationsRequired, responseText } = context;
  const legalAdvicePatterns = /\b(you should|you must|you are required to|we recommend|the court will|liability|damages|breach|negligence|indemnif|terminate|judgment)\b/i;
  const hasLegalAdvice = legalAdvicePatterns.test(responseText);

  // HIGH: legal advice in active-matter context with citations expected
  if (hasActiveMatter && citationsRequired && hasLegalAdvice) return 'HIGH';
  // HIGH: drafting or research with legal conclusions
  if ((intent === 'draft' || intent === 'research' || intent === 'review') && hasLegalAdvice) return 'HIGH';
  // MEDIUM: active matter with citations needed but no strong legal language
  if (hasActiveMatter && citationsRequired) return 'MEDIUM';
  // LOW: everything else
  return 'LOW';
}

/**
 * RuleVerifier — always runs. Checks citations, disclaimers, no hallucinated refs.
 */
function ruleVerify(context: {
  responseText: string;
  citationsRequired: boolean;
  retrievedDocNames: Set<string>;
  hasActiveMatter: boolean;
  intent: string;
}): VerifierResult {
  const { responseText, citationsRequired, retrievedDocNames, hasActiveMatter, intent } = context;
  const reasons: string[] = [];

  // 1. Citation presence check
  if (citationsRequired && hasActiveMatter) {
    const hasCitations = /\*\*Sources?:?\*\*|Per \*\*[^*]+\*\*|\(§\s*[\d.]+\)|cited in|according to.*\*\*/i.test(responseText);
    const hasAbsenceDisclaimer = /documents do not contain|no information regarding|no relevant documents/i.test(responseText);
    if (!hasCitations && !hasAbsenceDisclaimer) {
      reasons.push('Response references document-derived facts but lacks inline citations or a Sources section.');
    }
  }

  // 2. No hallucinated document references (check cited names against retrieved set)
  if (retrievedDocNames.size > 0) {
    const citedNames = responseText.match(/\*\*([^*]+\.(pdf|docx|xlsx|csv|txt|doc))\*\*/gi) || [];
    for (const cited of citedNames) {
      const cleanName = cited.replace(/\*\*/g, '').trim().toLowerCase();
      const isKnown = Array.from(retrievedDocNames).some(
        rn => rn.toLowerCase().includes(cleanName) || cleanName.includes(rn.toLowerCase())
      );
      if (!isKnown) {
        reasons.push(`Possible hallucinated document reference: "${cited.replace(/\*\*/g, '')}"`);
      }
    }
  }

  // 3. General knowledge disclaimer when matter is active
  if (hasActiveMatter && intent !== 'workspace' && intent !== 'export') {
    const usesGeneralKnowledge = /\b(generally|typically|in most jurisdictions|common law)\b/i.test(responseText);
    const hasDisclaimer = /general (?:legal )?(?:principles?|knowledge)|not from case files|publicly available/i.test(responseText);
    if (usesGeneralKnowledge && !hasDisclaimer) {
      reasons.push('Response uses general legal knowledge without disclaiming it as non-document-sourced.');
    }
  }

  const riskLevel = scoreRisk({
    intent,
    hasActiveMatter,
    citationsRequired,
    responseText,
  });

  if (reasons.length === 0) {
    return { verdict: 'pass', reasons: [], retry_hint: null, risk_level: riskLevel };
  }

  return {
    verdict: 'fail',
    reasons,
    retry_hint: `Your response had verification issues:\n${reasons.map(r => `- ${r}`).join('\n')}\n\nPlease revise: add proper citations (document name + section), include a Sources section, and clearly label any general knowledge.`,
    risk_level: riskLevel,
  };
}

/**
 * LLM Verifier — gated by RiskScorer. Only runs when risk is HIGH.
 * Validates claim-support alignment without generating new content.
 * Max 1 call per user turn, max 500 tokens.
 */
async function llmVerify(
  responseText: string,
  retrievedContext: string,
  apiKey: string,
): Promise<VerifierResult> {
  try {
    const abortCtrl = new AbortController();
    const timeout = setTimeout(() => abortCtrl.abort(), 15000);

    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: abortCtrl.signal,
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        temperature: 0,
        max_tokens: 500,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `You are a legal response verifier. Your ONLY job is to check if claims in the response are supported by the retrieved context.

Output JSON:
{
  "verdict": "pass" or "fail",
  "reasons": ["list of unsupported claims or missing citations"],
  "retry_hint": "specific instruction for fixing issues, or null"
}

Rules:
- A claim is SUPPORTED if the retrieved context contains evidence for it.
- A claim is UNSUPPORTED if it makes specific factual assertions not found in context.
- General legal knowledge statements are ACCEPTABLE if clearly labelled as such.
- Do NOT verify legal correctness — only factual support from the provided context.
- Be lenient: if the context roughly supports the claim, pass it.`,
          },
          {
            role: 'user',
            content: `RESPONSE TO VERIFY:\n${responseText.substring(0, 3000)}\n\nRETRIEVED CONTEXT:\n${retrievedContext.substring(0, 4000)}`,
          },
        ],
      }),
    });

    clearTimeout(timeout);
    if (!resp.ok) return { verdict: 'pass', reasons: ['LLM verifier unavailable'], retry_hint: null, risk_level: 'HIGH' };

    const data = await resp.json();
    const raw = JSON.parse(data.choices?.[0]?.message?.content || '{}');
    return {
      verdict: raw.verdict === 'fail' ? 'fail' : 'pass',
      reasons: Array.isArray(raw.reasons) ? raw.reasons : [],
      retry_hint: raw.retry_hint || null,
      risk_level: 'HIGH',
    };
  } catch (e) {
    console.error('[LLM_VERIFIER] Error:', e);
    return { verdict: 'pass', reasons: ['LLM verifier error — passing by default'], retry_hint: null, risk_level: 'HIGH' };
  }
}

// ============================================================================
// 15. MAIN SERVER — Agentic Orchestration Pipeline
// ============================================================================

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    // ---- AUTH ----
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return new Response(JSON.stringify({ error: 'Missing authorization header' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const supabaseClient = createClient(supabaseUrl ?? '', supabaseAnonKey ?? '', { global: { headers: { Authorization: authHeader } } });

    let token = null;
    if (authHeader.startsWith('Bearer ')) token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);
    if (authError || !user) return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    // ---- TENANT + SUBSCRIPTION + CREDITS (parallelized) ----
    const [{ data: tenantMember }] = await Promise.all([
      supabaseClient.from('tenant_members').select('tenant_id, role').eq('user_id', user.id).maybeSingle(),
    ]);

    let pricingTier: any = null;
    let tenantName: string | undefined;
    let subscriptionStatus: string | null = null;
    let monthlyCredits = 0;
    let allowedModes: string[] = ['general', 'summary'];
    let multiStageLevel: string = 'none';

    if (tenantMember) {
      // Fetch tenant + pricing tier + subscription in parallel
      const [{ data: tenant }, { data: subscription }] = await Promise.all([
        supabaseClient.from('tenants').select('name, pricing_tier_id, subscription_status, pricing_tiers (rate_limit_per_hour, max_documents, max_file_size_mb, name, monthly_credits, allowed_modes, multi_stage_level, enable_multi_stage_reasoning, response_priority)').eq('id', tenantMember.tenant_id).single(),
        supabaseClient.from('subscriptions').select('status, pricing_tier_id, current_period_end').eq('tenant_id', tenantMember.tenant_id).in('status', ['active', 'trialing', 'past_due']).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      ]);

      if (tenant?.pricing_tiers) pricingTier = tenant.pricing_tiers;
      tenantName = tenant?.name;
      subscriptionStatus = subscription?.status || tenant?.subscription_status || null;
      monthlyCredits = pricingTier?.monthly_credits || 0;
      allowedModes = pricingTier?.allowed_modes || ['general', 'summary'];
      multiStageLevel = pricingTier?.multi_stage_level || 'none';
    }

    // ---- SUBSCRIPTION CHECK ----
    if (!subscriptionStatus || !['active', 'trialing'].includes(subscriptionStatus)) {
      // Allow past_due with grace period (3 days)
      if (subscriptionStatus === 'past_due') {
        // Past due is handled below — allow with warning
      } else {
        return new Response(JSON.stringify({ error: 'Active subscription required. Please subscribe to continue using Horizon.', code: 'subscription_required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
    }

    // ---- CREDIT-BASED USAGE CHECK (replaces hourly rate limit) ----
    let creditWarning = false;
    if (tenantMember?.tenant_id && monthlyCredits > 0) {
      const now = new Date();
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

      const { data: usageRows } = await supabaseClient
        .from('credit_usage')
        .select('credits_consumed')
        .eq('tenant_id', tenantMember.tenant_id)
        .gte('created_at', monthStart.toISOString())
        .lt('created_at', monthEnd.toISOString());

      const totalUsed = (usageRows || []).reduce((sum: number, r: any) => sum + (r.credits_consumed || 0), 0);
      const usagePercent = (totalUsed / monthlyCredits) * 100;

      if (totalUsed >= monthlyCredits) {
        return new Response(JSON.stringify({
          error: 'Monthly credit limit reached. Upgrade your plan or wait for the next billing cycle.',
          code: 'credit_limit_reached',
          used: totalUsed,
          limit: monthlyCredits,
          resetDate: monthEnd.toISOString(),
        }), { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (usagePercent >= 80) {
        creditWarning = true;
      }
    }

    // ---- INPUT VALIDATION ----
    const body: ChatRequest = await req.json();
    if (!body.message || typeof body.message !== 'string') return new Response(JSON.stringify({ error: 'Invalid message format' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    const trimmedMessage = body.message.trim();
    if (trimmedMessage.length === 0) return new Response(JSON.stringify({ error: 'Message cannot be empty' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (body.message.length > 10000) return new Response(JSON.stringify({ error: 'Message too long (max 10,000 characters)' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    if (!Array.isArray(body.history)) body.history = [];
    if (body.history.length > 20) body.history = body.history.slice(-20);
    if (!Array.isArray(body.files)) body.files = [];

    const maxFileSize = pricingTier?.max_file_size_mb || 10;
    for (const file of body.files) {
      if (!file.name || !file.mimeType || !file.data) return new Response(JSON.stringify({ error: 'Invalid file format' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const fileSizeMB = (file.data.length * 0.75) / (1024 * 1024);
      if (fileSizeMB > maxFileSize) return new Response(JSON.stringify({ error: `File "${file.name}" exceeds ${maxFileSize}MB limit.` }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      const dangerous = ['application/x-sh', 'application/x-executable', 'application/x-msdownload', 'text/html'];
      if (dangerous.includes(file.mimeType)) return new Response(JSON.stringify({ error: `File type not allowed: ${file.mimeType}` }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ---- MATTER-LEVEL FILE OWNERSHIP VALIDATION ----
    // Security: file_ids without a case_id is invalid — files always belong to a matter.
    // If file_ids are provided, every file must belong to the specified case + tenant.
    if (body.file_ids && body.file_ids.length > 0) {
      if (!body.case_id) {
        return new Response(JSON.stringify({ error: 'file_ids requires a case_id — files must be scoped to a matter' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }
      if (tenantMember?.tenant_id) {
        const ownership = await validateFileOwnership(body.file_ids, body.case_id, tenantMember.tenant_id, supabaseClient);
        if (!ownership.valid) {
          console.error(`[SECURITY] File ownership violation: user=${user.id} invalid_files=[${ownership.invalidFileIds.join(',')}] case_id=${body.case_id}`);
          return new Response(JSON.stringify({ error: 'One or more files do not belong to the specified matter' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
    }

    // ---- API KEY ----
    const openaiApiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiApiKey) return new Response(JSON.stringify({ error: 'Server configuration error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

    const modelTemperature = Math.min(1.0, Math.max(0.1, body.temperature ?? 0.3));
    const useRAG = body.use_rag !== false && !!tenantMember?.tenant_id;
    // Feature flag: set MODES_ENABLED=false in env to force all requests to general mode
    const modesEnabled = Deno.env.get('MODES_ENABLED') !== 'false';
    const requestedMode = modesEnabled ? body.mode : 'general';

    // ---- PLAN-BASED MODE GATING ----
    // Check if the requested mode is allowed by the user's plan
    let effectiveMode = requestedMode;
    let modeDowngraded = false;
    if (requestedMode && requestedMode !== 'general' && !allowedModes.includes(requestedMode)) {
      console.log(`[MODE_GATE] Mode '${requestedMode}' not allowed by plan. Falling back to 'general'.`);
      effectiveMode = 'general';
      modeDowngraded = true;
    }

    const { modeKey, config: modeConfig } = getModeConfig(effectiveMode);
    const subOptions: string[] = Array.isArray(body.sub_options) ? body.sub_options.filter((s: any) => typeof s === 'string') : [];

    // ---- ADVANCED ACTION FLAGS ----
    const flagDeepAnalysis = body.deep_analysis === true;
    const flagStrictCitations = body.strict_citations === true;
    const flagPrivilegeReview = body.privilege_review === true;
    const flagFastMode = body.fast_mode === true;
    // Mutual exclusion: fast_mode and deep_analysis cannot both be active
    const effectiveDeepAnalysis = flagDeepAnalysis && !flagFastMode;
    const effectiveFastMode = flagFastMode && !flagDeepAnalysis;
    const activeActionFlags = [
      effectiveDeepAnalysis && 'deep_analysis',
      flagStrictCitations && 'strict_citations',
      flagPrivilegeReview && 'privilege_review',
      effectiveFastMode && 'fast_mode',
    ].filter(Boolean) as string[];
    console.log('RAG config:', { useRAG, tenantId: tenantMember?.tenant_id, userId: user.id, use_rag_body: body.use_rag, mode: modeKey, modesEnabled, subOptions, actionFlags: activeActionFlags });

    // ============================================================================
    // DETERMINISTIC PIPELINE (inside streaming response)
    // ============================================================================

    const toolContext: ToolExecutionContext = { supabaseClient, tenantId: tenantMember?.tenant_id || '', userId: user.id, openaiApiKey, caseId: body.case_id, fileIds: body.file_ids };
    const enableTools = !!tenantMember?.tenant_id;
    const encoder = new TextEncoder();

    const stream = new ReadableStream({
      async start(controller) {
        // ── HEARTBEAT: keep SSE connection alive during long processing ──
        // Supabase edge functions (and proxies) can close idle connections.
        // Send an SSE comment every 8 seconds so the connection stays open.
        const heartbeat = setInterval(() => {
          try { controller.enqueue(encoder.encode(': heartbeat\n\n')); } catch (_) { /* stream closed */ }
        }, 8_000);

        try {
          // ── PIPELINE TIMING ──
          const pipelineStart = Date.now();
          const t = (label: string) => console.log(`[TIMING] ${label}: ${Date.now() - pipelineStart}ms`);

          // ── EMIT PLAN WARNINGS (credit/mode) ──
          if (creditWarning) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'warning', code: 'credit_warning', message: 'You have used over 80% of your monthly research credits.' })}\n\n`));
          }
          if (modeDowngraded) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'warning', code: 'mode_downgraded', message: `The "${requestedMode}" mode requires a higher plan. Using general mode instead.` })}\n\n`));
          }

          // ── PENDING ACTION CHECK (runs before ANY LLM call — non-negotiable) ──
          // If a previous turn created a PendingAction (confirmation/clarification),
          // check if the user's current message resolves it.
          let pendingActionHandled = false;
          if (body.session_id) {
            const pendingAction = await checkPendingAction(supabaseClient, body.session_id);
            if (pendingAction) {
              console.log(`[PENDING_ACTION] Found active: type=${pendingAction.action_type} tool=${pendingAction.tool_name} id=${pendingAction.id}`);

              if (pendingAction.action_type === 'clarification') {
                // Clarification: "yes" does NOT trigger tool execution — it means "I've answered"
                // Expire the action and let the pipeline re-process with the new info
                await expirePendingAction(supabaseClient, pendingAction.id);
                console.log('[PENDING_ACTION] Clarification resolved — continuing with pipeline');
              } else if (CONFIRMATION_PATTERN.test(trimmedMessage)) {
                // User confirmed a tool_confirmation or parameter_blocked action → execute the stored tool
                await consumePendingAction(supabaseClient, pendingAction.id);
                console.log(`[PENDING_ACTION] Confirmed — executing ${pendingAction.tool_name}`);
                pendingActionHandled = true;

                if (pendingAction.tool_name && pendingAction.tool_args) {
                  emitState(encoder, controller, 'executing_tools', `Executing ${pendingAction.tool_name}...`, true);
                  const toolResult = await executeTool(pendingAction.tool_name, pendingAction.tool_args, toolContext);
                  const resultStr = JSON.stringify(toolResult);
                  console.log(`[PENDING_ACTION] Tool result: success=${toolResult.success} len=${resultStr.length}`);

                  if (toolResult.success) {
                    // Generate a brief confirmation response
                    const confirmMsg = toolResult.result?.message || `${pendingAction.tool_name} completed successfully.`;
                    emitContent(encoder, controller, `✓ ${confirmMsg}`);
                  } else {
                    emitContent(encoder, controller, `The action could not be completed: ${toolResult.error || 'Unknown error'}`);
                  }
                } else {
                  emitContent(encoder, controller, 'Action confirmed, but no tool was stored. Please repeat your request.');
                }

                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                clearInterval(heartbeat);
                try { controller.close(); } catch (_) {}
                return;
              } else if (MODIFICATION_PATTERN.test(trimmedMessage)) {
                // User wants to modify the pending action — expire it and let pipeline re-process
                await expirePendingAction(supabaseClient, pendingAction.id);
                console.log('[PENDING_ACTION] User requested modification — expiring and re-processing');
              } else {
                // User sent an unrelated message → topic change, expire the pending action
                await expirePendingAction(supabaseClient, pendingAction.id);
                console.log('[PENDING_ACTION] Topic change detected — expiring pending action');
              }
            }
          }

          // ---- ORCHESTRATOR PREFLIGHT PLAN ----
          // Agent intent should lead routing decisions. If the agent plans a
          // workspace action (e.g. rename/update/create folder), do not run conversational gate.
          const preAgentPlan = await getOrchestratorPlan(
            body.message,
            openaiApiKey,
            body.history,
            {
              hasActiveMatter: !!body.case_id,
              hasCsvData: false,
              matterName: body.case_name,
            },
          );
          const skipConversationalGate = preAgentPlan?.intent === 'workspace';

          // ---- CONVERSATIONAL GATE (lightweight LLM triage) ----
          // Single fast LLM call that classifies AND responds for conversational queries.
          // Runs BEFORE the heavy classifier/RAG pipeline for ALL modes.
          // Includes lightweight context (date/time, identity, active matter) so the
          // gate can answer quick factual queries without the full pipeline.
          let gateResult: any = { conversational: false, response: null };
          if (!skipConversationalGate) {
            gateResult = await conversationalGate(body.message, openaiApiKey, body.history, {
              userTimezone: body.user_timezone,
              userEmail: user.email,
              userRole: tenantMember?.role,
              tenantName: tenantName,
              matterName: body.case_name,
              matterClient: body.case_client,
            });
            t('conversational-gate');
          } else {
            console.log('[GATE] Skipped conversational gate due to workspace intent from orchestrator preflight plan');
          }

          if (gateResult.conversational && gateResult.response) {
            console.log('[GATE] Conversational — responding inline, skipping pipeline');
            emitContent(encoder, controller, gateResult.response);

            // ── CREDIT DEDUCTION (conversational = 1 credit) ──
            if (tenantMember?.tenant_id) {
              try {
                const serviceClient = createClient(supabaseUrl ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
                await serviceClient.from('credit_usage').insert({
                  tenant_id: tenantMember.tenant_id,
                  user_id: user.id,
                  session_id: null,
                  case_id: body.case_id || null,
                  operation_type: 'simple_query',
                  credits_consumed: 1,
                  metadata: { mode: 'conversational_gate' },
                });
              } catch (e) { console.error('[CREDITS] Failed to deduct:', e); }
            }

            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            clearInterval(heartbeat);
            try { controller.close(); } catch (_) { /* already closed */ }
            return; // Skip pipeline — finally block will be a no-op since heartbeat cleared & controller closed
          }

          // ---- SUBSTANTIVE PROCESSING GATE ----
          let substantiveProcessing = false;

          // ---- MODE-AWARE CLASSIFICATION ----
          let classification: QueryClassification;
          let modelTier: ModelTier;
          let agentTaskType: AgentTaskType = 'general_chat';
          let pipelineConfig: AgentPipelineConfig = AGENT_PIPELINE_CONFIGS['general_chat'];
          let agentPlan: AgentPlan | null = null;
          let agentRunId: string | null = null;

          if (preAgentPlan?.intent === 'workspace') {
            // Workspace intent from orchestrator is authoritative across modes.
            // Never route create/update/list workspace actions into RAG/research.
            agentPlan = {
              ...preAgentPlan,
              requires_retrieval: false,
              citations_required: false,
              doc_scope: 'none',
            };
            classification = planToClassification(agentPlan, body.message);
            modelTier = 'standard';
            agentTaskType = 'workspace_management';
            pipelineConfig = AGENT_PIPELINE_CONFIGS[agentTaskType];
            emitState(encoder, controller, 'mode_active', 'workspace', false);
            console.log('[ORCHESTRATOR] Workspace intent enforced: bypassing mode/classifier routing');

            if (tenantMember?.tenant_id) {
              agentRunId = await createAgentRun(supabaseClient, {
                tenant_id: tenantMember.tenant_id,
                session_id: body.session_id || null,
                case_id: body.case_id || null,
                user_id: user.id,
                status: 'running',
                user_query: body.message,
                task_graph: agentPlan || {},
                metadata: { mode: modeKey, intent_override: 'workspace' },
              });
            }
          } else if (modeConfig.skip_classifier) {
            // Non-general modes: skip classifier, use mode config directly
            console.log(`Mode '${modeKey}': skipping classifier, using mode config`);
            emitState(encoder, controller, 'mode_active', modeKey, false);
            classification = {
              domain: 'legal',
              complexity: modeKey === 'summary' ? 'multi_source' : 'analytical',
              requires_reasoning: modeConfig.model === 'reasoning',
              requires_planning: modeKey === 'drafting',
              search_intent: modeConfig.use_rag,
              requires_structured_data: false,
              structured_intents: [],
              tasks: [{ query: body.message, type: modeKey === 'drafting' ? 'drafting' : 'document', label: modeKey }],
            };
            modelTier = modeConfig.model;
            // Derive agent task type from explicit mode
            agentTaskType = inferAgentTaskType(classification);
            pipelineConfig = AGENT_PIPELINE_CONFIGS[agentTaskType];
            // Action flag model tier overrides
            if (effectiveFastMode) modelTier = 'fast';
            else if (effectiveDeepAnalysis && modelTier !== 'reasoning') modelTier = 'reasoning';
          } else {
            // General/Auto mode: use ORCHESTRATOR AGENT for planning (replaces classifier)
            emitState(encoder, controller, 'classifying_query', undefined, false);

            // ── ORCHESTRATOR PLANNING CALL (replaces classifyQuery) ──
            // Reuse preflight plan when available to avoid divergent routing.
            agentPlan = preAgentPlan || await getOrchestratorPlan(
              body.message,
              openaiApiKey,
              body.history,
              {
                hasActiveMatter: !!body.case_id,
                hasCsvData: false, // Will be refined after CSV schema fetch
                matterName: body.case_name,
              },
            );
            t('orchestrator-plan');

            // ── CREATE AGENT RUN (audit log) ──
            if (tenantMember?.tenant_id) {
              agentRunId = await createAgentRun(supabaseClient, {
                tenant_id: tenantMember.tenant_id,
                session_id: body.session_id || null,
                case_id: body.case_id || null,
                user_id: user.id,
                status: 'running',
                user_query: body.message,
                task_graph: agentPlan || {},
                metadata: { mode: modeKey },
              });
            }

            if (agentPlan) {
              // Agent-driven classification via plan bridge
              classification = planToClassification(agentPlan, body.message);
              agentTaskType = classification.agent_task_type || inferAgentTaskType(classification);
              pipelineConfig = AGENT_PIPELINE_CONFIGS[agentTaskType];

              console.log('Pipeline (orchestrator):', {
                intent: agentPlan.intent,
                domain: classification.domain,
                complexity: classification.complexity,
                search: classification.search_intent,
                structured: classification.requires_structured_data,
                structuredIntents: classification.structured_intents.map(si => si.type),
                suggestedMode: classification.suggested_mode,
                agentTaskType,
                toolsRequested: agentPlan.tools_requested.map(t => t.name),
                clarifyingQuestions: agentPlan.clarifying_questions.length,
              });

              // Emit plan SSE event for frontend visibility
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                type: 'agent_plan',
                intent: agentPlan.intent,
                requires_retrieval: agentPlan.requires_retrieval,
                tools_requested: agentPlan.tools_requested.map(t => t.name),
                citations_required: agentPlan.citations_required,
                execution_budget: agentPlan.execution_budget,
              })}\n\n`));

              // ── HANDLE CLARIFYING QUESTIONS ──
              // If the orchestrator has questions, create a PendingAction and stream them
              if (agentPlan.clarifying_questions.length > 0) {
                console.log(`[ORCHESTRATOR] ${agentPlan.clarifying_questions.length} clarifying question(s) — pausing pipeline`);

                // Create a clarification PendingAction (yes ≠ tool execution)
                if (body.session_id) {
                  await createPendingAction(supabaseClient, body.session_id, {
                    action_type: 'clarification',
                    user_prompt_summary: body.message.substring(0, 200),
                  });
                }

                // Stream the clarifying questions to the user
                const questionsText = agentPlan.clarifying_questions.length === 1
                  ? `Before I proceed, I need some clarification:\n\n${agentPlan.clarifying_questions[0]}`
                  : `Before I proceed, I need some clarification:\n\n${agentPlan.clarifying_questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}`;
                emitContent(encoder, controller, questionsText);

                // Emit clarifying_questions SSE event for frontend
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                  type: 'clarifying_questions',
                  questions: agentPlan.clarifying_questions,
                })}\n\n`));

                if (agentRunId && tenantMember?.tenant_id) {
                  await updateAgentRun(supabaseClient, agentRunId, {
                    status: 'awaiting_clarification',
                    metadata: { clarifying_questions: agentPlan.clarifying_questions },
                  });
                }

                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                clearInterval(heartbeat);
                try { controller.close(); } catch (_) {}
                return;
              }
            } else {
              // Orchestrator failed — use a safe agent-only fallback (no classifier).
              // Default to general_chat with retrieval OFF to avoid accidental RAG.
              console.warn('[ORCHESTRATOR] Planning failed, using safe non-classifier fallback');
              classification = {
                domain: 'legal',
                complexity: 'simple',
                requires_reasoning: false,
                requires_planning: false,
                search_intent: false,
                requires_structured_data: false,
                structured_intents: [],
                tasks: [{ query: body.message, type: 'general', label: 'fallback' }],
                agent_task_type: 'general_chat',
              };
              agentTaskType = 'general_chat';
              pipelineConfig = AGENT_PIPELINE_CONFIGS[agentTaskType];
              modelTier = 'standard';
            }

            console.log(`[PIPELINE] agentTaskType=${agentTaskType}, maxRounds=${pipelineConfig?.maxToolRounds}, tools=${pipelineConfig?.toolNames.length || 'all'}`);

            // Emit agent_task SSE event for non-general pipelines
            if (agentTaskType !== 'general_chat') {
              const pipelineLabels: Record<string, string> = {
                document_drafting: '📝 Document Drafting Pipeline',
                legal_research: '🔍 Legal Research Pipeline',
                contract_review: '📋 Contract Review Pipeline',
                case_summary: '📄 Case Summary Pipeline',
                litigation_strategy: '⚖️ Litigation Strategy Pipeline',
                deposition_analysis: '🎤 Deposition Analysis Pipeline',
                document_export: '📥 Document Export Pipeline',
                workspace_management: '🗂️ Workspace Management',
              };
              const label = pipelineLabels[agentTaskType] || agentTaskType;
              const agentTaskEvent = `data: ${JSON.stringify({ type: 'agent_task', task_type: agentTaskType, label })}\n\n`;
              controller.enqueue(encoder.encode(agentTaskEvent));
            }

            // ── CONTENT-IN-MESSAGE EXPORT (pre-classification) ──
            // If the user's message ITSELF contains substantial content (>300 chars)
            // AND they asked for a file, export it directly — regardless of classifier.
            // This handles: user pastes a full document + "give me this in a word file".
            const fileKeywordMatch = /\b(word|docx|\.docx|pdf|\.pdf)\b/i.test(body.message);
            const fileActionMatch = /\b(give\s+me|export|download|save|convert|send|make.*file|in\s+a\s+word|as\s+a?\s*word|as\s+a?\s*pdf)\b/i.test(body.message);
            if (fileKeywordMatch && fileActionMatch) {
              const exportable = findExportableMessage([], body.message); // Pass empty history — only check user message (Pass 0)
              if (exportable) {
                console.log(`[CONTENT-EXPORT] User message contains exportable content: "${exportable.title}" (${exportable.content.length} chars)`);
                const format = /\bpdf\b/i.test(body.message) ? 'pdf' as const : 'word' as const;
                emitState(encoder, controller, 'creating_document', 'Formatting and preparing your document...', false);
                // Format through LLM for proper Word structure
                const formattedContent = await formatDocumentForExport(exportable.content, exportable.title, openaiApiKey);
                emitFileExport(encoder, controller, formattedContent, exportable.title, format);
                emitContent(encoder, controller, `Your document "${exportable.title}" has been downloaded as ${format === 'pdf' ? 'PDF' : 'Word'}.`);

                if (tenantMember?.tenant_id) {
                  try {
                    const serviceClient = createClient(supabaseUrl ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
                    await serviceClient.from('credit_usage').insert({
                      tenant_id: tenantMember.tenant_id,
                      user_id: user.id,
                      session_id: null,
                      case_id: body.case_id || null,
                      operation_type: 'document_export',
                      credits_consumed: 1,
                      metadata: { title: exportable.title, format },
                    });
                  } catch (e) { console.error('[CREDITS] Failed to deduct:', e); }
                }

                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                clearInterval(heartbeat);
                try { controller.close(); } catch (_) { /* already closed */ }
                return;
              }
            }

            // ── DOCUMENT EXPORT SHORT-CIRCUIT (history-based) ──
            // When classifier detects user wants to export a previous response,
            // scan history for the best exportable message and send it directly.
            // Zero AI calls, zero latency — instant file download.
            if (agentTaskType === 'document_export') {
              const exportable = findExportableMessage(body.history, body.message);
              if (exportable) {
                console.log(`[EXPORT SHORT-CIRCUIT] Found exportable message: "${exportable.title}" (${exportable.content.length} chars)`);
                const format = /\bpdf\b/i.test(body.message) ? 'pdf' as const : 'word' as const;
                emitState(encoder, controller, 'creating_document', 'Formatting and preparing your document...', false);
                // Format through LLM for proper Word structure
                const formattedContent = await formatDocumentForExport(exportable.content, exportable.title, openaiApiKey);
                emitFileExport(encoder, controller, formattedContent, exportable.title, format);
                emitContent(encoder, controller, `Your document "${exportable.title}" has been downloaded as ${format === 'pdf' ? 'PDF' : 'Word'}.`);

                // Deduct 1 credit for export
                if (tenantMember?.tenant_id) {
                  try {
                    const serviceClient = createClient(supabaseUrl ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
                    await serviceClient.from('credit_usage').insert({
                      tenant_id: tenantMember.tenant_id,
                      user_id: user.id,
                      session_id: null,
                      case_id: body.case_id || null,
                      operation_type: 'document_export',
                      credits_consumed: 1,
                      metadata: { title: exportable.title, format },
                    });
                  } catch (e) { console.error('[CREDITS] Failed to deduct:', e); }
                }

                controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                clearInterval(heartbeat);
                try { controller.close(); } catch (_) { /* already closed */ }
                return; // Skip entire pipeline
              } else {
                console.log('[EXPORT SHORT-CIRCUIT] No exportable message found in history, falling through to pipeline');
              }
            }

            // ── HYBRID DRAFT+FILE DETECTION ──
            // If user asked for a draft AND a file in the same message, emit
            // file_requested so frontend knows to auto-export after pipeline.
            const wantsFileDownload = agentTaskType !== 'document_export'
              && /\b(word|docx|\.docx|pdf|\.pdf)\b/i.test(body.message)
              && /\b(draft|write|create|generate|prepare|make|give\s+me)\b/i.test(body.message);
            if (wantsFileDownload) {
              const fileFormat = /\bpdf\b/i.test(body.message) ? 'pdf' : 'word';
              console.log(`[HYBRID] Draft + file requested, format=${fileFormat}`);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'file_requested', format: fileFormat })}\n\n`));
            }

            // Auto-detect: if classifier suggests a specialized mode, apply its config
            if (classification.suggested_mode) {
              const detectedConfig = MODE_CONFIGS[classification.suggested_mode];
              console.log(`[AUTO_DETECT] Classifier suggested mode: ${classification.suggested_mode}, applying config`);
              emitState(encoder, controller, 'detected_mode', classification.suggested_mode, false);
              // Use detected mode's model tier
              modelTier = detectedConfig.model;
            } else {
              // Smart model tier selection based on complexity and data needs
              if (classification.complexity === 'analytical' || classification.complexity === 'drafting') {
                modelTier = 'reasoning';
              } else if (classification.requires_structured_data && !classification.search_intent) {
                // Pure structured data query (no document search) → standard tier is sufficient
                // since we're mostly presenting pre-extracted data
                modelTier = 'standard';
              } else {
                modelTier = 'standard';
              }
            }

            // Action flag model tier overrides (applied after normal tier selection)
            if (effectiveFastMode) modelTier = 'fast';
            else if (effectiveDeepAnalysis && modelTier !== 'reasoning') modelTier = 'reasoning';
          }

          // ---- STEP 1b: AUTHORITY ROUTING ----
          // Determine query authority BEFORE any retrieval. This governs what
          // data sources are consulted and whether general knowledge is allowed.
          const hasCaseId = !!body.case_id;
          const authorityRouting = determineAuthorityRouting(
            classification, hasCaseId, useRAG, body.message,
          );
          // Emit authority routing decision (substantive only when it involves internal data lookup)
          const authorityIsSubstantive = authorityRouting.primaryAuthority !== 'conversational'
            && authorityRouting.primaryAuthority !== 'general_knowledge';
          emitState(encoder, controller, 'authority_routing', authorityRouting.routingReason, authorityIsSubstantive);

          // ── SAFETY NET: ensure reasoning panel shows for any active-matter processing ──
          // If the authority routing is non-conversational AND a matter is active,
          // emit a substantive state now so the frontend shows the research panel
          // BEFORE any async work (RAG/DB) that might take time.
          if (authorityIsSubstantive && hasCaseId) {
            emitState(encoder, controller, 'querying_intelligence', 'Analyzing matter data...', true);
          }

          console.log('[AUTHORITY]', authorityRouting.routingReason, { primary: authorityRouting.primaryAuthority, rag: authorityRouting.shouldRunRAG, db: authorityRouting.shouldQueryStructuredDB, genKnowledge: authorityRouting.shouldAllowGeneralKnowledge });

          // ---- STEP 1c: ACTIVE MATTER CONTEXT (identity + intelligence) ----
          // When a matter is selected, build a rich context block so the LLM
          // knows WHICH case it's operating in and has core intelligence at hand.
          // Skip for conversational queries (fast_mode or simple greetings)
          let activeMatterContext = '';
          if (body.case_id && tenantMember?.tenant_id && authorityRouting.primaryAuthority !== 'conversational') {
            try {
              // 1. Case identity — from frontend metadata or DB fallback
              let caseName = body.case_name;
              let caseClient = body.case_client;
              let caseDescription = body.case_description;
              let caseNumber = body.case_number;
              let caseMatterType = body.case_matter_type;

              // Fire ALL matter context queries in parallel (was 5 serial queries — ~500ms→~100ms)
              const matterContextPromises: Record<string, Promise<any>> = {};

              if (!caseName) {
                matterContextPromises.caseRecord = supabaseClient
                  .from('cases')
                  .select('name, client_name, description, case_number, matter_type')
                  .eq('id', body.case_id)
                  .eq('tenant_id', tenantMember.tenant_id)
                  .maybeSingle();
              }

              matterContextPromises.entities = supabaseClient
                .from('canonical_entities')
                .select('canonical_name, entity_type, mention_count')
                .eq('case_id', body.case_id)
                .eq('tenant_id', tenantMember.tenant_id)
                .order('mention_count', { ascending: false })
                .limit(15);

              matterContextPromises.risks = supabaseClient
                .from('matter_risks')
                .select('risk_type, severity, description')
                .eq('case_id', body.case_id)
                .eq('tenant_id', tenantMember.tenant_id)
                .in('severity', ['high', 'critical'])
                .order('severity', { ascending: true })
                .limit(10);

              matterContextPromises.obligations = supabaseClient
                .from('matter_obligations')
                .select('obligation_type, obligation_text, due_date, status')
                .eq('case_id', body.case_id)
                .eq('tenant_id', tenantMember.tenant_id)
                .gte('due_date', new Date().toISOString().split('T')[0])
                .order('due_date', { ascending: true })
                .limit(5);

              matterContextPromises.dates = supabaseClient
                .from('matter_dates')
                .select('date_type, date_value, description')
                .eq('case_id', body.case_id)
                .eq('tenant_id', tenantMember.tenant_id)
                .order('date_value', { ascending: false })
                .limit(8);

              // Await all in parallel — total time = MAX(individual) instead of SUM
              const matterResults: Record<string, any> = {};
              const keys = Object.keys(matterContextPromises);
              const results = await Promise.all(Object.values(matterContextPromises));
              keys.forEach((key, i) => { matterResults[key] = results[i]; });

              if (matterResults.caseRecord?.data) {
                const cr = matterResults.caseRecord.data;
                caseName = cr.name;
                caseClient = cr.client_name;
                caseDescription = cr.description;
                caseNumber = cr.case_number;
                caseMatterType = cr.matter_type;
              }

              // 2. Build the context block
              const parts: string[] = [];
              parts.push(`## ACTIVE MATTER CONTEXT`);
              parts.push(`You are currently working within the following matter. When the user says "this case", "this matter", "the case", etc., they are referring to THIS matter.`);
              parts.push(`- **Matter Name:** ${caseName || 'Unknown'}`);
              if (caseNumber) parts.push(`- **Case Number:** ${caseNumber}`);
              if (caseClient) parts.push(`- **Client:** ${caseClient}`);
              if (caseMatterType) parts.push(`- **Type:** ${caseMatterType}`);
              if (caseDescription) parts.push(`- **Description:** ${caseDescription}`);
              parts.push(`- **Matter ID:** ${body.case_id}`);

              const entities = matterResults.entities?.data;
              if (entities && entities.length > 0) {
                parts.push(`\n### Key Parties & Entities`);
                for (const e of entities) {
                  parts.push(`- **${e.canonical_name}** (${e.entity_type}) — ${e.mention_count} mentions`);
                }
              }

              const risks = matterResults.risks?.data;
              if (risks && risks.length > 0) {
                parts.push(`\n### Critical Risks`);
                for (const r of risks) {
                  parts.push(`- [${r.severity?.toUpperCase()}] ${r.risk_type}: ${r.description}`);
                }
              }

              const obligations = matterResults.obligations?.data;
              if (obligations && obligations.length > 0) {
                parts.push(`\n### Upcoming Deadlines`);
                for (const o of obligations) {
                  const dateStr = o.due_date?.split('T')[0] || '?';
                  parts.push(`- ${dateStr}: [${o.obligation_type}] ${o.obligation_text} (${o.status})`);
                }
              }

              const dates = matterResults.dates?.data;
              if (dates && dates.length > 0) {
                parts.push(`\n### Key Dates`);
                for (const d of dates) {
                  const dateStr = d.date_value?.split('T')[0] || '?';
                  parts.push(`- ${dateStr}: [${d.date_type}] ${d.description}`);
                }
              }

              activeMatterContext = parts.join('\n');
              console.log(`[MATTER_CONTEXT] Injected (parallel): name=${caseName} entities=${entities?.length || 0} risks=${risks?.length || 0} obligations=${obligations?.length || 0} dates=${dates?.length || 0}`);
            } catch (err) {
              console.error('[MATTER_CONTEXT] Failed to build matter context:', err);
            }
          }

          // ---- STEP 2: PARALLEL DATA RETRIEVAL ────────────────────────
          // Run structured data, matter summary, and RAG in PARALLEL.
          // These are independent — total time = MAX(individual) instead of SUM.
          // This is the #1 performance optimization: cuts 5-15s from the pipeline.

          const shouldRunRAG = agentPlan
            ? (agentPlan.requires_retrieval && useRAG)
            : (authorityRouting.shouldRunRAG
              || (modeConfig.skip_classifier && modeConfig.use_rag && useRAG));

          // CSV-only optimization: skip RAG for pure CSV intents
          const allIntentsCsv = classification.structured_intents.length > 0
            && classification.structured_intents.every(si => si.type === 'csv_query' || si.type === 'csv_summary')
            && !classification.search_intent;

          // ── Launch all retrieval tasks in parallel ──────────────────
          const retrievalTasks: Record<string, Promise<any>> = {};

          // Task 1: Structured data (works tenant-wide for CSV intents)
          if (authorityRouting.shouldQueryStructuredDB && tenantMember?.tenant_id) {
            emitState(encoder, controller, 'querying_intelligence', 'Querying structured intelligence...', true);
            retrievalTasks.structured = retrieveStructuredData(
              classification, tenantMember.tenant_id, body.case_id, supabaseClient,
            ).catch(err => { console.error('Structured data retrieval failed:', err); return { content: '', dataPoints: 0, intentsResolved: [] }; });
          }

          // Task 2: Matter summary (for background context, skip conversational)
          if (tenantMember?.tenant_id && body.case_id && authorityRouting.primaryAuthority !== 'conversational') {
            retrievalTasks.matterSummary = supabaseClient
              .from('matter_summaries')
              .select('summary_type, content, stale')
              .eq('case_id', body.case_id)
              .eq('tenant_id', tenantMember.tenant_id)
              .eq('summary_type', 'executive_brief')
              .limit(1)
              .maybeSingle()
              .then((res: any) => res.data)
              .catch(() => null);
          }

          // Task 4: CSV schema (for tool-aware prompting, skip conversational)
          if (tenantMember?.tenant_id && authorityRouting.primaryAuthority !== 'conversational') {
            let csvSchemaQ = supabaseClient
              .from('csv_datasets')
              .select('id, filename, schema_description, row_count, column_count')
              .eq('tenant_id', tenantMember.tenant_id);
            if (body.case_id) csvSchemaQ = csvSchemaQ.eq('case_id', body.case_id);
            retrievalTasks.csvSchema = csvSchemaQ
              .then((res: any) => res.data || [])
              .catch(() => []);
          }

          // Task 3: RAG (if needed)
          if (shouldRunRAG && !allIntentsCsv) {
            substantiveProcessing = true;
            emitState(encoder, controller, 'searching_documents', undefined, true);
            retrievalTasks.rag = executeRAG(
              classification, body.message, tenantMember!.tenant_id,
              supabaseClient, openaiApiKey,
              body.file_ids, body.case_id,
              encoder, controller
            ).catch(err => { console.error('RAG failed:', err); return { contextContent: '', sourceChunks: [], filesSearched: 0 }; });
          }

          // ── Await all in parallel ──────────────────────────────────
          t('parallel-retrieval-start');
          const retrievalKeys = Object.keys(retrievalTasks);
          const retrievalValues = await Promise.all(Object.values(retrievalTasks));
          const retrievalResults: Record<string, any> = {};
          retrievalKeys.forEach((key, i) => { retrievalResults[key] = retrievalValues[i]; });
          t('parallel-retrieval-done');

          // ── Unpack results ─────────────────────────────────────────
          let structuredResult: StructuredDataResult = retrievalResults.structured || { content: '', dataPoints: 0, intentsResolved: [] };
          if (structuredResult.dataPoints > 0) {
            substantiveProcessing = true;
            emitState(encoder, controller, 'intelligence_retrieved', `${structuredResult.dataPoints} data points (${structuredResult.intentsResolved.join(', ')})`, true);
            console.log(`Structured data retrieved: ${structuredResult.dataPoints} data points from [${structuredResult.intentsResolved.join(', ')}]`);
          }

          // DB-first: check if structured data fully resolves query → skip RAG results
          const structuredFullyResolved = structuredResult.dataPoints >= 3
            && classification.structured_intents.length > 0
            && classification.structured_intents.length === structuredResult.intentsResolved.length
            && !classification.search_intent;

          let ragResult: RAGResult = retrievalResults.rag || { contextContent: '', sourceChunks: [], filesSearched: 0 };

          // If structured data fully resolved, discard RAG results to keep context clean
          if (structuredFullyResolved && ragResult.sourceChunks.length > 0) {
            console.log(`DB-first: structured data fully resolved — discarding ${ragResult.sourceChunks.length} RAG chunks`);
            ragResult = { contextContent: '', sourceChunks: [], filesSearched: 0 };
            emitState(encoder, controller, 'intelligence_retrieved', `Direct DB answer: ${structuredResult.intentsResolved.join(', ')}`, true);
          } else if (ragResult.filesSearched > 0) {
            emitState(encoder, controller, 'context_retrieved', `${ragResult.filesSearched} document(s)`, true);
          } else if (allIntentsCsv) {
            console.log(`CSV-only query — RAG skipped (tool will query csv_datasets directly)`);
            emitState(encoder, controller, 'intelligence_retrieved', `CSV query — tool will fetch data`, true);
          }

          // Unpack matter summary
          let matterSummaryContext = '';
          const summaryData = retrievalResults.matterSummary;
          if (summaryData?.content && !structuredResult.intentsResolved.includes('matter_summary')) {
            const sc = summaryData.content as Record<string, any>;
            const parts: string[] = [];
            if (sc.executive_summary) parts.push(sc.executive_summary);
            if (sc.key_findings && Array.isArray(sc.key_findings)) {
              parts.push('Key findings: ' + sc.key_findings.join('; '));
            }
            if (parts.length > 0) {
              matterSummaryContext = `\n\n--- MATTER BACKGROUND ---\n${parts.join('\n')}\n${summaryData.stale ? '(Note: This summary may be outdated — new documents were processed since it was generated.)\n' : ''}--- END MATTER BACKGROUND ---\n`;
              console.log('[CHAT] Auto-injected matter summary as background context');
            }
          }

          // ---- RETRIEVAL AUDIT LOG (matter isolation traceability) ----
          const fileScope = (body.file_ids && body.file_ids.length > 0) ? 'file_scoped' : body.case_id ? 'matter_scoped' : 'none';
          const simRange = ragResult.sourceChunks.length > 0
            ? `${Math.min(...ragResult.sourceChunks.map(c => c.similarity)).toFixed(2)}-${Math.max(...ragResult.sourceChunks.map(c => c.similarity)).toFixed(2)}`
            : 'n/a';
          console.log(`[RETRIEVAL_AUDIT] matter_id=${body.case_id || 'none'} file_scope=${fileScope} file_ids_requested=${body.file_ids?.length || 0} chunks_retrieved=${ragResult.sourceChunks.length} unique_files=${ragResult.filesSearched} similarity_range=${simRange} structured_points=${structuredResult.dataPoints} user=${user.id}`);

          // Mark substantive if reasoning tier or planning required
          if (modelTier === 'reasoning') {
            substantiveProcessing = true;
          }

          // ---- STEP 2c: INSUFFICIENT CONTEXT GUARD (matter isolation) ----
          // When a matter is active but RAG found no relevant chunks, inject a
          // hard system instruction preventing the LLM from speculating with
          // training data on matter-specific questions.
          let insufficientContextInjection = '';
          if (body.case_id && shouldRunRAG && ragResult.sourceChunks.length === 0 && structuredResult.dataPoints === 0) {
            insufficientContextInjection = `\n\n## ⚠ INSUFFICIENT CONTEXT — HARD CONSTRAINT
No relevant document content was found in this matter's files for the user's query.
YOU MUST follow these rules:
- Do NOT speculate or use training data to answer matter-specific questions.
- Do NOT invent or fabricate document content, case details, or party information.
- State clearly: "This matter's documents do not contain information regarding [topic]."
- You MAY still use the search_documents tool with alternative keywords to verify.
- You MAY provide general legal knowledge ONLY if explicitly labelled as such.
- NEVER blend general knowledge with matter-specific claims.\n`;
            console.log('[CONTEXT_GUARD] Insufficient context injection activated — matter has no relevant chunks');
          }

          // ---- STEP 3: BUILD SYSTEM PROMPT (mode-aware + sub-options) ----
          // Priority: explicit mode > auto-detected mode > general prompt
          let systemPrompt: string;
          let activeConfig: ModeConfig = modeConfig;
          if (modeConfig.skip_classifier && modeConfig.system_prompt) {
            // Explicit non-general mode selected by user
            systemPrompt = modeConfig.system_prompt;
            activeConfig = modeConfig;
          } else if (classification.suggested_mode) {
            // Auto-detected mode: use its specialized system prompt
            const detectedConfig = MODE_CONFIGS[classification.suggested_mode];
            systemPrompt = detectedConfig.system_prompt;
            activeConfig = detectedConfig;
          } else {
            // General mode, no detection
            systemPrompt = buildSystemPrompt(classification.complexity, ragResult.contextContent.length > 0, structuredResult.dataPoints > 0);
          }

          // Append structured intelligence awareness to ALL mode prompts when data is available
          if (structuredResult.dataPoints > 0 && !systemPrompt.includes('STRUCTURED MATTER INTELLIGENCE')) {
            systemPrompt += `\n\n## STRUCTURED MATTER INTELLIGENCE AVAILABLE
You have access to ${structuredResult.dataPoints} structured data points extracted from this matter's documents. Use this structured intelligence for precise, data-backed answers.

**Presentation Rules:**
- When presenting obligations: state WHO must do WHAT by WHEN, and what triggers it. Group overdue items first with ⚠ markers.
- When presenting risks: state the ISSUE, SEVERITY, and RECOMMENDED ACTION in plain language.
- When presenting entities: identify their ROLE in the matter (e.g., "plaintiff", "opposing counsel").
- NEVER present raw database fields — synthesize into scannable, actionable prose.
- When structured data provides exact figures (dates, amounts, party names, risk scores), cite them directly rather than paraphrasing from document text.`;
          }

          // Append active sub-option prompt fragments
          // When auto-detect fires (general mode + suggested_mode), use default sub-options
          // so the auto-detected response is as rich as explicit mode selection
          let effectiveSubOptions = subOptions;
          if (effectiveSubOptions.length === 0 && classification.suggested_mode && modeKey === 'general') {
            effectiveSubOptions = DEFAULT_SUB_OPTIONS[classification.suggested_mode] || [];
            if (effectiveSubOptions.length > 0) {
              console.log(`[AUTO_DETECT] No explicit sub-options, applying defaults for ${classification.suggested_mode}: [${effectiveSubOptions.join(', ')}]`);
            }
          }
          if (effectiveSubOptions.length > 0 && activeConfig.sub_option_prompts) {
            const fragments: string[] = [];
            for (const optId of effectiveSubOptions) {
              const fragment = activeConfig.sub_option_prompts[optId];
              if (fragment) fragments.push(fragment);
            }
            if (fragments.length > 0) {
              systemPrompt += '\n\n' + fragments.join('\n\n');
              console.log(`Applied ${fragments.length} sub-option fragments: [${effectiveSubOptions.join(', ')}]`);
            }
          }

          // ---- STEP 3a.4: APPEND ACTION FLAG PROMPT FRAGMENTS ----
          // These are mode-independent — they apply on top of any mode's prompt
          if (activeActionFlags.length > 0) {
            const flagFragments: string[] = [];
            for (const flagId of activeActionFlags) {
              const fragment = ACTION_FLAG_PROMPTS[flagId];
              if (fragment) flagFragments.push(fragment);
            }
            if (flagFragments.length > 0) {
              systemPrompt += '\n\n' + flagFragments.join('\n\n');
              console.log(`Applied ${flagFragments.length} action flag fragments: [${activeActionFlags.join(', ')}]`);
            }
          }

          // Emit mode + sub-options info to Research panel
          const effectiveModeKey = (modeConfig.skip_classifier && modeConfig.system_prompt) ? modeKey
            : classification.suggested_mode ? classification.suggested_mode
            : 'general';
          const modeLabel = MODE_LABELS[effectiveModeKey] || effectiveModeKey;
          const subLabels = effectiveSubOptions.map(id => SUB_OPTION_LABELS[id] || id).filter(Boolean);
          const modeInfoDetail = subLabels.length > 0
            ? `${modeLabel} · ${subLabels.join(', ')}`
            : modeLabel;
          emitState(encoder, controller, 'mode_info', modeInfoDetail, authorityIsSubstantive);

          // ---- STEP 3a.5: INJECT ACTIVE MATTER CONTEXT ----
          // This goes early in the system prompt so the LLM always knows which
          // matter is active and has key intelligence at hand.
          if (activeMatterContext) {
            systemPrompt += '\n\n' + activeMatterContext;
          }

          // ---- STEP 3a.6: INJECT CSV DATASET SCHEMA CONTEXT ----
          // CSV schema was fetched in the parallel retrieval block (Task 4)
          const csvDatasets: any[] = retrievalResults.csvSchema || [];
          if (csvDatasets.length > 0) {
            let csvSchemaBlock = `\n\n## CSV/EXCEL DATASETS AVAILABLE
Your account contains ${csvDatasets.length} structured dataset(s). Use the \`query_csv\` tool for precise filtering and aggregation.

**MANDATORY — WHEN TO USE query_csv:**
You MUST use the \`query_csv\` tool (not RAG text) for ANY of these:
- "How many..." / "How much..." / "Total..." / "Count..." / "Sum..." / "Average..."
- "Show all entries/rows for X" / "List everything about X" / "Show them all"
- "How many times was X billed/paid/invoiced?"
- "What was the amount/cost/fee for X?"
- "Filter by X" / "Entries from [date]" / "Rows where [condition]"
- Any question that requires counting, summing, filtering, or listing structured data rows

NEVER answer these from RAG document chunks or conversation history. RAG gives you TEXT excerpts which are incomplete. The \`query_csv\` tool gives you EXACT, COMPLETE, COMPUTED results from the full dataset.

If you already discussed data in previous messages, you MUST still call \`query_csv\` again for new quantitative questions — do NOT reuse or hallucinate previous numbers.

**DATASET SELECTION — CRITICAL:**
When the same file has multiple sheets/datasets, apply these rules:
- For detailed queries (how many entries, show all rows, individual billing events, amounts per entry, dates of activities): Use the dataset with the MOST columns and rows — this is the detailed ledger/docket.
- For client-level summaries (list of clients, payment status per client): Use the dataset with fewer columns that has client-name-type columns.
- Column names like \`__EMPTY\`, \`__EMPTY_1\`, etc. are auto-generated from Excel files with non-standard headers. Look at the example values and data types to infer what each column actually represents.
- If your query returns unexpectedly few results (e.g., 1 row when asking "how many times"), you likely queried a summary table. Retry with the most detailed dataset (highest column count).

**IMPORTANT RULES for query_csv:**
- For currency, date, and duration columns, use the \`__n\` suffixed column name for numeric comparisons (e.g., \`Amount__n\` instead of \`Amount\`)
- Use \`fuzzy\` operator for name lookups (handles typos and variations)
- Use \`date_range\` operator with \`value\`=start and \`value2\`=end in YYYY-MM-DD format
- Aggregation results are COMPUTED — present them as exact values, never estimates
- If first query returns 0 results, the tool will auto-retry with fuzzy matching
- When asked to "show all" or "list", set limit to 100+ to get complete data
- When asked for counts, use the aggregation parameter with \`count\` — never count rows yourself

**Available Datasets:**\n`;
            // Group datasets by filename to identify detailed vs summary sheets
            const datasetsByFile = new Map<string, any[]>();
            for (const ds of csvDatasets) {
              const base = ds.filename?.split('.')[0] || ds.filename;
              if (!datasetsByFile.has(base)) datasetsByFile.set(base, []);
              datasetsByFile.get(base)!.push(ds);
            }

            for (const ds of csvDatasets) {
              const base = ds.filename?.split('.')[0] || ds.filename;
              const siblings = datasetsByFile.get(base) || [];
              let sheetLabel = '';
              if (siblings.length > 1) {
                // Identify whether this is the most detailed sheet or a summary
                const maxCols = Math.max(...siblings.map((s: any) => s.column_count || 0));
                const maxRows = Math.max(...siblings.map((s: any) => s.row_count || 0));
                if (ds.column_count === maxCols || ds.row_count === maxRows) {
                  sheetLabel = ' ⭐ DETAILED — use for entry-level queries (counts, listings, individual records)';
                } else if (ds.column_count <= 5) {
                  sheetLabel = ' 📋 SUMMARY — use for client/matter-level overviews only';
                }
              }
              csvSchemaBlock += `\n**${ds.filename}${ds.sheet_name ? ' (Sheet: ' + ds.sheet_name + ')' : ''}** (${ds.row_count} rows × ${ds.column_count} cols) — dataset_id: ${ds.id}${sheetLabel}\n`;
              if (ds.schema_description) {
                csvSchemaBlock += ds.schema_description + '\n';
              }
            }
            systemPrompt += csvSchemaBlock;
          }

          // ---- STEP 3b: AUTHORITY ENFORCEMENT ----
          // NOTE: Fallback assessment is deferred to AFTER tool execution.
          // At this point, tools haven't run yet — the LLM may find content via
          // search_documents tool even if RAG returned nothing.
          // Build authority block with current knowledge (pre-tool execution).
          const authorityBlock = buildAuthorityBlock(
            authorityRouting,
            ragResult.contextContent.length > 0,
            structuredResult.dataPoints > 0,
          );
          if (authorityBlock) {
            systemPrompt += authorityBlock;
          }
          // Append insufficient context guard when matter-scoped RAG found nothing
          if (insufficientContextInjection) {
            systemPrompt += insufficientContextInjection;
          }

          // ---- STEP 3c: BUILD RUNTIME CONTEXT (deterministic injection) ----
          // Construct runtime context with post-retrieval state indicators.
          const environment = Deno.env.get('ENVIRONMENT') || Deno.env.get('DENO_DEPLOYMENT_ID') ? 'production' : 'development';
          const runtimeContextInput: RuntimeContextInput = {
            // Temporal
            userTimezone: body.user_timezone,
            // Tenant
            tenantId: tenantMember?.tenant_id,
            tenantName: tenantName,
            tenantPlan: pricingTier?.name || 'standard',
            environment,
            // User
            userId: user.id,
            userEmail: user.email,
            userRole: tenantMember?.role || 'lawyer',
            // Matter / file selection
            matterId: body.case_id,
            matterName: body.case_name,
            fileIds: body.file_ids,
            multiFileMode: (body.file_ids?.length || 0) > 1,
            ragScope: body.file_ids && body.file_ids.length > 0
              ? 'restricted_to_selected_file'
              : body.case_id ? 'restricted_to_selected_matter' : 'none',
            // Retrieval state (populated with actual results)
            retrievalExecuted: shouldRunRAG || authorityRouting.shouldQueryStructuredDB,
            documentsRetrieved: ragResult.sourceChunks.length,
            structuredQueryExecuted: structuredResult.dataPoints > 0,
            structuredDataPoints: structuredResult.dataPoints,
            csvEngineActivated: csvDatasets.length > 0,
            // Intelligence mode flags
            activeModes: {
              csv_structured_mode: csvDatasets.length > 0,
              entity_resolution_enabled: structuredResult.intentsResolved.includes('entities'),
              hybrid_query_enabled: shouldRunRAG && authorityRouting.shouldQueryStructuredDB,
              matter_intelligence_active: !!activeMatterContext,
              rag_active: ragResult.sourceChunks.length > 0,
            },
            // Action flags
            activeActionFlags: activeActionFlags,
          };

          const runtimeContextMessage = buildRuntimeContext(runtimeContextInput);
          const architecturalRulesMessage = buildArchitecturalRules();

          // Log runtime context server-side (never exposed to user)
          console.log(`[RUNTIME_CONTEXT] tenant=${tenantName || tenantMember?.tenant_id} user_role=${tenantMember?.role || 'lawyer'} matter=${body.case_id || 'none'} rag_scope=${runtimeContextInput.ragScope} retrieval=${runtimeContextInput.retrievalExecuted} docs=${runtimeContextInput.documentsRetrieved} structured_pts=${runtimeContextInput.structuredDataPoints} csv=${runtimeContextInput.csvEngineActivated} env=${environment} tz=${body.user_timezone || 'not_provided'} action_flags=[${activeActionFlags.join(',')}]`);

          // ---- MESSAGE ARRAY — STRICT INJECTION ORDER ----
          // 1. Runtime context (temporal, tenant, matter, permissions, retrieval state)
          // 2. Architectural rules (immutable authority hierarchy)
          // 3. Mode-specific system prompt (behavioral instructions)
          // 4. Retrieval context / file content
          // 5. Structured data
          // 6. Matter summary
          // 7. Conversation history
          // 8. Current user message
          const messages: Array<{ role: string; content: any }> = [
            { role: 'system', content: runtimeContextMessage },
            { role: 'system', content: architecturalRulesMessage },
            { role: 'system', content: systemPrompt }
          ];

          // Add RAG context or legacy files
          // hasCsvIntent: classifier detected a CSV-specific intent
          const classifierCsvIntent = csvDatasets.length > 0 && classification.structured_intents.some(
            (si: any) => si.type === 'csv_query' || si.type === 'csv_summary'
          );
          // hasCsvData: CSV datasets exist (even if classifier didn't detect csv_query)
          const hasCsvData = csvDatasets.length > 0;
          // hasCsvIntent: true when either classifier detected it OR datasets exist
          // (we always want the RAG caveat when CSV data is available)
          const hasCsvIntent = classifierCsvIntent || hasCsvData;
          if (ragResult.contextContent) {
            let ragPreamble = 'CURRENT RETRIEVAL CONTEXT — These are the document excerpts retrieved for THIS query. Use ONLY these as citation sources. Each excerpt is tagged with "--- From: [filename] ---".';
            if (hasCsvData) {
              ragPreamble += '\n\n⚠️ IMPORTANT: These are TEXT excerpts only. For ANY quantitative question (amounts, counts, totals, sums, "how much", "how many", "show all", "list"), IGNORE these excerpts entirely and use the query_csv tool. Text excerpts contain incomplete summaries — only the query_csv tool returns exact, computed results from the full dataset.';
            }
            messages.push({ role: 'user', content: `${ragPreamble}\n\n${ragResult.contextContent}` });
            messages.push({ role: 'assistant', content: 'I have reviewed the relevant document excerpts. How can I assist you?' });
          } else if (body.files && body.files.length > 0) {
            let filesContent = "You have access to the following case documents.\n\n";
            for (const file of body.files) {
              if (file.mimeType.startsWith('text/') || file.mimeType === 'application/csv') {
                filesContent += `\n--- BEGIN FILE: ${file.name} ---\n${file.data}\n--- END FILE ---\n`;
              } else {
                filesContent += `\n[File: ${file.name} (${file.mimeType}) - binary content]\n`;
              }
            }
            messages.push({ role: 'user', content: filesContent });
            messages.push({ role: 'assistant', content: 'I have reviewed the case documents. How can I assist you?' });
          }

          // Add inline chat attachment context (text extraction + Vision results from Express backend)
          if (body.attachment_context) {
            const attCount = body.chat_attachments?.length || 0;
            messages.push({ role: 'user', content: `The user has attached ${attCount} file(s) to this message. Here is the extracted content:\n\n${body.attachment_context}` });
            messages.push({ role: 'assistant', content: `I have reviewed the ${attCount} attached file(s). I'll use their content to answer your question.` });
          }

          // Add structured matter intelligence if available
          if (structuredResult.content) {
            messages.push({ role: 'user', content: `The following structured intelligence was extracted from the matter's documents. Use this data to provide precise, data-driven answers. Cite specific data points when relevant.\n${structuredResult.content}` });
            messages.push({ role: 'assistant', content: `I have access to ${structuredResult.dataPoints} structured data points covering: ${structuredResult.intentsResolved.join(', ')}. I'll use this alongside document context to answer your question.` });
          }

          // Auto-inject matter summary as background context (if not already from structured data)
          if (matterSummaryContext) {
            messages.push({ role: 'user', content: `The following is background context about this matter for your awareness. Use it to inform your answers but don't recite it unless directly relevant.\n${matterSummaryContext}` });
            messages.push({ role: 'assistant', content: 'I have reviewed the matter background context and will use it to inform my analysis.' });
          }

          // Add history with source isolation boundary
          if (body.history.length > 0) {
            messages.push({ role: 'system', content: '--- CONVERSATION HISTORY BELOW ---\nThe following messages are from earlier in this conversation. They provide conversational context only.\n⚠ IMPORTANT: File names, document references, and sources mentioned in the history below are from PREVIOUS turns. Do NOT use them as citation sources for NEW answers. Only cite documents from the CURRENT RETRIEVAL CONTEXT (the document excerpts provided above, marked "--- From: filename ---").' });
            for (const msg of body.history) {
              let content = msg.content;
              // Strip **Sources:** sections from assistant history to prevent source name bleeding
              if (msg.role === 'assistant') {
                content = content.replace(/\n*\*\*Sources?:\*\*[\s\S]*$/i, '');
              }
              messages.push({ role: msg.role === 'user' ? 'user' : 'assistant', content });
            }
            messages.push({ role: 'system', content: '--- END CONVERSATION HISTORY ---\nAnswer the NEXT user message using ONLY the CURRENT RETRIEVAL CONTEXT for source citations. Never cite files mentioned only in history.' });

            // ── WORKING DOCUMENT INJECTION ──
            // If conversation history contains a substantial draft/document, extract it
            // and inject as a dedicated WORKING DOCUMENT. This ensures that when the user
            // asks for modifications, the AI treats the prior draft as the base to edit
            // (not just vague context). Applies to ANY edit/modification scenario.
            const workingDoc = findWorkingDocument(body.history);
            if (workingDoc) {
              console.log(`[WORKING_DOC] Found draft: "${workingDoc.title}" (${workingDoc.content.length} chars)`);
              messages.push({ role: 'system', content: `--- WORKING DOCUMENT ---\nThe following is the most recent document/draft from this conversation. If the user asks to modify, edit, revise, or update it, use THIS as the base. Make ONLY the requested changes and preserve everything else exactly.\n\nTitle: ${workingDoc.title}\n\n${workingDoc.content}\n--- END WORKING DOCUMENT ---` });
            }
          }

          // When CSV intent is detected, inject a strong reminder right before the
          // user's question to prevent the LLM from answering with RAG text.
          if (classifierCsvIntent) {
            messages.push({ role: 'system', content: 'CRITICAL INSTRUCTION: The next user message asks about structured data (CSV/Excel). You MUST call the query_csv tool BEFORE answering. Do NOT synthesize an answer from document excerpts or conversation history. Call query_csv with appropriate filters/aggregations and present the tool\'s computed results.' });
          } else if (hasCsvData) {
            // Gentler reminder: datasets exist but classifier didn't detect csv_query.
            // Encourage the model to check CSV for counting/listing questions.
            messages.push({ role: 'system', content: 'REMINDER: CSV/Excel datasets are available via the query_csv tool. If the next question involves counting, listing, frequencies, dates, amounts, or any data that could be in a spreadsheet, call query_csv to check the structured data before answering. Users may use general terms like "meetings", "events", or "entries" to refer to rows in the dataset.' });
          }
          // Inject pipeline-specific system prompt if available
          if (pipelineConfig?.systemPromptAddition) {
            messages.push({ role: 'system', content: pipelineConfig.systemPromptAddition });
          }

          messages.push({ role: 'user', content: body.message });

          // ---- STEP 4: LLM CALL (substantive only if reasoning/RAG was used) ----
          t('pre-llm');
          emitState(encoder, controller, 'synthesizing_response', undefined, substantiveProcessing);

          const selectedModel = getModel(modelTier, classification.complexity === 'drafting' ? 'drafting' : 'synthesis');

          const openaiRequestBody: any = {
            model: selectedModel.model,
            messages,
            temperature: modelTemperature,
            stream: true,
          };
          // Hoist csvIsPrimaryIntent so it's accessible in tool loop follow-up logic
          // csvIsPrimaryIntent requires classifier to explicitly detect csv_query
          // (gentler CSV reminder handles cases where classifier misses it)
          const csvIsPrimaryIntent = classifierCsvIntent && classification.structured_intents.some(
            (si: any) => si.type === 'csv_query'
          );
          if (enableTools) {
            // Use pipeline-specific tool set
            const pipelineToolSet = getToolsForPipeline(agentTaskType, HORIZON_TOOLS);
            openaiRequestBody.tools = pipelineToolSet;
            // When csv_query is the primary intent, force the model to call a tool
            openaiRequestBody.tool_choice = csvIsPrimaryIntent ? 'required' : 'auto';
            if (csvIsPrimaryIntent) console.log('[CSV_TOOL_FORCE] tool_choice=required — csv_query is primary intent');
          }

          let openaiResponse: Response;
          try {
            openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiApiKey}` },
              body: JSON.stringify(openaiRequestBody),
              signal: AbortSignal.timeout(60_000), // 60s timeout for initial LLM call
            });
          } catch (fetchErr: any) {
            console.error('OpenAI fetch error:', fetchErr.name || fetchErr.message);
            emitContent(encoder, controller, 'The request timed out while generating a response. Please try again with a simpler question.');
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }

          if (!openaiResponse.ok) {
            console.error('OpenAI error:', await openaiResponse.text());
            emitContent(encoder, controller, 'An error occurred while processing your request. Please try again.');
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }

          // ---- STREAM RESPONSE ----
          const reader = openaiResponse.body!.getReader();
          const decoder = new TextDecoder();
          let toolCalls: any[] = [];
          let hasToolCalls = false;
          const workingMessages = [...messages];
          let fullResponseText = ''; // Accumulate for verifier

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split('\n').filter(l => l.trim() !== '');

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6);
                if (data === '[DONE]') continue;
                try {
                  const parsed = JSON.parse(data);
                  const delta = parsed.choices?.[0]?.delta;

                  // Tool calls
                  if (delta?.tool_calls) {
                    hasToolCalls = true;
                    for (const tc of delta.tool_calls) {
                      if (tc.index !== undefined) {
                        if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: '', function: { name: '', arguments: '' } };
                        if (tc.id) toolCalls[tc.index].id = tc.id;
                        if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                        if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                      }
                    }
                    continue;
                  }

                  // Content — stream directly
                  const content = delta?.content;
                  if (content) {
                    emitContent(encoder, controller, content);
                    fullResponseText += content;
                  }
                } catch (_e) { /* skip invalid JSON */ }
              }
            }
          }

          // ---- TOOL EXECUTION (multi-round — pipeline-aware) ----
          t(`initial-llm-done tools=${hasToolCalls}`);
          // Track tool-discovered sources for citation emission
          const toolDiscoveredSources: Array<{ filename: string; similarity: number }> = [];
          const createdFolderNames = new Set<string>();
          let toolLoopEmittedAnyContent = false; // Track if ANY content was emitted during tool loop
          const MAX_TOOL_ROUNDS = pipelineConfig?.maxToolRounds || 2;
          const TOOL_LOOP_TIMEOUT_MS = MAX_TOOL_ROUNDS > 2 ? 45_000 : 30_000;
          const WALL_CLOCK_LIMIT_MS = 110_000; // 110s — leave margin before Supabase kills us at ~150s
          const toolLoopStart = Date.now();
          let toolRound = 0;
          let toolLoopTimedOut = false;
          let artifactCreatedThisRound = false;
          let totalToolCallsExecuted = 0;
          let lastCreatedFolderCaseId: string | null = null;

          while (hasToolCalls && toolCalls.length > 0 && toolRound < MAX_TOOL_ROUNDS) {
            // Safety: abort if tool loop or wall clock exceeded
            const wallElapsed = Date.now() - pipelineStart;
            if (Date.now() - toolLoopStart > TOOL_LOOP_TIMEOUT_MS || wallElapsed > WALL_CLOCK_LIMIT_MS) {
              console.warn(`[TOOL_LOOP] Timed out: tool_loop=${Date.now() - toolLoopStart}ms wall=${wallElapsed}ms round=${toolRound}`);
              toolLoopTimedOut = true;
              break;
            }
            toolRound++;
            console.log(`Processing ${toolCalls.length} tool call(s) — round ${toolRound}/${MAX_TOOL_ROUNDS}...`);
            substantiveProcessing = true;
            emitState(encoder, controller, 'executing_tools', undefined, true);

            const assistantMessage: any = {
              role: 'assistant',
              content: null,
              tool_calls: toolCalls.map((tc, idx) => ({ id: tc.id || `call_${idx}`, type: 'function', function: tc.function }))
            };
            workingMessages.push(assistantMessage);

            let toolActionsSummary = '';
            let csvToolCalledThisRound = false; // Track if query_csv was called
            let pendingActionCreatedInLoop = false; // Track if loop should stop for user confirmation

            // ── TOOL GATEWAY CONTEXT ──
            const gwContext: ToolGatewayContext = {
              tenantId: tenantMember?.tenant_id || '',
              userId: user.id,
              userRole: tenantMember?.role,
              matterId: body.case_id,
              jurisdiction: agentPlan?.jurisdiction?.value || undefined,
              sessionId: body.session_id,
              budgetRemaining: {
                tool_calls: (agentPlan?.execution_budget?.max_tool_calls || 8) - totalToolCallsExecuted,
                rounds: MAX_TOOL_ROUNDS - toolRound,
              },
              featureFlags: {},
            };

            for (const tc of toolCalls) {
              if (pendingActionCreatedInLoop) break; // Stop processing if awaiting confirmation
              let toolArgs = {};
              try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch (_e) {}
              console.log(`[TOOL_EXEC] ${tc.function.name} args=${JSON.stringify(toolArgs).substring(0, 200)}`);

              // ── TOOL GATEWAY CHECK (ALL tools through gateway — non-negotiable) ──
              const toolRequest: ToolRequest = { name: tc.function.name, args: toolArgs, reason: '' };
              const gwDecision = evaluateToolGateway(toolRequest, gwContext, body.message);
              console.log(`[GATEWAY] ${tc.function.name}: allowed=${gwDecision.allowed} reason="${gwDecision.reason}"`);

              // Emit gateway decision SSE event
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                type: 'tool_gateway',
                tool: tc.function.name,
                allowed: gwDecision.allowed,
                reason: gwDecision.reason,
                requires_confirmation: gwDecision.requires_confirmation || false,
              })}\n\n`));

              // Log to agent_tasks audit table
              if (agentRunId && tenantMember?.tenant_id) {
                // Fire audit log async — don't block tool execution
                logAgentTask(supabaseClient, agentRunId, tenantMember.tenant_id, {
                  tool_name: tc.function.name,
                  tool_args: toolArgs,
                  gateway_decision: gwDecision,
                  round: toolRound,
                }).catch(() => {});
              }

              if (!gwDecision.allowed) {
                if (gwDecision.requires_confirmation && body.session_id) {
                  // Gateway requires user confirmation → create PendingAction, stop loop
                  await createPendingAction(supabaseClient, body.session_id, {
                    action_type: 'tool_confirmation',
                    tool_name: tc.function.name,
                    tool_args: gwDecision.modified_args || toolArgs,
                    requires_confirmation: true,
                    user_prompt_summary: body.message.substring(0, 200),
                  });
                  const confirmText = gwDecision.confirmation_prompt || `I need your confirmation to execute **${tc.function.name}**. Shall I proceed?`;
                  emitContent(encoder, controller, confirmText);
                  pendingActionCreatedInLoop = true;

                  // Return denial to LLM so it knows the tool was blocked
                  workingMessages.push({ role: 'tool', tool_call_id: tc.id || `call_${toolCalls.indexOf(tc)}`, content: JSON.stringify({ success: false, error: 'Awaiting user confirmation' }) } as any);
                  continue;
                }

                // Gateway denied — return denial to LLM
                const denialResult = { success: false, error: `Gateway denied: ${gwDecision.reason}` };
                workingMessages.push({ role: 'tool', tool_call_id: tc.id || `call_${toolCalls.indexOf(tc)}`, content: JSON.stringify(denialResult) } as any);

                // Update audit log with denial
                if (agentRunId && tenantMember?.tenant_id) {
                  logAgentTask(supabaseClient, agentRunId, tenantMember.tenant_id, {
                    tool_name: tc.function.name,
                    tool_args: toolArgs,
                    gateway_decision: gwDecision,
                    execution_result: { success: false, error: gwDecision.reason },
                    round: toolRound,
                  }).catch(() => {});
                }
                continue;
              }

              // Gateway allowed — execute tool (use modified_args if gateway adjusted them)
              const effectiveArgs = gwDecision.modified_args || toolArgs;
              if (tc.function.name === 'query_csv') csvToolCalledThisRound = true;
              const toolResult = await executeTool(tc.function.name, effectiveArgs, toolContext);
              const toolResultStr = JSON.stringify(toolResult);
              console.log(`[TOOL_RESULT] ${tc.function.name} success=${toolResult.success} result_len=${toolResultStr.length}`);
              workingMessages.push({ role: 'tool', tool_call_id: tc.id || `call_${toolCalls.indexOf(tc)}`, content: toolResultStr } as any);
              if (toolResult.success) toolActionsSummary += `- ${toolResult.result?.message || tc.function.name}\n`;

              if (tc.function.name === 'create_folder' && toolResult.success) {
                const ea: any = effectiveArgs as any;
                const createdName = toolResult.result?.folder?.name || ea?.name || ea?.folder_name;
                if (createdName) createdFolderNames.add(String(createdName));
                const createdCaseId = toolResult.result?.folder?.case_id || ea?.case_id || null;
                if (createdCaseId) lastCreatedFolderCaseId = String(createdCaseId);
              }

              // Decrement budget
              totalToolCallsExecuted++;

              // Update audit log with execution result
              if (agentRunId && tenantMember?.tenant_id) {
                logAgentTask(supabaseClient, agentRunId, tenantMember.tenant_id, {
                  tool_name: tc.function.name,
                  tool_args: effectiveArgs,
                  gateway_decision: gwDecision,
                  execution_result: { success: toolResult.success, error: toolResult.error },
                  round: toolRound,
                }).catch(() => {});
              }

              // Emit tool_progress SSE event for each successful tool
              if (toolResult.success) {
                const progressMsg = toolResult.result?.message || `${tc.function.name} completed`;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tool_progress', tool: tc.function.name, round: toolRound + 1, message: progressMsg })}\n\n`));
              }

              // Emit artifact event when a legal document is created
              if (tc.function.name === 'create_legal_document' && toolResult.success && toolResult.result?.artifact_id) {
                artifactCreatedThisRound = true;
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'artifact', artifact_id: toolResult.result.artifact_id, title: toolResult.result.title, document_type: toolResult.result.document_type })}\n\n`));
              }

              if (tc.function.name === 'search_documents' && toolResult.success && toolResult.result?.results) {
                for (const r of toolResult.result.results) {
                  if (r.filename) {
                    toolDiscoveredSources.push({ filename: r.filename, similarity: r.similarity || 0.5 });
                  }
                }
                // Emit corrected state — tools DID find content
                if (toolResult.result.count > 0) {
                  emitState(encoder, controller, 'context_retrieved',
                    `${toolResult.result.count} document(s) found via search`, true);
                }
              }
            }

            // If a PendingAction was created, stop the tool loop entirely
            if (pendingActionCreatedInLoop) {
              if (agentRunId) {
                await updateAgentRun(supabaseClient, agentRunId, {
                  status: 'awaiting_confirmation',
                  metadata: { paused_at_round: toolRound },
                });
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              clearInterval(heartbeat);
              try { controller.close(); } catch (_) {}
              return;
            }

            // Deterministic completion guard for two-step nested folder requests.
            // If user asked: create parent then child inside parent, and only parent
            // was created so far, execute child creation directly.
            if (agentTaskType === 'workspace_management') {
              const nested = extractNestedFolderIntent(body.message);
              if (nested && createdFolderNames.has(nested.parent) && !createdFolderNames.has(nested.child)) {
                console.log(`[WORKSPACE_GUARD] Completing nested folder request: child="${nested.child}" parent="${nested.parent}"`);
                const autoArgs: Record<string, any> = {
                  name: nested.child,
                  parent_folder_name: nested.parent,
                };
                if (body.case_id) autoArgs.case_id = body.case_id;
                else if (lastCreatedFolderCaseId) autoArgs.case_id = lastCreatedFolderCaseId;
                else if (body.case_name) autoArgs.case_name = body.case_name;

                const autoResult = await executeTool('create_folder', autoArgs, toolContext);
                const autoResultStr = JSON.stringify(autoResult);
                workingMessages.push({ role: 'tool', tool_call_id: `auto_nested_${toolRound}`, content: autoResultStr } as any);

                if (autoResult.success) {
                  createdFolderNames.add(nested.child);
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'tool_progress', tool: 'create_folder', round: toolRound + 1, message: autoResult.result?.message || `Created folder "${nested.child}" successfully.` })}\n\n`));
                } else {
                  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'warning', code: 'nested_folder_create_failed', message: autoResult.error || `Failed to create nested folder "${nested.child}".` })}\n\n`));
                }
              }
            }

            // Follow-up call — trim history to keep tokens manageable
            // Full history was in the initial call; follow-ups only need
            // system prompt + recent context + tool results
            const trimmedMessages = workingMessages.length > 12
              ? [workingMessages[0], ...workingMessages.slice(-10)] // system + last 10
              : workingMessages;

            // After CSV tool execution, replace any CSV-related system messages
            // with a synthesis directive — the tool has already run.
            // This applies whenever query_csv was actually called, regardless of
            // whether the classifier detected csv_query as the primary intent.
            if (csvToolCalledThisRound || csvIsPrimaryIntent) {
              for (let mi = 0; mi < trimmedMessages.length; mi++) {
                const m = trimmedMessages[mi];
                if (m.role === 'system' && typeof m.content === 'string' &&
                    (m.content.includes('CRITICAL INSTRUCTION') || m.content.includes('REMINDER: CSV'))) {
                  trimmedMessages[mi] = {
                    role: 'system',
                    content: 'The query_csv tool has already been executed and the results are in the conversation above. ' +
                      'NOW you must format those results into a clear, well-organized response. ' +
                      'Do NOT call any more tools. Present the data directly to the user.'
                  };
                  break;
                }
              }
            }

            // Truncate large tool results to prevent context overflow & timeouts
            for (let mi = 0; mi < trimmedMessages.length; mi++) {
              const m = trimmedMessages[mi];
              if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 6000) {
                try {
                  const parsed = JSON.parse(m.content);
                  if (parsed.result?.rows && parsed.result.rows.length > 15) {
                    const truncatedRows = parsed.result.rows.slice(0, 15);
                    parsed.result.rows = truncatedRows;
                    parsed.result._truncated = true;
                    parsed.result._truncatedNote = `Showing first 25 of ${parsed.result.total_matches || 'many'} rows. The total_matches count above reflects ALL matching rows.`;
                    trimmedMessages[mi] = { ...m, content: JSON.stringify(parsed) };
                    console.log(`[TOOL_LOOP] Truncated tool result from ${m.content.length} to ${trimmedMessages[mi].content.length} chars`);
                  }
                } catch (_e) { /* not JSON or no rows — leave as-is */ }
              }
            }

            // When RAG already found context, remove search_documents from tools
            // to prevent redundant tool calls that add 10-20s each.
            // When CSV tool ran OR CSV was primary intent, remove ALL tools to force text output.
            // When artifact was created, stop tool calls — task is complete.
            const csvToolRan = csvToolCalledThisRound || csvIsPrimaryIntent;
            const taskComplete = artifactCreatedThisRound;
            const pipelineToolSet = getToolsForPipeline(agentTaskType, HORIZON_TOOLS);
            const followUpTools = (toolRound >= MAX_TOOL_ROUNDS || csvToolRan || taskComplete) ? undefined
              : (ragResult.contextContent.length > 0
                ? pipelineToolSet.filter((t: any) => t.function.name !== 'search_documents')
                : pipelineToolSet);

            // When tools are removed, add synthesis instruction.
            // Vary instruction based on whether an artifact was created.
            if (!followUpTools) {
              const synthesisInstruction = artifactCreatedThisRound
                ? 'A legal document artifact has been created and is ready for download. Provide a brief summary of what was drafted, key points included, and mention that the user can download it as Word or PDF using the buttons below.'
                : 'You have all the information needed. Format the tool results above into a clear, well-structured response for the user. Use Markdown tables for tabular data. Include totals and summaries. Do not attempt any tool calls — just present the data.';
              trimmedMessages.push({ role: 'system', content: synthesisInstruction });
            } else if (toolRound < MAX_TOOL_ROUNDS - 1) {
              // Multi-round reasoning injection: guide the model on what to do next
              trimmedMessages.push({
                role: 'system',
                content: `Tool round ${toolRound}/${MAX_TOOL_ROUNDS} complete. Review the results so far. If you have sufficient information to answer the user's question, generate your response now. If more research is needed, make targeted follow-up tool calls. Do not repeat searches you've already done.`
              });
            }

            try {
              const followUpResponse = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiApiKey}` },
                body: JSON.stringify({
                  model: selectedModel.model,
                  messages: trimmedMessages,
                  temperature: modelTemperature,
                  stream: true,
                  tools: followUpTools?.length ? followUpTools : undefined,
                  tool_choice: followUpTools?.length ? 'auto' : undefined,
                }),
                signal: AbortSignal.timeout(30_000), // 30s timeout for follow-up
              });

              // Reset for next round
              toolCalls = [];
              hasToolCalls = false;

              if (followUpResponse.ok) {
                const followUpReader = followUpResponse.body!.getReader();
                let followUpEmittedContent = false;
                while (true) {
                  const { done, value } = await followUpReader.read();
                  if (done) break;
                  const chunk = decoder.decode(value, { stream: true });
                  const lines = chunk.split('\n').filter(l => l.trim() !== '');
                  for (const line of lines) {
                    if (line.startsWith('data: ')) {
                      const data = line.slice(6);
                      if (data === '[DONE]') continue;
                      try {
                        const parsed = JSON.parse(data);
                        const delta = parsed.choices?.[0]?.delta;

                        // Check for new tool calls in follow-up (multi-round)
                        if (delta?.tool_calls && toolRound < MAX_TOOL_ROUNDS) {
                          hasToolCalls = true;
                          for (const tc of delta.tool_calls) {
                            if (tc.index !== undefined) {
                              if (!toolCalls[tc.index]) toolCalls[tc.index] = { id: '', function: { name: '', arguments: '' } };
                              if (tc.id) toolCalls[tc.index].id = tc.id;
                              if (tc.function?.name) toolCalls[tc.index].function.name += tc.function.name;
                              if (tc.function?.arguments) toolCalls[tc.index].function.arguments += tc.function.arguments;
                            }
                          }
                          continue;
                        }

                        const content = delta?.content;
                        if (content) {
                          emitContent(encoder, controller, content);
                          fullResponseText += content;
                          followUpEmittedContent = true;
                        }
                      } catch (_e) {}
                    }
                  }
                }
                // If tool executed but follow-up produced no content, emit a fallback
                if (followUpEmittedContent) toolLoopEmittedAnyContent = true;
                if (!followUpEmittedContent && !hasToolCalls) {
                  console.warn(`[TOOL_LOOP] Follow-up produced no content after round ${toolRound}`);
                }
              } else {
                console.error(`[TOOL_LOOP] Follow-up OpenAI call failed: ${followUpResponse.status}`);
                const errBody = await followUpResponse.text().catch(() => 'unknown');
                console.error(`[TOOL_LOOP] Error body: ${errBody.substring(0, 200)}`);
                break; // Exit tool loop on API error
              }
            } catch (followUpErr: any) {
              console.error(`[TOOL_LOOP] Follow-up call error (round ${toolRound}):`, followUpErr.name || followUpErr.message);
              // On timeout or network error, exit the tool loop gracefully
              toolLoopTimedOut = followUpErr.name === 'TimeoutError' || followUpErr.name === 'AbortError';
              break;
            }

            // If no new tool calls were generated, exit the loop
            if (!hasToolCalls || toolCalls.length === 0) break;
          }

          if (toolRound > 1) {
            console.log(`Multi-round tool execution completed: ${toolRound} rounds`);
          }

          // If tool loop timed out, emit a fallback with any data we collected
          if (toolLoopTimedOut && !toolLoopEmittedAnyContent) {
            // Try to extract a brief summary from tool results
            let briefData = '';
            for (const m of workingMessages) {
              if (m.role === 'tool' && typeof m.content === 'string') {
                try {
                  const parsed = JSON.parse(m.content);
                  if (parsed.result?.total_matches) {
                    briefData += `Found ${parsed.result.total_matches} matching records. `;
                  }
                  if (parsed.result?.aggregation) {
                    briefData += JSON.stringify(parsed.result.aggregation) + ' ';
                  }
                } catch (_e) {}
              }
            }
            emitContent(encoder, controller,
              briefData
                ? `Here's what I found before the time limit: ${briefData.trim()} For the full breakdown, try asking for specific details (e.g., "show the first 10 billing entries for Lyndsy").`
                : 'The query took too long to complete. Please try a more specific question (e.g., "show the first 10 entries" instead of "show them all").'
            );
          }
          // Global fallback: if tools ran but no content was ever emitted to the user
          const wallClockElapsed = Date.now() - pipelineStart;
          if (toolRound > 0 && !toolLoopEmittedAnyContent && !toolLoopTimedOut && wallClockElapsed < WALL_CLOCK_LIMIT_MS) {
            console.warn(`[TOOL_LOOP] Tools ran (${toolRound} round(s)) but no content emitted — generating fallback (wall=${wallClockElapsed}ms)`);
            // Build clean messages from scratch — the complex history with tool_calls
            // confuses models. Extract just the tool results and user question.
            try {
              // Collect all tool results from workingMessages
              let toolDataSummary = '';
              for (const m of workingMessages) {
                if (m.role === 'tool' && typeof m.content === 'string') {
                  try {
                    const parsed = JSON.parse(m.content);
                    if (parsed.result) {
                      const rows = parsed.result.rows;
                      const total = parsed.result.total_matches;
                      if (rows && rows.length > 0) {
                        // Include first 20 rows as context
                        const displayRows = rows.slice(0, 20);
                        toolDataSummary += `\nDataset: ${parsed.result.dataset_name || 'unknown'}\n`;
                        toolDataSummary += `Total matches: ${total || rows.length}\n`;
                        toolDataSummary += `Columns: ${Object.keys(displayRows[0]).join(', ')}\n`;
                        toolDataSummary += `Data:\n${JSON.stringify(displayRows, null, 1)}\n`;
                      } else if (parsed.result.aggregation) {
                        toolDataSummary += `\nAggregation: ${JSON.stringify(parsed.result.aggregation)}\n`;
                      } else {
                        toolDataSummary += `\nTool result: ${JSON.stringify(parsed.result).substring(0, 2000)}\n`;
                      }
                    }
                  } catch (_e) {
                    toolDataSummary += `\nRaw result: ${m.content.substring(0, 2000)}\n`;
                  }
                }
              }

              // Extract user question (last user message)
              const userQuestion = body.message;
              // Get conversation context from history
              const historyContext = (body.history || [])
                .slice(-4)
                .map((h: any) => `${h.role}: ${h.content}`)
                .join('\n');

              const fallbackMessages = [
                {
                  role: 'system',
                  content: 'You are a legal data assistant. The user asked a question and a database query tool was executed. ' +
                    'Format the tool results below into a clear, readable response for the user. ' +
                    'Use tables (Markdown) when listing multiple entries. Always include totals/counts when relevant.'
                },
                {
                  role: 'user',
                  content: (historyContext ? `Previous conversation:\n${historyContext}\n\n` : '') +
                    `User question: "${userQuestion}"\n\n` +
                    `Tool query results:\n${toolDataSummary || 'No data returned from the query.'}`
                }
              ];

              console.log(`[TOOL_LOOP_FALLBACK] Sending clean fallback with ${toolDataSummary.length} chars of data`);
              const fallbackResp = await fetch('https://api.openai.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiApiKey}` },
                body: JSON.stringify({
                  model: selectedModel.model,
                  messages: fallbackMessages,
                  temperature: modelTemperature,
                  stream: true,
                }),
                signal: AbortSignal.timeout(25_000), // 25s — tight budget for fallback
              });
              if (fallbackResp.ok) {
                const fbReader = fallbackResp.body!.getReader();
                let fallbackEmitted = false;
                while (true) {
                  const { done, value } = await fbReader.read();
                  if (done) break;
                  const chunk = decoder.decode(value, { stream: true });
                  for (const line of chunk.split('\n').filter(l => l.trim())) {
                    if (line.startsWith('data: ') && line.slice(6) !== '[DONE]') {
                      try {
                        const parsed = JSON.parse(line.slice(6));
                        const c = parsed.choices?.[0]?.delta?.content;
                        if (c) { emitContent(encoder, controller, c); fullResponseText += c; fallbackEmitted = true; }
                      } catch (_e) {}
                    }
                  }
                }
                if (!fallbackEmitted) {
                  console.warn('[TOOL_LOOP_FALLBACK] Fallback LLM returned 200 but emitted no content');
                  emitContent(encoder, controller, 'The tool returned data but the response could not be formatted. Please try rephrasing your question.');
                }
              } else {
                const fbErrBody = await fallbackResp.text().catch(() => 'unknown');
                console.error(`[TOOL_LOOP_FALLBACK] OpenAI error ${fallbackResp.status}: ${fbErrBody.substring(0, 300)}`);
                emitContent(encoder, controller, 'The query was processed but could not generate a summary. Please try again.');
              }
            } catch (fbErr: any) {
              console.error('[TOOL_LOOP_FALLBACK] Error:', fbErr.name || fbErr.message);
              emitContent(encoder, controller, 'The query was processed but the response timed out. Please try a more specific question.');
            }
          }

          // ---- POST-TOOL FALLBACK ASSESSMENT ----
          // Now that tools have executed, assess if ANY data source found content.
          // If RAG found nothing AND tools found nothing → emit fallback.
          const toolFoundContent = toolDiscoveredSources.length > 0;
          if (ragResult.filesSearched === 0 && !toolFoundContent && shouldRunRAG) {
            emitState(encoder, controller, 'no_documents_found', undefined, true);
          }
          const fallbackNeeded = assessFallbackNeeded(ragResult, structuredResult, authorityRouting)
            && !toolFoundContent; // Tools found content → no fallback needed
          if (fallbackNeeded) {
            authorityRouting.fallbackRequired = true;
            emitState(encoder, controller, 'authority_fallback',
              'No internal data found — general knowledge may be used with explicit labelling', true);
          }

          // ---- HYBRID VERIFIER (runs after response generation) ----
          // ruleVerify always runs; llmVerify only for HIGH risk.
          // Max 1 verifier retry per user turn (non-negotiable).
          let verifierResult: VerifierResult | null = null;
          if (fullResponseText.length > 50 && substantiveProcessing) {
            const retrievedDocNames = new Set<string>();
            for (const chunk of ragResult.sourceChunks) {
              if (chunk.metadata?.filename) retrievedDocNames.add(chunk.metadata.filename);
            }
            for (const ts of toolDiscoveredSources) {
              retrievedDocNames.add(ts.filename);
            }

            const planIntent = agentPlan?.intent || classification.suggested_mode || 'other';
            const citationsReq = agentPlan?.citations_required ?? (!!body.case_id && ragResult.sourceChunks.length > 0);

            // Phase 1: Rule-based verification (always runs, zero latency)
            verifierResult = ruleVerify({
              responseText: fullResponseText,
              citationsRequired: citationsReq,
              retrievedDocNames,
              hasActiveMatter: !!body.case_id,
              intent: planIntent,
            });
            console.log(`[VERIFIER] Rule: verdict=${verifierResult.verdict} risk=${verifierResult.risk_level} reasons=${verifierResult.reasons.length}`);

            // Phase 2: LLM verification (only for HIGH risk — gated by RiskScorer)
            if (verifierResult.risk_level === 'HIGH') {
              const llmResult = await llmVerify(
                fullResponseText.substring(0, 3000),
                ragResult.contextContent.substring(0, 4000),
                openaiApiKey,
              );
              console.log(`[VERIFIER] LLM: verdict=${llmResult.verdict} reasons=${llmResult.reasons.length}`);

              // Merge LLM reasons into rule verifier result
              if (llmResult.verdict === 'fail') {
                verifierResult.verdict = 'fail';
                verifierResult.reasons = [...verifierResult.reasons, ...llmResult.reasons];
                verifierResult.retry_hint = llmResult.retry_hint || verifierResult.retry_hint;
              }
            }

            // Emit verification result (if issues found)
            if (verifierResult.verdict === 'fail') {
              console.warn(`[VERIFIER] Failed: ${verifierResult.reasons.join('; ')}`);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({
                type: 'verification',
                verdict: 'fail',
                reasons: verifierResult.reasons,
                risk_level: verifierResult.risk_level,
              })}\n\n`));
            }
          }

          // ---- UPDATE AGENT RUN (audit log finalization) ----
          if (agentRunId) {
            await updateAgentRun(supabaseClient, agentRunId, {
              status: verifierResult?.verdict === 'fail' ? 'completed_with_warnings' : 'completed',
              verification_report: verifierResult || undefined,
              metadata: {
                tool_rounds: toolRound,
                intent: agentPlan?.intent,
                model_tier: modelTier,
                response_length: fullResponseText.length,
              },
            });
          }

          // ---- MODE TELEMETRY ----
          t(`pipeline-done tool_rounds=${toolRound}`);
          if (modeKey !== 'general' || classification.suggested_mode) {
            console.log(`[MODE_TELEMETRY] mode=${modeKey} detected=${classification.suggested_mode || 'none'} model=${modelTier} rag=${shouldRunRAG} sources=${ragResult.sourceChunks.length} tool_sources=${toolDiscoveredSources.length} structured=${structuredResult.dataPoints} intents=[${structuredResult.intentsResolved.join(',')}] sub_options=[${subOptions.join(',')}] user=${user.id}`);
          }

          // ---- AUTHORITY AUDIT LOG (enterprise requirement) ----
          console.log(`[AUTHORITY_AUDIT] query="${body.message.substring(0, 80)}" classification=${classification.domain}/${classification.complexity} search_intent=${classification.search_intent} authority=${authorityRouting.primaryAuthority} reason="${authorityRouting.routingReason}" rag_executed=${shouldRunRAG && !structuredFullyResolved} rag_sources=${ragResult.sourceChunks.length} structured_db=${structuredResult.dataPoints > 0} fallback=${authorityRouting.fallbackRequired} user=${user.id}`);

          // ---- EMIT SOURCES ----
          // RAG sources: high-confidence only (>= 0.45 similarity)
          const relevantSources = ragResult.sourceChunks
            .filter(c => c.similarity >= 0.45)
            .map(c => ({
              filename: c.metadata?.filename || 'Unknown',
              chunk_index: c.metadata?.chunk_index,
              similarity: c.similarity,
            }));
          // Merge tool-discovered sources (the LLM explicitly used them in its answer)
          const allSources = [...relevantSources];
          for (const ts of toolDiscoveredSources) {
            // Avoid duplicates — tool may have found same files as RAG
            if (!allSources.some(s => s.filename === ts.filename)) {
              allSources.push({ filename: ts.filename, chunk_index: 0, similarity: ts.similarity });
            }
          }
          if (allSources.length > 0) {
            emitSources(encoder, controller, allSources);
          }

          // ---- EMIT VALIDATION METADATA ----
          // Only emit validation when there are genuine absence warnings.
          // NEVER expose "low confidence" when documents or structured data contributed.
          if (substantiveProcessing) {
            const validation = assessContextConfidence(ragResult, structuredResult, classification);
            const hasContributingData = allSources.length > 0 || structuredResult.dataPoints > 0 || toolFoundContent;
            // Only emit validation if there's a real absence issue AND no data contributed
            if (!hasContributingData && validation.warnings.length > 0) {
              emitValidation(encoder, controller, {
                confidence: validation.confidence,
                has_document_context: false,
                has_structured_data: structuredResult.dataPoints > 0,
                data_points_used: structuredResult.dataPoints,
                source_count: allSources.length,
                warnings: validation.warnings,
              });
            }
            // Log validation internally regardless (for debugging, not user-facing)
            console.log(`[VALIDATION_INTERNAL] confidence=${validation.confidence} contributing_sources=${allSources.length} tool_sources=${toolDiscoveredSources.length} structured=${structuredResult.dataPoints} warnings=[${validation.warnings.join('; ')}]`);
          }

          // ── CREDIT DEDUCTION (substantive pipeline) ──
          if (tenantMember?.tenant_id) {
            try {
              // Classify the task weight based on mode, RAG usage, and document count
              const hasRagContent = ragResult && (ragResult.sourceChunks?.length > 0 || ragResult.contextContent?.length > 0);
              const docCount = (body.file_ids?.length || 0) + (body.files?.length || 0);
              let opType = 'simple_query';
              let credits = 1;

              if (multiStageLevel === 'full' && ['legal_research', 'contract_review', 'multi_document'].includes(modeKey)) {
                opType = 'multi_stage'; credits = 8;
              } else if (multiStageLevel === 'limited' && ['legal_research', 'contract_review'].includes(modeKey)) {
                opType = 'heavy_rag'; credits = 5;
              } else if (hasRagContent && docCount > 2 && modeKey !== 'general') {
                opType = 'heavy_rag'; credits = 5;
              } else if (['multi_document', 'contract_review', 'legal_research'].includes(modeKey) && hasRagContent) {
                opType = 'heavy_rag'; credits = 5;
              } else if (hasRagContent) {
                opType = 'standard_rag'; credits = 2;
              } else if (effectiveDeepAnalysis) {
                opType = 'heavy_rag'; credits = 5;
              }

              const serviceClient = createClient(supabaseUrl ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
              await serviceClient.from('credit_usage').insert({
                tenant_id: tenantMember.tenant_id,
                user_id: user.id,
                session_id: null,
                case_id: body.case_id || null,
                operation_type: opType,
                credits_consumed: credits,
                metadata: { mode: modeKey, sub_options: subOptions, has_rag: !!hasRagContent, doc_count: docCount, multi_stage_level: multiStageLevel },
              });
              console.log(`[CREDITS] Deducted ${credits} credits (${opType}) for tenant ${tenantMember.tenant_id}`);
            } catch (e) { console.error('[CREDITS] Failed to deduct:', e); }
          }

          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        } catch (error) {
          console.error('Stream error:', error);
          // CRITICAL: Emit error to client so it doesn't hang forever
          try {
            const errMsg = error instanceof Error ? error.message : 'An unexpected error occurred';
            const safeMsg = errMsg.length > 200 ? errMsg.substring(0, 200) + '...' : errMsg;
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'error', content: `I encountered an issue processing your request. Please try again. (${safeMsg})` })}\n\n`));
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          } catch (_) { /* stream already closed */ }
        } finally {
          clearInterval(heartbeat);
          try { controller.close(); } catch (_) { /* already closed (e.g. conversational gate early return) */ }
        }
      },
    });

    return new Response(stream, {
      headers: { ...corsHeaders, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' },
    });

  } catch (error) {
    console.error('Edge function error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});