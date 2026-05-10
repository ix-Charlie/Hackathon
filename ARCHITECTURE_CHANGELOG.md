# Architecture Changelog — Maks Horizon

> Living document. Every architectural change is logged here with date, rationale, and files affected.
> Reviewed May 10, 2026 (light refresh; entries not revalidated against code).

---

## [2026-03-09] Agentic Architecture Refactor — Phase 5: Wiring Complete

### What Changed (Implementation)
All agentic components from Phases 1-4 are now wired into the main handler:

1. **PendingAction check** (before conversational gate):
   - Reads `session_pending_actions` for active actions
   - `CONFIRMATION_PATTERN` match → consume action, execute stored tool, return
   - `MODIFICATION_PATTERN` match → expire, re-process pipeline
   - Unrelated message → expire (topic change)
   - Clarification actions → expire (user provided info, continue pipeline)

2. **Orchestrator replaces classifier** (general/auto mode):
   - `getOrchestratorPlan()` — gpt-4o-mini planning call using `buildOrchestratorPrompt()`
   - Returns `AgentPlan` with intent, tools_requested, clarifying_questions, execution_budget
   - `planToClassification()` bridge maps plan → QueryClassification for downstream compat
   - If plan has clarifying_questions → create `PendingAction(type=clarification)`, return
   - Falls back to `classifyQuery()` if orchestrator fails

3. **Tool Gateway in tool loop**:
   - Every `executeTool()` call is preceded by `evaluateToolGateway()` check
   - Denied tools return error to LLM (it can adjust approach)
   - Confirmation-required tools create `PendingAction(type=tool_confirmation)`, halt loop
   - Budget tracking via `gwContext.budgetRemaining`
   - Every decision logged to `agent_tasks` via `logAgentTask()`

4. **Hybrid Verifier after response**:
   - `fullResponseText` accumulated from all streaming phases
   - `ruleVerify()` runs always on substantive responses (>50 chars)
   - `scoreRisk()` determines HIGH/MED/LOW
   - `llmVerify()` runs only for HIGH risk (max 1 per turn)
   - Failure emits `verification` SSE event with reasons
   - Results logged to `agent_runs.verification_report`

5. **Audit logging**:
   - `createAgentRun()` at pipeline start (in else block)
   - `logAgentTask()` for each tool request/decision/execution
   - `updateAgentRun()` at pipeline end with status + verifier report

6. **New SSE events**:
   - `agent_plan` — intent, tools, budget (shown in research panel)
   - `tool_gateway` — per-tool allow/deny decision
   - `clarifying_questions` — questions list
   - `verification` — verifier verdict + reasons + risk level

### Files Modified
| File | Changes |
|------|---------|
| `functions/chat/index.ts` | PendingAction block, orchestrator planning, gateway in tool loop, verifier, audit, content accumulator |
| `functions/chat/prompts/orchestrator.ts` | Already created in Phase 1C (unchanged) |
| `services/openaiService.ts` | `StreamChunk` type expanded with 4 new event types + agentic properties |
| `App.tsx` | SSE chunk handlers for `agent_plan`, `tool_gateway`, `clarifying_questions`, `verification` |

### New Functions
| Function | Purpose |
|----------|---------|
| `planToClassification()` | Bridge: AgentPlan → QueryClassification for downstream compatibility |
| `getOrchestratorPlan()` | Orchestrator planning call (gpt-4o-mini) — replaces classifyQuery |

---

## [2026-03-09] Agentic Architecture Refactor — Phase 1

### Before (Classifier → Pipeline)
```
User Message
 → Conversational Gate (gpt-4o-mini, 4s)
 → Semantic Classifier (gpt-4o-mini) → picks 1 of 9 AgentTaskTypes
 → AGENT_PIPELINE_CONFIGS[type] → pre-filters tools (hard allowlist)
 → Authority Routing (code) → decides RAG yes/no
 → Parallel Retrieval (vector + structured + summary)
 → System Prompt Assembly (11 layers)
 → LLM Call (gpt-4o) with pipeline-filtered tools
 → Tool Loop (2-3 rounds, pre-approved tools only)
 → Stream Response
```

**Problems:**
- Misclassification → wrong pipeline → wrong tools → bad response
- "Sure/yes/do it" reclassified as chitchat (no pending action state)
- Tool visibility hard-gated by classifier output, not agent intelligence
- No citation verification, no retry on quality failure

### After (Hybrid Agentic + Tool Gateway)
```
User Message
 → [1] PendingAction Check (deterministic, pre-LLM)
       Confirmation ("sure") → execute stored action, skip pipeline
       Modification → update pending action args
       Unrelated → expire, proceed
 → [2] Conversational Gate (KEPT — cheap fast-path)
 → [3] Pre-classification Export Checks (KEPT — orthogonal)
 → [4] Orchestrator Agent (ONE LLM, sees ALL 16 tools)
       Produces AgentPlan JSON: intent, tools_requested[], budget, citations_required
       If clarifying_questions → store PendingAction(type=clarification), respond, STOP
       For each tool_request → Tool Gateway (deterministic) → allow/deny + audit
       Execute allowed tools → feed results back
       Agent integrates → may request more tools (max 3 rounds)
       Generates final response
 → [5] Hybrid Verifier
       RuleVerifier (always) → citations present? disclaimers? no hallucinated refs?
       RiskScorer (deterministic) → LOW/MED/HIGH
       LLMVerifier (HIGH risk only) → claim-support alignment
       If fail → retry once with hint
 → [6] Stream Response
```

### Components Added
| Component | File | Purpose |
|-----------|------|---------|
| `session_pending_actions` table | `migrations/036_session_pending_actions.sql` | Persistent multi-turn action state |
| Agentic interfaces | `functions/chat/index.ts` | `AgentPlan`, `ToolGatewayDecision`, `PendingAction`, `VerifierResult` |
| Orchestrator prompt | `functions/chat/prompts/orchestrator.ts` | Agent system prompt that produces plan JSON |
| `toolGateway()` | `functions/chat/index.ts` | Deterministic policy engine — allow/deny per tool |
| `ruleVerify()` | `functions/chat/index.ts` | Citation + disclaimer verification |
| `scoreRisk()` | `functions/chat/index.ts` | Deterministic risk scorer |
| `llmVerify()` | `functions/chat/index.ts` | Gated LLM verification for HIGH risk |
| Audit logging | `functions/chat/index.ts` | Logs to `agent_runs` + `agent_tasks` (migration 021) |

### Components Modified
| Component | Change |
|-----------|--------|
| `classifyQuery()` | Downgraded from hard-gate to optional hint (retained for structured_intents fallback) |
| `AGENT_PIPELINE_CONFIGS` | Deprecated — no longer gates tool access (kept as dead code for rollback) |
| Main handler flow | Rewritten: PendingAction check → Gate → Orchestrator → Gateway → Verifier |

### Components Preserved (unchanged)
- Conversational gate (cheap fast-path)
- Pre-classification export checks (file export shortcuts)
- Authority routing (now advisory — informs agent plan, doesn't dictate)
- RAG execution (vector search, structured DB, matter summary)
- All 16 tool implementations (`executeTool()`)
- SSE streaming infrastructure
- Credit deduction system

### Non-Negotiables
- PendingAction check runs BEFORE any LLM call
- ALL tool execution goes through `toolGateway()` — no direct `executeTool()` calls from loop
- Hard caps: max 3 rounds, max 1 verifier retry per user turn
- Tool Gateway logs every request/decision/execution to `agent_tasks`

### Decisions
| Decision | Rationale |
|----------|-----------|
| No `tenant_id` on `session_pending_actions` | Derived via JOIN from `chat_sessions.tenant_id` — prevents drift |
| `agent_tasks` for per-tool audit, `agent_runs` for run summary | Granular audit trail using existing migration 021 tables |
| `action_type=clarification` for questions (not confirmable) | "Yes" after a clarifying question ≠ approval to mutate state |
| Hybrid verifier: Rule always + LLM gated by risk | Balances cost/latency with thoroughness |
| Classifier kept as fallback hint | Agent plan may not always produce `structured_intents`; classifier fills gaps |

---

## [Pre-2026-03-09] Original Architecture

### Chat System (Classifier → Pipeline)
- 9 `AgentTaskType` values route to 9 `AGENT_PIPELINE_CONFIGS`
- Each config specifies: allowed tool names, max tool rounds, system prompt addition
- `classifyQuery()` (gpt-4o-mini) returns `QueryClassification` with `agent_task_type`
- `inferAgentTaskType()` derives type from classification if not explicit
- `getToolsForPipeline()` filters `HORIZON_TOOLS` to pipeline's allowlist
- Authority routing decides RAG/structured/general_knowledge priority
- Conversational gate catches chitchat before classifier

### Tool System
- 16 tools defined in `HORIZON_TOOLS` constant
- `executeTool()` handles all tool execution with tenant/matter isolation
- Tool loop: max 2-3 rounds depending on pipeline

### Database (migration 021 — unused)
- `agent_runs`, `agent_tasks`, `agent_artifacts`, `tenant_feature_flags` tables
- Created but never wired into chat flow
