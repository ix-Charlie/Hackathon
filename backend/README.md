# Horizon Document Processing Backend

Production-grade Node.js backend for document processing with job queue support.

## Features

- **Document Extraction**: PDF, DOCX, XLSX, CSV, and plain text files
- **Job Queue**: BullMQ-based background processing for large files
- **Embeddings**: OpenAI text-embedding-3-small for vector search
- **Scalable**: Separate worker processes for processing
- **Production Ready**: Docker support, health checks, graceful shutdown

## Quick Start

### Prerequisites

- Node.js 18+
- Redis (for job queue)
- Supabase project with document storage set up
- OpenAI API key

### Local Development

1. **Install dependencies:**
   ```bash
   cd backend
   npm install
   ```

2. **Set up environment:**
   ```bash
   cp .env.example .env
   # Edit .env with your credentials
   ```

3. **Start Redis (if not running):**
   ```bash
   # Using Docker
   docker run -d -p 6379:6379 redis:7-alpine

   # Or using Homebrew (macOS)
   brew services start redis
   ```

4. **Start the server and worker:**
   ```bash
   # Run both server and worker
   npm run dev:all

   # Or run separately
   npm run dev     # API server on port 3001
   npm run worker  # Background worker
   ```

## API Endpoints

### Health Check
- `GET /health` - Basic health status
- `GET /health/detailed` - Detailed status with dependency checks
- `GET /health/live` - Liveness probe
- `GET /health/ready` - Readiness probe

### Document Processing
- `POST /api/documents/process` - Queue document for processing
- `POST /api/documents/process-sync` - Process document synchronously
- `GET /api/documents/job/:jobId` - Get job status
- `GET /api/documents/file/:fileId/status` - Get processing status by file ID
- `DELETE /api/documents/job/:jobId` - Cancel pending job
- `GET /api/documents/queue/stats` - Queue statistics
- `GET /api/documents/supported` - List supported file types

### Example Request

```bash
curl -X POST http://localhost:3001/api/documents/process \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_SUPABASE_JWT" \
  -d '{
    "file_id": "uuid",
    "tenant_id": "uuid",
    "case_id": "uuid",
    "storage_path": "tenant/case/folder/file.pdf",
    "filename": "document.pdf",
    "filetype": "application/pdf"
  }'
```

## Deployment

### Railway (Recommended)

1. Create a new project on Railway
2. Add a Redis service
3. Connect your GitHub repo (point to `/backend` folder)
4. Add environment variables
5. Deploy!

### Render

1. Create a new Web Service
2. Add a Redis instance
3. Use `render.yaml` for infrastructure as code

### Docker Compose (Self-hosted)

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

## Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port (default: 3001) | No |
| `NODE_ENV` | Environment (development/production) | No |
| `SUPABASE_URL` | Supabase project URL | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | Yes |
| `SUPABASE_ANON_KEY` | Supabase anon key | Yes |
| `OPENAI_API_KEY` | OpenAI API key for embeddings | Yes |
| `REDIS_URL` | Redis connection URL | Yes |
| `CORS_ORIGINS` | Allowed CORS origins (comma-separated) | No |
| `MAX_FILE_SIZE_MB` | Max file size in MB (default: 100) | No |

## Architecture

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   Frontend  │────▶│  API Server │────▶│    Redis    │
│   (Vite)    │     │  (Express)  │     │   (Queue)   │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                                │
                           ┌────────────────────┘
                           │
                           ▼
                    ┌─────────────┐     ┌─────────────┐
                    │   Worker    │────▶│  Supabase   │
                    │  (BullMQ)   │     │ (Storage/DB)│
                    └─────────────┘     └─────────────┘
```

## Supported File Types

| Type | Extensions | Notes |
|------|------------|-------|
| PDF | .pdf | Text-based PDFs. Scanned PDFs need OCR. |
| Word | .docx, .doc | Full support for .docx |
| Excel | .xlsx, .xls | All sheets extracted |
| CSV | .csv | Parsed and formatted |
| Text | .txt, .md, .json, .xml, .html, etc. | Many text formats supported |

## License

MIT
