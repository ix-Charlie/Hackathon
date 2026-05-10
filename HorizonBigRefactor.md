# Horizon → Enterprise Legal Intelligence Platform

## Refactoring Roadmap

---

## Overall Target State

At the end of this roadmap, Horizon must have:

- [ ] **Structured legal memory per Matter**
- [ ] **Pre-processing + extraction on upload**
- [ ] **Query decomposition + routing**
- [ ] **Model orchestration** (not single model usage)
- [ ] **Multi-step reasoning pipelines**
- [ ] **Deterministic structured outputs**
- [ ] **Conflict detection + analytical engines**
- [ ] **Matter-scoped intelligence**
- [ ] **Validation / verification layer**
- [ ] **Cost-aware model allocation**

> If it doesn't have these, it is not enterprise-grade.

---

## Phase 0 — Foundational Principle Shift

Before touching architecture:

**Stop thinking:**
> "User asks → LLM answers"

**Start thinking:**
> "User intent triggers an analytical workflow."

This mindset change is mandatory.

---

## Phase 1 — Matter-Centric Intelligence Layer

### Objective
Make each Matter a **persistent intelligence container** — not just a folder.

### What Enterprise Systems Do

When a document is uploaded, they:
1. Parse it
2. Extract structured entities
3. Classify clauses
4. Identify obligations
5. Detect dates
6. Store structured results
7. Link entities across documents

They do this **ONCE**. They do not re-analyze everything on every question.

### What We Must Do

#### 1. Structured Legal Memory Per Matter

Introduce structured storage for:
- **Entities** — parties, courts, statutes, defined terms
- **Clauses** — with type classification
- **Obligations** — who owes what to whom
- **Dates** — effective, termination, deadlines
- **Cross-references** — between documents
- **Risk indicators** — flagged issues
- **Document metadata** — enriched beyond filename

> Database changes — see `017_matter_intelligence_schema.sql`

#### 2. Extraction Pipeline on File Upload

When file is uploaded, system must automatically:
1. Parse text
2. Run clause classification
3. Extract entities
4. Extract obligations
5. Extract critical dates
6. Store results in structured tables
7. Link everything to Matter ID

**This pipeline must be deterministic.** Not "ask model loosely."

Use:
- Smaller reasoning model (`gpt-4o-mini`) for extraction
- **Structured JSON schema output** (`response_format: json_schema`)
- **Strict Zod validation** before saving

---

## Phase 2 — Query Intelligence Router

### Step 1: Build Query Classifier

Every user query must first be classified into:

| Intent Category | Description |
|----------------|-------------|
| `general_qa` | General questions |
| `clause_lookup` | Find specific clause types |
| `comparison` | Compare across documents |
| `conflict_detection` | Find contradictions |
| `timeline_analysis` | Date/deadline questions |
| `risk_assessment` | Risk evaluation |
| `drafting` | Generate legal text |
| `summarization` | Summarize content |
| `cross_document_reasoning` | Multi-document analysis |
| `obligation_query` | Who owes what |
| `entity_lookup` | Find parties/courts/statutes |

Use: `gpt-4o-mini` — must output a structured intent type. **No answering yet.**

### Step 2: Decompose Complex Queries

If query contains multiple parts:
1. Break into sub-questions
2. Route each independently
3. Merge outputs

---

## Phase 3 — Model Orchestration Strategy

Different models for different cognitive tasks.

### Tiered Model Allocation

| Tier | Model | Use For |
|------|-------|---------|
| **Tier 1** — Lightweight | `gpt-4o-mini` | Classification, extraction, simple transforms |
| **Tier 2** — Mid-tier | `gpt-4o` | Clause comparison, synthesis, standard drafting |
| **Tier 3** — High-tier | `gpt-4o` (→ `o3-mini`/`gpt-5.2` later) | Conflict detection, risk eval, strategic analysis, complex drafting, multi-hop reasoning |

> Never use top-tier model for everything. Enterprise systems route intelligently.

---

## Phase 4 — Analytical Engines

These are **not just prompts** — they are **deterministic workflows**.

### 1. Conflict Detection Engine

**Inputs**: Extracted clauses, obligations, dates, definitions

**Process**:
1. Identify clause types across documents
2. Compare obligation polarity
3. Detect contradictory language
4. Detect deadline mismatches
5. Send structured findings to **Tier 3** model for explanation

**Output**: Structured conflicts with confidence score + source references

### 2. Obligation Tracker Engine

Answers: **Who owes what? By when? Under which document?**

This comes from **structured memory** — not semantic search.

### 3. Timeline Builder

Automatically construct:
- Effective dates
- Renewal dates
- Termination triggers
- Notice periods
- Payment schedules

Stored as structured timeline per Matter.

### 4. Risk Scoring Engine

Based on:
- Missing clauses
- One-sided indemnities
- Unlimited liability
- Auto-renewal traps
- Undefined terms

Risk flags are **structured**. Then reasoning model explains impact.

---

## Phase 5 — Hybrid Retrieval Strategy

Stop using pure vector search. Use:

1. **Structured retrieval** — from matter intelligence tables
2. **Semantic retrieval** — embeddings (existing)
3. **Metadata filtering** — Matter, document type, clause type

Combine results before sending to reasoning model.

> Enterprise systems never rely purely on embeddings.

---

## Phase 6 — Validation Layer

After generating answer, send to secondary reasoning pass:

**Check**:
- Are all claims supported by sources?
- Are citations present?
- Any logical inconsistencies?

If issues → **revise internally** before showing user.

> Enterprise tools self-check.

---

## Phase 7 — Persistent Matter Intelligence

Each Matter should accumulate:
- Extracted knowledge
- Analytical outputs
- Risk profiles
- Timeline
- Key facts summary
- Prior Q&A results

**Over time, Matter becomes smarter.** This mimics human associate memory.

---

## Phase 8 — Chat Evolution

When user chats inside a Matter, system must automatically:
1. Use Matter ID
2. Retrieve structured memory
3. Retrieve relevant clauses
4. Include timeline context
5. Include risk profile
6. Then answer

User should feel: *"It already knows this deal."*

---

## Phase 9 — Cost Optimization Strategy

- Cache extraction results
- Cache analytical engine outputs
- Cache clause classifications
- Cache timeline builds
- **Never recompute unless document changes**

---

## Phase 10 — Security + Multi-Tenancy Hardening

- Enforce strict tenant isolation
- Enforce Matter-scoped access
- Prevent cross-tenant embedding leakage
- Log analytical operations
- Audit model decisions

> If you don't have this, law firms won't trust you.

---

## Final State Architecture

```
User Query
  → Classifier (intent detection)
  → Decomposer (if multi-part)
  → Retrieval (structured + semantic)
  → Analytical Engine (if applicable)
  → Reasoning Model (tiered)
  → Validation Pass
  → Final Response
```

**All scoped to: Matter ID.**

---

## User Experience Impact

Instead of: *"Here is what I found."*

Horizon will return:
- **Structured sections**
- **Explicit conflict tables**
- **Risk summaries**
- **Linked citations**
- **Timeline outputs**
- **Actionable recommendations**

That is enterprise behavior.

---

## Implementation Status

| Phase | Description | Status |
|-------|-------------|--------|
| 0 | Format plan + cleanup dead code | ✅ Complete |
| 1 | Matter intelligence schema + extraction pipeline | ✅ Complete |
| 2 | Query intelligence router | ✅ Complete |
| 3 | Model orchestration tiers | ✅ Complete |
| 4 | Analytical engines | ✅ Complete |
| 5 | Hybrid retrieval upgrade | ✅ Complete |
| 6 | Validation layer | ✅ Complete |
| 7 | Persistent matter intelligence | ✅ Complete |
| 8 | Chat evolution | ✅ Complete |
| 9 | Cost optimization + caching | ✅ Complete |
| 10 | Security hardening | ✅ Complete |
