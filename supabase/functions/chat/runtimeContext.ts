// ============================================================================
// RUNTIME CONTEXT INJECTION — Deterministic system context for every LLM call
// Extracted into a separate module for testability.
// ============================================================================

export interface RuntimeContextInput {
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
export function buildRuntimeContext(ctx: RuntimeContextInput, nowOverride?: Date): string {
  const now = nowOverride || new Date();
  const utcISO = now.toISOString();
  const unixTimestamp = Math.floor(now.getTime() / 1000);

  // ── Temporal context ──────────────────────────────────────────
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

  // ── Tenant context ────────────────────────────────────────────
  const tenantBlock = `## TENANT CONTEXT
Tenant: ${ctx.tenantName || 'Unknown'}
Tenant ID: ${ctx.tenantId || 'unknown'}
Environment: ${ctx.environment}
Plan Tier: ${ctx.tenantPlan || 'standard'}`;

  // ── Matter / file selection context ────────────────────────────
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

  // ── Permission context ────────────────────────────────────────
  const accessScope = ctx.userRole === 'admin' || ctx.userRole === 'owner'
    ? 'full_workspace_access'
    : ctx.matterId ? 'full_matter_access' : 'workspace_read';
  const permissionBlock = `## PERMISSION CONTEXT
User Role: ${ctx.userRole || 'lawyer'}
Access Scope: ${accessScope}`;

  // ── Retrieval state indicators ────────────────────────────────
  const retrievalBlock = `## RETRIEVAL STATE
Retrieval Status: ${ctx.retrievalExecuted ? 'executed' : 'not_executed'}
Documents Retrieved: ${ctx.documentsRetrieved}
Structured Query Engine: ${ctx.structuredQueryExecuted ? 'activated' : 'inactive'}
Structured Data Points: ${ctx.structuredDataPoints}
CSV Engine: ${ctx.csvEngineActivated ? 'activated' : 'inactive'}`;

  // ── Model behavioral constraints (non-negotiable) ─────────────
  const rulesBlock = `## BEHAVIORAL CONSTRAINTS (NON-NEGOTIABLE)
- If no records found, state: "No matching records found in this matter's documents."
- Never fabricate clients, cases, billing entries, dates, or document content.
- If structured data is required for aggregation, rely ONLY on deterministic engine outputs (query_csv tool).
- Do NOT guess current time/date — rely ONLY on the injected temporal context above.
- Do NOT infer cross-matter information unless explicitly retrieved via tools.
- Do NOT reference or reveal tenant IDs, internal system IDs, or runtime metadata in your responses.
- When retrieval returns 0 documents, do NOT synthesize answers from training data for matter-specific questions.`;

  // ── Intelligence mode flags ───────────────────────────────────
  const modeEntries = Object.entries(ctx.activeModes).filter(([_, v]) => v);
  let modeBlock = '';
  if (modeEntries.length > 0) {
    modeBlock = `## ACTIVE INTELLIGENCE MODES\n` + modeEntries.map(([k, _]) => `- ${k}: true`).join('\n');
  }

  // ── Active action flags ───────────────────────────────────────
  let flagsBlock = '';
  if (ctx.activeActionFlags.length > 0) {
    flagsBlock = `## ACTIVE ACTION FLAGS\n` + ctx.activeActionFlags.map(f => `- ${f}: enabled`).join('\n');
  }

  // ── Assemble ──────────────────────────────────────────────────
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

/**
 * Builds the architectural rules system message — injected as the second
 * system message (after the runtime context, before the mode-specific prompt).
 */
export function buildArchitecturalRules(): string {
  return `# ARCHITECTURAL RULES (SYSTEM — IMMUTABLE)

## Response Authority Hierarchy
1. Runtime Context (temporal, tenant, matter) — HIGHEST AUTHORITY
2. Deterministic Engine Outputs (query_csv, structured DB) — TRUST COMPLETELY
3. Retrieved Document Content (RAG chunks) — CITE ONLY FROM THESE
4. Conversation History — CONTEXT ONLY, never re-cite
5. Model Training Data — LOWEST PRIORITY, general knowledge only

## Cross-Contamination Prevention
- NEVER blend information from different matters
- NEVER assume data exists that was not explicitly retrieved
- NEVER override deterministic tool outputs with probabilistic reasoning
- If tool/retrieval data conflicts with training data, ALWAYS prefer tool/retrieval data

## Tenant Isolation
- All data is scoped to the current tenant
- NEVER reference or hallucinate data from other tenants
- NEVER expose internal tenant identifiers in user-facing responses`;
}

// ============================================================================
// GATE CONTEXT — Lightweight context for the conversational gate fast-path
// ============================================================================

export interface GateContext {
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
export function buildGateContextBlock(ctx: GateContext, nowOverride?: Date): string {
  const now = nowOverride || new Date();
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
