# GCP Deployment Outline (Maks Horizon)

Goal: Host the existing stack on GCP with minimal changes. This assumes:
- Frontend: Vite/React
- Backend API: Node/Express
- Workers: BullMQ (Redis)
- DB/Auth/Storage: Supabase (managed)

---

## 1) GCP Services to Use
- Cloud Run: API service + worker services
- Artifact Registry: container images
- Cloud Build: build and push containers
- Memorystore (Redis): BullMQ queues
- Secret Manager: runtime secrets (optional)
- Cloud Storage + Cloud CDN: static frontend (optional) OR Cloud Run for frontend

---

## 2) Architecture Mapping

### Option A (Simplest)
- Frontend on Vercel (keep as-is)
- Backend API on Cloud Run
- Workers on Cloud Run
- Redis on Memorystore
- Supabase stays managed (external)

### Option B (All on GCP)
- Frontend on Cloud Run (static container) OR GCS + CDN
- Backend API on Cloud Run
- Workers on Cloud Run
- Redis on Memorystore
- Supabase still managed (recommended)

---

## 3) Containerize the Backend
You already have:
- backend/Dockerfile
- backend/Dockerfile.worker

Recommended split:
- Service 1: API (server)
- Service 2: Worker (doc processing)
- Service 3: Image worker
- Service 4: Extraction worker

Each service uses the same env vars. Only the start command differs.

---

## 4) Required Env Vars (Cloud Run)
Set these on each Cloud Run service:
- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY
- OPENAI_API_KEY
- REDIS_URL (Memorystore endpoint)
- CORS_ORIGINS
- NODE_ENV=production

If used:
- STRIPE_SECRET_KEY
- STRIPE_WEBHOOK_SECRET
- STRIPE_PUBLISHABLE_KEY

---

## 5) Redis (Memorystore)
- Create a Memorystore Redis instance
- Put the internal IP in REDIS_URL (ex: redis://10.0.0.5:6379)
- Use a VPC connector for Cloud Run to reach Redis

---

## 6) Cloud Run Services

### API Service
- Image: backend API container
- Command: node dist/server.js
- Port: 3001 (Cloud Run auto sets PORT env)

### Worker Services
- Image: backend worker container
- Command: node dist/worker.js
- Command: node dist/imageWorker.js
- Command: node dist/extractionWorker.js

---

## 7) Frontend Hosting

### Option A: Keep Vercel
- Set VITE_BACKEND_API_URL to the Cloud Run URL

### Option B: Cloud Run
- Build a static container from Vite output
- Serve via Nginx or a simple static server
- Set VITE_BACKEND_API_URL at build time

### Option C: GCS + CDN
- Build Vite to dist/
- Upload to a GCS bucket
- Enable static website hosting + Cloud CDN

---

## 8) Networking and CORS
- CORS_ORIGINS must include the frontend origin
- Use a custom domain on Cloud Run if needed

---

## 9) Build and Deploy Flow (Suggested)
1) Enable APIs: Cloud Run, Cloud Build, Artifact Registry
2) Create Artifact Registry repo
3) Build and push images with Cloud Build
4) Deploy Cloud Run services (API + workers)
5) Create Memorystore instance
6) Configure VPC connector for Cloud Run
7) Set env vars and redeploy
8) Point frontend to the API URL

---

## 10) Validation Checklist
- GET /health returns OK
- Upload file works
- Queue jobs process (worker logs show activity)
- CORS allows frontend origin
- Chat responses stream

---

## 11) Optional Enhancements
- Cloud Logging alerts for worker failures
- Cloud Scheduler to ping /health
- Private services with Cloud Armor
- Secret Manager for keys (avoid plaintext env vars)

---

## Notes
- Supabase does not need to be on GCP to work.
- You can self-host Supabase on GCP later if needed, but it adds complexity.
