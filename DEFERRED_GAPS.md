# Deferred Enterprise Gaps — Non-Code Dependencies

These gaps were identified in QA testing but cannot be closed through code changes alone. They require external service integrations, licensing agreements, or infrastructure investments.

---

## 1. External Legal Database / Precedent Search (Gap 1)

**Gap:** Horizon can identify case citations and statutory references found *within uploaded documents*, but cannot independently search external legal databases (Westlaw, LexisNexis, Google Scholar Legal) to find additional precedents or verify cited authorities.

**Why it's deferred:**
- **Licensing:** Westlaw (Thomson Reuters) and LexisNexis (RELX) charge per-query or per-seat licensing fees. This is a business/contract negotiation, not a code problem.
- **API access:** Neither service offers a simple public REST API. Integration requires enterprise partnership agreements.
- **Alternative:** Google Scholar Legal has no official API. Web scraping is against ToS.
- **Cost model:** Per-query pricing (typically $3-15 per search) would need to be factored into tenant billing.

**What we've done instead (code):**
- Enhanced Legal Research prompts to extract all case citations, statutory references, and legal authorities found within uploaded documents
- Added argument-precedent mapping that links legal arguments to their supporting authorities
- Clear labeling: document-sourced authorities vs. general legal knowledge
- Precedent cross-referencing across multiple uploaded documents

**When to revisit:** When a legal data provider offers a viable API partnership or when open legal databases (CourtListener, case.law) mature enough for production use.

---

## 2. Auto-Citation of External Case Law (Gap 1, 4)

**Gap:** Drafts and research outputs include placeholder citations like `[AUTHORITY NEEDED: topic]` instead of automatically inserting verified case law from a legal database.

**Why it's deferred:**
- Requires external legal database integration (see #1 above)
- Hallucinated case citations are a critical risk — auto-inserting unverified case names is worse than a placeholder
- Citation verification requires a real-time lookup service

**What we've done instead (code):**
- Drafting mode now identifies where authorities are needed and inserts structured placeholders
- Legal Research mode extracts all cited authorities from uploaded documents
- With Authorities sub-option attempts to provide statute numbers and case names from model training data, clearly labelled as general knowledge

---

## 3. Real-Time Multi-User Collaboration (Gap 6)

**Gap:** Multiple lawyers working on the same matter cannot see each other's queries, annotations, or work product in real time.

**Why it's deferred:**
- **Infrastructure:** Requires WebSocket/real-time sync infrastructure (Supabase Realtime partially supports this, but not for chat state)
- **UX complexity:** Collaborative editing, presence indicators, conflict resolution — this is a significant product decision
- **Privacy:** Some firms require lawyer-to-lawyer communication isolation even within the same matter

**What we've done instead (code):**
- Matter context is shared across all users in the same tenant
- Intelligence data (entities, risks, obligations) is matter-level, visible to all team members
- Export capabilities allow sharing analysis as Word/PDF documents

---

## 4. Regulatory & Compliance Feed Integration (Gap 6)

**Gap:** No live feed of regulatory changes, court rule updates, or compliance requirement modifications.

**Why it's deferred:**
- **Data source:** Requires subscription to regulatory data feeds (e.g., Bloomberg Law, Practical Law)
- **Jurisdiction scope:** Regulatory tracking varies by jurisdiction, practice area, and agency
- **Maintenance:** Keeping regulatory data current requires ongoing curation

**What we've done instead (code):**
- Jurisdiction-aware prompts that reference applicable rules from model training data
- Jurisdiction Notes sub-option flags cross-jurisdictional differences
- Jurisdiction Align sub-option applies jurisdiction-specific formatting conventions

---

## 5. Automated Workflow Orchestration (Gap 6)

**Gap:** No automated triggers (e.g., "when a deadline is 30 days away, notify team" or "when new document uploaded, auto-run full extraction and brief team").

**Why it's deferred:**
- **Notification infrastructure:** Requires email/SMS/Slack notification service integration
- **Scheduling:** Needs a cron/scheduler service for time-based triggers
- **Customization:** Workflow rules vary significantly by firm, practice area, and matter type

**What we've done instead (code):**
- Intelligence Dashboard surfaces overdue obligations and upcoming deadlines with visual indicators
- Matter Brief shows "needs attention" flags
- Extraction pipeline runs automatically on document upload
- Real-time extraction progress tracking in UI

---

## Priority for Future Implementation

| Gap | Business Impact | Technical Complexity | Recommended Timing |
|-----|----------------|---------------------|-------------------|
| External Legal DB | High — differentiator for research mode | High — licensing + API | When partnership secured |
| Auto-Citation | High — saves manual citation work | Depends on #1 | After external DB |
| Multi-User Collab | Medium — team workflow | Medium — Supabase Realtime | Next major release |
| Regulatory Feeds | Medium — compliance practices | Medium — data partnerships | After core stabilization |
| Workflow Automation | Medium — efficiency | Low-Medium — cron + notifications | Next major release |
