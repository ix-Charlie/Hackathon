// Test PDF extraction using PDF.js
// Run with: node test-pdf-extraction.mjs [path-to-pdf]
// Example: node test-pdf-extraction.mjs ~/Downloads/myfile.pdf

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Test the extraction
const testExtraction = async (pdfPath) => {
  console.log('🧪 Testing PDF.js extraction...\n');
  
  if (!pdfPath) {
    console.log('Usage: node test-pdf-extraction.mjs <path-to-pdf>');
    console.log('Example: node test-pdf-extraction.mjs ~/Downloads/Cv.pdf');
    process.exit(1);
  }
  
  // Expand ~ to home directory
  if (pdfPath.startsWith('~')) {
    pdfPath = join(process.env.HOME, pdfPath.slice(1));
  }
  
  if (!existsSync(pdfPath)) {
    console.error(`❌ File not found: ${pdfPath}`);
    process.exit(1);
  }
  
  // Read the PDF
  const pdfBuffer = readFileSync(pdfPath);
  console.log(`📄 PDF: ${pdfPath}`);
  console.log(`📄 Size: ${pdfBuffer.length} bytes\n`);
  
  try {
    // Import PDF.js (same version as Edge Function)
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    
    // Load the PDF
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
    });
    
    const pdf = await loadingTask.promise;
    console.log(`📄 PDF loaded: ${pdf.numPages} page(s)\n`);
    
    const textParts = [];
    
    // Extract text from each page
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      let lastY = null;
      let pageText = '';
      
      for (const item of textContent.items) {
        if ('str' in item && item.str) {
          if (lastY !== null && 'transform' in item) {
            const currentY = item.transform[5];
            if (Math.abs(currentY - lastY) > 5) {
              pageText += '\n';
            } else if (pageText && !pageText.endsWith(' ')) {
              pageText += ' ';
            }
          }
          
          pageText += item.str;
          
          if ('transform' in item) {
            lastY = item.transform[5];
          }
        }
      }
      
      if (pageText.trim()) {
        textParts.push(pageText.trim());
        console.log(`📄 Page ${pageNum}: extracted ${pageText.length} chars`);
      } else {
        console.log(`⚠️ Page ${pageNum}: NO TEXT (may be scanned/image)`);
      }
    }
    
    const fullText = textParts.join('\n\n');
    
    // Validate
    const meaningfulChars = fullText.replace(/[^a-zA-Z0-9\s]/g, '').length;
    const meaningfulRatio = meaningfulChars / Math.max(fullText.length, 1);
    
    console.log(`\n📊 Stats:`);
    console.log(`   Total characters: ${fullText.length}`);
    console.log(`   Meaningful ratio: ${(meaningfulRatio * 100).toFixed(1)}%`);
    
    if (meaningfulRatio < 0.3) {
      console.log(`\n⚠️ WARNING: Low meaningful ratio - PDF may be scanned/image-based`);
      console.log(`   This PDF requires OCR to extract text.`);
    }
    
    console.log(`\n✅ EXTRACTED TEXT (first 2000 chars):\n${'='.repeat(50)}`);
    console.log(fullText.substring(0, 2000));
    if (fullText.length > 2000) {
      console.log(`\n... (${fullText.length - 2000} more characters)`);
    }
    console.log('='.repeat(50));
    
  } catch (error) {
    console.error('❌ Extraction failed:', error.message);
  }
};

// Get PDF path from command line argument
const pdfPath = process.argv[2];
testExtraction(pdfPath);
