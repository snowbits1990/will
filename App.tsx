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
  const playbackRateRef = useRef(1.0);
  
  // Persistence & Caching Refs
  const previousModeRef = useRef<ReaderMode>(ReaderMode.IDLE); 
  // Changed from single object to a Map to store multiple pages
  const audioCacheRef = useRef<Map<number, AudioBuffer>>(new Map());
  // Track which pages are currently being fetched to avoid duplicate requests
  const activeFetchSetRef = useRef<Set<number>>(new Set());
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

  // Sync playbackRate state to Ref for stable access in callbacks
  useEffect(() => {
    playbackRateRef.current = playbackRate;
  }, [playbackRate]);

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
    
    // Clear caches
    audioCacheRef.current.clear();
    activeFetchSetRef.current.clear();
    
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
    utterance.rate = playbackRateRef.current; // Use Ref to avoid dependency chain
    
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
  }, []); // Dependencies removed to keep processPage stable

  // --- Smart Preloading Logic (Multi-page) ---
  const runSmartCaching = useCallback(async (startFromPage: number, doc: PDFDocumentProxy) => {
    const CACHE_LIMIT = 5; // Cache up to 5 pages ahead

    // We loop sequentially to avoid hammering the API with 5 simultaneous requests
    // This ensures a steady stream without network congestion.
    for (let i = 0; i < CACHE_LIMIT; i++) {
      const targetPage = startFromPage + i;

      // Stop if we reach end of doc
      if (targetPage > doc.numPages) break;

      // Optimization: If user stopped playing, we might want to stop caching to save credits/resources.
      // However, keeping a small buffer is good. Let's check if mode changed.
      if (previousModeRef.current !== ReaderMode.GEMINI_TTS) break;

      // Skip if already cached
      if (audioCacheRef.current.has(targetPage)) {
        continue;
      }

      // Skip if currently being fetched
      if (activeFetchSetRef.current.has(targetPage)) {
        continue;
      }

      try {
        activeFetchSetRef.current.add(targetPage);
        console.log(`[SmartCache] Prefetching page ${targetPage}...`);

        const page = await doc.getPage(targetPage);
        const extracted = await extractTextFromPage(page, targetPage);
        const cleanText = extracted.text.replace(/\s+/g, ' ').trim();

        // If text is empty or scanned, we can't generate audio, so we skip storing audio
        if (!cleanText || extracted.isScanned) {
          console.log(`[SmartCache] Page ${targetPage} empty/scanned. Skipping audio generation.`);
        } else {
          // Generate Audio
          const buffer = await generateSpeech(cleanText);
          
          // Store in Map
          audioCacheRef.current.set(targetPage, buffer);
          console.log(`[SmartCache] Successfully cached audio for page ${targetPage}`);
        }
      } catch (err) {
        console.warn(`[SmartCache] Failed to cache page ${targetPage}`, err);
      } finally {
        activeFetchSetRef.current.delete(targetPage);
      }
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
    source.playbackRate.value = playbackRateRef.current; // Use Ref
    source.connect(audioContextRef.current.destination);
    
    source.onended = () => {
      audioSourceRef.current = null;
      // Always call the ref to ensure we use the latest logic/state
      onAudioEndedRef.current(); 
    };

    audioSourceRef.current = source;
    source.start(0);

    // --- Preload Logic Trigger ---
    if (pageForAudio < doc.numPages) {
      const duration = buffer.duration; 
      // Trigger preload at 20% progress
      const currentRate = playbackRateRef.current || 1;
      const estimatedDelay = (duration * 1000 * 0.2) / currentRate;
      
      console.log(`Scheduled smart caching starting from page ${pageForAudio + 1} in ${estimatedDelay.toFixed(0)}ms`);
      
      if (preloadTimeoutRef.current) clearTimeout(preloadTimeoutRef.current);
      
      preloadTimeoutRef.current = setTimeout(() => {
        // Start caching sequence for next 5 pages
        runSmartCaching(pageForAudio + 1, doc);
      }, estimatedDelay);
    }
  }, [runSmartCaching]); // Dependencies removed to keep processPage stable

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
      
      // Check for valid text content
      const hasContent = cleanText.length > 0 && !extracted.isScanned;

      if (!hasContent) {
        setIsTextScanned(extracted.isScanned);
        setReaderMode(ReaderMode.IDLE);
        setIsLoading(false);

        // AUTO SKIP Logic: If playing, skip to next page if available
        if (autoPlayRef.current && pageNum < doc.numPages) {
            console.log(`[AutoPlay] Page ${pageNum} has no readable content. Skipping to next...`);
            setCurrentPageNum(prev => prev + 1);
        }
        return;
      }
      
      // If we have content
      setIsTextScanned(false);
        
      // --- Auto Play Logic with Cache Check ---
      if (autoPlayRef.current) {
        console.log(`Auto-play triggered for page ${pageNum}. Mode: ${previousModeRef.current}`);
        
        if (previousModeRef.current === ReaderMode.GEMINI_TTS) {
          // Check if we have this page in the multi-page cache
          if (audioCacheRef.current.has(pageNum)) {
              console.log(`[Cache] Hit for Page ${pageNum}! Playing preloaded audio.`);
              const cachedBuffer = audioCacheRef.current.get(pageNum)!;
              
              // Remove used page from cache to free memory
              audioCacheRef.current.delete(pageNum);
              
              setReaderMode(ReaderMode.GEMINI_TTS);
              audioBufferRef.current = cachedBuffer;
              playAudioBuffer(cachedBuffer, pageNum, doc);
              setIsPlaying(true);
              setIsLoading(false); 
          } else {
              console.log(`[Cache] Miss for Page ${pageNum}. Generating fresh.`);
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
    playbackRateRef.current = rate; // Immediate update for synchronous calls
    
    if (readerMode === ReaderMode.NATIVE_TTS && isPlaying) {
      if (synthRef.current.speaking) {
        synthRef.current.cancel();
        const resumeIndex = lastKnownCharIndexRef.current;
        currentTextOffsetRef.current = resumeIndex;
        prepareNativeTTS(textContent, true, resumeIndex);
      }
    } else if (readerMode === ReaderMode.GEMINI_TTS) {
        if (audioSourceRef.current) {
            // Apply smooth speed change without restarting
            try {
              audioSourceRef.current.playbackRate.setValueAtTime(rate, audioContextRef.current?.currentTime || 0);
            } catch(e) {
              // Fallback just in case
              audioSourceRef.current.playbackRate.value = rate;
            }
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