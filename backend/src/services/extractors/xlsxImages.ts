/**
 * XLSX Image Extractor
 * Extracts embedded images from Excel files using JSZip.
 * Mirrors the pattern from docxImages.ts but targets xl/media/ and
 * parses xl/drawings/ XML for cell anchor positions.
 */

import JSZip from 'jszip';
import { ExtractedImage } from '../imageService.js';

export interface XlsxImageExtractionResult {
  images: ExtractedImage[];
}

// Supported raster image MIME types (skip EMF/WMF vector formats — sharp can't process them)
const IMAGE_EXTENSIONS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
};

/**
 * Parse drawing XML files to extract cell anchor positions for images.
 * Returns a map of image path → { sheetName, fromCol, fromRow }.
 */
async function parseDrawingAnchors(
  zip: JSZip,
): Promise<Map<string, { sheetName: string; fromCol: number; fromRow: number }>> {
  const imageAnchors = new Map<string, { sheetName: string; fromCol: number; fromRow: number }>();

  try {
    // Find all drawing relationship files
    const drawingRelsFiles = Object.keys(zip.files).filter(
      (f) => f.startsWith('xl/drawings/_rels/') && f.endsWith('.xml.rels'),
    );

    for (const relsPath of drawingRelsFiles) {
      const relsFile = zip.file(relsPath);
      if (!relsFile) continue;

      const relsXml = await relsFile.async('text');

      // Extract relationship ID → target (image path) mappings
      const relRegex = /Relationship\s+Id="(rId\d+)"[^>]*Target="([^"]+)"/g;
      const relMap = new Map<string, string>();
      let relMatch;
      while ((relMatch = relRegex.exec(relsXml)) !== null) {
        // Resolve the relative path: ../media/image1.png → xl/media/image1.png
        let target = relMatch[2];
        if (target.startsWith('..')) {
          target = 'xl' + target.substring(2);
        } else if (!target.startsWith('xl/')) {
          target = 'xl/drawings/' + target;
        }
        relMap.set(relMatch[1], target);
      }

      // Parse the corresponding drawing XML for anchors
      const drawingName = relsPath
        .replace('xl/drawings/_rels/', '')
        .replace('.xml.rels', '.xml');
      const drawingPath = `xl/drawings/${drawingName}`;
      const drawingFile = zip.file(drawingPath);
      if (!drawingFile) continue;

      const drawingXml = await drawingFile.async('text');

      // Match twoCellAnchor and oneCellAnchor blocks with image references
      // Looking for patterns like: <xdr:from><xdr:col>2</xdr:col>...<xdr:row>5</xdr:row>
      // followed by <a:blip ... r:embed="rId1"/>
      const anchorRegex =
        /<xdr:(?:twoCellAnchor|oneCellAnchor)[^>]*>([\s\S]*?)<\/xdr:(?:twoCellAnchor|oneCellAnchor)>/g;

      let anchorMatch;
      while ((anchorMatch = anchorRegex.exec(drawingXml)) !== null) {
        const block = anchorMatch[1];

        // Extract from position
        const colMatch = block.match(/<xdr:from>\s*<xdr:col>(\d+)<\/xdr:col>/);
        const rowMatch = block.match(/<xdr:from>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/);
        const blipMatch = block.match(/<a:blip[^>]*r:embed="(rId\d+)"/);

        if (colMatch && rowMatch && blipMatch) {
          const col = parseInt(colMatch[1], 10);
          const row = parseInt(rowMatch[1], 10);
          const rId = blipMatch[1];
          const imagePath = relMap.get(rId);

          if (imagePath) {
            imageAnchors.set(imagePath, { sheetName: '', fromCol: col, fromRow: row });
          }
        }
      }
    }
  } catch (error) {
    console.warn('⚠️ Could not parse drawing anchors (non-fatal):', error);
  }

  return imageAnchors;
}

/**
 * Extract images from an XLSX buffer.
 * Returns ExtractedImage[] compatible with the existing image processing pipeline.
 */
export async function extractXlsxImages(
  buffer: Buffer,
): Promise<XlsxImageExtractionResult> {
  console.log(`🖼️ Extracting images from XLSX (${buffer.length} bytes)...`);

  const images: ExtractedImage[] = [];

  try {
    const zip = await JSZip.loadAsync(buffer);

    // Parse cell anchor positions (optional — enriches metadata)
    const anchors = await parseDrawingAnchors(zip);

    // Extract all images from xl/media/
    const mediaFiles = Object.keys(zip.files).filter(
      (name) => name.startsWith('xl/media/') && !name.endsWith('/'),
    );

    if (mediaFiles.length === 0) {
      console.log('📁 No media files found in XLSX');
      return { images };
    }

    let imageIndex = 0;
    for (const filename of mediaFiles) {
      const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
      const mimeType = IMAGE_EXTENSIONS[ext];

      if (!mimeType) {
        console.log(`⏩ Skipping non-raster file: ${filename} (${ext})`);
        continue;
      }

      try {
        const file = zip.file(filename);
        if (!file) continue;

        const imageBuffer = await file.async('nodebuffer');
        const baseName = filename.split('/').pop() || `xlsx_image_${imageIndex}${ext}`;

        // Check if we have cell anchor info for this image
        const anchor = anchors.get(filename);
        const surroundingText = anchor
          ? `Excel embedded image at column ${anchor.fromCol + 1}, row ${anchor.fromRow + 1}`
          : `Excel embedded image (${baseName})`;

        images.push({
          buffer: imageBuffer,
          filename: baseName,
          imageIndex,
          mimeType,
          surroundingText,
        });

        console.log(
          `📸 Found XLSX image: ${baseName} (${imageBuffer.length} bytes)${
            anchor ? ` at col=${anchor.fromCol + 1}, row=${anchor.fromRow + 1}` : ''
          }`,
        );
        imageIndex++;
      } catch (fileError) {
        console.warn(`⚠️ Error extracting image ${filename}:`, fileError);
      }
    }

    console.log(`🖼️ Extracted ${images.length} images from XLSX`);
    return { images };
  } catch (error) {
    console.error('❌ XLSX image extraction error:', error);
    return { images: [] };
  }
}
