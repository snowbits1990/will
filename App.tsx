import React, { useState, useRef, useEffect, useCallback } from 'react';
import { FileUp, AlertCircle } from 'lucide-react';
import { loadPDF, renderPageToCanvas, extractTextFromPage, getCanvasAsBase64 } from './services/pdfService';
import { generateSpeech, performOCR } from './services/geminiService';
import { PDFDocumentProxy, PDFPageProxy, ReaderMode } from './types';
import ControlBar from './components/ControlBar';
import { Spinner } from './components/Spinner';

const App: React.FC = () => {
  // Data State
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPageNum, setCurrentPageNum] = useState(1);
  const [textContent, setTextContent] = useState<string>('');
  const [isTextScanned, setIsTextScanned] = useState(false);
  
  // UI State
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readerMode, setReaderMode] = useState<ReaderMode>(ReaderMode.IDLE);
  
  // Audio State
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);

  // Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const synthRef = useRef<SpeechSynthesis>(window.speechSynthesis);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  
  // Web Audio Context for Gemini TTS
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  const audioStartTimeRef = useRef<number>(0);
  const audioPauseTimeRef = useRef<number>(0); // For pausing web audio

  // --- Initialization ---
  useEffect(() => {
    // Cleanup on unmount
    return () => {
      stopAllAudio();
    };
  }, []);

  const stopAllAudio = () => {
    // Stop Native
    if (synthRef.current.speaking) {
      synthRef.current.cancel();
    }
    // Stop Gemini Web Audio
    if (audioSourceRef.current) {
      try {
        audioSourceRef.current.stop();
      } catch (e) { /* ignore if already stopped */ }
      audioSourceRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.suspend();
    }
    setIsPlaying(false);
  };

  // --- PDF Handling ---
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (file.type !== 'application/pdf') {
      setError('Please upload a valid PDF file.');
      return;
    }

    setIsLoading(true);
    setError(null);
    stopAllAudio();
    setReaderMode(ReaderMode.IDLE);

    try {
      const doc = await loadPDF(file);
      setPdfDoc(doc);
      setCurrentPageNum(1);
    } catch (err: any) {
      console.error(err);
      // Display the actual error message to help with debugging (e.g. "Fake worker failed" or "Invalid PDF structure")
      setError(`Failed to load PDF: ${err.message || 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  // --- Page Rendering & Text Extraction ---
  const processPage = useCallback(async (pageNum: number, doc: PDFDocumentProxy) => {
    if (!canvasRef.current) return;

    setIsLoading(true);
    stopAllAudio();
    setReaderMode(ReaderMode.IDLE);
    setTextContent('');
    setIsTextScanned(false);
    
    try {
      const page: PDFPageProxy = await doc.getPage(pageNum);
      await renderPageToCanvas(page, canvasRef.current);
      
      const extracted = await extractTextFromPage(page, pageNum);
      
      // Clean up text for better reading
      const cleanText = extracted.text.replace(/\s+/g, ' ').trim();
      setTextContent(cleanText);
      
      if (extracted.isScanned) {
        setIsTextScanned(true);
      } else {
        setIsTextScanned(false);
        // Setup Native TTS ready to go
        prepareNativeTTS(cleanText);
      }

    } catch (err) {
      console.error(err);
      setError('Error rendering page.');
    } finally {
      setIsLoading(false);
    }
  }, []); // Dependencies handled by useEffect

  useEffect(() => {
    if (pdfDoc) {
      processPage(currentPageNum, pdfDoc);
    }
  }, [pdfDoc, currentPageNum, processPage]);

  // --- Audio Logic: Native ---
  const prepareNativeTTS = (text: string) => {
    if (!text) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = playbackRate;
    utterance.onend = () => {
      setIsPlaying(false);
      setReaderMode(ReaderMode.IDLE);
    };
    utterance.onerror = (e) => {
      console.error("TTS Error", e);
      setIsPlaying(false);
    };
    utteranceRef.current = utterance;
    setReaderMode(ReaderMode.NATIVE_TTS);
  };

  // --- Audio Logic: Play/Pause Toggle ---
  const togglePlayPause = async () => {
    if (isPlaying) {
      // PAUSE logic
      if (readerMode === ReaderMode.NATIVE_TTS) {
        synthRef.current.pause();
      } else if (readerMode === ReaderMode.GEMINI_TTS) {
        if (audioContextRef.current) {
          await audioContextRef.current.suspend();
        }
      }
      setIsPlaying(false);
    } else {
      // PLAY logic
      if (readerMode === ReaderMode.NATIVE_TTS) {
        if (synthRef.current.paused) {
           synthRef.current.resume();
        } else {
           // Start fresh
           if (utteranceRef.current) {
             // Need to re-apply rate in case it changed
             utteranceRef.current.rate = playbackRate;
             synthRef.current.speak(utteranceRef.current);
           }
        }
      } else if (readerMode === ReaderMode.GEMINI_TTS) {
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume();
        } else {
           // If strictly fresh start or ended, playGeminiAudio handles it
           if(audioBufferRef.current && !audioSourceRef.current) {
               playAudioBuffer(audioBufferRef.current);
           }
        }
      }
      setIsPlaying(true);
    }
  };

  // --- Audio Logic: Speed ---
  const handleRateChange = (rate: number) => {
    setPlaybackRate(rate);
    
    if (readerMode === ReaderMode.NATIVE_TTS) {
      if (synthRef.current.speaking) {
        // Browser TTS often requires a cancel/restart to change rate smoothly or pause/resume
        synthRef.current.cancel();
        if (utteranceRef.current) {
            utteranceRef.current.rate = rate;
            if (isPlaying) synthRef.current.speak(utteranceRef.current);
        }
      } else if (utteranceRef.current) {
        utteranceRef.current.rate = rate;
      }
    } else if (readerMode === ReaderMode.GEMINI_TTS) {
        if (audioSourceRef.current) {
            audioSourceRef.current.playbackRate.value = rate;
        }
    }
  };

  // --- Gemini Features ---

  const handleOCR = async () => {
    if (!canvasRef.current) return;
    setIsLoading(true);
    try {
      const base64 = getCanvasAsBase64(canvasRef.current);
      const text = await performOCR(base64);
      setTextContent(text);
      setIsTextScanned(false); // Treated as normal text now
      prepareNativeTTS(text); // Default back to native for responsiveness
    } catch (err) {
      setError("OCR Failed. Please check your API Key or network.");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleGeminiTTS = async () => {
    if (!textContent) return;
    setIsLoading(true);
    stopAllAudio(); // Stop native
    
    try {
      const buffer = await generateSpeech(textContent);
      audioBufferRef.current = buffer;
      setReaderMode(ReaderMode.GEMINI_TTS);
      playAudioBuffer(buffer);
      setIsPlaying(true);
    } catch (err) {
      setError("Failed to generate AI speech.");
      console.error(err);
      // Fallback to native
      prepareNativeTTS(textContent);
    } finally {
      setIsLoading(false);
    }
  };

  const playAudioBuffer = (buffer: AudioBuffer) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    source.connect(audioContextRef.current.destination);
    
    source.onended = () => {
      // Only set playing false if it finished naturally, not just stopped manually
      // But for simplicity in this demo, we reset.
      setIsPlaying(false); 
      audioSourceRef.current = null;
    };

    audioSourceRef.current = source;
    source.start(0);
  };


  return (
    <div className="flex flex-col h-screen bg-slate-100 text-slate-900">
      
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="bg-indigo-600 p-2 rounded-lg text-white">
            <FileUp size={20} />
          </div>
          <h1 className="text-xl font-bold text-slate-800 tracking-tight">AI Smart Reader</h1>
        </div>
        
        <div className="flex items-center gap-4">
             <button 
               onClick={() => fileInputRef.current?.click()}
               className="bg-slate-900 hover:bg-slate-800 text-white px-4 py-2 rounded-md text-sm font-medium transition-colors shadow-sm"
             >
               Open PDF
             </button>
             <input 
               type="file" 
               ref={fileInputRef} 
               onChange={handleFileChange} 
               accept="application/pdf" 
               className="hidden" 
             />
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 overflow-hidden flex relative">
        
        {/* PDF View Area */}
        <div className="flex-1 bg-slate-200 overflow-auto flex justify-center p-8 relative">
          {error && (
             <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded z-50 flex items-center shadow-lg">
                <AlertCircle className="mr-2" size={20} />
                <span>{error}</span>
                <button onClick={() => setError(null)} className="ml-4 font-bold">✕</button>
             </div>
          )}

          {!pdfDoc ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-400">
               <FileUp size={64} className="mb-4 opacity-20" />
               <p className="text-lg font-medium">No PDF loaded</p>
               <p className="text-sm">Click "Open PDF" to start reading</p>
            </div>
          ) : (
            <div className="shadow-2xl border border-gray-300 bg-white transition-all duration-300 ease-in-out origin-top">
               {/* The actual PDF Page Canvas */}
               <canvas ref={canvasRef} className="block max-w-full h-auto" />
               
               {/* Overlay for visual feedback during loading */}
               {isLoading && (
                 <div className="absolute inset-0 bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center z-20">
                    <Spinner />
                    <p className="mt-3 text-slate-600 font-medium animate-pulse">
                      {isTextScanned ? 'Analyzing Image...' : 'Processing Page...'}
                    </p>
                 </div>
               )}
            </div>
          )}
        </div>
        
        {/* Sidebar / Text View (Desktop) */}
        <div className="w-96 bg-white border-l border-gray-200 hidden xl:flex flex-col shadow-xl z-10">
           <div className="p-4 border-b border-gray-100 bg-gray-50">
              <h2 className="font-semibold text-gray-700 text-sm uppercase tracking-wider">Extracted Text</h2>
           </div>
           <div className="flex-1 overflow-y-auto p-6 text-gray-600 leading-relaxed text-sm font-serif whitespace-pre-wrap">
              {textContent ? textContent : (
                <span className="italic text-gray-400">
                  {isLoading ? 'Extracting...' : 'No text available on this page. Try OCR if it appears to be a scanned document.'}
                </span>
              )}
           </div>
        </div>

      </main>

      {/* Footer Controls */}
      {pdfDoc && (
        <ControlBar 
          pageNumber={currentPageNum}
          totalPages={pdfDoc.numPages}
          onPageChange={setCurrentPageNum}
          isPlaying={isPlaying}
          onPlayPause={togglePlayPause}
          playbackRate={playbackRate}
          onRateChange={handleRateChange}
          mode={readerMode}
          hasText={!!textContent && !isTextScanned}
          isProcessing={isLoading}
          onUseGeminiTTS={handleGeminiTTS}
          onOCR={handleOCR}
          extractedText={textContent}
        />
      )}
    </div>
  );
};

export default App;