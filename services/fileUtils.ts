import { UploadedFile } from '../types';

// Dynamic imports for heavy document processing libraries
// mammoth (~400KB) and xlsx (~400KB) are only loaded when needed
const getMammoth = () => import('mammoth');
const getXLSX = () => import('xlsx');

export const generateId = (): string => Math.random().toString(36).substring(2, 9);

export const readFileAsBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove the Data URL prefix (e.g., "data:application/pdf;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

export const readFileAsText = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsText(file);
  });
};

export const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
};

const convertDocxToText = async (file: File): Promise<string> => {
  try {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const mammoth = await getMammoth();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value;
  } catch (e) {
    console.error("Error converting DOCX", e);
    throw new Error(`Failed to convert Word document: ${file.name}`);
  }
};

const convertExcelToCsv = async (file: File): Promise<string> => {
  try {
    const arrayBuffer = await readFileAsArrayBuffer(file);
    const XLSX = await getXLSX();
    const workbook = XLSX.read(arrayBuffer, { type: 'array' });
    const firstSheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[firstSheetName];
    return XLSX.utils.sheet_to_csv(worksheet);
  } catch (e) {
    console.error("Error converting Excel", e);
    throw new Error(`Failed to convert Excel document: ${file.name}`);
  }
};

/**
 * Resolve MIME type from file extension when browser reports empty or generic types.
 * Browsers often report '' or 'application/octet-stream' for .msg, .docx, etc.
 */
function resolveMimeType(file: File): string {
  if (file.type && file.type !== 'application/octet-stream') return file.type;
  const ext = file.name.toLowerCase().split('.').pop();
  const extMimeMap: Record<string, string> = {
    msg: 'application/vnd.ms-outlook',
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    csv: 'text/csv',
    txt: 'text/plain',
    md: 'text/markdown',
    json: 'application/json',
  };
  return (ext && extMimeMap[ext]) || file.type || 'application/octet-stream';
}

export const processFile = async (file: File): Promise<UploadedFile> => {
  let data: string;
  const mimeType = resolveMimeType(file);
  let finalMimeType = mimeType;

  // Conversion Logic
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || mimeType === 'application/msword') {
    data = await convertDocxToText(file);
    finalMimeType = 'text/plain';
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || mimeType === 'application/vnd.ms-excel') {
    data = await convertExcelToCsv(file);
    finalMimeType = 'text/csv';
  } else if (mimeType === 'application/vnd.ms-outlook') {
    // .msg files are processed by the backend worker via RAG pipeline.
    // Store as base64; the Edge Function won't try to inline-read this.
    data = await readFileAsBase64(file);
    finalMimeType = 'application/vnd.ms-outlook';
  } else if (mimeType.startsWith('text/')) {
    data = await readFileAsText(file);
  } else {
    data = await readFileAsBase64(file);
  }

  return {
    id: generateId(),
    name: file.name,
    mimeType: finalMimeType,
    size: file.size,
    data: data
  };
};
