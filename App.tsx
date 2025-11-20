import React, { useState, useRef, useEffect, useCallback } from 'react';
import { FileUp, AlertCircle } from 'lucide-react';
import { loadPDF, renderPageToCanvas, extractTextFromPage, getCanvasAsBase64 } from './services/pdfService';
import { generateSpeech, performOCR } from './services/geminiService';
import { PDFDocumentProxy, PDFPageProxy, ReaderMode } from './types';
import ControlBar from './components/ControlBar';
import { Spinner } from './components/Spinner';
import { HighlightableText } from './components/HighlightableText';

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
  const [highlightIndex, setHighlightIndex] = useState(0); // Current char index for highlighting relative to FULL text

  // Logic Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoPlayRef = useRef<boolean>(false); // Should we auto-play when the next page loads?
  
  // Persistence & Caching Refs
  const previousModeRef = useRef<ReaderMode>(ReaderMode.IDLE); 
  const nextPageAudioCacheRef = useRef<{ page: number; buffer: AudioBuffer } | null>(null);
  const preloadTimeoutRef = useRef<any>(null);

  // Native Audio Refs
  const synthRef = useRef<SpeechSynthesis>(window.speechSynthesis);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  // Tracks where we started the current utterance relative to the whole page text.
  // This is crucial for resuming playback mid-page when changing speed.
  const currentTextOffsetRef = useRef<number>(0); 
  const lastKnownCharIndexRef = useRef<number>(0); // Tracks precise current position for pause/resume logic

  // Gemini Audio Context Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null); // Current page buffer
  const audioStartTimeRef = useRef<number>(0); // When the current source started playing

  // --- Initialization ---
  useEffect(() => {
    // Cleanup on unmount
    return () => {
      stopAllAudio();
      if (preloadTimeoutRef.current) clearTimeout(preloadTimeoutRef.current);
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

  // --- Preloading Logic (The "50%" Thread) ---
  const preloadNextPageAudio = useCallback(async (nextPageNum: number, doc: PDFDocumentProxy) => {
    if (nextPageNum > doc.numPages) return;
    if (nextPageAudioCacheRef.current?.page === nextPageNum) return; // Already cached

    console.log(`[Cache] Starting background preload for page ${nextPageNum}...`);
    try {
      // 1. Get Text without rendering canvas (pure data extraction)
      const page = await doc.getPage(nextPageNum);
      const extracted = await extractTextFromPage(page, nextPageNum);
      const cleanText = extracted.text.replace(/\s+/g, ' ').trim();

      if (!cleanText || extracted.isScanned) {
        console.log(`[Cache] Page ${nextPageNum} is empty or scanned. Skipping audio preload.`);
        return;
      }

      // 2. Generate Audio
      const buffer = await generateSpeech(cleanText);
      
      // 3. Store in Cache
      nextPageAudioCacheRef.current = {
        page: nextPageNum,
        buffer: buffer
      };
      console.log(`[Cache] Successfully preloaded audio for page ${nextPageNum}`);
      
    } catch (err) {
      console.warn("[Cache] Background preload failed:", err);
      // Silent fail is okay for preload, we'll just load normally when user gets there
    }
  }, []);

  // --- Page Rendering & Text Extraction ---
  const processPage = useCallback(async (pageNum: number, doc: PDFDocumentProxy) => {
    if (!canvasRef.current) return;

    setIsLoading(true);
    // Stop audio from PREVIOUS page.
    stopAllAudio();
    
    // Reset tracking refs for the new page
    setHighlightIndex(0);
    currentTextOffsetRef.current = 0;
    lastKnownCharIndexRef.current = 0;
    setTextContent('');
    setIsTextScanned(false);
    
    try {
      const page: PDFPageProxy = await doc.getPage(pageNum);
      await renderPageToCanvas(page, canvasRef.current);
      
      const extracted = await extractTextFromPage(page, pageNum);
      const cleanText = extracted.text.replace(/\s+/g, ' ').trim();
      setTextContent(cleanText);
      
      if (extracted.isScanned) {
        setIsTextScanned(true);
        setReaderMode(ReaderMode.IDLE);
      } else {
        setIsTextScanned(false);
        
        // --- Auto Play Logic with Cache Check ---
        if (autoPlayRef.current && cleanText.length > 0) {
          console.log(`Auto-play triggered for page ${pageNum}. Mode: ${previousModeRef.current}`);
          
          if (previousModeRef.current === ReaderMode.GEMINI_TTS) {
            // CHECK CACHE FIRST
            if (nextPageAudioCacheRef.current?.page === pageNum) {
                console.log("[Cache] Hit! Playing preloaded audio.");
                const cachedBuffer = nextPageAudioCacheRef.current.buffer;
                
                // Clear cache to free memory after consuming
                nextPageAudioCacheRef.current = null;
                
                // Need to set mode and play
                setReaderMode(ReaderMode.GEMINI_TTS);
                audioBufferRef.current = cachedBuffer;
                playAudioBuffer(cachedBuffer, pageNum, doc);
                setIsLoading(false); // Done immediately
                return; // Exit early
            } else {
                console.log("[Cache] Miss. Generating fresh.");
                handleGeminiTTS(cleanText); 
            }
          } else {
            // Native Auto Play
            prepareNativeTTS(cleanText, true);
          }
        } else {
           // Just load text, don't play
           // If we were playing native before, we usually reset to beginning of page anyway
           prepareNativeTTS(cleanText, false);
        }
      }

    } catch (err) {
      console.error(err);
      setError('Error rendering page.');
    } finally {
      if (previousModeRef.current !== ReaderMode.GEMINI_TTS || !autoPlayRef.current) {
          setIsLoading(false);
      }
    }
  }, []); 

  useEffect(() => {
    if (pdfDoc) {
      processPage(currentPageNum, pdfDoc);
    }
  }, [pdfDoc, currentPageNum, processPage]);

  // --- Handle Page Turn on Audio End ---
  const handleAudioEnd = () => {
    if (pdfDoc && currentPageNum < pdfDoc.numPages) {
      console.log("Audio ended, advancing to next page...");
      autoPlayRef.current = true;
      // previousModeRef.current is already set when we started playing
      setCurrentPageNum(prev => prev + 1);
    } else {
      setIsPlaying(false);
      setReaderMode(ReaderMode.IDLE);
      setHighlightIndex(0);
      currentTextOffsetRef.current = 0;
    }
  };

  // --- Audio Logic: Native ---
  const prepareNativeTTS = (text: string, autoStart: boolean = false, startOffset: number = 0) => {
    if (!text) return;
    
    // Cancel any existing speech
    synthRef.current.cancel();

    // If we are restarting middle of page, we slice the text
    // But we need to map the boundary indices back to the full text
    const textToSpeak = startOffset > 0 ? text.substring(startOffset) : text;

    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.rate = playbackRate;
    
    utterance.onboundary = (event) => {
      if (event.name === 'word' || event.name === 'sentence') {
        // Accurate global index = Offset + Current Utterance Index
        const globalIndex = startOffset + event.charIndex;
        setHighlightIndex(globalIndex);
        lastKnownCharIndexRef.current = globalIndex;
      }
    };

    utterance.onend = () => {
      // Only advance if we reached the end of the FULL text, not just a segment
      // Actually onend fires when the specific utterance finishes. 
      // Since we speak to the end of the string, this is fine.
      handleAudioEnd();
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
        // Clear preload timeout on pause to save resources/logic
        if (preloadTimeoutRef.current) clearTimeout(preloadTimeoutRef.current);
      }
      setIsPlaying(false);
    } else {
      // PLAY logic
      if (readerMode === ReaderMode.NATIVE_TTS) {
        if (synthRef.current.paused) {
           synthRef.current.resume();
        } else {
           // Start fresh
           prepareNativeTTS(textContent, true, 0);
        }
      } else if (readerMode === ReaderMode.GEMINI_TTS) {
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume();
        } else {
           if(audioBufferRef.current && !audioSourceRef.current) {
               // Resume from start of buffer (Gemini doesn't support seek easily without complexities)
               // For V1, replaying page is safer, or we assume suspend/resume handled it.
               playAudioBuffer(audioBufferRef.current, currentPageNum, pdfDoc!);
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
      // Smart Restart Logic for Native TTS
      if (synthRef.current.speaking) {
        synthRef.current.cancel();
        
        // Use the last known character index as the new offset
        // We back up slightly (e.g. 50 chars) or to the start of the last sentence to make it sound natural?
        // For now, strict resume is requested.
        const resumeIndex = lastKnownCharIndexRef.current;
        currentTextOffsetRef.current = resumeIndex;

        console.log(`Changing speed to ${rate}x. Resuming from index ${resumeIndex}`);
        prepareNativeTTS(textContent, true, resumeIndex);
      }
    } else if (readerMode === ReaderMode.GEMINI_TTS) {
        // Web Audio API allows dynamic rate change without restart
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

  const handleGeminiTTS = async (textToRead?: string) => {
    const targetText = textToRead || textContent;
    
    if (!targetText) {
      setError("No text content to read.");
      return;
    }
    
    // Set mode immediately so UI updates
    setReaderMode(ReaderMode.GEMINI_TTS);
    previousModeRef.current = ReaderMode.GEMINI_TTS;
    setIsLoading(true);
    stopAllAudio(); 
    
    try {
      const buffer = await generateSpeech(targetText);
      console.log("Gemini TTS Audio Generated successfully.");
      
      audioBufferRef.current = buffer;
      if (pdfDoc) {
        playAudioBuffer(buffer, currentPageNum, pdfDoc);
      }
      setIsPlaying(true);

    } catch (err: any) {
      setError(`Failed to generate AI speech: ${err.message}`);
      console.error("Gemini TTS Error:", err);
      // Fallback
      console.log("Falling back to native TTS");
      prepareNativeTTS(targetText, true);
    } finally {
      setIsLoading(false);
    }
  };

  const playAudioBuffer = (buffer: AudioBuffer, currentPage: number, doc: PDFDocumentProxy) => {
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
      handleAudioEnd(); 
    };

    audioSourceRef.current = source;
    source.start(0);

    // --- Preload Logic ---
    // Schedule preloading of next page when this one is 50% done.
    if (currentPage < doc.numPages) {
      const duration = buffer.duration; // in seconds
      // We want to trigger at 50%. 
      // Note: Changing playbackRate changes *actual* time, but setTimeout uses wall clock.
      // Roughly, if speed is 1.0, wait duration/2.
      // If speed is 2.0, we should wait duration/4. 
      // Let's use current rate estimate.
      const estimatedDelay = (duration * 1000) / 2 / playbackRate;
      
      console.log(`Scheduled cache preload for page ${currentPage + 1} in ${estimatedDelay.toFixed(0)}ms`);
      
      if (preloadTimeoutRef.current) clearTimeout(preloadTimeoutRef.current);
      
      preloadTimeoutRef.current = setTimeout(() => {
        preloadNextPageAudio(currentPage + 1, doc);
      }, estimatedDelay);
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
            autoPlayRef.current = false; // Disable auto-play on manual turn
            setCurrentPageNum(n);
          }}
          isPlaying={isPlaying}
          onPlayPause={togglePlayPause}
          playbackRate={playbackRate}
          onRateChange={handleRateChange}
          mode={readerMode}
          hasText={!!textContent && !isTextScanned}
          isProcessing={isLoading}
          onUseGeminiTTS={() => handleGeminiTTS()}
          onOCR={handleOCR}
          extractedText={textContent}
        />
      )}
    </div>
  );
};

export default App;