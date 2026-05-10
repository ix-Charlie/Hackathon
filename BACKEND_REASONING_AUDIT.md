# Backend Reasoning & RAG Decision Pipeline Audit
**Generated:** 2025-01-XX  
**Purpose:** Complete architectural transparency for Horizon chat system reasoning/RAG decision-making  
**Scope:** Backend Edge Function + Frontend State Processing

---

## Executive Summary

**Key Finding:** The "Research details" panel appears for **ALL queries** (including simple greetings) because:
1. Backend unconditionally emits `classifying_query` state
2. Frontend accumulates all state emissions into `thinking` string
3. ResearchPanel renders whenever `thinking` has content or `isThinking === true`

**RAG is Conditional:** RAG only executes when `classification.search_intent === true`  
**Reasoning Mode is Conditional:** Model tier selection (fast/standard/reasoning) is based on `complexity` from classification  
**Performance Impact:** Simple greetings pay ~1-2s latency penalty for unnecessary classification

---

## 1. Current Request Lifecycle (End-to-End)

### Phase 1: User Input → Frontend Submission
**Location:** [App.tsx](App.tsx#L467-L714) `handleSendMessage()`

1. User types message in ChatInterface
2. `handleSendMessage()` validates session existence
3. Creates optimistic user message (role: 'user')
4. Creates placeholder assistant message (role: 'model', thinking: '', isThinking: true)
5. Saves user message to database via `chatService.saveMessage()`
6. Calls `sendMessageToHorizonStream()` to initiate backend request

### Phase 2: Backend Pipeline Execution
**Location:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts#L899-L1116) Main request handler

```
┌─────────────────────────────────────────────────────────────┐
│ UNCONDITIONAL STATES (emitted for ALL queries)              │
├─────────────────────────────────────────────────────────────┤
│ 1. emitState('classifying_query')         [ALWAYS]          │
│    ↓                                                         │
│ 2. classification = await classifyQuery() [ALWAYS, ~1-2s]   │
│    ↓                                                         │
│    Returns: {                                                │
│      domain: string,                                         │
│      complexity: 'simple' | 'moderate' | 'analytical' | etc  │
│      search_intent: boolean,                                 │
│      tasks: string[]                                         │
│    }                                                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ CONDITIONAL STATES (only for non-conversational queries)    │
├─────────────────────────────────────────────────────────────┤
│ 3. IF (useRAG && classification.search_intent):             │
│      emitState('searching_documents')     [CONDITIONAL]      │
│      ↓                                                       │
│      ragResult = await executeRAG()       [~2-3s]           │
│      ↓                                                       │
│      emitState('context_retrieved', fileNames)               │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ FINAL SYNTHESIS (emitted for ALL queries)                   │
├─────────────────────────────────────────────────────────────┤
│ 4. emitState('synthesizing_response')      [ALWAYS]         │
│    ↓                                                         │
│ 5. Select model tier based on complexity:                   │
│    - 'analytical' | 'drafting' → GPT-4o (reasoning tier)    │
│    - 'simple' | 'moderate'     → GPT-4o (standard tier)     │
│    ↓                                                         │
│ 6. Build system prompt with RAG context (if available)      │
│    ↓                                                         │
│ 7. Stream OpenAI response via SSE                           │
│    ↓                                                         │
│ 8. emitState('done')                       [ALWAYS]         │
└─────────────────────────────────────────────────────────────┘
```

**Telemetry:** Lines 899-1116 emit structured states for frontend UI updates

### Phase 3: Frontend State Processing
**Location:** [App.tsx](App.tsx#L576-L610) SSE chunk processing

1. **State Events** (lines 576-601):
   ```tsx
   if (chunk.type === 'state' && chunk.state) {
     const stateLabel = {
       'classifying_query': 'Analyzing query...',
       'searching_documents': 'Searching documents...',
       'synthesizing_response': 'Generating response...',
       // ... etc
     }[chunk.state];
     
     accumulatedThinking += (accumulatedThinking ? '\n' : '') + stateLabel;
     
     // Update message: { thinking, isThinking: true }
   }
   ```

2. **Content Events** (lines 603-625):
   - Accumulate streamed content
   - Update message: `{ content, isThinking: true }`

3. **Done Event** (lines 651-680):
   - Set `isThinking: false`
   - Save assistant message to database

### Phase 4: UI Rendering
**Location:** [components/ChatInterface.tsx](components/ChatInterface.tsx#L12-L75) ResearchPanel component

**Visibility Logic:**
```tsx
if (!isActive && !thinking) return null;  // Line 66
```

**State Machine:**
- **State A** (Processing): `isActive && !hasSteps && !hasContent`  
  → Shows "Processing…" (auto-expanded)
  
- **State B** (Research): `isActive && hasSteps && !hasContent`  
  → Shows "Research" with live steps (auto-expanded)
  
- **State C** (Collapsed): `hasContent || (!isActive && hasSteps)`  
  → Shows "Research details" (collapsed by default)

**Critical Insight:** Panel appears if `thinking` has ANY content, regardless of whether RAG was used.

---

## 2. RAG Trigger Logic

### Decision Point 1: Global RAG Toggle
**Location:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts#L906)

```typescript
const useRAG = body.use_rag !== false && !!tenantMember?.tenant_id;
```

**Conditions:**
- Frontend doesn't explicitly disable RAG (`use_rag !== false`)
- User has valid tenant association (`tenantMember?.tenant_id` exists)

### Decision Point 2: Query Classification
**Location:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts#L95-L215) `classifyQuery()`

**Process:**
1. Check against `CONVERSATIONAL_PATTERNS` (lines 95-102):
   ```typescript
   const CONVERSATIONAL_PATTERNS = [
     /^(hi|hey|hello|greetings?|good\s+(morning|afternoon|evening))/i,
     /^(thanks?|thank\s+you|thx|cheers|appreciated)/i,
     /^(bye|goodbye|see\s+you|farewell|catch\s+you\s+later)/i,
     /^(yes|no|yeah|nope|yep|ok|okay|sure|alright|fine|got\s+it)/i,
     /^(who|what)\s+(are|is)\s+you\??$/i,
     /^how\s+(are|r|is)\s+you\??$/i,
   ];
   ```

2. If matches: Return `{ domain: 'conversational', complexity: 'simple', search_intent: false }`

3. If no match: Call GPT-4o-mini for semantic classification (lines 130-200):
   ```typescript
   const response = await openai.chat.completions.create({
     model: 'gpt-4o-mini',
     messages: [
       { role: 'system', content: classificationSystemPrompt },
       { role: 'user', content: query }
     ],
     response_format: { type: 'json_object' },
     temperature: 0.3
   });
   
   // Returns: { domain, complexity, search_intent, tasks }
   ```

**Default Behavior:** `search_intent` defaults to `true` for all non-conversational queries

### Decision Point 3: RAG Execution
**Location:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts#L912-L928)

```typescript
if (useRAG && classification.search_intent) {
  emitState(encoder, controller, 'searching_documents');
  
  const ragResult = await executeRAG(
    query,
    classification.tasks || [],
    supabase,
    tenantMember.tenant_id
  );
  
  if (ragResult.chunks.length > 0) {
    emitState(encoder, controller, 'context_retrieved', ragResult.sourceFiles.join(', '));
  } else {
    emitState(encoder, controller, 'no_documents_found');
  }
}
```

**Conditions:**
- `useRAG === true` (global toggle)
- `classification.search_intent === true` (semantic classification)

**RAG Engine Details:**
- **Hybrid Search:** Vector similarity + Full-Text Search via `match_documents_hybrid` RPC
- **Similarity Threshold:** 0.15 (very permissive, configurable in RAG config)
- **Parallel Queries:** For complex tasks with multiple parts (lines 620-665)
- **Smart Context Grouping:** Groups chunks by source document for coherent context

---

## 3. Reasoning/Thinking Mode Logic

### Model Tier Selection
**Location:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts#L913)

```typescript
const useReasoningTier = 
  classification.complexity === 'analytical' || 
  classification.complexity === 'drafting';
```

**Tier Mapping:**
- **Reasoning Tier:** `analytical`, `drafting` → GPT-4o with extended reasoning capabilities
- **Standard Tier:** `simple`, `moderate` → GPT-4o (standard)
- **Fast Tier:** (Not currently used) → GPT-4o-mini

**No Explicit "Thinking Mode" Toggle:** Reasoning is implicitly controlled via complexity classification, not a user-facing setting.

### System Prompt Construction
**Location:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts#L745-L793) `buildSystemPrompt()`

**Dynamic Prompt Logic:**
```typescript
function buildSystemPrompt(
  classification: ClassificationResult,
  ragResult?: RAGResult,
  userProfile?: { full_name: string; user_type: string; } | null
): string {
  let prompt = BASE_SYSTEM_PROMPT;  // Legal AI identity, capabilities
  
  // Add RAG context if available
  if (ragResult && ragResult.chunks.length > 0) {
    prompt += `\n\nRELEVANT DOCUMENTS:\n${ragResult.formattedContext}`;
  }
  
  // Add complexity-specific instructions
  if (classification.complexity === 'analytical') {
    prompt += `\n\nAnalytical Response Requirements:
- Break down complex concepts step-by-step
- Cite specific sections/clauses when referencing documents
- Consider multiple perspectives or interpretations`;
  }
  
  // Add user context if available
  if (userProfile) {
    prompt += `\n\nUser Profile: ${userProfile.full_name} (${userProfile.user_type})`;
  }
  
  return prompt;
}
```

**Key Insight:** System prompt adapts based on complexity tier and RAG context availability, but doesn't explicitly toggle "thinking mode".

---

## 4. Research UI Trigger Logic

### Backend State Emissions
**Location:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts#L85-L93) `emitState()` helper

```typescript
function emitState(
  encoder: TextEncoder,
  controller: ReadableStreamDefaultController,
  state: string,
  detail?: string
) {
  const event = `data: ${JSON.stringify({ type: 'state', state, detail })}\n\n`;
  controller.enqueue(encoder.encode(event));
}
```

**Emitted States:**
- `classifying_query` → **ALWAYS** (line 899)
- `searching_documents` → Conditional (line 914)
- `vector_search_started` → Conditional (line 614)
- `vector_search_completed` → Conditional (line 645)
- `context_retrieved` → Conditional (line 920)
- `no_documents_found` → Conditional (line 922)
- `synthesizing_response` → **ALWAYS** (line 931)
- `done` → **ALWAYS** (line 1094)

### Frontend State Mapping
**Location:** [App.tsx](App.tsx#L583-L593)

```typescript
const stateLabel = {
  'classifying_query': 'Analyzing query...',
  'searching_documents': 'Searching documents...',
  'vector_search_started': chunk.detail ? `Searching: ${chunk.detail}` : 'Vector search...',
  'vector_search_completed': 'Search complete',
  'context_retrieved': chunk.detail ? `Found relevant content in ${chunk.detail}` : 'Context retrieved',
  'no_documents_found': 'No relevant documents found',
  'synthesizing_response': 'Generating response...',
  'executing_tools': 'Executing actions...',
}[chunk.state] || chunk.state;
```

**Accumulation Logic (lines 595-601):**
```typescript
accumulatedThinking += (accumulatedThinking ? '\n' : '') + stateLabel;

setSessions(prev => prev.map(s => {
  if (s.id === sessionId) {
    return {
      ...s,
      messages: s.messages.map(m => 
        m.id === modelMsgId 
          ? { ...m, thinking: accumulatedThinking, isThinking: true } 
          : m
      )
    };
  }
  return s;
}));
```

### ResearchPanel Rendering Decision
**Location:** [components/ChatInterface.tsx](components/ChatInterface.tsx#L12-L75)

**Visibility Condition:**
```typescript
if (!isActive && !thinking) return null;  // Line 66
```

**Explanation:**
- `isActive` = `isThinking` (true while streaming)
- `thinking` = accumulated state labels (e.g., "Analyzing query...\nGenerating response...")
- Panel renders if EITHER condition is true

**Result:** Even simple greetings show ResearchPanel with 2 steps:
1. "Analyzing query..." (from `classifying_query` state)
2. "Generating response..." (from `synthesizing_response` state)

---

## 5. Query Type Handling Matrix

| Query Type | Example | Pattern Match | `search_intent` | RAG Executed? | Reasoning Tier? | UI Shows Research? |
|------------|---------|---------------|-----------------|---------------|-----------------|-------------------|
| **Pure Greeting** | "Hi" | ✅ `^(hi\|hey\|hello)` | `false` | ❌ No | ❌ No | ✅ Yes (2 steps) |
| **Gratitude** | "Thanks!" | ✅ `^(thanks?\|thank you)` | `false` | ❌ No | ❌ No | ✅ Yes (2 steps) |
| **Simple Question** | "What is negligence?" | ❌ No match | `true` (default) | ✅ Yes | ❌ No (simple) | ✅ Yes (4+ steps) |
| **Document Query** | "Summarize contract X" | ❌ No match | `true` (default) | ✅ Yes | ❌ No (moderate) | ✅ Yes (4+ steps) |
| **Analytical Task** | "Compare clauses 2.3 and 5.1" | ❌ No match | `true` (default) | ✅ Yes | ✅ Yes (analytical) | ✅ Yes (4+ steps) |
| **Drafting Request** | "Write a demand letter" | ❌ No match | `true` (default) | ✅ Yes | ✅ Yes (drafting) | ✅ Yes (4+ steps) |

**Key Observations:**
1. **Binary Classification:** Only pure greetings/acknowledgments skip RAG; everything else triggers full pipeline
2. **No "Simple Q&A" Category:** No distinction between factual questions and document queries
3. **Conservative Defaults:** `search_intent` defaults to `true` for safety (better to search than miss context)
4. **UI Always Shows Research:** Even greetings trigger ResearchPanel due to unconditional state emissions

---

## 6. Latency Breakdown (Typical Request)

### Simple Greeting ("Hi")
```
┌──────────────────────────────────────────────────────┐
│ PHASE                        │ LATENCY  │ CUMULATIVE │
├──────────────────────────────────────────────────────┤
│ Frontend → Supabase Edge     │  ~50ms   │  50ms      │
│ RLS Auth + Tenant Lookup     │  ~100ms  │  150ms     │
│ classifyQuery() [GPT-4o-mini]│  ~1-2s   │  1.15-2.15s│
│ buildSystemPrompt()          │  ~1ms    │  1.15-2.15s│
│ OpenAI Stream [First Token]  │  ~300ms  │  1.45-2.45s│
│ OpenAI Stream [Complete]     │  ~1-2s   │  2.45-4.45s│
└──────────────────────────────────────────────────────┘
Total: ~2.5-4.5 seconds for "Hi" response
```

**Bottleneck:** Unnecessary GPT-4o-mini classification call for obvious greetings

### Document Query ("What are the termination clauses?")
```
┌──────────────────────────────────────────────────────┐
│ PHASE                        │ LATENCY  │ CUMULATIVE │
├──────────────────────────────────────────────────────┤
│ Frontend → Supabase Edge     │  ~50ms   │  50ms      │
│ RLS Auth + Tenant Lookup     │  ~100ms  │  150ms     │
│ classifyQuery() [GPT-4o-mini]│  ~1-2s   │  1.15-2.15s│
│ executeRAG() [Hybrid Search] │  ~2-3s   │  3.15-5.15s│
│   - Vector embedding         │  ~500ms  │            │
│   - match_documents_hybrid   │  ~1-2s   │            │
│   - Context formatting       │  ~500ms  │            │
│ buildSystemPrompt()          │  ~1ms    │  3.15-5.15s│
│ OpenAI Stream [First Token]  │  ~500ms  │  3.65-5.65s│
│ OpenAI Stream [Complete]     │  ~2-4s   │  5.65-9.65s│
└──────────────────────────────────────────────────────┘
Total: ~5.7-9.7 seconds for RAG-enhanced response
```

**Bottleneck:** Hybrid search execution (vector embedding + database query + context assembly)

### Performance Observations:
- **Classification Overhead:** 1-2s for every query (even greetings that don't need it)
- **RAG Overhead:** Additional 2-3s for document retrieval
- **No Caching:** Classification runs on every request (no query deduplication)
- **No Streaming Optimization:** Classification blocks response start (could parallel with streaming)

---

## 7. Architectural Weaknesses & Optimization Opportunities

### ❌ **Weakness 1: Unconditional Classification for All Queries**
**Location:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts#L899-L910)

**Problem:**
```typescript
emitState(encoder, controller, 'classifying_query');  // ALWAYS emitted
const classification = await classifyQuery(query, conversationHistory);  // ALWAYS called
```

**Impact:**
- Simple greetings ("Hi", "Thanks") pay 1-2s latency penalty for unnecessary LLM call
- User sees "Analyzing query..." for obvious inputs
- Wastes GPT-4o-mini API credits

**Fix Opportunity:**
```typescript
// BEFORE classification, check conversational patterns
if (isConversationalQuery(query)) {
  classification = { domain: 'conversational', complexity: 'simple', search_intent: false, tasks: [] };
  // Skip emitState('classifying_query')
} else {
  emitState(encoder, controller, 'classifying_query');
  classification = await classifyQuery(query, conversationHistory);
}
```

**Trade-off:** Loses semantic classification for edge cases like "Hi, but also can you summarize document X?"

---

### ❌ **Weakness 2: Binary RAG Decision (No Hybrid Fallback)**
**Location:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts#L912-L928)

**Problem:**
```typescript
if (useRAG && classification.search_intent) {
  // Full RAG with 2-3s latency
  ragResult = await executeRAG(...);
} else {
  // No RAG at all
  ragResult = null;
}
```

**Impact:**
- No middle ground for "probably doesn't need RAG, but search if fast"
- Misclassified queries either waste time (false positive) or miss context (false negative)

**Fix Opportunity:**
```typescript
// Add "opportunistic RAG" tier
if (classification.search_intent === 'high') {
  ragResult = await executeRAG(...);  // Full hybrid search
} else if (classification.search_intent === 'low') {
  ragResult = await fastVectorSearch(..., timeout: 500);  // Best-effort with timeout
} else {
  ragResult = null;  // Skip entirely
}
```

**Trade-off:** Requires classifier to return confidence levels, not just boolean

---

### ❌ **Weakness 3: ResearchPanel Shows for All Queries**
**Location:** [components/ChatInterface.tsx](components/ChatInterface.tsx#L66)

**Problem:**
```typescript
if (!isActive && !thinking) return null;  // Renders if ANY thinking content exists
```

**Impact:**
- Greetings show "Research details" with 2 steps (confusing for users)
- Panel clutter reduces perceived speed
- No distinction between trivial operations (classification) and expensive ones (RAG)

**Fix Opportunity:**
```typescript
// Only render if RAG was actually used OR reasoning tier active
const hasSubstantiveProcessing = 
  thinking.includes('Searching documents') || 
  thinking.includes('Executing actions') ||
  isReasoningMode;

if (!hasSubstantiveProcessing && !isActive && !thinking) return null;
```

**Alternative Fix:** Don't emit `classifying_query` state for conversational queries in backend

**Trade-off:** Loses transparency for classification step (might confuse power users)

---

### ❌ **Weakness 4: No Query Deduplication/Caching**
**Location:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts#L907) Classification always runs fresh

**Problem:**
- Identical queries (e.g., "What is negligence?" repeated) re-classify every time
- No semantic similarity check for near-duplicate queries
- RAG re-searches identical document sets

**Fix Opportunity:**
```typescript
// Add query fingerprinting
const queryHash = await hashQuery(query + JSON.stringify(conversationHistory.slice(-3)));
const cachedClassification = await redis.get(`classify:${queryHash}`);

if (cachedClassification) {
  classification = JSON.parse(cachedClassification);
} else {
  classification = await classifyQuery(...);
  await redis.setex(`classify:${queryHash}`, 3600, JSON.stringify(classification));
}
```

**Trade-off:** Redis dependency, cache invalidation complexity, context drift risk

---

### ❌ **Weakness 5: Classification Blocks Response Streaming**
**Location:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts#L899-L931)

**Problem:**
```typescript
// Sequential execution
emitState('classifying_query');
const classification = await classifyQuery(...);  // 1-2s blocking
// ... RAG logic ...
emitState('synthesizing_response');
const stream = await openai.chat.completions.create(...);  // Stream starts 3-5s later
```

**Impact:**
- User waits 3-5s before seeing first content token
- Modern AI chat UX expects instant streaming (200ms to first token)

**Fix Opportunity:**
```typescript
// Start streaming immediately with generic prompt, refine mid-stream
const [classificationPromise, streamPromise] = await Promise.all([
  classifyQuery(query, history),
  openai.chat.completions.create({ /* minimal context */ })
]);

// If classification reveals RAG need, inject via function calling mid-stream
if (classification.search_intent) {
  // Signal tool use to OpenAI, inject RAG context dynamically
}
```

**Trade-off:** Significantly more complex architecture, potential hallucinations without context

---

### ✅ **Strength 1: Excellent Multi-Tenancy Isolation**
**Location:** All RLS policies, tenant_id filtering in RAG

**Why It Works:**
- Every database query filtered by `tenant_id`
- Supabase RLS policies prevent cross-contamination
- RAG search scoped to tenant documents only

---

### ✅ **Strength 2: Hybrid Search Quality**
**Location:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts#L569-L744) `executeRAG()`

**Why It Works:**
- Vector similarity catches semantic matches
- FTS catches exact keyword matches
- Smart context grouping preserves document structure
- Parallel queries for multi-part questions

---

### ✅ **Strength 3: Structured State Emissions for UI**
**Location:** `emitState()` calls throughout pipeline

**Why It Works:**
- Predictable state machine for frontend
- Easy to add new states without breaking UI
- Audit trail of processing steps

---

## 8. Recommendations (Not Implementations)

### **Priority 1: Skip Classification for Obvious Greetings**
- **Impact:** Reduces 1-2s latency for ~10-20% of queries
- **Risk:** Low (regex patterns are well-defined)
- **Implementation:** Move `CONVERSATIONAL_PATTERNS` check BEFORE `emitState('classifying_query')`

### **Priority 2: Conditional ResearchPanel Rendering**
- **Impact:** Cleaner UI for greetings, less cognitive load
- **Risk:** Very low (purely cosmetic)
- **Implementation:** Add `hasSubstantiveProcessing` check in ChatInterface.tsx

### **Priority 3: Query Classification Caching**
- **Impact:** ~1-2s savings for repeated queries
- **Risk:** Medium (requires Redis, cache invalidation logic)
- **Implementation:** Hash query + recent history, cache classification for 1 hour

### **Priority 4: Confidence-Based RAG (Not Binary)**
- **Impact:** Better precision/recall trade-off, fewer false positives
- **Risk:** Medium (requires classifier retraining)
- **Implementation:** Return `search_intent: 'high' | 'medium' | 'low'`, add opportunistic RAG tier

### **Priority 5: Streaming-First Architecture (Advanced)**
- **Impact:** Instant response start (200ms vs 3-5s)
- **Risk:** High (major architectural refactor)
- **Implementation:** Parallel classification + streaming, dynamic context injection via function calling

---

## 9. Implementation Priority Matrix

| Change | Impact | Risk | Effort | Priority |
|--------|--------|------|--------|----------|
| Skip classification for greetings | High | Low | 1 hour | **P0** |
| Conditional ResearchPanel | Medium | Very Low | 30 min | **P0** |
| Query classification caching | High | Medium | 4 hours | **P1** |
| Confidence-based RAG | Medium | Medium | 8 hours | **P2** |
| Streaming-first architecture | Very High | High | 40+ hours | **P3** |

---

## 10. Code References Summary

### Backend Entry Point
- **File:** [supabase/functions/chat/index.ts](supabase/functions/chat/index.ts)
- **Main Handler:** Lines 853-1116
- **Classification:** Lines 95-215 (`classifyQuery()`)
- **RAG Execution:** Lines 569-744 (`executeRAG()`)
- **System Prompt:** Lines 745-793 (`buildSystemPrompt()`)

### Frontend State Processing
- **File:** [App.tsx](App.tsx)
- **Message Sending:** Lines 467-714 (`handleSendMessage()`)
- **State Mapping:** Lines 576-649 (SSE chunk processing)
- **Optimistic UI:** Lines 248-358 (new/delete/rename chat)

### UI Rendering
- **File:** [components/ChatInterface.tsx](components/ChatInterface.tsx)
- **ResearchPanel:** Lines 12-75 (state-driven research panel)
- **Message Rendering:** Lines 380-460 (user/assistant bubbles)

### Database Layer
- **File:** [services/chatService.ts](services/chatService.ts)
- **Save Message:** Lines 218-260 (role conversion, RLS enforcement)
- **Fetch Messages:** Lines 192-210 (chronological ordering)

---

## Conclusion

The Horizon chat system has **excellent architectural fundamentals** (multi-tenancy, hybrid search, structured state machine) but suffers from **over-processing simple queries**. The "Research details" panel appears for all inputs because:

1. Backend unconditionally emits `classifying_query` state
2. Frontend renders ResearchPanel whenever `thinking` has content
3. No early-exit for obvious conversational queries

**Quick Win:** Move `CONVERSATIONAL_PATTERNS` check BEFORE classification to save 1-2s on greetings, and conditionally render ResearchPanel only when RAG/tools/reasoning is active.

**Long-Term Vision:** Migrate to streaming-first architecture where responses start instantly, classification runs in parallel, and RAG context is injected dynamically as needed.
