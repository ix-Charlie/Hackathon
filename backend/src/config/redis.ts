import { Redis } from 'ioredis';
import { config } from './index.js';

let redisConnection: Redis | null = null;

export function getRedisConnection(): Redis {
  if (!redisConnection) {
    redisConnection = new Redis(config.redis.url, {
      maxRetriesPerRequest: null, // Required for BullMQ
      enableReadyCheck: false,
      retryStrategy: (times) => {
        if (times > config.redis.maxRetries) {
          console.error('❌ Redis connection failed after max retries');
          return null; // Stop retrying
        }
        const delay = Math.min(times * 200, 2000);
        console.log(`🔄 Redis retry attempt ${times}, waiting ${delay}ms...`);
        return delay;
      },
    });

    redisConnection.on('connect', () => {
      console.log('✅ Redis connected');
    });

    redisConnection.on('error', (err) => {
      console.error('❌ Redis error:', err.message);
    });

    redisConnection.on('close', () => {
      console.log('🔌 Redis connection closed');
    });
  }

  return redisConnection;
}

export async function closeRedisConnection(): Promise<void> {
  if (redisConnection) {
    await redisConnection.quit();
    redisConnection = null;
    console.log('🔌 Redis connection closed gracefully');
  }
}
