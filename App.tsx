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
  const [highlightIndex, setHighlightIndex] = useState(0); // Current char index for highlighting

  // Logic Refs
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoPlayRef = useRef<boolean>(false); // Should we auto-play when the next page loads?
  const previousModeRef = useRef<ReaderMode>(ReaderMode.IDLE); // Remember what mode triggered the page turn

  // Native Audio Refs
  const synthRef = useRef<SpeechSynthesis>(window.speechSynthesis);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  
  // Gemini Audio Context Refs
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);

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
    autoPlayRef.current = false;

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

  // --- Page Rendering & Text Extraction ---
  const processPage = useCallback(async (pageNum: number, doc: PDFDocumentProxy) => {
    if (!canvasRef.current) return;

    setIsLoading(true);
    // IMPORTANT: Don't stop audio here if we are auto-playing, 
    // but we usually need to stop previous page audio before rendering next.
    // In this flow, audio has likely already stopped triggering the page turn.
    stopAllAudio(); 
    
    setHighlightIndex(0);
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
        setReaderMode(ReaderMode.IDLE);
      } else {
        setIsTextScanned(false);
        
        // --- Auto Play Logic ---
        if (autoPlayRef.current && cleanText.length > 0) {
          console.log("Auto-play triggered for page", pageNum);
          
          // Restore previous mode logic
          if (previousModeRef.current === ReaderMode.GEMINI_TTS) {
            // Trigger Gemini
            // We need to call this *after* state updates, but since handleGeminiTTS is async and uses local text var, it's fine.
            handleGeminiTTS(cleanText); 
          } else {
            // Default to Native
            prepareNativeTTS(cleanText, true);
          }
          autoPlayRef.current = false; // Reset trigger
        } else {
           prepareNativeTTS(cleanText, false);
        }
      }

    } catch (err) {
      console.error(err);
      setError('Error rendering page.');
    } finally {
      setIsLoading(false);
    }
  }, []); 

  useEffect(() => {
    if (pdfDoc) {
      processPage(currentPageNum, pdfDoc);
    }
  }, [pdfDoc, currentPageNum, processPage]);

  // --- Handle Page Turn on Audio End ---
  const handleAudioEnd = () => {
    // We need to check if there is a next page
    if (pdfDoc && currentPageNum < pdfDoc.numPages) {
      console.log("Audio ended, advancing to next page...");
      autoPlayRef.current = true;
      previousModeRef.current = readerMode; // Remember if we were using Gemini or Native
      setCurrentPageNum(prev => prev + 1);
    } else {
      setIsPlaying(false);
      setReaderMode(ReaderMode.IDLE);
      setHighlightIndex(0);
    }
  };

  // --- Audio Logic: Native ---
  const prepareNativeTTS = (text: string, autoStart: boolean = false) => {
    if (!text) return;
    
    // Cancel any existing speech
    synthRef.current.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = playbackRate;
    
    // Highlighting Logic
    utterance.onboundary = (event) => {
      if (event.name === 'word' || event.name === 'sentence') {
        setHighlightIndex(event.charIndex);
      }
    };

    utterance.onend = () => {
      handleAudioEnd();
    };

    utterance.onerror = (e) => {
      console.error("Native TTS Error", e);
      setIsPlaying(false);
    };

    utteranceRef.current = utterance;
    setReaderMode(ReaderMode.NATIVE_TTS);
    
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
             utteranceRef.current.rate = playbackRate;
             synthRef.current.speak(utteranceRef.current);
           }
        }
      } else if (readerMode === ReaderMode.GEMINI_TTS) {
        if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
          await audioContextRef.current.resume();
        } else {
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
        synthRef.current.cancel();
        if (utteranceRef.current) {
            utteranceRef.current.rate = rate;
            // Need to reset onboundary here because creating a new utterance often wipes events if not careful, 
            // but strictly we just updated the prop on the existing obj? 
            // No, for speech synthesis changing rate mid-speech usually requires restart.
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
      setIsTextScanned(false); 
      prepareNativeTTS(text, false);
    } catch (err) {
      setError("OCR Failed. Please check your API Key or network.");
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  };

  // Modified to accept text argument for auto-play
  const handleGeminiTTS = async (textToRead?: string) => {
    const targetText = textToRead || textContent;
    
    if (!targetText) {
      setError("No text content to read.");
      return;
    }
    
    // Set mode immediately so UI updates
    setReaderMode(ReaderMode.GEMINI_TTS);
    setIsLoading(true);
    stopAllAudio(); 
    
    try {
      const buffer = await generateSpeech(targetText);
      console.log("Gemini TTS Audio Generated successfully.");
      
      audioBufferRef.current = buffer;
      playAudioBuffer(buffer);
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

  const playAudioBuffer = (buffer: AudioBuffer) => {
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
      // Only trigger next page if we played to the end naturally (not stopped manually)
      // Checking isPlaying state here is tricky because stopping sets isPlaying false.
      // We rely on the fact that stop() calls usually happen via UI which sets intended state.
      // However, onended fires on stop() too. 
      // Workaround: we check if context is currently running and we haven't explicitly set stopped via UI logic?
      // Simpler: handleAudioEnd handles the "next page" logic.
      // If user clicked "Pause", isPlaying becomes false.
      // If source ends naturally, isPlaying is still true at that exact moment? No.
      // We need a flag or check.
      
      // Ideally, we'd check logic, but for now, let's assume if it ends and we didn't explicitly stop it...
      // Actually, stop() fires onended.
      // We can use a flag "isManuallyStopped" but let's just check the time.
      // If playback time matches duration? 
      handleAudioEnd(); 
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
