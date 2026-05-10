# Hackathon Handoff Plan (6-hour Prototype)

Goal: Give a new agent enough context to reproduce a close prototype of this app in 6 hours. This plan assumes you will provide:
- [BACKEND_ARCHITECTURE.md](BACKEND_ARCHITECTURE.md)
- [ARCHITECTURE_CHANGELOG.md](ARCHITECTURE_CHANGELOG.md)
- [CHAT_QUERY_FLOW.md](CHAT_QUERY_FLOW.md)
- Your database schemas (tables + columns)

Below is the step-by-step sequence to give information and tasks to the agent.

---

## Step 0 - Define the Prototype Scope (5-10 min)
Give this to the agent as a short paragraph:
- What is the demo outcome? (e.g., upload files, chat over documents, list files, delete files)
- What is explicitly out of scope? (e.g., billing, advanced RAG tuning, verification)
- What must be "similar" vs "exact" (UI look, file pipeline, chat behavior)

Checklist to include:
- Demo must support: file upload, file list, delete, chat with file IDs.
- Acceptable shortcuts: no RLS, no production auth, minimal logging.

---

## Step 1 - Provide Architecture Docs (10 min)
Send these in order:
1) BACKEND_ARCHITECTURE.md
2) CHAT_QUERY_FLOW.md
3) ARCHITECTURE_CHANGELOG.md

Why this order:
- Backend architecture explains the high-level system first.
- Chat flow gives the request path and contracts.
- Changelog tells the agent which agentic parts matter.

---

## Step 2 - Provide Database Schema (10-15 min)
Send your schema in this order:
1) Core data tables (matters, files, folders)
2) Chat tables (sessions, messages)
3) Intelligence tables (entities, risks, obligations, etc.)
4) Anything else used by UI counters or flags

Include these minimums:
- Primary keys and foreign keys
- Required columns + default values
- Enum values (status fields)

Note: For hackathon speed, skip RLS policies. Just provide the structure.

---

## Step 3 - Provide API Contract Cheat-Sheet (15 min)
Give a single file or message that lists:
- Endpoint
- Method
- Request body
- Response shape
- Error cases (only the main ones)

Minimum endpoints for a prototype:
- POST /api/documents/process (upload)
- GET /api/features
- GET /api/billing/status (if frontend calls it)
- POST /functions/v1/chat (or equivalent chat endpoint)

If you do not have time, provide just the request/response JSON for each.

---

## Step 4 - Provide Frontend Flow Notes (15-20 min)
This is a short document or bullet list. Include:
- Main screens: Landing, Vault, Chat, Settings
- Critical UI flows:
  - Upload -> shows processing -> becomes ready
  - Delete -> optimistic UI -> refresh
  - Chat -> selects files -> sends to backend
- Any UI behaviors that are required for the demo

If you can, add 2-3 screenshots with labels:
- "Vault All Files view"
- "Chat with selected files"
- "Upload modal"

---

## Step 5 - Provide Env Vars + Deployment Assumptions (10 min)
Give a short list of required env vars:
- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY (backend only)
- OPENAI_API_KEY
- REDIS_URL (if queues used)
- CORS_ORIGINS

Also tell the agent where the backend is hosted and the frontend host.

---

## Step 6 - Ask Agent to Build a "Hackathon Replica" (1-2 min)
Give a single instruction:
- "Build a minimal clone that matches these flows and endpoints. Prefer hardcoded shortcuts over full feature parity. You have 6 hours."

---

## Step 7 - Validation Checklist (5 min)
Ask the agent to confirm these work:
- Upload a file -> see it in Vault list
- Delete a file -> disappears in UI and backend
- Open chat -> ask about file -> response returns
- Refresh -> state persists

---

## Optional Add-ons (Only if time)
- Worker queue for extraction
- Structured intelligence tables
- Tool gateway / agentic verification
- Billing or Stripe

---

## Quick Summary (Copy/Paste to Agent)
"You are building a 6-hour prototype clone of this app. Use the docs and schema provided. Focus on upload, file list, delete, and chat with file IDs. Skip RLS and production hardening. If unsure, default to a simple approach that keeps UI behavior consistent with the provided screenshots."
