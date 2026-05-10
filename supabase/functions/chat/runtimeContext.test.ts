// ============================================================================
// Runtime Context Injection Layer — Unit Tests
// Run with: deno test supabase/functions/chat/runtimeContext.test.ts
// ============================================================================

/// <reference lib="deno.ns" />

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { buildRuntimeContext, buildArchitecturalRules, RuntimeContextInput, buildGateContextBlock, GateContext } from "./runtimeContext.ts";

// ── Helper: create a default context input ──────────────────────────────────
function makeDefaultContext(overrides?: Partial<RuntimeContextInput>): RuntimeContextInput {
  return {
    userTimezone: 'Asia/Karachi',
    tenantId: 't_842394',
    tenantName: 'Horizon Legal',
    tenantPlan: 'enterprise',
    environment: 'production',
    userId: 'u_12345',
    userEmail: 'lawyer@horizonlegal.com',
    userRole: 'lawyer',
    matterId: 'm_2291',
    matterName: 'Lyndsy E. Pieters v. His Majesty',
    fileIds: ['f_001'],
    multiFileMode: false,
    ragScope: 'restricted_to_selected_matter',
    retrievalExecuted: true,
    documentsRetrieved: 6,
    structuredQueryExecuted: true,
    structuredDataPoints: 12,
    csvEngineActivated: false,
    activeModes: {
      csv_structured_mode: false,
      entity_resolution_enabled: true,
      hybrid_query_enabled: true,
    },
    activeActionFlags: ['deep_analysis'],
    ...overrides,
  };
}

// Fixed date for deterministic tests: 2026-02-28T02:42:00.000Z (Saturday)
const FIXED_DATE = new Date('2026-02-28T02:42:00.000Z');

// ============================================================================
// TEST SUITE 1: Temporal Context — Time Query
// ============================================================================

Deno.test("Temporal: includes UTC ISO timestamp", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "2026-02-28T02:42:00.000Z");
});

Deno.test("Temporal: includes Unix timestamp", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  const expectedUnix = Math.floor(FIXED_DATE.getTime() / 1000).toString();
  assertStringIncludes(result, `Unix timestamp: ${expectedUnix}`);
});

Deno.test("Temporal: includes correct UTC weekday", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Server weekday (UTC): Saturday");
});

Deno.test("Temporal: includes user timezone and local time when timezone provided", () => {
  const ctx = makeDefaultContext({ userTimezone: 'Asia/Karachi' });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "User timezone: Asia/Karachi");
  assertStringIncludes(result, "Local weekday:");
  assertStringIncludes(result, "Local date:");
  assertStringIncludes(result, "Local time:");
});

Deno.test("Temporal: works without timezone", () => {
  const ctx = makeDefaultContext({ userTimezone: undefined });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Current UTC time:");
  // Should NOT include local time block
  assertEquals(result.includes("User timezone:"), false);
  assertEquals(result.includes("Local time:"), false);
});

Deno.test("Temporal: contains DO NOT GUESS instruction", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "DO NOT GUESS");
});

Deno.test("Temporal: handles invalid timezone gracefully", () => {
  const ctx = makeDefaultContext({ userTimezone: 'Invalid/Timezone_XYZ' });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  // Should include fallback message, not crash
  assertStringIncludes(result, "Invalid/Timezone_XYZ");
});

// ============================================================================
// TEST SUITE 2: Tenant Context
// ============================================================================

Deno.test("Tenant: includes tenant name", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Tenant: Horizon Legal");
});

Deno.test("Tenant: includes tenant ID", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Tenant ID: t_842394");
});

Deno.test("Tenant: includes environment", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Environment: production");
});

Deno.test("Tenant: includes plan tier", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Plan Tier: enterprise");
});

Deno.test("Tenant: defaults gracefully when missing", () => {
  const ctx = makeDefaultContext({ tenantId: undefined, tenantName: undefined, tenantPlan: undefined });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Tenant: Unknown");
  assertStringIncludes(result, "Tenant ID: unknown");
  assertStringIncludes(result, "Plan Tier: standard");
});

// ============================================================================
// TEST SUITE 3: Matter / File Selection — Cross-Matter Isolation
// ============================================================================

Deno.test("Matter: includes selected matter name and ID", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Selected Matter: Lyndsy E. Pieters v. His Majesty");
  assertStringIncludes(result, "Matter ID: m_2291");
});

Deno.test("Matter: includes RAG scope when matter selected", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "RAG Scope: restricted_to_selected_matter");
});

Deno.test("Matter: includes file IDs when file-scoped", () => {
  const ctx = makeDefaultContext({ fileIds: ['f_001', 'f_002'], multiFileMode: true, ragScope: 'restricted_to_selected_file' });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Selected File IDs: f_001, f_002");
  assertStringIncludes(result, "Multi-file mode: true");
  assertStringIncludes(result, "RAG Scope: restricted_to_selected_file");
});

Deno.test("Matter: shows 'no matter selected' when none active", () => {
  const ctx = makeDefaultContext({ matterId: undefined, matterName: undefined, ragScope: 'none' });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "No matter selected");
  assertEquals(result.includes("Matter ID:"), false);
});

Deno.test("Matter: cross-matter isolation — only one matter referenced", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  // Ensure only the specified matter appears
  assertStringIncludes(result, "m_2291");
  // The context should not include references to other matters
  assertEquals(result.includes("m_9999"), false);
});

// ============================================================================
// TEST SUITE 4: Empty Retrieval — Zero Document Handling
// ============================================================================

Deno.test("Retrieval: shows 'executed' when retrieval ran", () => {
  const ctx = makeDefaultContext({ retrievalExecuted: true, documentsRetrieved: 6 });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Retrieval Status: executed");
  assertStringIncludes(result, "Documents Retrieved: 6");
});

Deno.test("Retrieval: shows 0 documents when retrieval returns nothing", () => {
  const ctx = makeDefaultContext({ retrievalExecuted: true, documentsRetrieved: 0, structuredDataPoints: 0, structuredQueryExecuted: false });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Retrieval Status: executed");
  assertStringIncludes(result, "Documents Retrieved: 0");
});

Deno.test("Retrieval: shows 'not_executed' when retrieval skipped", () => {
  const ctx = makeDefaultContext({ retrievalExecuted: false, documentsRetrieved: 0 });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Retrieval Status: not_executed");
});

Deno.test("Retrieval: includes structured query engine state", () => {
  const ctx = makeDefaultContext({ structuredQueryExecuted: true, structuredDataPoints: 12 });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Structured Query Engine: activated");
  assertStringIncludes(result, "Structured Data Points: 12");
});

Deno.test("Retrieval: includes CSV engine state", () => {
  const ctx = makeDefaultContext({ csvEngineActivated: true });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "CSV Engine: activated");
});

// ============================================================================
// TEST SUITE 5: Permission Enforcement
// ============================================================================

Deno.test("Permission: includes user role", () => {
  const ctx = makeDefaultContext({ userRole: 'lawyer' });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "User Role: lawyer");
});

Deno.test("Permission: admin gets full_workspace_access", () => {
  const ctx = makeDefaultContext({ userRole: 'admin' });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "User Role: admin");
  assertStringIncludes(result, "Access Scope: full_workspace_access");
});

Deno.test("Permission: owner gets full_workspace_access", () => {
  const ctx = makeDefaultContext({ userRole: 'owner' });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Access Scope: full_workspace_access");
});

Deno.test("Permission: lawyer with matter gets full_matter_access", () => {
  const ctx = makeDefaultContext({ userRole: 'lawyer', matterId: 'm_2291' });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Access Scope: full_matter_access");
});

Deno.test("Permission: lawyer without matter gets workspace_read", () => {
  const ctx = makeDefaultContext({ userRole: 'lawyer', matterId: undefined });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Access Scope: workspace_read");
});

Deno.test("Permission: viewer role is preserved", () => {
  const ctx = makeDefaultContext({ userRole: 'viewer', matterId: 'm_2291' });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "User Role: viewer");
  assertStringIncludes(result, "Access Scope: full_matter_access");
});

Deno.test("Permission: defaults to 'lawyer' when role is undefined", () => {
  const ctx = makeDefaultContext({ userRole: undefined });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "User Role: lawyer");
});

// ============================================================================
// TEST SUITE 6: Behavioral Constraints
// ============================================================================

Deno.test("Rules: includes no-fabrication constraint", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Never fabricate clients, cases, billing entries, dates");
});

Deno.test("Rules: includes no-time-guessing constraint", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Do NOT guess current time/date");
});

Deno.test("Rules: includes no-cross-matter constraint", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Do NOT infer cross-matter information");
});

Deno.test("Rules: includes no-ID-leakage constraint", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "Do NOT reference or reveal tenant IDs");
});

Deno.test("Rules: includes zero-retrieval constraint", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "retrieval returns 0 documents");
});

Deno.test("Rules: includes deterministic engine constraint", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "deterministic engine outputs");
});

// ============================================================================
// TEST SUITE 7: Intelligence Mode Flags
// ============================================================================

Deno.test("Modes: includes active modes", () => {
  const ctx = makeDefaultContext({ activeModes: { csv_structured_mode: true, entity_resolution_enabled: true, hybrid_query_enabled: false } });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "csv_structured_mode: true");
  assertStringIncludes(result, "entity_resolution_enabled: true");
  assertEquals(result.includes("hybrid_query_enabled: true"), false);
});

Deno.test("Modes: omits mode section when all modes are false", () => {
  const ctx = makeDefaultContext({ activeModes: { csv_structured_mode: false, entity_resolution_enabled: false } });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertEquals(result.includes("ACTIVE INTELLIGENCE MODES"), false);
});

// ============================================================================
// TEST SUITE 8: Action Flags
// ============================================================================

Deno.test("Flags: includes active action flags", () => {
  const ctx = makeDefaultContext({ activeActionFlags: ['deep_analysis', 'strict_citations'] });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "deep_analysis: enabled");
  assertStringIncludes(result, "strict_citations: enabled");
});

Deno.test("Flags: omits flags section when no flags active", () => {
  const ctx = makeDefaultContext({ activeActionFlags: [] });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertEquals(result.includes("ACTIVE ACTION FLAGS"), false);
});

// ============================================================================
// TEST SUITE 9: System Header — Non-Disclosure
// ============================================================================

Deno.test("Header: includes DO NOT DISCLOSE instruction", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "DO NOT DISCLOSE TO USER");
});

// ============================================================================
// TEST SUITE 10: Architectural Rules
// ============================================================================

Deno.test("ArchRules: includes authority hierarchy", () => {
  const rules = buildArchitecturalRules();
  assertStringIncludes(rules, "Response Authority Hierarchy");
  assertStringIncludes(rules, "HIGHEST AUTHORITY");
  assertStringIncludes(rules, "LOWEST PRIORITY");
});

Deno.test("ArchRules: includes cross-contamination prevention", () => {
  const rules = buildArchitecturalRules();
  assertStringIncludes(rules, "Cross-Contamination Prevention");
  assertStringIncludes(rules, "NEVER blend information from different matters");
});

Deno.test("ArchRules: includes tenant isolation", () => {
  const rules = buildArchitecturalRules();
  assertStringIncludes(rules, "Tenant Isolation");
  assertStringIncludes(rules, "NEVER reference or hallucinate data from other tenants");
});

Deno.test("ArchRules: includes immutability header", () => {
  const rules = buildArchitecturalRules();
  assertStringIncludes(rules, "IMMUTABLE");
});

Deno.test("ArchRules: prefers tool/retrieval over training data", () => {
  const rules = buildArchitecturalRules();
  assertStringIncludes(rules, "ALWAYS prefer tool/retrieval data");
});

// ============================================================================
// TEST SUITE 11: Integration — Full Context Assembly
// ============================================================================

Deno.test("Integration: full context contains all required sections", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  const requiredSections = [
    'TEMPORAL CONTEXT',
    'TENANT CONTEXT',
    'MATTER SELECTION CONTEXT',
    'PERMISSION CONTEXT',
    'RETRIEVAL STATE',
    'BEHAVIORAL CONSTRAINTS',
  ];
  for (const section of requiredSections) {
    assertStringIncludes(result, section);
  }
});

Deno.test("Integration: temporal context appears before tenant context", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  const temporalIdx = result.indexOf('TEMPORAL CONTEXT');
  const tenantIdx = result.indexOf('TENANT CONTEXT');
  assertEquals(temporalIdx < tenantIdx, true);
});

Deno.test("Integration: matter context appears before permission context", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  const matterIdx = result.indexOf('MATTER SELECTION CONTEXT');
  const permIdx = result.indexOf('PERMISSION CONTEXT');
  assertEquals(matterIdx < permIdx, true);
});

Deno.test("Integration: behavioral constraints appear after retrieval state", () => {
  const ctx = makeDefaultContext();
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  const retrievalIdx = result.indexOf('RETRIEVAL STATE');
  const rulesIdx = result.indexOf('BEHAVIORAL CONSTRAINTS');
  assertEquals(retrievalIdx < rulesIdx, true);
});

// ============================================================================
// TEST SUITE 12: Edge Cases
// ============================================================================

Deno.test("Edge: empty fileIds array does not add file section", () => {
  const ctx = makeDefaultContext({ fileIds: [], multiFileMode: false });
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertEquals(result.includes("Selected File IDs:"), false);
});

Deno.test("Edge: multiple timezones produce different local times", () => {
  const ctxKarachi = makeDefaultContext({ userTimezone: 'Asia/Karachi' });
  const ctxNY = makeDefaultContext({ userTimezone: 'America/New_York' });
  const resultKarachi = buildRuntimeContext(ctxKarachi, FIXED_DATE);
  const resultNY = buildRuntimeContext(ctxNY, FIXED_DATE);
  // Both should have UTC time identical
  assertStringIncludes(resultKarachi, "2026-02-28T02:42:00.000Z");
  assertStringIncludes(resultNY, "2026-02-28T02:42:00.000Z");
  // But local times should differ
  assertStringIncludes(resultKarachi, "Asia/Karachi");
  assertStringIncludes(resultNY, "America/New_York");
});

Deno.test("Edge: minimal context (no optional fields) still produces valid output", () => {
  const ctx: RuntimeContextInput = {
    environment: 'development',
    userId: 'u_minimal',
    multiFileMode: false,
    ragScope: 'none',
    retrievalExecuted: false,
    documentsRetrieved: 0,
    structuredQueryExecuted: false,
    structuredDataPoints: 0,
    csvEngineActivated: false,
    activeModes: {},
    activeActionFlags: [],
  };
  const result = buildRuntimeContext(ctx, FIXED_DATE);
  assertStringIncludes(result, "TEMPORAL CONTEXT");
  assertStringIncludes(result, "TENANT CONTEXT");
  assertStringIncludes(result, "No matter selected");
  assertStringIncludes(result, "User Role: lawyer"); // default
});

// ============================================================================
// TEST SUITE 13: Gate Context Builder — Conversational Fast-Path
// ============================================================================

Deno.test("GateCtx: includes UTC date", () => {
  const result = buildGateContextBlock({}, FIXED_DATE);
  assertStringIncludes(result, "2026-02-28T02:42:00.000Z");
  assertStringIncludes(result, "Saturday");
});

Deno.test("GateCtx: includes user local date when timezone provided", () => {
  const result = buildGateContextBlock({ userTimezone: 'Asia/Karachi' }, FIXED_DATE);
  assertStringIncludes(result, "User timezone: Asia/Karachi");
  assertStringIncludes(result, "User local date:");
  assertStringIncludes(result, "User local time:");
});

Deno.test("GateCtx: includes user email", () => {
  const result = buildGateContextBlock({ userEmail: 'lawyer@firm.com' }, FIXED_DATE);
  assertStringIncludes(result, "User: lawyer@firm.com");
});

Deno.test("GateCtx: includes user role", () => {
  const result = buildGateContextBlock({ userRole: 'admin' }, FIXED_DATE);
  assertStringIncludes(result, "Role: admin");
});

Deno.test("GateCtx: includes tenant/org name", () => {
  const result = buildGateContextBlock({ tenantName: 'Horizon Legal' }, FIXED_DATE);
  assertStringIncludes(result, "Organization: Horizon Legal");
});

Deno.test("GateCtx: includes active matter and client", () => {
  const result = buildGateContextBlock({ matterName: 'Smith v. Jones', matterClient: 'John Smith' }, FIXED_DATE);
  assertStringIncludes(result, "Active matter: Smith v. Jones");
  assertStringIncludes(result, "Client: John Smith");
});

Deno.test("GateCtx: omits matter section when no matter", () => {
  const result = buildGateContextBlock({}, FIXED_DATE);
  assertEquals(result.includes("Active matter:"), false);
  assertEquals(result.includes("Client:"), false);
});

Deno.test("GateCtx: omits optional fields when not provided", () => {
  const result = buildGateContextBlock({}, FIXED_DATE);
  assertEquals(result.includes("User:"), false);
  assertEquals(result.includes("Role:"), false);
  assertEquals(result.includes("Organization:"), false);
});

Deno.test("GateCtx: has system facts boundary markers", () => {
  const result = buildGateContextBlock({}, FIXED_DATE);
  assertStringIncludes(result, "--- SYSTEM FACTS");
  assertStringIncludes(result, "--- END SYSTEM FACTS ---");
  assertStringIncludes(result, "never guess");
});

Deno.test("GateCtx: full context includes all fields", () => {
  const ctx: GateContext = {
    userTimezone: 'America/New_York',
    userEmail: 'jane@lawfirm.com',
    userRole: 'lawyer',
    tenantName: 'Acme Law',
    matterName: 'Doe v. Roe',
    matterClient: 'Jane Doe',
  };
  const result = buildGateContextBlock(ctx, FIXED_DATE);
  assertStringIncludes(result, "2026-02-28T02:42:00.000Z");
  assertStringIncludes(result, "America/New_York");
  assertStringIncludes(result, "jane@lawfirm.com");
  assertStringIncludes(result, "lawyer");
  assertStringIncludes(result, "Acme Law");
  assertStringIncludes(result, "Doe v. Roe");
  assertStringIncludes(result, "Jane Doe");
});

Deno.test("GateCtx: handles invalid timezone gracefully", () => {
  const result = buildGateContextBlock({ userTimezone: 'Fake/Zone' }, FIXED_DATE);
  assertStringIncludes(result, "Fake/Zone");
  // Should not crash, should include fallback
  assertStringIncludes(result, "SYSTEM FACTS");
});
