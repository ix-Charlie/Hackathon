# Matter Intelligence Extraction - Fixed ✅

## What Was Wrong

1. **Reprocess button WAS triggering extraction** - but the extraction worker needed to be running
2. **Moving files between matters DID NOT trigger extraction for the new matter** - this was a bug (now fixed!)
3. Files uploaded in the past may have failed extraction if:
   - The extraction worker wasn't running
   - There were API errors (OpenAI key issues, rate limits)
   - Database connection problems

## What's Fixed Now

### 1. File Move Intelligence Extraction ✨ NEW
When files are moved from one matter to another:
- **Old matter keeps ALL its intelligence data** - including data from the moved file
- **Only the moved file is extracted** in the context of the new matter
- **New intelligence is ADDED to target matter** - doesn't replace anything
- Same file can have different intelligence in different matters (context-dependent)

**Example:**
```
Matter A (Criminal Case) has:
- contract.pdf → extracts parties, dates, clauses
  
Move contract.pdf to Matter B (Civil Case)

Result:
- Matter A KEEPS all its intelligence (unchanged)
- contract.pdf is extracted FOR Matter B's context
- Matter B gets NEW intelligence from contract.pdf
- Both matters have intelligence from the same file (different contexts)
```

**Backend Changes:**
- `/backend/src/routes/documents.ts`
  - Added `addExtractionJob` import
  - Enhanced `POST /api/documents/move` endpoint to:
    - Queue extraction jobs ONLY for moved files
    - Extract in the context of the NEW matter
    - No deletion of old matter intelligence

- `/backend/src/services/extractionService.ts`
  - Updated `clearExistingExtractions` to be case_id-aware
  - Only clears intelligence for specific file+case combination
  - Allows same file to have intelligence in multiple matters

**Frontend Changes:**
- `/components/Vault.tsx`
  - Updated toast message to inform users about intelligence extraction

### 2. Reprocess Button Works
The reprocess button in Intelligence Dashboard and Matter Brief:
- Deletes existing extraction data
- Queues new extraction jobs
- Requires the **extraction worker to be running**

### 3. Automatic Extraction on Upload
When files are uploaded:
- Document processing happens first (text extraction, chunking, embeddings)
- Extraction job is automatically queued (unless it's "General Documents")
- Extraction runs asynchronously via the worker

## How to Use

### Ensure Workers Are Running

You need **3 workers running** for full functionality:

```bash
cd backend
npm run dev:all
```

This starts:
1. **Main Backend Server** (port 3001) - API endpoints
2. **Document Worker** - Processes uploads (text, chunks, embeddings)
3. **Image Worker** - Extracts and processes images
4. **Extraction Worker** - Generates intelligence (entities, clauses, obligations, dates, risks)

Or run individually:
```bash
npm run dev           # Main server
npm run worker        # Document worker
npm run worker:image  # Image worker
npm run worker:extraction  # Intelligence extraction worker
```

### Check Extraction Status

The extraction worker logs will show:
```
🧠 Horizon Legal Extraction Worker
✅ Extraction worker ready and listening for jobs

🧠 Extraction job extract-abc123: Contract.pdf
   [15%] Stage A: Extracting entity candidates...
   [22%] Stage B: Supervisory validation...
   [30%] Classifying clauses...
   [85%] Saving validated extraction results...
✅ Extraction complete
```

### Trigger Re-extraction for Files Missing Intelligence

If you have files that are missing intelligence (uploaded before the worker was running):

#### Option 1: Use the "Reprocess" Button
1. Go to Intelligence Dashboard or Matter Brief
2. Click "🔄 Reprocess Documents"
3. Wait a few seconds and refresh

#### Option 2: Run the Manual Script
```bash
cd backend
npx tsx trigger-missing-intelligence.ts
```

This will:
- Find all files without intelligence data
- Queue extraction jobs for them
- Show progress in the console

### Moving Files Between Matters

When you move files using the Vault:
1. Select files/folders
2. Click "Move to..."
3. Select target matter
4. Intelligence is automatically cleaned up and re-extracted
5. Check the Intelligence Dashboard after a few seconds

## Database Tables for Intelligence

Intelligence is stored in these tables:
- `matter_entities` - Parties, courts, statutes, defined terms, etc.
- `matter_clauses` - Contract clauses with risk levels
- `matter_obligations` - Who owes what to whom
- `matter_dates` - Critical dates (deadlines, effective dates, etc.)
- `matter_risks` - Identified risks with severity
- `extraction_jobs` - Job tracking (status, errors, tokens used)

## Monitoring

### Check Queue Status
```bash
curl http://localhost:3001/api/documents/queue-stats
```

### Check Extraction Jobs for a Matter
```bash
curl http://localhost:3001/api/matters/{CASE_ID}/extraction-status \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### View Recent Extraction Jobs
```sql
SELECT 
  id, file_id, status, 
  results->>'entities_count' as entities,
  results->>'clauses_count' as clauses,
  tokens_used, 
  created_at
FROM extraction_jobs
ORDER BY created_at DESC
LIMIT 10;
```

## Troubleshooting

### No Intelligence After Upload
1. **Check if extraction worker is running**: `ps aux | grep extractionWorker`
2. **Check for errors**: Look at extraction worker logs
3. **Verify OPENAI_API_KEY** is set in backend `.env`
4. **Check Redis is running**: `redis-cli ping` (should return PONG)
5. **Check file has chunks**: Query `document_chunks` table for that file_id

### Reprocess Doesn't Work
1. Extraction worker must be running
2. Check network connection (if using remote Redis)
3. Check OpenAI API quota/limits
4. Look for errors in extraction worker logs

### Files Moved But No Intelligence
1. Wait 10-30 seconds (extraction is async)
2. Check extraction worker is processing the jobs
3. Refresh the Intelligence Dashboard
4. Check extraction_jobs table for errors

## Files Changed
- ✅ `/backend/src/routes/documents.ts` - Added intelligence cleanup and re-extraction on move
- ✅ `/components/Vault.tsx` - Updated toast message
- ✅ `/backend/trigger-missing-intelligence.ts` - NEW utility script

## Testing Checklist
- [x] Backend compiles successfully
- [ ] Upload a file → check intelligence is generated
- [ ] Move a file → verify old intelligence deleted, new jobs queued
- [ ] Click reprocess → verify extraction runs again
- [ ] Check all 3 workers are running properly
