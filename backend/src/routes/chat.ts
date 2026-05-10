/**
 * Chat Route — Attachment-aware proxy to the Supabase Edge Function.
 *
 * Accepts multipart/form-data with file/image attachments, processes them
 * (text extraction for documents, GPT-4o Vision for images), uploads to
 * Supabase Storage under chat-temp/, then forwards an enriched JSON payload
 * to the existing Edge Function and streams the SSE response back to the client.
 */

import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import { config } from '../config/index.js';
import { supabaseAdmin } from '../config/supabase.js';
import { extractDocument, isSupported } from '../services/extractors/index.js';

const router = Router();

// ─── Multer config: in-memory, 25 MB per file, max 10 files ─────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,  // 25 MB per file
    files: 10,
  },
});

// Lazy OpenAI client
let openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: config.openai.apiKey });
  }
  return openai;
}

// Image MIME types for Vision API routing
const IMAGE_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
  'image/svg+xml', 'image/bmp', 'image/tiff',
]);

function isImageMime(mime: string): boolean {
  return IMAGE_MIME_TYPES.has(mime);
}

// ─── Interfaces ──────────────────────────────────────────────────────────────

interface ProcessedAttachment {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  storage_path: string;
  type: 'file' | 'image';
  extracted_text?: string;
  vision_result?: string;
}

// ─── POST /api/chat — Main chat-with-attachments endpoint ────────────────────

router.post('/', upload.array('attachments', 10), async (req: Request, res: Response) => {
  const user = (req as any).user;
  const tenantId = (req as any).tenantId;
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!user || !token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  try {
    // ── Parse form data ──────────────────────────────────────────────────
    const {
      message = '',
      history: historyStr = '[]',
      file_ids: fileIdsStr,
      case_id,
      session_id,
      case_name,
      case_client,
      case_description,
      case_number,
      case_matter_type,
      mode = 'general',
      sub_options: subOptionsStr,
      temperature: tempStr,
      user_timezone,
      web_search,
      jurisdiction,
      deep_analysis,
      strict_citations,
      privilege_review,
      fast_mode,
    } = req.body;

    const history = JSON.parse(historyStr);
    const file_ids = fileIdsStr ? JSON.parse(fileIdsStr) : undefined;
    const sub_options = subOptionsStr ? JSON.parse(subOptionsStr) : undefined;
    const temperature = tempStr ? parseFloat(tempStr) : undefined;

    const attachedFiles = (req.files as Express.Multer.File[]) || [];
    const processed: ProcessedAttachment[] = [];

    // ── Process each attachment ──────────────────────────────────────────
    for (const file of attachedFiles) {
      const attId = uuidv4();
      const timestamp = Date.now();
      const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const storagePath = `chat-temp/${tenantId}/${timestamp}_${safeName}`;

      // Upload to Supabase Storage
      const { error: uploadError } = await supabaseAdmin.storage
        .from('documents')
        .upload(storagePath, file.buffer, {
          contentType: file.mimetype,
          upsert: false,
        });

      if (uploadError) {
        console.error(`[chat] Upload failed for ${file.originalname}:`, uploadError);
        continue; // Skip failed uploads, process the rest
      }

      const attachment: ProcessedAttachment = {
        id: attId,
        filename: file.originalname,
        mime_type: file.mimetype,
        size: file.size,
        storage_path: storagePath,
        type: isImageMime(file.mimetype) ? 'image' : 'file',
      };

      // ── Document: extract text ──────────────────────────────────────
      if (!isImageMime(file.mimetype) && isSupported(file.originalname, file.mimetype)) {
        try {
          const result = await extractDocument(file.buffer, file.originalname, file.mimetype);
          attachment.extracted_text = result.text.slice(0, 50000); // Cap at 50k chars
          console.log(`[chat] Extracted ${result.text.length} chars from ${file.originalname}`);
        } catch (err) {
          console.error(`[chat] Extraction failed for ${file.originalname}:`, err);
          attachment.extracted_text = `[Could not extract text from ${file.originalname}]`;
        }
      }

      // ── Image: GPT-4o Vision analysis ───────────────────────────────
      if (isImageMime(file.mimetype)) {
        try {
          const base64 = file.buffer.toString('base64');
          const dataUri = `data:${file.mimetype};base64,${base64}`;

          const visionResponse = await getOpenAI().chat.completions.create({
            model: 'gpt-4o-mini',
            max_tokens: 1000,
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: 'Describe this image in detail. If it contains text, extract all visible text. If it is a chart, table, or diagram, describe the data it represents. If it is a legal document, identify document type, parties, and key details.',
                  },
                  {
                    type: 'image_url',
                    image_url: { url: dataUri, detail: 'high' },
                  },
                ],
              },
            ],
          });

          attachment.vision_result = visionResponse.choices[0]?.message?.content || '';
          console.log(`[chat] Vision analysis for ${file.originalname}: ${attachment.vision_result.length} chars`);
        } catch (err) {
          console.error(`[chat] Vision failed for ${file.originalname}:`, err);
          attachment.vision_result = `[Could not analyze image: ${file.originalname}]`;
        }
      }

      processed.push(attachment);
    }

    // ── Build enriched payload for the Edge Function ──────────────────────
    const edgePayload: Record<string, any> = {
      message,
      history,
      file_ids,
      case_id,
      session_id,
      case_name,
      case_client,
      case_description,
      case_number,
      case_matter_type,
      use_rag: true,
      temperature,
      mode,
      sub_options,
      user_timezone,
      // Action flags
      ...(web_search === 'true' && { web_search: true }),
      ...(jurisdiction && { jurisdiction }),
      ...(deep_analysis === 'true' && { deep_analysis: true }),
      ...(strict_citations === 'true' && { strict_citations: true }),
      ...(privilege_review === 'true' && { privilege_review: true }),
      ...(fast_mode === 'true' && { fast_mode: true }),
    };

    // Inject extracted content so the LLM can reason about attachments
    if (processed.length > 0) {
      edgePayload.chat_attachments = processed.map(a => ({
        id: a.id,
        filename: a.filename,
        mime_type: a.mime_type,
        size: a.size,
        type: a.type,
        storage_path: a.storage_path,
      }));

      // Build inline attachment context for the LLM
      const attachmentTexts = processed
        .filter(a => a.extracted_text || a.vision_result)
        .map(a => {
          if (a.type === 'image' && a.vision_result) {
            return `[Attached Image: ${a.filename}]\n${a.vision_result}`;
          }
          if (a.extracted_text) {
            return `[Attached File: ${a.filename}]\n${a.extracted_text}`;
          }
          return '';
        })
        .filter(Boolean);

      if (attachmentTexts.length > 0) {
        edgePayload.attachment_context = attachmentTexts.join('\n\n---\n\n');
      }
    }

    // ── Proxy to Edge Function and stream SSE back ────────────────────────
    const edgeUrl = `${config.supabase.url}/functions/v1/chat`;

    const edgeResponse = await fetch(edgeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(edgePayload),
    });

    if (!edgeResponse.ok) {
      const errBody = await edgeResponse.text();
      console.error('[chat] Edge function error:', edgeResponse.status, errBody);
      return res.status(edgeResponse.status).json({
        error: `Edge function returned ${edgeResponse.status}`,
        detail: errBody,
      });
    }

    // Stream SSE response back to client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Emit attachment metadata as the first SSE event so the frontend can display chips
    if (processed.length > 0) {
      const attachmentEvent = JSON.stringify({
        type: 'attachments',
        attachments: processed.map(a => ({
          id: a.id,
          filename: a.filename,
          mime_type: a.mime_type,
          size: a.size,
          type: a.type,
          storage_path: a.storage_path,
        })),
      });
      res.write(`data: ${attachmentEvent}\n\n`);
    }

    // Pipe the edge function SSE stream
    const reader = edgeResponse.body?.getReader();
    if (!reader) {
      res.write('data: {"type":"content","content":"Error: No response from AI"}\n\n');
      res.end();
      return;
    }

    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);
      }
    } catch (streamErr) {
      console.error('[chat] Stream error:', streamErr);
    }

    res.end();
  } catch (err) {
    console.error('[chat] Route error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    } else {
      res.end();
    }
  }
});

// ─── POST /api/chat/promote — Promote a temp attachment to the vault ─────────

router.post('/promote', async (req: Request, res: Response) => {
  const tenantId = (req as any).tenantId;
  if (!tenantId) return res.status(403).json({ error: 'No tenant' });

  try {
    const { storage_path, case_id, folder_id, filename } = req.body;

    if (!storage_path || !case_id || !filename) {
      return res.status(400).json({ error: 'storage_path, case_id, and filename are required' });
    }

    // Verify the file exists in chat-temp
    if (!storage_path.startsWith('chat-temp/')) {
      return res.status(400).json({ error: 'Can only promote files from chat-temp/' });
    }

    // Build new vault path
    const timestamp = Date.now();
    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const newPath = `${tenantId}/${case_id}/${folder_id || 'root'}/${timestamp}_${safeName}`;

    // Move file: copy to new location, then delete temp
    const { data: fileData, error: downloadError } = await supabaseAdmin.storage
      .from('documents')
      .download(storage_path);

    if (downloadError || !fileData) {
      return res.status(404).json({ error: 'Temp file not found' });
    }

    const buffer = Buffer.from(await fileData.arrayBuffer());

    const { error: uploadError } = await supabaseAdmin.storage
      .from('documents')
      .upload(newPath, buffer, {
        contentType: fileData.type,
        upsert: false,
      });

    if (uploadError) {
      return res.status(500).json({ error: 'Failed to copy file to vault', detail: uploadError.message });
    }

    // Create vault_assets record
    const assetId = uuidv4();
    const { error: insertError } = await supabaseAdmin
      .from('vault_assets')
      .insert({
        id: assetId,
        tenant_id: tenantId,
        case_id,
        folder_id: folder_id || null,
        filename,
        storage_path: newPath,
        file_type: fileData.type,
        file_size: buffer.length,
        status: 'uploaded',
        created_by: (req as any).user?.id,
      });

    if (insertError) {
      console.error('[chat/promote] Insert vault_assets failed:', insertError);
      // Clean up the uploaded file
      await supabaseAdmin.storage.from('documents').remove([newPath]);
      return res.status(500).json({ error: 'Failed to create vault record' });
    }

    // Remove temp file (best effort)
    await supabaseAdmin.storage.from('documents').remove([storage_path]).catch(() => {});

    res.json({
      success: true,
      asset_id: assetId,
      storage_path: newPath,
    });
  } catch (err) {
    console.error('[chat/promote] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─── POST /api/chat/discard — Delete a temp attachment ──────────────────────

router.post('/discard', async (req: Request, res: Response) => {
  const tenantId = (req as any).tenantId;
  if (!tenantId) return res.status(403).json({ error: 'No tenant' });

  try {
    const { storage_paths } = req.body;

    if (!Array.isArray(storage_paths) || storage_paths.length === 0) {
      return res.status(400).json({ error: 'storage_paths array is required' });
    }

    // Only allow deleting chat-temp files owned by this tenant
    const validPaths = storage_paths.filter(
      (p: string) => typeof p === 'string' && p.startsWith(`chat-temp/${tenantId}/`)
    );

    if (validPaths.length === 0) {
      return res.status(400).json({ error: 'No valid chat-temp paths for this tenant' });
    }

    const { error } = await supabaseAdmin.storage.from('documents').remove(validPaths);

    if (error) {
      console.error('[chat/discard] Storage delete error:', error);
      return res.status(500).json({ error: 'Failed to delete temp files' });
    }

    res.json({ success: true, deleted: validPaths.length });
  } catch (err) {
    console.error('[chat/discard] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
