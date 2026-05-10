/**
 * Document Queue Service
 * BullMQ-based job queue for document processing and legal extraction
 */

import { Queue, Job, QueueEvents, JobsOptions } from 'bullmq';
import { getRedisConnection } from '../config/redis.js';
import { ProcessDocumentJob, ProcessImageJob, JobStatus, ProcessingResult, ImageProcessingResult } from '../types/index.js';
import type { ExtractionJob, ExtractionResult } from './extractionService.js';

const QUEUE_NAME = 'document-processing';
const EXTRACTION_QUEUE_NAME = 'legal-extraction';
const IMAGE_QUEUE_NAME = 'image-processing';

let queue: Queue | null = null;
let queueEvents: QueueEvents | null = null;
let extractionQueue: Queue | null = null;
let imageQueue: Queue | null = null;

/**
 * Get or create the document processing queue
 */
export function getQueue(): Queue {
  if (!queue) {
    const connection = getRedisConnection();
    queue = new Queue(QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 1000,
        },
        removeOnComplete: {
          age: 24 * 3600, // Keep completed jobs for 24 hours
          count: 1000,    // Keep last 1000 completed jobs
        },
        removeOnFail: {
          age: 7 * 24 * 3600, // Keep failed jobs for 7 days
        },
      },
    });

    console.log('📋 Document processing queue initialized');
  }

  return queue;
}

/**
 * Get queue events for monitoring job status
 */
export function getQueueEvents(): QueueEvents {
  if (!queueEvents) {
    const connection = getRedisConnection();
    queueEvents = new QueueEvents(QUEUE_NAME, { connection });
  }

  return queueEvents;
}

/**
 * Add a document processing job to the queue
 */
export async function addDocumentJob(
  jobData: ProcessDocumentJob,
  options?: JobsOptions
): Promise<Job<ProcessDocumentJob, ProcessingResult>> {
  const queue = getQueue();

  // Use file_id as job ID to prevent duplicates
  const jobId = `doc-${jobData.file_id}`;

  const job = await queue.add(
    'process-document',
    jobData,
    {
      jobId,
      priority: getPriority(jobData),
      ...options,
    }
  );

  console.log(`📥 Job ${job.id} added to queue for file: ${jobData.filename}`);

  return job;
}

/**
 * Get priority based on file type and size
 * Lower number = higher priority
 */
function getPriority(jobData: ProcessDocumentJob): number {
  // Text files are fast - high priority
  if (
    jobData.filetype.startsWith('text/') ||
    jobData.filetype === 'application/json'
  ) {
    return 1;
  }

  // PDFs might be slow - medium priority
  if (jobData.filetype === 'application/pdf') {
    return 5;
  }

  // Office documents - medium priority
  if (
    jobData.filetype.includes('officedocument') ||
    jobData.filetype.includes('ms-excel') ||
    jobData.filetype.includes('msword')
  ) {
    return 3;
  }

  // Everything else - lower priority
  return 10;
}

/**
 * Get job status by job ID
 */
export async function getJobStatus(jobId: string): Promise<JobStatus | null> {
  const queue = getQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    return null;
  }

  const state = await job.getState();

  return {
    job_id: job.id || jobId,
    status: mapJobState(state),
    progress: typeof job.progress === 'number' ? job.progress : undefined,
    result: job.returnvalue as ProcessingResult | undefined,
    error: job.failedReason,
    created_at: new Date(job.timestamp).toISOString(),
    started_at: job.processedOn ? new Date(job.processedOn).toISOString() : undefined,
    completed_at: job.finishedOn ? new Date(job.finishedOn).toISOString() : undefined,
  };
}

/**
 * Map BullMQ job state to our status
 */
function mapJobState(state: string): JobStatus['status'] {
  switch (state) {
    case 'waiting':
    case 'delayed':
    case 'prioritized':
      return 'queued';
    case 'active':
      return 'processing';
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    default:
      return 'queued';
  }
}

/**
 * Get job by file ID
 */
export async function getJobByFileId(fileId: string): Promise<Job | null> {
  const queue = getQueue();
  const jobId = `doc-${fileId}`;
  return (await queue.getJob(jobId)) || null;
}

/**
 * Cancel a pending job
 */
export async function cancelJob(jobId: string): Promise<boolean> {
  const queue = getQueue();
  const job = await queue.getJob(jobId);

  if (!job) {
    return false;
  }

  const state = await job.getState();

  // Can only cancel waiting/delayed jobs
  if (state === 'waiting' || state === 'delayed') {
    await job.remove();
    console.log(`🗑️ Job ${jobId} cancelled`);
    return true;
  }

  return false;
}

/**
 * Get queue statistics
 */
export async function getQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getQueue();

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  return { waiting, active, completed, failed, delayed };
}

/**
 * Get or create the legal extraction queue
 */
export function getExtractionQueue(): Queue {
  if (!extractionQueue) {
    const connection = getRedisConnection();
    extractionQueue = new Queue(EXTRACTION_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 24 * 3600,
          count: 500,
        },
        removeOnFail: {
          age: 7 * 24 * 3600,
        },
      },
    });
    console.log('🧠 Legal extraction queue initialized');
  }
  return extractionQueue;
}

/**
 * Add a legal extraction job to the queue
 */
export async function addExtractionJob(
  jobData: ExtractionJob,
  options?: JobsOptions
): Promise<Job<ExtractionJob, ExtractionResult>> {
  const queue = getExtractionQueue();
  const jobId = `extract-${jobData.file_id}`;

  const job = await queue.add(
    'extract-legal-intelligence',
    jobData,
    {
      jobId,
      priority: 5,
      // Delay extraction slightly to ensure document processing chunks are saved
      delay: 2000,
      ...options,
    }
  );

  console.log(`🧠 Extraction job ${job.id} queued for file: ${jobData.filename}`);
  return job;
}

/**
 * Get extraction job status by file ID
 */
export async function getExtractionJobByFileId(fileId: string): Promise<Job | null> {
  const queue = getExtractionQueue();
  const jobId = `extract-${fileId}`;
  return (await queue.getJob(jobId)) || null;
}

/**
 * Get extraction queue statistics
 */
export async function getExtractionQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getExtractionQueue();
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

// ── Image Processing Queue ───────────────────────────────────────────

/**
 * Get or create the image processing queue
 */
export function getImageQueue(): Queue {
  if (!imageQueue) {
    const connection = getRedisConnection();
    imageQueue = new Queue(IMAGE_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 2,
        backoff: {
          type: 'exponential',
          delay: 2000,
        },
        removeOnComplete: {
          age: 24 * 3600,
          count: 500,
        },
        removeOnFail: {
          age: 7 * 24 * 3600,
        },
      },
    });
    console.log('🖼️ Image processing queue initialized');
  }
  return imageQueue;
}

/**
 * Add an image processing job to the queue
 */
export async function addImageJob(
  jobData: ProcessImageJob,
  options?: JobsOptions
): Promise<Job<ProcessImageJob, ImageProcessingResult>> {
  const queue = getImageQueue();
  const jobId = `img-${jobData.file_id}`;

  const job = await queue.add(
    'process-image',
    jobData,
    {
      jobId,
      priority: 3,
      ...options,
    }
  );

  console.log(`🖼️ Image job ${job.id} queued for file: ${jobData.filename}`);
  return job;
}

/**
 * Get image job by file ID
 */
export async function getImageJobByFileId(fileId: string): Promise<Job | null> {
  const queue = getImageQueue();
  const jobId = `img-${fileId}`;
  return (await queue.getJob(jobId)) || null;
}

/**
 * Get image queue statistics
 */
export async function getImageQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
}> {
  const queue = getImageQueue();
  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);
  return { waiting, active, completed, failed, delayed };
}

/**
 * Close the queue gracefully
 */
export async function closeQueue(): Promise<void> {
  if (queueEvents) {
    await queueEvents.close();
    queueEvents = null;
  }

  if (queue) {
    await queue.close();
    queue = null;
  }

  if (extractionQueue) {
    await extractionQueue.close();
    extractionQueue = null;
  }

  if (imageQueue) {
    await imageQueue.close();
    imageQueue = null;
  }

  console.log('📋 All queues closed gracefully');
}
