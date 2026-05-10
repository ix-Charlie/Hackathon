/**
 * Image Processing Worker
 * Processes image assets from the BullMQ image-processing queue.
 * Separate from the document worker — images skip chunking/embedding entirely.
 */

import { Worker, Job } from 'bullmq';
import { config } from './config/index.js';
import { getRedisConnection, closeRedisConnection } from './config/redis.js';
import { processImageAsset } from './services/vault/imageProcessor.js';
import { ProcessImageJob, ImageProcessingResult } from './types/index.js';

const QUEUE_NAME = 'image-processing';

console.log(`\n🖼️  Horizon Image Processing Worker`);
console.log(`   Environment: ${config.nodeEnv}`);
console.log(`   Connecting to Redis...`);

const connection = getRedisConnection();

const worker = new Worker<ProcessImageJob, ImageProcessingResult>(
  QUEUE_NAME,
  async (job: Job<ProcessImageJob, ImageProcessingResult>) => {
    console.log(`\n🖼️  Processing image job ${job.id}: ${job.data.filename}`);

    try {
      const result = await processImageAsset(
        job.data,
        async (progress: number, message: string) => {
          await job.updateProgress(progress);
          console.log(`   [${progress}%] ${message}`);
        }
      );

      if (result.success) {
        console.log(`✅ Image job ${job.id} completed — ${result.classification} (${(result.confidence_score * 100).toFixed(0)}%)`);
        return result;
      } else {
        throw new Error(result.error || 'Image processing failed');
      }
    } catch (error) {
      console.error(`❌ Image job ${job.id} failed:`, error);
      throw error;
    }
  },
  {
    connection,
    concurrency: 2, // Process 2 images in parallel
    limiter: {
      max: 20,       // Max 20 jobs
      duration: 60000, // Per minute
    },
    removeOnComplete: {
      age: 24 * 3600,
      count: 500,
    },
    removeOnFail: {
      age: 7 * 24 * 3600,
    },
  }
);

// ── Event handlers ───────────────────────────────────────────────────

worker.on('ready', () => {
  console.log(`✅ Image worker ready and listening for jobs`);
});

worker.on('active', (job) => {
  console.log(`🔄 Image job ${job.id} started processing`);
});

worker.on('completed', (job, result) => {
  console.log(`✅ Image job ${job.id} completed:`, {
    classification: result.classification,
    ocr_chars: result.ocr_text_length,
    link: result.link_status,
    time: `${result.processing_time_ms}ms`,
  });
});

worker.on('failed', (job, error) => {
  console.error(`❌ Image job ${job?.id} failed:`, error.message);
});

worker.on('error', (error) => {
  console.error('Image worker error:', error);
});

worker.on('stalled', (jobId) => {
  console.warn(`⚠️ Image job ${jobId} stalled`);
});

// ── Graceful shutdown ────────────────────────────────────────────────

async function gracefulShutdown(signal: string) {
  console.log(`\n${signal} received. Shutting down image worker...`);

  await worker.close();
  console.log('✅ Image worker stopped');

  await closeRedisConnection();
  console.log('✅ Redis connection closed');

  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

console.log(`\n👂 Image worker listening for jobs on queue: ${QUEUE_NAME}\n`);
