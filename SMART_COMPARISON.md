# Smart Comparison Pipeline

Enterprise-grade intelligence deduplication and relevance scoring that runs automatically after every extraction.

## Overview

When multiple documents are added to the same matter, they often contain overlapping clauses, obligations, and dates. The Smart Comparison Pipeline prevents data bloat by:

1. **Deduplicating** near-identical clauses, obligations, dates, and risks
2. **Scoring relevance** so summaries prioritise what actually matters

## UX: Real-Time Extraction Progress

When users click "Reprocess Documents" in MatterBrief or IntelligenceDashboard:

1. **Jobs Queued** — HTTP 202 response, extraction jobs added to BullMQ
2. **Live Progress** — [ExtractionProgress](components/ExtractionProgress.tsx) component polls `/api/matters/:caseId/extraction-status` every 2.5s
3. **Visual Feedback**:
   - Progress bar (0-100%)
   - Status breakdown: X processing, Y pending, Z completed, N failed
   - Auto-dismisses when all jobs complete
4. **Auto-Refresh** — Intelligence data reloads when extraction finishes

No more clicking "Reprocess" multiple times — users see exactly what's happening.

## Architecture

```
File Upload / Move → Extraction → Save → Canonicalize Entities → Smart Comparison
                                                                    ├─ Phase 1: Clause Dedup
                                                                    ├─ Phase 2: Obligation Merge
                                                                    ├─ Phase 2b: Date Dedup  
                                                                    ├─ Phase 2c: Risk Dedup
                                                                    └─ Phase 3: Relevance Scoring
```

The pipeline runs **post-save**: intelligence is first written to the database, then duplicates are removed and relevance metadata is added. This is safer than pre-save filtering because it never loses data silently.

## Phases

### Phase 1 — Clause Deduplication

| Step | Method | Cost |
|------|--------|------|
| Generate embeddings for all clauses | `text-embedding-3-small` | ~$0.0001/clause |
| Cosine similarity > 0.88 | Pure math (free) | $0 |
| Ambiguous range (0.78–0.88) | `gpt-4.1-mini` LLM verification | ~$0.01/batch |
| Below 0.78 | Kept as unique | $0 |

Duplicate clauses are **deleted** from `matter_clauses`.

### Phase 2 — Obligation Merging

Same approach as clause dedup, but tuned for obligations:
- Compares `obligor → obligee: text` strings
- LLM checks whether parties and duties are truly the same
- Duplicates are deleted from `matter_obligations`

### Phase 2b — Date Deduplication

**Deterministic** — no AI needed:
- Exact match on `date_type + date_value`
- Same deadline appearing in two contracts = one entry

### Phase 2c — Risk Deduplication

- Embeddings with a higher threshold (0.90) for precision
- No LLM verification — risks are shorter and more uniform

### Phase 3 — Relevance Scoring

Every remaining intelligence item is scored against the matter's existing context:

| Score | Meaning | Effect |
|-------|---------|--------|
| `high` | Directly relevant to matter parties/issues | Prioritised in summaries |
| `medium` | Tangentially relevant | Normal display |
| `low` | Boilerplate or unrelated | Flagged in `metadata.relevance` |

Low-relevance items are **not deleted** — only flagged so dashboards can filter them.

## Cost Analysis

For a typical matter with 5 documents (20 clauses & 10 obligations each):

| Component | Cost |
|-----------|------|
| Embeddings (100 items) | ~$0.002 |
| LLM verification (~10 ambiguous pairs) | ~$0.05 |
| Relevance scoring (100 items) | ~$0.08 |
| **Total per file** | **~$0.13** |

## Integration Point

[extractionService.ts](backend/src/services/extractionService.ts) step 10c:

```typescript
// After: saveExtractionResults() + runCanonicalizationPipeline()
// Before: job status update

const comparisonResult = await runSmartComparison(case_id, tenant_id, file_id, filename);
```

Results are stored in the extraction job's `results.smart_comparison` field.

## Files

- [intelligenceComparisonService.ts](backend/src/services/intelligenceComparisonService.ts) — Full service (all 3 phases)
- [extractionService.ts](backend/src/services/extractionService.ts) — Integration at step 10c

## First File Behaviour

When a file is the first in a matter, deduplication is skipped (no existing data to compare against). Relevance scoring still runs using the matter name/description as context.

## Error Handling

All phases are wrapped in try/catch and are **non-fatal** — if comparison fails, extraction still completes normally. Errors are logged but don't block the pipeline.
