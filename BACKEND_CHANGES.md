# Backend Change Log

All backend changes are documented here with date, summary, and affected files/lines.

---

## 2026-02-15 — Fix Substantive Flag Regression + Restore Streaming UX

**Change:** Fixed two regressions from the Substantive Processing Gate refactor.

### Bug 1: ResearchPanel not appearing when RAG executes
- **Root Cause:** Frontend relied solely on `chunk.substantive === true` from backend SSE. If Edge Function not redeployed, field is absent → always `false`.
- **Fix (App.tsx):** Added client-side `KNOWN_SUBSTANTIVE_STATES` fallback set (`searching_documents`, `vector_search_started`, `vector_search_completed`, `context_retrieved`, `no_documents_found`, `executing_tools`). The gate now checks `chunk.substantive === true || KNOWN_SUBSTANTIVE_STATES.has(chunk.state)`.
- **File:** `App.tsx` lines 587-596

### Bug 2: Blank UI gap before first token + missing typing indicator
- **Root Cause:** Model placeholder message has `isThinking: true` and `content: ''`. Content block gated on `msg.content` (falsy when empty). Typing cursor gated on `msg.isThinking === false`. Result: nothing rendered between message creation and first token.
- **Fix (ChatInterface.tsx):** Added bouncing dots indicator: `{msg.isThinking && !msg.content && (<dots/>)}`. Shows immediately when message is created, disappears when first content token arrives.
- **File:** `components/ChatInterface.tsx` lines 459-465

### Bug 3: Streaming cursor not visible or showing on old messages
- **Root Cause:** Cursor condition `isTyping && msg.isThinking === false` prevented cursor from showing during early streaming. Also, `isTyping` is global so all old MODEL messages would show cursor.
- **Fix (ChatInterface.tsx):** Changed cursor to `{isTyping && msg === messages.filter(m => m.role === Role.MODEL).slice(-1)[0]}`. Scoped to last model message only. Removed `isThinking` gate since content presence already gates the block.
- **File:** `components/ChatInterface.tsx` lines 471-473

### No backend code changes needed
The backend `emitState()` function and `substantive` flag implementation from the previous refactor are correct. This fix is purely frontend state-flow and rendering.

---

## 2026-02-15 — Substantive Processing Gate (Backend + Frontend Refactor)

**Change:** Introduced a Substantive Processing Gate that separates orchestration states from substantive cognitive work across the entire pipeline.

### Backend (`supabase/functions/chat/index.ts`)
- **`emitState()` helper** (line 267): Added `substantive: boolean = false` parameter. Every emitted SSE state event now includes a `substantive` field.
- **Pipeline variable** (line 901): Added `let substantiveProcessing = false` tracking variable.
- **Classification state** (line 901): `classifying_query` → `substantive: false` (orchestration, invisible to UI)
- **RAG search states** (lines 601-641 inside `executeRAG`): `vector_search_started`, `vector_search_completed` → `substantive: true`
- **RAG result states** (lines 921-931): `searching_documents`, `context_retrieved`, `no_documents_found` → `substantive: true`
- **Reasoning tier gate** (line 935): Sets `substantiveProcessing = true` when `modelTier === 'reasoning'`
- **Synthesis state** (line 971): `synthesizing_response` → `substantive: <dynamic>` (true only if RAG/reasoning was used)
- **Tool execution state** (line 1049): `executing_tools` → `substantive: true`

### Frontend Service (`services/openaiService.ts`)
- **`StreamChunk` interface** (line 10): Added `substantive?: boolean` field
- **State yield** (line 126): Now passes `substantive: data.substantive === true` from backend SSE payload

### Frontend State (`App.tsx`)
- **State tracking** (line 572): Added `let hasSubstantiveWork = false` variable
- **State processing** (lines 582-620): Only substantive states accumulate into `thinking` string. Non-substantive states are received but NOT shown in ResearchPanel.
- **Message updates**: All `setSessions` calls now include `hasSubstantiveWork` flag on messages

### Frontend UI (`components/ChatInterface.tsx`)
- **ResearchPanel props**: Added `hasSubstantiveWork: boolean` prop
- **Rendering gate** (line 42): `if (!hasSubstantiveWork) return null;` — Panel is completely hidden unless RAG, tools, or reasoning tier was triggered
- **State A** (Processing): Now requires `hasSubstantiveWork` to show spinner

### Types (`types.ts`)
- **`ChatMessage` interface**: Added `hasSubstantiveWork?: boolean` field

### Result Matrix
| Query | ResearchPanel | RAG? | Classification? |
|-------|--------------|------|-----------------|
| "Hi" | ❌ Hidden | ❌ No | ✅ Still runs |
| "Thanks" | ❌ Hidden | ❌ No | ✅ Still runs |
| "What is negligence?" | ✅ Shows | ✅ Yes | ✅ Still runs |
| "Compare clauses" | ✅ Shows | ✅ Yes | ✅ Still runs |
| "Draft a motion" | ✅ Shows | ✅ Yes | ✅ Still runs |
| "List my cases" | ✅ Shows (tools) | ❌ No | ✅ Still runs |

---

## 2026-02-15
**Change:** Added comprehensive architectural audit of backend reasoning/RAG pipeline (no code changes, documentation only)
- **File:** BACKEND_REASONING_AUDIT.md
- **Summary:** Full transparency report on backend decision tree, RAG triggers, state emissions, and UI logic. Includes recommendations and optimization opportunities.

---

(For all future backend changes, add a new entry at the top with date, summary, and affected files/lines.)
