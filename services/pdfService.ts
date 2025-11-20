import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocumentProxy, PDFPageProxy, PDFPageText } from '../types';

// We use a fixed version string here to match the importmap in index.html.
// This ensures the worker is exactly compatible with the main library.
const PDFJS_VERSION = '4.10.38';

// Set the worker source. Using the .mjs module worker is preferred for modern browsers/imports.
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

export const loadPDF = async (file: File): Promise<PDFDocumentProxy> => {
  const arrayBuffer = await file.arrayBuffer();
  // Convert to Uint8Array for better compatibility
  const uint8Array = new Uint8Array(arrayBuffer);
  
  const loadingTask = pdfjsLib.getDocument({ 
    data: uint8Array,
    // cMapUrl is essential for rendering PDFs with complex fonts or non-Latin characters correctly.
    // Without this, some PDFs fail to load or show garbled text.
    cMapUrl: `https://unpkg.com/pdfjs-dist@${PDFJS_VERSION}/cmaps/`,
    cMapPacked: true,
  });
  
  return loadingTask.promise as unknown as PDFDocumentProxy;
};

export const renderPageToCanvas = async (
  page: PDFPageProxy,
  canvas: HTMLCanvasElement,
  scale: number = 1.5
): Promise<void> => {
  const viewport = page.getViewport({ scale });
  canvas.height = viewport.height;
  canvas.width = viewport.width;

  const canvasContext = canvas.getContext('2d');
  if (!canvasContext) throw new Error('Canvas context not found');

  const renderContext = {
    canvasContext,
    viewport,
  };
  
  await page.render(renderContext).promise;
};

export const extractTextFromPage = async (page: PDFPageProxy, pageNumber: number): Promise<PDFPageText> => {
  const textContent = await page.getTextContent();
  // Join text items. Sometimes items are just spaces, so filter if needed, but ' ' join usually works well.
  const textItems = textContent.items.map((item: any) => item.str).join(' ');
  
  // Heuristic: If text length is extremely low but page is not empty, it might be scanned/image-based
  const isScanned = textItems.trim().length < 5; 

  return {
    pageNumber,
    text: textItems,
    isScanned,
  };
};

export const getCanvasAsBase64 = (canvas: HTMLCanvasElement): string => {
  // Returns clean base64 data (removes "data:image/png;base64," prefix)
  return canvas.toDataURL('image/jpeg', 0.8).split(',')[1];
};