import React, { useState, useRef, useEffect, useCallback } from 'react';
import { FileUp, AlertCircle } from 'lucide-react';
import { loadPDF, renderPageToCanvas, extractTextFromPage, getCanvasAsBase64 } from './services/pdfService';
import { generateSpeech, performOCR } from './services/geminiService';
import { PDFDocumentProxy, PDFPageProxy, ReaderMode } from './types';
import ControlBar from './components/ControlBar';
import { Spinner } from './components/Spinner';
import { HighlightableText } from './components/HighlightableText';
import { WaitingOverlay } from './components/WaitingOverlay';

const App: React.FC = () => {
  // Data State
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPageNum, setCurrentPageNum] = useState(1);
  const [textContent, setTextContent] = useState<string>('');
  const [isTextScanned, setIsTextScanned] = useState(false);
  
  // UI State
  const [isLoading, setIsLoading] = useState(false); // Generic loading (PDF render, etc)
  const [isGeneratingAI, setIsGeneratingAI] = useState(false); // Specific heavy lifting state for Overlay
  const [error, setError] = useState<string | null>(null);
  const [readerMode, setReaderMode] = useState<ReaderMode>(ReaderMode.IDLE);
  
  // Audio State
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [highlightIndex, setHighlightIndex] = useState(0); 

  // Logic Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoPlayRef = useRef<boolean>(false); 
  
  // Persistence & Caching Refs
  const previousModeRef = useRef<ReaderMode>(ReaderMode.IDLE); 
  const nextPageAudioCacheRef = useRef<{ page: number; buffer: AudioBuffer } | null>(null);
  const preloadTimeoutRef = useRef<any>(null);

  // Native Audio Refs
  const synthRef = useRef<SpeechSynthesis>(window.speechSynthesis);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const currentTextOffsetRef = useRef<number>(0); 
  const lastKnownCharIndexRef = useRef<number>(0); 

  // Gemini Audio Context Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null); 
  
  // Refs for closure safety in event handlers
  const currentPageRef = useRef(1);
  const isProcessingPageRef = useRef(false);

  useEffect(() => {
    currentPageRef.current = currentPageNum;
  }, [currentPageNum]);

  // --- Initialization ---
  useEffect(() => {
    return () => {
      stopAllAudio();
      if (preloadTimeoutRef.current) clearTimeout(preloadTimeoutRef.current);
    };
  }, []);

  const stopAllAudio = () => {
    if (synthRef.current.speaking) {
      synthRef.current.cancel();
    }
    if (audioSourceRef.current) {
      audioSourceRef.current.onended = null; 
      try {
        audioSourceRef.current.stop();
      } catch (e) { /* ignore */ }
      audioSourceRef.current = null;
    }
    if (preloadTimeoutRef.current) {
      clearTimeout(preloadTimeoutRef.current);
      preloadTimeoutRef.current = null;
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
    setIsGeneratingAI(false);
    setError(null);
    stopAllAudio();
    setReaderMode(ReaderMode.IDLE);
    previousModeRef.current = ReaderMode.IDLE;
    nextPageAudioCacheRef.current = null;
    autoPlayRef.current = false;
    currentTextOffsetRef.current = 0;
    lastKnownCharIndexRef.current = 0;

    try {
      const doc = await loadPDF(file);
      setPdfDoc(doc);
      setCurrentPageNum(1);
    } catch (err: any) {
      console.error(err);
      setError(`Failed to load PDF: ${err.message || 'Unknown error'}`);
    } finally {
      setIsLoading(false);
    }
  };

  // --- Audio Logic: Native ---
  // Defined early so it can be used in other callbacks
  const prepareNativeTTS = useCallback((text: string, autoStart: boolean = false, startOffset: number = 0) => {
    if (!text) return;
    
    synthRef.current.cancel();

    const textToSpeak = startOffset > 0 ? text.substring(startOffset) : text;

    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.rate = playbackRate; // Note: This captures current playbackRate
    
    utterance.onboundary = (event) => {
      if (event.name === 'word' || event.name === 'sentence') {
        const globalIndex = startOffset + event.charIndex;
        setHighlightIndex(globalIndex);
        lastKnownCharIndexRef.current = globalIndex;
      }
    };

    utterance.onend = () => {
       onAudioEndedRef.current();
    };

    utterance.onerror = (e) => {
      console.error("Native TTS Error", e);
      setIsPlaying(false);
    };

    utteranceRef.current = utterance;
    setReaderMode(ReaderMode.NATIVE_TTS);
    previousModeRef.current = ReaderMode.NATIVE_TTS;
    
    if (autoStart) {
      setIsPlaying(true);
      synthRef.current.speak(utterance);
    } else {
      setIsPlaying(false);
    }
  }, [playbackRate]);

  // --- Preloading Logic ---
  const preloadNextPageAudio = useCallback(async (nextPageNum: number, doc: PDFDocumentProxy) => {
    if (nextPageNum > doc.numPages) return;
    if (nextPageAudioCacheRef.current?.page === nextPageNum) return; 

    console.log(`[Cache] Starting background preload for page ${nextPageNum}...`);
    try {
      const page = await doc.getPage(nextPageNum);
      const extracted = await extractTextFromPage(page, nextPageNum);
      const cleanText = extracted.text.replace(/\s+/g, ' ').trim();

      if (!cleanText || extracted.isScanned) {
        console.log(`[Cache] Page ${nextPageNum} is empty or scanned. Skipping audio preload.`);
        return;
      }

      const buffer = await generateSpeech(cleanText);
      
      nextPageAudioCacheRef.current = {
        page: nextPageNum,
        buffer: buffer
      };
      console.log(`[Cache] Successfully preloaded audio for page ${nextPageNum}`);
      
    } catch (err) {
      console.warn("[Cache] Background preload failed:", err);
    }
  }, []);

  // --- Handle Audio End (Page Turn) ---
  // This ref holds the latest logic to execute when audio finishes
  const onAudioEndedRef = useRef<() => void>(() => {});
  
  useEffect(() => {
    onAudioEndedRef.current = () => {
      const current = currentPageRef.current;
      if (pdfDoc && current < pdfDoc.numPages) {
        console.log(`Audio ended for page ${current}. Moving to ${current + 1}`);
        // CRITICAL: Set autoPlay intent BEFORE state update trigger
        autoPlayRef.current = true;
        setCurrentPageNum(current + 1);
      } else {
        console.log("Finished reading document.");
        setIsPlaying(false);
        setReaderMode(ReaderMode.IDLE);
        setHighlightIndex(0);
        currentTextOffsetRef.current = 0;
        autoPlayRef.current = false;
      }
    };
  }, [pdfDoc]);

  // --- Gemini Audio Playback ---
  const playAudioBuffer = useCallback((buffer: AudioBuffer, pageForAudio: number, doc: PDFDocumentProxy) => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (audioContextRef.current.state === 'suspended') {
      audioContextRef.current.resume();
    }
    
    const source = audioContextRef.current.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = playbackRate;
    source.connect(audioContextRef.current.destination);
    
    source.onended = () => {
      audioSourceRef.current = null;
      // Always call the ref to ensure we use the latest logic/state
      onAudioEndedRef.current(); 
    };

    audioSourceRef.current = source;
    source.start(0);

    // --- Preload Logic ---
    if (pageForAudio < doc.numPages) {
      const duration = buffer.duration; 
      // Trigger preload at 50% progress
      const estimatedDelay = (duration * 1000) / 2 / playbackRate;
      
      console.log(`Scheduled cache preload for page ${pageForAudio + 1} in ${estimatedDelay.toFixed(0)}ms`);
      
      if (preloadTimeoutRef.current) clearTimeout(preloadTimeoutRef.current);
      
      preloadTimeoutRef.current = setTimeout(() => {
        preloadNextPageAudio(pageForAudio + 1, doc);
      }, estimatedDelay);
    }
  }, [playbackRate, preloadNextPageAudio]);

  const handleGeminiTTS = useCallback(async (textToRead: string, pageNum: number) => {
    if (!textToRead) {
      setError("No text content to read.");
      return;
    }
    
    setReaderMode(ReaderMode.GEMINI_TTS);
    previousModeRef.current = ReaderMode.GEMINI_TTS;
    
    // ACTIVATE OVERLAY
    setIsGeneratingAI(true);
    stopAllAudio(); 
    
    try {
      const buffer = await generateSpeech(textToRead);
      console.log(`Gemini TTS Audio Generated successfully for page ${pageNum}.`);
      
      audioBufferRef.current = buffer;
      if (pdfDoc) {
        playAudioBuffer(buffer, pageNum, pdfDoc);
      }
      setIsPlaying(true);

    } catch (err: any) {
      setError(`Failed to generate AI speech: ${err.message}`);
      console.error("Gemini TTS Error:", err);
      prepareNativeTTS(textToRead, true);
    } finally {
      // DEACTIVATE OVERLAY
      setIsGeneratingAI(false);
      setIsLoading(false);
    }
  }, [pdfDoc, playAudioBuffer, prepareNativeTTS]);


  // --- Page Rendering & Text Extraction ---
  const processPage = useCallback(async (pageNum: number, doc: PDFDocumentProxy) => {
    if (!canvasRef.current || isProcessingPageRef.current) return;
    isProcessingPageRef.current = true;

    setIsLoading(true);
    // Only stop audio if we are NOT transitioning automatically with cache
    // Actually, safe to stop previous page audio as we are about to start new one
    stopAllAudio();
    
    setHighlightIndex(0);
    currentTextOffsetRef.current = 0;
    lastKnownCharIndexRef.current = 0;
    setTextContent('');
    setIsTextScanned(false);
    audioBufferRef.current = null; 
    
    try {
      const page: PDFPageProxy = await doc.getPage(pageNum);
      await renderPageToCanvas(page, canvasRef.current);
      
      const extracted = await extractTextFromPage(page, pageNum);
      const cleanText = extracted.text.replace(/\s+/g, ' ').trim();
      setTextContent(cleanText);
      
      if (extracted.isScanned) {
        setIsTextScanned(true);
        setReaderMode(ReaderMode.IDLE);
        setIsLoading(false);
      } else {
        setIsTextScanned(false);
        
        // --- Auto Play Logic with Cache Check ---
        if (autoPlayRef.current && cleanText.length > 0) {
          console.log(`Auto-play triggered for page ${pageNum}. Mode: ${previousModeRef.current}`);
          
          if (previousModeRef.current === ReaderMode.GEMINI_TTS) {
            if (nextPageAudioCacheRef.current?.page === pageNum) {
                console.log("[Cache] Hit! Playing preloaded audio.");
                const cachedBuffer = nextPageAudioCacheRef.current.buffer;
                nextPageAudioCacheRef.current = null;
                
                setReaderMode(ReaderMode.GEMINI_TTS);
                audioBufferRef.current = cachedBuffer;
                playAudioBuffer(cachedBuffer, pageNum, doc);
                setIsPlaying(true);
                setIsLoading(false); 
            } else {
                console.log("[Cache] Miss. Generating fresh.");
                // Pass pageNum explicitly to avoid closure staleness
                await handleGeminiTTS(cleanText, pageNum); 
            }
          } else {
            // Native Auto Play
            prepareNativeTTS(cleanText, true);
            setIsLoading(false);
          }
        } else {
           // Just prep, don't play
           prepareNativeTTS(cleanText, false);
           setIsLoading(false);
        }
      }

    } catch (err) {
      console.error(err);
      setError('Error rendering page.');
      setIsLoading(false);
    } finally {
      isProcessingPageRef.current = false;
    }
  }, [playAudioBuffer, handleGeminiTTS, prepareNativeTTS]); 

  // Trigger Page Processing when Page changes
  useEffect(() => {
    if (pdfDoc) {
      processPage(currentPageNum, pdfDoc);
    }
  }, [pdfDoc, currentPageNum, processPage]);


  // --- Audio Logic: Play/Pause Toggle ---
  const togglePlayPause = async () => {
    if (isPlaying) {
      // PAUSE
      if (readerMode === ReaderMode.NATIVE_TTS) {
        synthRef.current.pause();
      } else if (readerMode === ReaderMode.GEMINI_TTS) {
        if (audioContextRef.current) {
          await audioContextRef.current.suspend();
        }
        if (preloadTimeoutRef.current) clearTimeout(preloadTimeoutRef.current);
      }
      setIsPlaying(false);
    } else {
      // PLAY / RESUME
      if (readerMode === ReaderMode.NATIVE_TTS) {
        if (synthRef.current.paused) {
           synthRef.current.resume();
        } else {
           // Start fresh if stopped
           prepareNativeTTS(textContent, true, currentTextOffsetRef.current);
        }
      } else if (readerMode === ReaderMode.GEMINI_TTS) {
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume();
        } 
        else {
           // Recover if no source
           if(audioBufferRef.current && !audioSourceRef.current && pdfDoc) {
               playAudioBuffer(audioBufferRef.current, currentPageNum, pdfDoc);
           } 
           else if (!audioBufferRef.current && textContent) {
               console.log("Buffer missing on play, regenerating...");
               await handleGeminiTTS(textContent, currentPageNum);
           }
        }
      }
      setIsPlaying(true);
    }
  };

  // --- Audio Logic: Speed ---
  const handleRateChange = (rate: number) => {
    setPlaybackRate(rate);
    
    if (readerMode === ReaderMode.NATIVE_TTS && isPlaying) {
      if (synthRef.current.speaking) {
        synthRef.current.cancel();
        const resumeIndex = lastKnownCharIndexRef.current;
        currentTextOffsetRef.current = resumeIndex;
        prepareNativeTTS(textContent, true, resumeIndex);
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
      setIsTextScanned(false); 
      prepareNativeTTS(text, false);
    } catch (err) {
      setError("OCR Failed. Please check your API Key or network.");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
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
        
        {/* IMMERSIVE OVERLAY for AI Generation */}
        {isGeneratingAI && <WaitingOverlay />}

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
            <div className="shadow-2xl border border-gray-300 bg-white transition-all duration-300 ease-in-out origin-top h-fit">
               <canvas ref={canvasRef} className="block max-w-full h-auto" />
               
               {/* Standard Spinner for Page Rendering (Not AI Gen) */}
               {isLoading && !isGeneratingAI && (
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
           <div className="p-4 border-b border-gray-100 bg-gray-50 flex justify-between items-center">
              <h2 className="font-semibold text-gray-700 text-sm uppercase tracking-wider">Text View</h2>
              {readerMode === ReaderMode.GEMINI_TTS && isPlaying && (
                 <span className="text-xs text-purple-600 bg-purple-100 px-2 py-1 rounded animate-pulse">AI Voice Active</span>
              )}
           </div>
           <div className="flex-1 overflow-y-auto p-6 relative">
              {textContent ? (
                <HighlightableText 
                  text={textContent} 
                  currentInfo={{ 
                    charIndex: highlightIndex, 
                    isActive: isPlaying && readerMode === ReaderMode.NATIVE_TTS 
                  }} 
                />
              ) : (
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
          onPageChange={(n) => {
            autoPlayRef.current = false; 
            setCurrentPageNum(n);
          }}
          isPlaying={isPlaying}
          onPlayPause={togglePlayPause}
          playbackRate={playbackRate}
          onRateChange={handleRateChange}
          mode={readerMode}
          hasText={!!textContent && !isTextScanned}
          isProcessing={isLoading || isGeneratingAI}
          onUseGeminiTTS={() => handleGeminiTTS(textContent, currentPageNum)}
          onOCR={handleOCR}
          extractedText={textContent}
        />
      )}
    </div>
  );
};

export default App;