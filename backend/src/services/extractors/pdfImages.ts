/**
 * PDF Image Extractor
 * Extracts embedded images from PDFs (crime scene photos, diagrams, etc.)
 * Uses pdfjs-dist legacy build for Node.js
 */

import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from 'canvas';
import sharp from 'sharp';
import { ExtractedImage } from '../imageService.js';

// Set up worker for Node.js
pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/legacy/build/pdf.worker.mjs';

export interface PdfImageExtractionResult {
  images: ExtractedImage[];
  needsOcr: boolean;
  metadata: ImageMetadata[];
}

export interface ImageMetadata {
  pageNumber: number;
  imageIndex: number;
  width: number;
  height: number;
  surroundingText: string; // Text near the image for context
  caption?: string; // Detected caption if any
  filename: string;
}

/**
 * Extract all embedded images from a PDF
 * Captures surrounding text for context (e.g., "Figure 1: Crime scene photo")
 */
export async function extractPdfImages(
  buffer: Buffer,
  onProgress?: (current: number, total: number) => void
): Promise<PdfImageExtractionResult> {
  console.log(`🖼️ Extracting images from PDF (${buffer.length} bytes)...`);
  
  const images: ExtractedImage[] = [];
  const metadata: ImageMetadata[] = [];
  let needsOcr = false;
  let globalImageIndex = 0;
  
  try {
    const uint8Array = new Uint8Array(buffer);
    const loadingTask = pdfjsLib.getDocument({
      data: uint8Array,
      useSystemFonts: true,
    });
    
    const pdf = await loadingTask.promise;
    const numPages = pdf.numPages;
    
    console.log(`📄 PDF has ${numPages} pages`);
    
    // Process each page
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      onProgress?.(pageNum, numPages);
      
      try {
        const page = await pdf.getPage(pageNum);
        
        // Get text content for context
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .map((item: any) => item.str || '')
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        
        // Get the page resources to find images
        const resources = await page.getOperatorList();
        const objs = page.objs;
        
        // Track which image objects we've seen
        const seenImages = new Set<string>();
        
        // Look for image paint operations
        for (let i = 0; i < resources.fnArray.length; i++) {
          const fn = resources.fnArray[i];
          
          // OPS.paintImageXObject = 85, OPS.paintJpegXObject = 82, OPS.paintImageMaskXObject = 83
          if (fn === 85 || fn === 82 || fn === 83) {
            const imageName = resources.argsArray[i][0];
            
            if (seenImages.has(imageName)) continue;
            seenImages.add(imageName);
            
            try {
              // Get the image object
              const imgData = await new Promise<any>((resolve, reject) => {
                objs.get(imageName, (data: any) => {
                  if (data) resolve(data);
                  else reject(new Error('Image not found'));
                });
              });
              
              if (!imgData || !imgData.width || !imgData.height) continue;
              
              // Skip very small images (likely icons or decorations)
              if (imgData.width < 50 || imgData.height < 50) continue;
              
              console.log(`📸 Found image on page ${pageNum}: ${imageName} (${imgData.width}x${imgData.height})`);
              
              // Convert image data to buffer
              const imageBuffer = await convertImageDataToBuffer(imgData);
              
              if (imageBuffer && imageBuffer.length > 1000) { // Skip tiny images
                const filename = `page${pageNum}_img${globalImageIndex + 1}.png`;
                
                // Extract surrounding text for context
                const surroundingText = extractSurroundingText(pageText, pageNum, globalImageIndex);
                const caption = detectCaption(pageText, globalImageIndex);
                
                images.push({
                  buffer: imageBuffer,
                  filename,
                  pageNumber: pageNum,
                  imageIndex: globalImageIndex,
                  width: imgData.width,
                  height: imgData.height,
                  mimeType: 'image/png',
                });
                
                metadata.push({
                  pageNumber: pageNum,
                  imageIndex: globalImageIndex,
                  width: imgData.width,
                  height: imgData.height,
                  surroundingText,
                  caption,
                  filename,
                });
                
                globalImageIndex++;
              }
            } catch (imgError) {
              // Image extraction failed - try rendering the region
              console.warn(`⚠️ Could not extract ${imageName} directly, will try page render`);
            }
          }
        }
        
        // Check if page is scanned (has little text but large image area)
        const hasLittleText = pageText.replace(/\s/g, '').length < 100;
        if (seenImages.size > 0 && hasLittleText) {
          needsOcr = true;
        }
        
      } catch (pageError) {
        console.warn(`⚠️ Error processing page ${pageNum}:`, pageError);
      }
    }
    
    // If we found no images through direct extraction, try rendering pages with images
    if (images.length === 0) {
      console.log('📸 No direct images found, trying page rendering...');
      const renderResult = await extractImagesViaPageRender(pdf, numPages, onProgress);
      images.push(...renderResult.images);
      metadata.push(...renderResult.metadata);
      needsOcr = renderResult.needsOcr;
    }
    
    console.log(`✅ Extracted ${images.length} images from PDF`);
    
    return { images, needsOcr, metadata };
    
  } catch (error) {
    console.error('❌ PDF image extraction error:', error);
    return { images: [], needsOcr: false, metadata: [] };
  }
}

/**
 * Convert pdfjs image data to PNG buffer
 */
async function convertImageDataToBuffer(imgData: any): Promise<Buffer | null> {
  try {
    const { width, height, data, kind } = imgData;
    
    if (!data || !width || !height) return null;
    
    // Create canvas and draw image
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');
    
    // Handle different image kinds
    // kind: 1 = grayscale, 2 = RGB, 3 = RGBA
    let imageData: any;
    
    if (kind === 3 || data.length === width * height * 4) {
      // RGBA
      imageData = ctx.createImageData(width, height);
      imageData.data.set(data);
    } else if (kind === 2 || data.length === width * height * 3) {
      // RGB - convert to RGBA
      imageData = ctx.createImageData(width, height);
      for (let i = 0, j = 0; i < data.length; i += 3, j += 4) {
        imageData.data[j] = data[i];     // R
        imageData.data[j + 1] = data[i + 1]; // G
        imageData.data[j + 2] = data[i + 2]; // B
        imageData.data[j + 3] = 255;     // A
      }
    } else if (kind === 1 || data.length === width * height) {
      // Grayscale - convert to RGBA
      imageData = ctx.createImageData(width, height);
      for (let i = 0, j = 0; i < data.length; i++, j += 4) {
        imageData.data[j] = data[i];     // R
        imageData.data[j + 1] = data[i]; // G
        imageData.data[j + 2] = data[i]; // B
        imageData.data[j + 3] = 255;     // A
      }
    } else {
      // Try to handle as RGBA
      imageData = ctx.createImageData(width, height);
      const expectedLength = width * height * 4;
      for (let i = 0; i < Math.min(data.length, expectedLength); i++) {
        imageData.data[i] = data[i];
      }
      // Fill remaining with white/opaque
      for (let i = data.length; i < expectedLength; i += 4) {
        imageData.data[i] = 255;
        imageData.data[i + 1] = 255;
        imageData.data[i + 2] = 255;
        imageData.data[i + 3] = 255;
      }
    }
    
    ctx.putImageData(imageData, 0, 0);
    
    // Convert to PNG buffer using sharp for better compression
    const pngBuffer = canvas.toBuffer('image/png');
    
    // Optimize with sharp
    const optimized = await sharp(pngBuffer)
      .png({ quality: 90, compressionLevel: 6 })
      .toBuffer();
    
    return optimized;
    
  } catch (error) {
    console.error('Error converting image data:', error);
    return null;
  }
}

/**
 * Extract images by rendering PDF pages (fallback method)
 */
async function extractImagesViaPageRender(
  pdf: any,
  numPages: number,
  onProgress?: (current: number, total: number) => void
): Promise<{ images: ExtractedImage[]; metadata: ImageMetadata[]; needsOcr: boolean }> {
  const images: ExtractedImage[] = [];
  const metadata: ImageMetadata[] = [];
  let needsOcr = false;
  
  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    onProgress?.(pageNum, numPages);
    
    try {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str || '').join(' ');
      const textLength = pageText.replace(/\s/g, '').length;
      
      // Get operator list to check for images
      const ops = await page.getOperatorList();
      let hasImages = false;
      
      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] === 82 || ops.fnArray[i] === 85 || ops.fnArray[i] === 83) {
          hasImages = true;
          break;
        }
      }
      
      // Render page if it has images and little text (likely scanned or image-heavy)
      if (hasImages && textLength < 200) {
        needsOcr = true;
        
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = createCanvas(viewport.width, viewport.height);
        const context = canvas.getContext('2d');
        
        await page.render({
          canvasContext: context as any,
          viewport,
        }).promise;
        
        const pngBuffer = await sharp(canvas.toBuffer('image/png'))
          .png({ quality: 90 })
          .toBuffer();
        
        const filename = `page${pageNum}_full.png`;
        
        images.push({
          buffer: pngBuffer,
          filename,
          pageNumber: pageNum,
          imageIndex: images.length,
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
          mimeType: 'image/png',
        });
        
        metadata.push({
          pageNumber: pageNum,
          imageIndex: images.length - 1,
          width: Math.round(viewport.width),
          height: Math.round(viewport.height),
          surroundingText: pageText.substring(0, 500),
          filename,
        });
        
        console.log(`📸 Rendered page ${pageNum} (${viewport.width}x${viewport.height})`);
      }
    } catch (err) {
      console.warn(`⚠️ Error rendering page ${pageNum}:`, err);
    }
  }
  
  return { images, metadata, needsOcr };
}

/**
 * Extract text surrounding an image for context
 */
function extractSurroundingText(pageText: string, pageNum: number, imageIndex: number): string {
  // Take first 500 chars of page text as context
  const text = pageText.substring(0, 500);
  return text || `Image from page ${pageNum}`;
}

/**
 * Try to detect a caption for the image
 * Looks for patterns like "Figure 1:", "Photo:", "Exhibit A:", etc.
 */
function detectCaption(pageText: string, imageIndex: number): string | undefined {
  const captionPatterns = [
    /(?:Figure|Fig\.?)\s*\d+[:\.]?\s*([^.]+)/i,
    /(?:Photo|Photograph)\s*\d*[:\.]?\s*([^.]+)/i,
    /(?:Exhibit)\s*[A-Z0-9]+[:\.]?\s*([^.]+)/i,
    /(?:Image|Picture)\s*\d*[:\.]?\s*([^.]+)/i,
    /(?:Crime\s*scene)[:\.]?\s*([^.]+)/i,
    /(?:Evidence)[:\.]?\s*([^.]+)/i,
  ];
  
  for (const pattern of captionPatterns) {
    const match = pageText.match(pattern);
    if (match && match[1]) {
      return match[1].trim().substring(0, 200);
    }
  }
  
  return undefined;
}

/**
 * Detect if a PDF is scanned/image-based
 */
export async function isPdfScanned(buffer: Buffer): Promise<boolean> {
  try {
    const uint8Array = new Uint8Array(buffer);
    const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
    const pdf = await loadingTask.promise;
    
    const pagesToCheck = Math.min(3, pdf.numPages);
    let scannedPages = 0;
    
    for (let pageNum = 1; pageNum <= pagesToCheck; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      const textLength = textContent.items
        .map((item: any) => item.str || '')
        .join('')
        .replace(/\s/g, '')
        .length;
      
      if (textLength < 50) {
        scannedPages++;
      }
    }
    
    return scannedPages > pagesToCheck / 2;
    
  } catch (error) {
    console.error('Error checking if PDF is scanned:', error);
    return false;
  }
}
