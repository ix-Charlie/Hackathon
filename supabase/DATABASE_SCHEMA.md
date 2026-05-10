# Horizon Database Schema

> Last Updated: 31 January 2026

---

## Tables Overview

| Table | Purpose |
|-------|---------|
| `tenants` | Organizations/companies (multi-tenant) |
| `tenant_members` | Junction: users ↔ tenants (with roles) |
| `cases` | Legal cases/matters |
| `folders` | Folders within cases |
| `document_files` | File metadata (name, path, type) |
| `document_chunks` | Text chunks with embeddings for RAG |
| `chat_sessions` | Chat conversation sessions |
| `chat_messages` | Individual messages in chats |
| `pricing_tiers` | Subscription plans |
| `subscriptions` | Tenant subscriptions |
| `usage_logs` | Token usage tracking |
| `user_rate_limits` | Rate limiting per user |

---

## Table Schemas

### `tenants`
| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| name | text | NO | - |
| plan | text | NO | 'free' |
| pricing_tier_id | uuid | YES | - |
| subscription_status | text | YES | 'active' |
| created_at | timestamp | YES | now() |

### `tenant_members`
| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| tenant_id | uuid | NO | - |
| user_id | uuid | NO | - |
| role | text | NO | - |
| joined_at | timestamp | YES | now() |

### `cases`
| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| tenant_id | uuid | NO | - |
| case_number | text | YES | - |
| name | text | NO | - |
| description | text | YES | - |
| client_name | text | YES | - |
| status | text | YES | 'active' |
| created_by | uuid | YES | - |
| created_at | timestamptz | YES | now() |
| updated_at | timestamptz | YES | now() |
| archived_at | timestamptz | YES | - |

### `folders`
| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| tenant_id | uuid | NO | - |
| case_id | uuid | NO | - |
| parent_folder_id | uuid | YES | - |
| name | text | NO | - |
| description | text | YES | - |
| folder_type | text | YES | - |
| created_by | uuid | YES | - |
| created_at | timestamptz | YES | now() |
| updated_at | timestamptz | YES | now() |

### `document_files`
| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| tenant_id | uuid | YES | - |
| case_id | uuid | YES | - |
| folder_id | uuid | YES | - |
| filename | text | NO | - |
| filetype | text | YES | - |
| storage_path | text | NO | - |
| uploaded_by | uuid | YES | - |
| created_at | timestamp | YES | now() |

### `document_chunks`
| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | auto-increment |
| tenant_id | uuid | YES | - |
| file_id | uuid | YES | - |
| case_id | uuid | YES | - |
| folder_id | uuid | YES | - |
| content | text | NO | - |
| metadata | jsonb | YES | - |
| embedding | vector(1536) | YES | - |
| fts | tsvector | YES | GENERATED (from content) |
| created_at | timestamp | YES | now() |

**Note:** The `metadata` JSONB field now stores rich metadata:
```json
{
  "filename": "contract.pdf",
  "chunk_index": 0,
  "total_chunks": 5,
  "start_char": 0,
  "end_char": 1500,
  "document_type": "contract",
  "court": "Supreme Court of Pakistan",
  "jurisdiction": "Pakistan",
  "year": 2024,
  "case_number": "PLD 2024 SC 123",
  "sections_referenced": ["Section 302 PPC", "Article 184(3)"],
  "names_mentioned": ["Mr. Ahmad", "Justice Khan"],
  "emails_mentioned": ["client@email.com"],
  "phones_mentioned": ["+92-300-1234567"]
}
```

### `chat_sessions`
| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| tenant_id | uuid | YES | - |
| user_id | uuid | YES | - |
| title | text | YES | - |
| created_at | timestamp | YES | now() |

### `chat_messages`
| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | auto-increment |
| session_id | uuid | YES | - |
| role | text | YES | - |
| content | text | NO | - |
| created_at | timestamp | YES | now() |

### `pricing_tiers`
| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| name | text | NO | - |
| display_name | text | NO | - |
| description | text | YES | - |
| price_monthly | numeric | NO | - |
| price_yearly | numeric | YES | - |
| rate_limit_per_hour | integer | NO | 20 |
| max_documents | integer | NO | 5 |
| max_file_size_mb | integer | NO | 10 |
| max_users_per_tenant | integer | NO | 1 |
| features | jsonb | YES | '{}' |
| is_active | boolean | YES | true |
| sort_order | integer | YES | 0 |
| created_at | timestamptz | YES | now() |
| updated_at | timestamptz | YES | now() |

### `subscriptions`
| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | uuid | NO | gen_random_uuid() |
| tenant_id | uuid | NO | - |
| pricing_tier_id | uuid | NO | - |
| status | text | NO | 'active' |
| billing_cycle | text | NO | 'monthly' |
| stripe_subscription_id | text | YES | - |
| stripe_customer_id | text | YES | - |
| payment_method | text | YES | - |
| trial_ends_at | timestamptz | YES | - |
| current_period_start | timestamptz | NO | now() |
| current_period_end | timestamptz | NO | - |
| canceled_at | timestamptz | YES | - |
| created_at | timestamptz | YES | now() |
| updated_at | timestamptz | YES | now() |

### `usage_logs`
| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| id | bigint | NO | auto-increment |
| tenant_id | uuid | YES | - |
| user_id | uuid | YES | - |
| tokens_in | integer | YES | - |
| tokens_out | integer | YES | - |
| model | text | YES | - |
| created_at | timestamp | YES | now() |

### `user_rate_limits`
| Column | Type | Nullable | Default |
|--------|------|----------|---------|
| user_id | uuid | NO | - |
| tenant_id | uuid | YES | - |
| request_count | integer | NO | 0 |
| window_start | timestamptz | NO | now() |

---

## RLS Policies Summary

All tables use Row Level Security (RLS) with `tenant_id` filtering.

### Policy Methods Used
- **`get_user_tenant_id()`** - Custom function returning user's tenant
- **`auth.jwt() ->> 'tenant_id'`** - Direct JWT claim access
- **`auth.uid()`** - Current user ID
- **`auth.role()`** - Service role check

### Policies by Table

| Table | SELECT | INSERT | UPDATE | DELETE | Notes |
|-------|--------|--------|--------|--------|-------|
| `tenants` | ✅ members | - | ✅ owners | - | Service role: ALL |
| `tenant_members` | ✅ own | ✅ own | ✅ own | ✅ own | Service role: ALL |
| `cases` | ✅ tenant | ✅ tenant | ✅ tenant | ✅ tenant | via `get_user_tenant_id()` |
| `folders` | ✅ tenant | ✅ tenant | ✅ tenant | ✅ tenant | via `get_user_tenant_id()` |
| `document_files` | ✅ tenant | ✅ tenant | ✅ tenant | ✅ tenant | Dual policies |
| `document_chunks` | ✅ tenant | ✅ tenant | ✅ tenant | ✅ tenant | Dual policies |
| `chat_sessions` | ✅ tenant | ✅ tenant | ✅ tenant | ✅ tenant | Dual policies |
| `chat_messages` | ✅ via session | ✅ via session | ✅ via session | ✅ via session | Checks session's tenant |
| `pricing_tiers` | ✅ if active | - | - | - | Public read |
| `subscriptions` | ✅ tenant | - | - | - | Service role: ALL |
| `usage_logs` | ✅ tenant | ✅ tenant | - | - | - |
| `user_rate_limits` | ✅ own/tenant | - | ✅ tenant | - | Service role: ALL |
| `users` | ✅ own | - | ✅ own | - | Service role: ALL |

### Detailed Policies

<details>
<summary><b>cases</b> (4 policies)</summary>

| Policy | Command | Condition |
|--------|---------|-----------|
| Users can view their tenant's cases | SELECT | `tenant_id = get_user_tenant_id()` |
| Users can insert cases for their tenant | INSERT | `tenant_id = get_user_tenant_id()` |
| Users can update their tenant's cases | UPDATE | `tenant_id = get_user_tenant_id()` |
| Users can delete their tenant's cases | DELETE | `tenant_id = get_user_tenant_id()` |

</details>

<details>
<summary><b>folders</b> (4 policies)</summary>

| Policy | Command | Condition |
|--------|---------|-----------|
| Users can view their tenant's folders | SELECT | `tenant_id = get_user_tenant_id()` |
| Users can insert folders for their tenant | INSERT | `tenant_id = get_user_tenant_id()` |
| Users can update their tenant's folders | UPDATE | `tenant_id = get_user_tenant_id()` |
| Users can delete their tenant's folders | DELETE | `tenant_id = get_user_tenant_id()` |

</details>

<details>
<summary><b>document_files</b> (8 policies - dual method)</summary>

| Policy | Command | Condition |
|--------|---------|-----------|
| Users can view their tenant's document files | SELECT | `tenant_id = get_user_tenant_id()` |
| read own tenant document files | SELECT | `tenant_id = auth.jwt() ->> 'tenant_id'` |
| Users can insert document files for their tenant | INSERT | `tenant_id = get_user_tenant_id()` |
| insert own tenant document files | INSERT | `tenant_id = auth.jwt() ->> 'tenant_id'` |
| Users can update their tenant's document files | UPDATE | `tenant_id = get_user_tenant_id()` |
| update own tenant document files | UPDATE | `tenant_id = auth.jwt() ->> 'tenant_id'` |
| Users can delete their tenant's document files | DELETE | `tenant_id = get_user_tenant_id()` |
| delete own tenant document files | DELETE | `tenant_id = auth.jwt() ->> 'tenant_id'` |

</details>

<details>
<summary><b>document_chunks</b> (8 policies - dual method)</summary>

| Policy | Command | Condition |
|--------|---------|-----------|
| Users can view their tenant's document chunks | SELECT | `tenant_id = get_user_tenant_id()` |
| read own tenant document chunks | SELECT | `tenant_id = auth.jwt() ->> 'tenant_id'` |
| Users can insert document chunks for their tenant | INSERT | `tenant_id = get_user_tenant_id()` |
| insert own tenant document chunks | INSERT | `tenant_id = auth.jwt() ->> 'tenant_id'` |
| Users can update their tenant's document chunks | UPDATE | `tenant_id = get_user_tenant_id()` |
| update own tenant document chunks | UPDATE | `tenant_id = auth.jwt() ->> 'tenant_id'` |
| Users can delete their tenant's document chunks | DELETE | `tenant_id = get_user_tenant_id()` |
| delete own tenant document chunks | DELETE | `tenant_id = auth.jwt() ->> 'tenant_id'` |

</details>

<details>
<summary><b>chat_sessions</b> (8 policies - dual method)</summary>

| Policy | Command | Condition |
|--------|---------|-----------|
| Users can view their tenant's chat sessions | SELECT | `tenant_id = get_user_tenant_id()` |
| read own tenant chat sessions | SELECT | `tenant_id = auth.jwt() ->> 'tenant_id'` |
| Users can insert chat sessions for their tenant | INSERT | `tenant_id = get_user_tenant_id()` |
| insert own tenant chat sessions | INSERT | `tenant_id = auth.jwt() ->> 'tenant_id'` |
| Users can update their tenant's chat sessions | UPDATE | `tenant_id = get_user_tenant_id()` |
| update own tenant chat sessions | UPDATE | `tenant_id = auth.jwt() ->> 'tenant_id'` |
| Users can delete their tenant's chat sessions | DELETE | `tenant_id = get_user_tenant_id()` |
| delete own tenant chat sessions | DELETE | `tenant_id = auth.jwt() ->> 'tenant_id'` |

</details>

<details>
<summary><b>chat_messages</b> (4 policies - via session lookup)</summary>

| Policy | Command | Condition |
|--------|---------|-----------|
| read own tenant chat messages | SELECT | `EXISTS (SELECT 1 FROM chat_sessions cs WHERE cs.id = session_id AND cs.tenant_id = auth.jwt() ->> 'tenant_id')` |
| insert own tenant chat messages | INSERT | Same EXISTS check |
| update own tenant chat messages | UPDATE | Same EXISTS check |
| delete own tenant chat messages | DELETE | Same EXISTS check |

</details>

<details>
<summary><b>tenants</b> (3 policies)</summary>

| Policy | Command | Condition |
|--------|---------|-----------|
| Users can view their tenants | SELECT | `EXISTS (SELECT 1 FROM tenant_members WHERE tenant_id = tenants.id AND user_id = auth.uid())` |
| Owners can update their tenant | UPDATE | Same EXISTS + `role = 'owner'` |
| Service role full access to tenants | ALL | `true` (service_role only) |

</details>

<details>
<summary><b>tenant_members</b> (3 policies)</summary>

| Policy | Command | Condition |
|--------|---------|-----------|
| Users can read own membership | SELECT | `user_id = auth.uid()` |
| Users can manage own membership | ALL | `user_id = auth.uid()` |
| Service role full access | ALL | `true` |

</details>

<details>
<summary><b>Other Tables</b></summary>

**pricing_tiers:**
- SELECT: `is_active = true` (public read for active tiers)

**subscriptions:**
- SELECT: `tenant_id = get_user_tenant_id()` or via tenant_members lookup
- ALL: Service role only

**usage_logs:**
- SELECT/INSERT: `tenant_id = get_user_tenant_id()`

**user_rate_limits:**
- SELECT: `user_id = auth.uid()` or `tenant_id = get_user_tenant_id()`
- UPDATE: `tenant_id = get_user_tenant_id()`
- ALL: Service role only

**users:**
- SELECT/UPDATE: `auth.uid() = id`
- ALL: Service role only

</details>

---

## Query 3: Foreign Key Relationships

### All Foreign Keys

| Table | Column | → Foreign Table | Foreign Column |
|-------|--------|-----------------|----------------|
| `tenant_members` | tenant_id | → `tenants` | id |
| `tenant_members` | user_id | → `users` | id |
| `tenants` | pricing_tier_id | → `pricing_tiers` | id |
| `cases` | tenant_id | → `tenants` | id |
| `folders` | tenant_id | → `tenants` | id |
| `folders` | case_id | → `cases` | id |
| `folders` | parent_folder_id | → `folders` | id |
| `document_files` | tenant_id | → `tenants` | id |
| `document_files` | case_id | → `cases` | id |
| `document_files` | folder_id | → `folders` | id |
| `document_files` | uploaded_by | → `users` | id |
| `document_chunks` | tenant_id | → `tenants` | id |
| `document_chunks` | file_id | → `document_files` | id |
| `document_chunks` | case_id | → `cases` | id |
| `document_chunks` | folder_id | → `folders` | id |
| `chat_sessions` | tenant_id | → `tenants` | id |
| `chat_sessions` | user_id | → `users` | id |
| `chat_messages` | session_id | → `chat_sessions` | id |
| `subscriptions` | tenant_id | → `tenants` | id |
| `subscriptions` | pricing_tier_id | → `pricing_tiers` | id |
| `usage_logs` | tenant_id | → `tenants` | id |
| `usage_logs` | user_id | → `users` | id |
| `user_rate_limits` | tenant_id | → `tenants` | id |

### Visual Relationship Diagram

```
┌─────────────────┐
│  pricing_tiers  │
└────────┬────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌───────┐  ┌──────────────┐
│tenants│◄─┤subscriptions │
└───┬───┘  └──────────────┘
    │
    ├──────────────┬───────────────┬────────────────┬─────────────────┐
    ▼              ▼               ▼                ▼                 ▼
┌────────────┐  ┌──────┐  ┌─────────────┐  ┌───────────┐  ┌─────────────────┐
│tenant_     │  │cases │  │chat_sessions│  │usage_logs │  │user_rate_limits │
│members     │  └──┬───┘  └──────┬──────┘  └───────────┘  └─────────────────┘
└─────┬──────┘     │             │
      │            │             ▼
      ▼            │      ┌─────────────┐
┌─────────┐        │      │chat_messages│
│  users  │        │      └─────────────┘
└─────────┘        │
                   ▼
              ┌─────────┐
              │ folders │◄──┐ (parent_folder_id - self-reference)
              └────┬────┘───┘
                   │
                   ▼
           ┌───────────────┐
           │document_files │
           └───────┬───────┘
                   │
                   ▼
           ┌───────────────┐
           │document_chunks│
           └───────────────┘
```

### Key Observations

1. **Multi-tenant**: All main tables have `tenant_id → tenants.id`
2. **Document Hierarchy**: `cases → folders → document_files → document_chunks`
3. **Self-referencing**: `folders.parent_folder_id → folders.id` (nested folders)
4. **Redundant FKs in chunks**: `document_chunks` has `case_id` and `folder_id` directly (denormalized for faster queries)
5. **Missing FK**: `cases.created_by` and `folders.created_by` don't have FK to users (may be intentional)

---

## Query 4: Database Functions

### Custom Application Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `get_user_tenant_id()` | uuid | Returns current user's tenant ID (used in RLS policies) |
| `can_add_team_member()` | boolean | Checks if tenant can add more team members (plan limit) |
| `can_upload_document()` | boolean | Checks if tenant can upload more documents (plan limit) |

### Trigger Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `handle_new_user()` | trigger | Creates tenant & membership when new user signs up |
| `create_default_case_for_tenant()` | trigger | Creates "General Documents" case for new tenants |
| `set_rate_limit_on_tenant_join()` | trigger | Initializes rate limits when user joins tenant |
| `update_rate_limits_on_subscription_change()` | trigger | Updates rate limits when subscription changes |

### RAG/Vector Search Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `match_documents_hybrid(query_embedding, query_text, tenant_id, ...)` | records | **Primary search** - 3-layer hybrid: exact match + vector + BM25 |
| `search_documents_exact(search_term, tenant_id, ...)` | records | Exact keyword search for case numbers, emails, names |
| `get_documents_by_metadata(tenant_id, document_type, year, court, ...)` | records | Metadata-based filtering |
| `match_documents_vector(query_embedding, tenant_id, ...)` | records | Vector-only similarity search (fallback) |

**Hybrid Search Parameters:**
- `query_embedding` - 1536-dim vector from OpenAI
- `query_text` - Original text for BM25/exact matching
- `p_tenant_id` - Tenant isolation
- `match_count` - Number of results (default: 15)
- `similarity_threshold` - Min similarity (default: 0.3)
- `p_case_id` - Filter by case (optional)
- `p_file_ids` - Filter by files (optional)
- `p_document_type` - Filter by type: judgment, contract, cv, etc. (optional)
- `p_year_min` / `p_year_max` - Year range filter (optional)
- `p_court` - Court filter (optional)

### pgvector Extension Functions

The following are provided by the `pgvector` extension for vector operations:

**Distance Functions:**
- `cosine_distance(vector, vector)` → double precision
- `l2_distance(vector, vector)` → double precision  
- `l1_distance(vector, vector)` → double precision
- `inner_product(vector, vector)` → double precision
- `hamming_distance(bit, bit)` → double precision
- `jaccard_distance(bit, bit)` → double precision

**Vector Operations:**
- `l2_norm(vector)` → double precision
- `l2_normalize(vector)` → vector
- `binary_quantize(vector)` → bit
- `subvector(vector, start, count)` → vector

**Type Conversions:**
- `array_to_vector()`, `array_to_halfvec()`, `array_to_sparsevec()`
- `halfvec_to_vector()`, `sparsevec_to_vector()`, etc.

**Index Handlers:**
- `hnswhandler` - HNSW index (fast approximate search)
- `ivfflathandler` - IVFFlat index (memory efficient)

---

## Query 5: Storage Buckets

| Bucket ID | Name | Public |
|-----------|------|--------|
| `documents` | documents | ❌ No (private) |

### Storage Structure

Files are stored with tenant isolation:
```
documents/
  └── {tenant_id}/
      └── {case_id}/
          └── {folder_id}/
              └── filename.pdf
```

### Storage Policies

| Policy | Operation | Condition |
|--------|-----------|-----------|
| Upload | INSERT | `foldername[1] = tenant_id` |
| Read | SELECT | `foldername[1] = tenant_id` |
| Delete | DELETE | `foldername[1] = tenant_id` |

---

## Indexes

### document_chunks Indexes

| Index | Column | Type | Purpose |
|-------|--------|------|---------|
| `document_chunks_pkey` | id | btree | Primary key |
| `idx_document_chunks_case_id` | case_id | btree | Filter by case |
| `idx_document_chunks_folder_id` | folder_id | btree | Filter by folder |
| `idx_document_chunks_tenant` | tenant_id | btree | Tenant isolation |
| `idx_document_chunks_tenant_case` | (tenant_id, case_id) | btree | Combined filter |
| `idx_document_chunks_file` | file_id | btree | Filter by file |
| `idx_document_chunks_embedding` | embedding | HNSW | Vector similarity search |
| `idx_document_chunks_fts` | fts | GIN | Full-text keyword search |
| `idx_document_chunks_metadata_type` | (metadata->>'document_type') | btree | Document type filter |
| `idx_document_chunks_metadata_year` | (metadata->>'year') | btree | Year filter |

---

## Key Relationships Diagram

```
tenants (1) ←──────────────────────── tenant_members (many)
    │                                        │
    │                                        ↓
    │                                     users
    │
    ├──→ cases (many)
    │       │
    │       ├──→ folders (many)
    │       │       │
    │       │       └──→ document_files (many)
    │       │               │
    │       │               └──→ document_chunks (many)
    │       │
    │       └──→ document_files (many) [direct to case]
    │
    ├──→ chat_sessions (many)
    │       │
    │       └──→ chat_messages (many)
    │
    └──→ subscriptions (1)
            │
            └──→ pricing_tiers
```

---

## Notes

- `document_files` stores file metadata, `document_chunks` stores text + embeddings
- **Hybrid RAG (3 layers):**
  1. **Exact Match**: Case numbers, emails, names (highest priority)
  2. **Vector Search**: Semantic similarity using OpenAI embeddings (1536-dim)
  3. **Full-Text Search**: PostgreSQL BM25-style keyword matching via `fts` column
- **Metadata Filtering**: Filter by document_type, year, court for precision
- Multi-tenant: All data filtered by `tenant_id`
- Rich metadata in JSONB enables entity extraction (emails, names, phones, sections)

