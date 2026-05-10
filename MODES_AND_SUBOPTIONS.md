# Horizon Modes & Sub-Options — Complete Architecture Reference

> Last updated: 17 February 2026  
> Files involved: `types.ts`, `App.tsx`, `components/ChatInterface.tsx`, `services/openaiService.ts`, `supabase/functions/chat/index.ts`

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture — How It All Connects](#architecture)
3. [Data Flow (End-to-End)](#data-flow)
4. [Mode Configuration](#mode-configuration)
5. [Sub-Options Per Mode](#sub-options-per-mode)
6. [Auto-Detect System](#auto-detect-system)
7. [System Prompt Composition](#system-prompt-composition)
8. [Mutual Exclusivity](#mutual-exclusivity)
9. [Persistence](#persistence)
10. [File-by-File Reference](#file-reference)
11. [Verification Checklist](#verification-checklist)

---

## 1. Overview <a id="overview"></a>

Horizon has **6 modes** (1 general + 5 specialized). Each specialized mode has:
- A unique **base system prompt** (core instructions + citation discipline + professional standards)
- **4 sub-options** (composable prompt fragments that modify output behavior)
- A specific **model tier** (standard or reasoning)
- RAG configuration

Sub-options are **not cosmetic** — each one appends a distinct instruction block to the system prompt that changes what the LLM produces. They are toggleable, persisted to localStorage, and transported to the Edge Function on every request.

---

## 2. Architecture <a id="architecture"></a>

```
┌─────────────────────────────────────────────────────────────────┐
│ FRONTEND                                                        │
│                                                                 │
│  types.ts                                                       │
│  ├── ModeSubOption { id, label, effect, defaultOn, exclusive }  │
│  ├── HORIZON_MODES: 5 modes × 4 sub-options = 20 definitions   │
│  └── getDefaultSubOptions() / getAllDefaultSubOptions()          │
│                                                                 │
│  App.tsx                                                        │
│  ├── activeSubOptions: Record<HorizonMode, string[]>            │
│  ├── handleSubOptionToggle() — with exclusivity logic           │
│  ├── localStorage persistence (horizon_sub_options)             │
│  └── Passes activeSubOptions[mode] to sendMessageToHorizonStream│
│                                                                 │
│  ChatInterface.tsx                                              │
│  ├── Toggle <button> elements (indigo=active, gray=inactive)    │
│  └── Tooltip shows option.effect on hover                       │
│                                                                 │
│  openaiService.ts                                               │
│  └── Sends { mode, sub_options: string[] } in request body      │
└────────────────────────────────┬────────────────────────────────┘
                                 │ POST /chat
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ EDGE FUNCTION (supabase/functions/chat/index.ts)                │
│                                                                 │
│  ChatRequest.sub_options: string[]                              │
│                                                                 │
│  MODE_CONFIGS: Record<HorizonMode, ModeConfig>                  │
│  ├── system_prompt: string (base prompt per mode)               │
│  └── sub_option_prompts: Record<string, string> (fragments)     │
│                                                                 │
│  DEFAULT_SUB_OPTIONS: Record<HorizonMode, string[]>             │
│  └── Used when auto-detect fires and no explicit sub-options    │
│                                                                 │
│  Step 3: BUILD SYSTEM PROMPT                                    │
│  ├── Select base prompt (explicit > auto-detected > general)    │
│  ├── Determine effective sub-options                            │
│  │   └── If auto-detect + empty sub_options → use defaults      │
│  └── Append matching fragment prompts to system prompt          │
│                                                                 │
│  Telemetry: logs mode, detected mode, sub_options               │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Flow (End-to-End) <a id="data-flow"></a>

### Explicit Mode Selection
```
User clicks "Research" tab → mode='legal_research'
User toggles "Deep Analysis" ON
  → activeSubOptions['legal_research'] = ['irac_structure', 'case_citations', 'deep_analysis']
  → Saved to localStorage

User sends message
  → openaiService sends: { mode: 'legal_research', sub_options: ['irac_structure', 'case_citations', 'deep_analysis'] }

Edge Function:
  → modeConfig = MODE_CONFIGS['legal_research'] (skip_classifier=true)
  → Skips classifier entirely
  → base systemPrompt = legal_research.system_prompt
  → Appends: irac_structure fragment + case_citations fragment + deep_analysis fragment
  → Final prompt = base + 3 fragments
  → LLM produces IRAC-structured response with citations and deep analysis
```

### Auto-Detect Flow
```
User is on "Auto" tab (mode='general')
User sends: "What are the legal precedents for breach of fiduciary duty?"
  → openaiService sends: { mode: 'general', sub_options: [] }

Edge Function:
  → modeConfig = MODE_CONFIGS['general'] (skip_classifier=false)
  → Runs GPT-4o-mini classifier
  → Classifier returns: { suggested_mode: 'legal_research', ... }
  → Emits 'detected_mode' event → frontend shows detection banner
  → Uses legal_research model tier (reasoning)
  → base systemPrompt = MODE_CONFIGS['legal_research'].system_prompt
  → sub_options is [] → uses DEFAULT_SUB_OPTIONS['legal_research'] = ['irac_structure', 'case_citations']
  → Appends: irac_structure fragment + case_citations fragment
  → LLM produces IRAC-structured response with citations

Frontend:
  → Detection banner appears: "Detected: Legal Research — Switch | Stay"
  → If user clicks Switch → mode changes to 'legal_research', sub-option toggles appear
```

### No Detection (Pure General)
```
User is on "Auto" tab
User sends: "Hello, how are you?"
  → Conversational pattern detected → skips classifier entirely
  → Uses buildSystemPrompt() (generic Horizon prompt)
  → No sub-options applied
  → Casual response
```

---

## 4. Mode Configuration <a id="mode-configuration"></a>

| Mode | Key | Model Tier | RAG | Skip Classifier | Has Sub-Options |
|------|-----|-----------|-----|-----------------|-----------------|
| Auto Detect | `general` | standard* | yes | no | no |
| Legal Research | `legal_research` | reasoning | yes | yes | 4 |
| Contract Review | `contract_review` | reasoning | yes | yes | 4 |
| Multi-Document | `multi_document` | reasoning | yes | yes | 4 |
| Summary | `summary` | standard | yes | yes | 4 |
| Drafting | `drafting` | reasoning | yes | yes | 4 |

*General mode's model tier is determined by classifier output (standard/reasoning based on complexity).

### What "Skip Classifier" Means
- **`skip_classifier: true`** (all explicit modes): The query classifier is NOT run. The mode's system prompt and model tier are used directly. RAG runs if `use_rag: true`.
- **`skip_classifier: false`** (general only): The GPT-4o-mini classifier runs to determine complexity, task decomposition, and optionally suggest a specialized mode.

---

## 5. Sub-Options Per Mode <a id="sub-options-per-mode"></a>

### Legal Research (`legal_research`)

| Sub-Option ID | Label | Default | Effect on Output |
|---------------|-------|---------|------------------|
| `irac_structure` | IRAC Structure | ✅ ON | Forces Issue → Rule → Application → Conclusion format |
| `case_citations` | Case Citations | ✅ ON | Includes statute/precedent citations with source attribution |
| `deep_analysis` | Deep Analysis | ❌ OFF | Expands reasoning with counterarguments, risk weighting, policy rationale |
| `jurisdiction_notes` | Jurisdiction Notes | ❌ OFF | Appends jurisdiction caveats and cross-jurisdictional differences |

**System prompt fragment example** (`irac_structure`):
```
## IRAC STRUCTURE (ENABLED)
You MUST structure every response using the IRAC framework:
### Issue  → ### Rule  → ### Application  → ### Conclusion
```

### Contract Review (`contract_review`)

| Sub-Option ID | Label | Default | Effect on Output |
|---------------|-------|---------|------------------|
| `risk_flags` | Risk Flags | ✅ ON | Adds 🔴🟡🟢 severity-rated risk assessment for each clause |
| `clause_breakdown` | Clause Breakdown | ✅ ON | Outputs clause-by-clause analysis with exact text quotation |
| `market_benchmark` | Market Benchmark | ❌ OFF | Compares flagged clauses against standard market terms |
| `redline_suggestions` | Redline Suggestions | ❌ OFF | Generates proposed alternative language for flagged clauses |

### Multi-Document Analysis (`multi_document`)

| Sub-Option ID | Label | Default | Effect on Output |
|---------------|-------|---------|------------------|
| `side_by_side` | Side-by-Side | ✅ ON | Outputs comparison matrix table with per-document columns |
| `conflicts` | Conflicts | ✅ ON | Highlights contradictions and material inconsistencies |
| `term_variations` | Term Variations | ❌ OFF | Extracts differences in defined terms across documents |
| `chronology` | Chronology | ❌ OFF | Builds merged timeline of events across documents |

### Summary (`summary`)

| Sub-Option ID | Label | Default | Effect on Output |
|---------------|-------|---------|------------------|
| `key_facts` | Key Facts | ✅ ON | Extracts material facts ranked by legal relevance |
| `deadlines` | Deadlines | ❌ OFF | Isolates all dates, deadlines, time-sensitive obligations |
| `obligations` | Obligations | ❌ OFF | Extracts duties, action items, responsible parties |
| `executive_brief` | Executive Brief | ✅ ON | Adds 3-5 sentence summary for senior stakeholder review |

### Drafting (`drafting`)

| Sub-Option ID | Label | Default | Effect on Output |
|---------------|-------|---------|------------------|
| `formal_tone` | Formal Tone | ✅ ON | Formal courtroom language, numbered sections, "WHEREAS" conventions |
| `plain_language` | Plain Language | ❌ OFF | Clear client-facing language, no legalese (**exclusive with formal_tone**) |
| `with_authorities` | With Authorities | ❌ OFF | Includes supporting legal authorities, statutes, precedent |
| `jurisdiction_align` | Jurisdiction Align | ❌ OFF | Adds jurisdiction-specific conventions and local practice notes |

---

## 6. Auto-Detect System <a id="auto-detect-system"></a>

### Classifier (GPT-4o-mini)

Located in `classifyQuery()` in the Edge Function. Only runs when `mode === 'general'`.

Returns `suggested_mode` based on these rules:
- `legal_research` — Analytical queries requiring IRAC, legal arguments, case law evaluation
- `contract_review` — Queries about contract clauses, terms, risks, amendments
- `multi_document` — Queries comparing/cross-referencing 2+ documents
- `summary` — Queries asking to summarize, extract key facts, overview
- `drafting` — Queries asking to write/draft/generate legal documents
- `null` — Simple lookups, general questions, no clear specialized fit

### What Happens When Auto-Detect Fires

1. Classifier returns `suggested_mode: 'legal_research'` (example)
2. Edge Function emits SSE event: `{ type: 'state', state: 'detected_mode', detail: 'legal_research' }`
3. Frontend receives event → sets `detectedMode` state → shows banner
4. System prompt = detected mode's base prompt + DEFAULT_SUB_OPTIONS for that mode
5. Model tier = detected mode's tier (e.g., reasoning for research)

### Default Sub-Options for Auto-Detect

When auto-detect fires and the frontend sent `sub_options: []` (because user was on General), the Edge Function applies these defaults:

```typescript
const DEFAULT_SUB_OPTIONS: Record<HorizonMode, string[]> = {
  general: [],
  legal_research: ['irac_structure', 'case_citations'],
  contract_review: ['risk_flags', 'clause_breakdown'],
  multi_document: ['side_by_side', 'conflicts'],
  summary: ['key_facts', 'executive_brief'],
  drafting: ['formal_tone'],
};
```

This ensures auto-detected responses are as rich as explicit mode selection with default toggles.

### Detection Banner Behavior

- **Switch button**: Changes `mode` to detected mode, saves to localStorage, sub-option toggles appear
- **Stay button**: Dismisses banner, stays on General. The current response already used the detected mode's prompt.
- Banner only appears when `mode === 'general'` and `detectedMode` is set

---

## 7. System Prompt Composition <a id="system-prompt-composition"></a>

The final system prompt sent to GPT-4o is assembled in Step 3 of the pipeline:

```
FINAL SYSTEM PROMPT = BASE PROMPT + "\n\n" + FRAGMENT_1 + "\n\n" + FRAGMENT_2 + ...
```

### Priority Order for Base Prompt Selection

1. **Explicit mode** (`skip_classifier: true` AND `system_prompt` exists) → use mode's system prompt
2. **Auto-detected mode** (`classification.suggested_mode` exists) → use detected mode's system prompt
3. **General fallback** → use `buildSystemPrompt()` which generates a dynamic prompt based on complexity and RAG context

### Each Mode's System Prompt Contains (base only)

1. **Mode header**: "You are Horizon, an expert AI [role] assistant."
2. **Mode description**: "## MODE: [NAME]" with core instructions
3. **Citation discipline**: Strict rules for source attribution
4. **Professional standards**: Language quality, precision, anti-fabrication rules

### Fragment Prompts Contain

Each fragment is a self-contained instruction block like:
```
## IRAC STRUCTURE (ENABLED)
You MUST structure every response using the IRAC framework:
### Issue → ### Rule → ### Application → ### Conclusion
```

Fragments are **additive** — they layer on top of the base prompt. Multiple fragments compose cleanly because each has its own section heading.

---

## 8. Mutual Exclusivity <a id="mutual-exclusivity"></a>

Only one exclusivity pair exists:

**Drafting mode**: `formal_tone` ↔ `plain_language`

When user toggles Plain Language ON → Formal Tone auto-deselects (and vice versa).

Implemented in `handleSubOptionToggle()` in App.tsx:
```typescript
const optionDef = modeOptions.subOptions?.find(o => o.id === optionId);
const exclusions = optionDef?.exclusiveWith || [];
newOptions = [...currentOptions.filter(id => !exclusions.includes(id)), optionId];
```

The `exclusiveWith` field in types.ts:
```typescript
{ id: 'formal_tone', ..., exclusiveWith: ['plain_language'] },
{ id: 'plain_language', ..., exclusiveWith: ['formal_tone'] },
```

---

## 9. Persistence <a id="persistence"></a>

### Mode Selection
- Key: `horizon_mode`
- Value: HorizonMode string (e.g., `'legal_research'`)
- Set on mode change in `handleModeChange()`

### Sub-Option Selections
- Key: `horizon_sub_options`
- Value: JSON of `Record<HorizonMode, string[]>`
- Example: `{"general":[],"legal_research":["irac_structure","case_citations","deep_analysis"],"contract_review":["risk_flags","clause_breakdown"],...}`
- Set on every toggle in `handleSubOptionToggle()`
- Initialized from localStorage on mount, falls back to `getAllDefaultSubOptions()`

Persistence is **per-mode** — toggling sub-options in Research doesn't affect Contract Review's selections.

---

## 10. File-by-File Reference <a id="file-reference"></a>

### `types.ts`
- **`ModeSubOption`** interface: `{ id, label, effect, defaultOn, exclusiveWith? }`
- **`ModeDisplayConfig.subOptions`**: Array of ModeSubOption per mode
- **`HORIZON_MODES`**: All 20 sub-option definitions (5 modes × 4 each)
- **`getDefaultSubOptions(mode)`**: Returns default-on IDs for a mode
- **`getAllDefaultSubOptions()`**: Returns defaults for all modes

### `App.tsx`
- **`activeSubOptions`** state: `Record<HorizonMode, string[]>` (line ~103)
- **`handleSubOptionToggle()`**: Toggle handler with exclusivity (line ~426)
- **Stream call**: Passes `activeSubOptions[mode]` as 9th arg (line ~697)
- **ChatInterface props**: `activeSubOptions={activeSubOptions[mode]}` `onSubOptionToggle={handleSubOptionToggle}` (line ~1011)

### `components/ChatInterface.tsx`
- **Props**: `activeSubOptions?: string[]`, `onSubOptionToggle?: (optionId: string) => void`
- **Toggle rendering**: Interactive `<button>` elements (line ~522-543)
- Active style: `bg-indigo-50 text-indigo-700 border-indigo-200`
- Inactive style: `bg-gray-50 text-gray-400 border-gray-200`
- Only shown when `mode !== 'general'`

### `services/openaiService.ts`
- **Parameter**: `subOptions?: string[]` (9th param, line ~39)
- **Transport**: `sub_options: subOptions || []` in fetch body (line ~90)

### `supabase/functions/chat/index.ts`
- **`ChatRequest.sub_options`**: `string[]` (line ~28)
- **`ModeConfig.sub_option_prompts`**: `Record<string, string>` (line ~86)
- **`MODE_CONFIGS`**: All base prompts + 20 fragment prompts (lines ~92-410)
- **`DEFAULT_SUB_OPTIONS`**: Defaults for auto-detect (line ~417)
- **Body parsing**: `const subOptions = Array.isArray(body.sub_options) ? ...` (line ~1264)
- **Step 3 assembly**: Selects base prompt, determines effective sub-options, appends fragments (lines ~1351-1386)
- **Telemetry**: Logs `sub_options=[...]` (line ~1541)

---

## 11. Verification Checklist <a id="verification-checklist"></a>

### Are modes NOT cosmetic?

| Check | Verified |
|-------|----------|
| Each mode has a unique `system_prompt` in MODE_CONFIGS | ✅ All 5 specialized modes have distinct prompts |
| General mode uses `buildSystemPrompt()` (different from all others) | ✅ Dynamic based on complexity + RAG |
| Explicit modes set `skip_classifier: true` (changes pipeline behavior) | ✅ Classifier is skipped entirely |
| Each mode sets `model` tier (affects which GPT model is used) | ✅ Summary=standard, all others=reasoning |
| Mode is sent in request body and read by Edge Function | ✅ `body.mode` → `getModeConfig()` |

### Are sub-options NOT cosmetic?

| Check | Verified |
|-------|----------|
| Each sub-option has a prompt fragment in `sub_option_prompts` | ✅ All 20 fragments exist in MODE_CONFIGS |
| Frontend sends `sub_options: string[]` in request body | ✅ openaiService.ts line ~90 |
| Edge Function reads `body.sub_options` | ✅ Parsed into `subOptions` array |
| Fragments are appended to system prompt | ✅ Step 3 iterates and concatenates |
| Toggling a sub-option changes what the LLM sees | ✅ Different fragments = different instructions |
| Fragments are distinct per sub-option (not duplicated) | ✅ Each has unique content |

### Does auto-detect work?

| Check | Verified |
|-------|----------|
| Classifier includes `suggested_mode` in output | ✅ Part of classifier prompt and response parsing |
| Auto-detected mode changes the system prompt | ✅ Step 3 uses detected config |
| Auto-detected mode changes the model tier | ✅ Applied in pipeline Step 1 |
| Detection banner appears on frontend | ✅ `emitState('detected_mode', ...)` → banner UI |
| Switch button changes mode | ✅ `handleAcceptDetectedMode()` in App.tsx |
| Default sub-options applied on auto-detect | ✅ `DEFAULT_SUB_OPTIONS` used when `subOptions` is empty |
| Auto-detect only runs on general mode | ✅ `skip_classifier: false` only on general |

### Edge cases handled

| Case | Behavior |
|------|----------|
| User sends message on General, no detection | `buildSystemPrompt()` used, no sub-options |
| User sends message on General, detection fires | Detected mode's prompt + DEFAULT_SUB_OPTIONS applied |
| User explicitly selects a mode | Mode's prompt + user's toggled sub-options applied |
| All sub-options toggled OFF | Base prompt only — still functional, just less structured |
| Invalid sub-option ID sent | Silently ignored (no matching key in `sub_option_prompts`) |
| Formal ↔ Plain mutual exclusion | `exclusiveWith` enforced in `handleSubOptionToggle()` |
| Page refresh | Mode + sub-options restored from localStorage |

---

## Quick Diff: What Changes Between Modes

To confirm modes aren't cosmetic, here's what is **different** when you switch from General to Legal Research:

| Aspect | General (auto) | Legal Research (explicit) |
|--------|---------------|-------------------------|
| Classifier | Runs (GPT-4o-mini) | Skipped |
| Model | standard (GPT-4o) | reasoning (GPT-4o, lower temp) |
| System prompt | Generic Horizon prompt | "## MODE: LEGAL RESEARCH" specialized prompt |
| Sub-option fragments | None (or defaults if auto-detected) | User-configured (default: IRAC + Citations) |
| Output format | Flexible | IRAC structured (if toggled on) |

And what changes when toggling a sub-option within a mode:

| Setting | Legal Research (defaults) | Legal Research (all on) |
|---------|--------------------------|------------------------|
| System prompt length | Base + 2 fragments | Base + 4 fragments |
| IRAC structure | ✅ Enforced | ✅ Enforced |
| Case citations | ✅ Required | ✅ Required |
| Deep analysis | ❌ Not instructed | ✅ Counterarguments + risk weighting |
| Jurisdiction notes | ❌ Not instructed | ✅ Cross-jurisdictional caveats |
