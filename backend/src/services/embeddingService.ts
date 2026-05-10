/**
 * Embedding Service
 * Generates embeddings using OpenAI API
 */

import OpenAI from 'openai';
import { config } from '../config/index.js';

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.openai.apiKey,
    });
  }
  return openaiClient;
}

/**
 * Generate embeddings for a batch of texts
 * Uses text-embedding-3-small (1536 dimensions)
 */
export async function generateEmbeddings(
  texts: string[],
  onProgress?: (completed: number, total: number) => void
): Promise<number[][]> {
  const client = getOpenAIClient();
  const model = config.openai.embeddingModel;
  
  console.log(`🧠 Generating embeddings for ${texts.length} chunks using ${model}...`);

  // OpenAI limits: 8191 tokens per text, 2048 texts per batch
  const BATCH_SIZE = 100;
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(texts.length / BATCH_SIZE);

    try {
      const response = await client.embeddings.create({
        model,
        input: batch,
      });

      const embeddings = response.data.map(item => item.embedding);
      allEmbeddings.push(...embeddings);

      console.log(`✅ Batch ${batchNum}/${totalBatches}: ${embeddings.length} embeddings generated`);

      if (onProgress) {
        onProgress(Math.min(i + BATCH_SIZE, texts.length), texts.length);
      }
    } catch (error) {
      console.error(`❌ Embedding batch ${batchNum} failed:`, error);
      throw new Error(
        `Failed to generate embeddings: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  return allEmbeddings;
}

/**
 * Generate embedding for a single text
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const embeddings = await generateEmbeddings([text]);
  return embeddings[0];
}

/**
 * Get the dimension count for the current embedding model
 */
export function getEmbeddingDimensions(): number {
  // text-embedding-3-small = 1536 dimensions
  // text-embedding-3-large = 3072 dimensions
  const modelDimensions: Record<string, number> = {
    'text-embedding-3-small': 1536,
    'text-embedding-3-large': 3072,
    'text-embedding-ada-002': 1536,
  };

  return modelDimensions[config.openai.embeddingModel] || 1536;
}
