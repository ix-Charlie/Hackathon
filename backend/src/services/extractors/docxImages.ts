/**
 * DOCX Image Extractor
 * Extracts images from DOCX files using JSZip
 */

import JSZip from 'jszip';
import { ExtractedImage } from '../imageService.js';

export interface DocxImageExtractionResult {
  images: ExtractedImage[];
}

// Supported image MIME types in DOCX
const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.wmf': 'image/wmf',
  '.emf': 'image/emf',
};

/**
 * Extract images from a DOCX buffer
 */
export async function extractDocxImages(buffer: Buffer): Promise<DocxImageExtractionResult> {
  console.log(`🖼️ Extracting images from DOCX (${buffer.length} bytes)...`);
  
  const images: ExtractedImage[] = [];
  
  try {
    // DOCX is a ZIP file
    const zip = await JSZip.loadAsync(buffer);
    
    // Images are typically in word/media/
    const mediaFolder = zip.folder('word/media');
    
    if (!mediaFolder) {
      console.log('📁 No media folder found in DOCX');
      return { images };
    }
    
    // Get all files in the media folder
    let imageIndex = 0;
    
    const files = Object.keys(zip.files).filter(
      name => name.startsWith('word/media/') && !name.endsWith('/')
    );
    
    for (const filename of files) {
      const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
      const mimeType = IMAGE_EXTENSIONS[ext];
      
      if (!mimeType) {
        console.log(`⏩ Skipping non-image file: ${filename}`);
        continue;
      }
      
      try {
        const file = zip.file(filename);
        if (!file) continue;
        
        const imageBuffer = await file.async('nodebuffer');
        const baseName = filename.split('/').pop() || `image_${imageIndex}.${ext}`;
        
        images.push({
          buffer: imageBuffer,
          filename: baseName,
          imageIndex,
          mimeType,
        });
        
        console.log(`📸 Found image: ${baseName} (${imageBuffer.length} bytes)`);
        imageIndex++;
        
      } catch (fileError) {
        console.warn(`⚠️ Error extracting image ${filename}:`, fileError);
      }
    }
    
    console.log(`🖼️ Extracted ${images.length} images from DOCX`);
    
    return { images };
    
  } catch (error) {
    console.error('❌ DOCX image extraction error:', error);
    return { images: [] };
  }
}
