import { extractPdfImages } from './src/services/extractors/pdfImages.js';
import { processAndStoreImages } from './src/services/imageService.js';
import { performOcr } from './src/services/ocrService.js';

console.log('✅ All image extraction imports successful');
console.log('Functions available:', { 
  extractPdfImages: typeof extractPdfImages, 
  processAndStoreImages: typeof processAndStoreImages, 
  performOcr: typeof performOcr 
});
