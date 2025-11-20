export interface PDFPageText {
  pageNumber: number;
  text: string;
  isScanned: boolean; // If true, likely needs OCR
}

export enum ReaderMode {
  IDLE = 'IDLE',
  NATIVE_TTS = 'NATIVE_TTS', // Browser SpeechSynthesis
  GEMINI_TTS = 'GEMINI_TTS', // Gemini Audio Generation
}

export interface AudioState {
  isPlaying: boolean;
  playbackRate: number; // 0.5 to 2.0
  progress: number; // 0 to 100
}

// Simplified wrapper for what we need from pdfjs-dist
export interface PDFDocumentProxy {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PDFPageProxy>;
  destroy: () => void;
}

export interface PDFPageProxy {
  render: (params: any) => any;
  getTextContent: () => Promise<any>;
  getViewport: (params: { scale: number }) => any;
  view: number[];
}