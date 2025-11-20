import React from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, BrainCircuit, ScanText } from 'lucide-react';
import { ReaderMode } from '../types';

interface ControlBarProps {
  pageNumber: number;
  totalPages: number;
  onPageChange: (newPage: number) => void;
  isPlaying: boolean;
  onPlayPause: () => void;
  playbackRate: number;
  onRateChange: (rate: number) => void;
  mode: ReaderMode;
  hasText: boolean;
  isProcessing: boolean;
  onUseGeminiTTS: () => void;
  onOCR: () => void;
  extractedText: string;
}

const ControlBar: React.FC<ControlBarProps> = ({
  pageNumber,
  totalPages,
  onPageChange,
  isPlaying,
  onPlayPause,
  playbackRate,
  onRateChange,
  mode,
  hasText,
  isProcessing,
  onUseGeminiTTS,
  onOCR,
  extractedText
}) => {
  return (
    <div className="bg-white border-t border-gray-200 p-4 shadow-lg flex flex-col md:flex-row items-center justify-between gap-4 z-10">
      
      {/* Page Navigation */}
      <div className="flex items-center space-x-4">
        <button 
          onClick={() => onPageChange(pageNumber - 1)}
          disabled={pageNumber <= 1 || isProcessing}
          className="p-2 rounded-full hover:bg-gray-100 disabled:opacity-50"
        >
          <SkipBack size={20} />
        </button>
        <span className="text-sm font-medium text-gray-600">
          Page {pageNumber} of {totalPages}
        </span>
        <button 
          onClick={() => onPageChange(pageNumber + 1)}
          disabled={pageNumber >= totalPages || isProcessing}
          className="p-2 rounded-full hover:bg-gray-100 disabled:opacity-50"
        >
          <SkipForward size={20} />
        </button>
      </div>

      {/* Playback Controls */}
      <div className="flex items-center space-x-6">
        {hasText ? (
          <>
             <div className="flex items-center bg-gray-100 rounded-full px-2 py-1">
                <button
                  onClick={onPlayPause}
                  disabled={isProcessing}
                  className={`p-3 rounded-full text-white shadow-md transition-all ${isPlaying ? 'bg-red-500 hover:bg-red-600' : 'bg-indigo-600 hover:bg-indigo-700'}`}
                >
                  {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}
                </button>
             </div>
            
            <div className="flex flex-col w-32">
              <div className="flex justify-between text-xs text-gray-500 mb-1">
                <span>Speed</span>
                <span>{playbackRate.toFixed(1)}x</span>
              </div>
              <input
                type="range"
                min="0.5"
                max="2.0"
                step="0.1"
                value={playbackRate}
                onChange={(e) => onRateChange(parseFloat(e.target.value))}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
              />
            </div>
          </>
        ) : (
          <div className="text-amber-600 text-sm font-medium flex items-center">
            <ScanText className="mr-2" size={16}/> No text detected
          </div>
        )}
      </div>

      {/* AI Features */}
      <div className="flex items-center space-x-3">
         {/* Fallback / OCR Button */}
         {!hasText && (
           <button
             onClick={onOCR}
             disabled={isProcessing}
             className="flex items-center space-x-2 px-4 py-2 bg-amber-100 text-amber-800 rounded-lg hover:bg-amber-200 transition disabled:opacity-50 text-sm font-medium"
           >
             <ScanText size={18} />
             <span>{isProcessing ? 'Scanning...' : 'AI OCR Scan'}</span>
           </button>
         )}

         {/* High Quality Audio Toggle */}
         {hasText && (
           <button
            onClick={onUseGeminiTTS}
            disabled={isProcessing || mode === ReaderMode.GEMINI_TTS}
            className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition text-sm font-medium border ${
              mode === ReaderMode.GEMINI_TTS 
              ? 'bg-purple-100 text-purple-800 border-purple-200 cursor-default' 
              : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
            }`}
           >
             <BrainCircuit size={18} />
             <span>{mode === ReaderMode.GEMINI_TTS ? 'Using Gemini Voice' : 'Switch to AI Voice'}</span>
           </button>
         )}
      </div>
    </div>
  );
};

export default ControlBar;