import React, { useEffect, useState, useRef } from 'react';
import { quotes } from '../data/quotes';
import { Music, Sparkles } from 'lucide-react';

// Using a reliable source for Gymnopédie No.1.
const MUSIC_URL = "https://upload.wikimedia.org/wikipedia/commons/3/34/Erik_Satie_-_Gymnop%C3%A9die_No._1.mp3";

export const WaitingOverlay: React.FC = () => {
  const [currentQuoteIndex, setCurrentQuoteIndex] = useState(0);
  const [fadeIn, setFadeIn] = useState(true);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // Rotate quotes every 15 seconds
  useEffect(() => {
    // Randomize initial quote
    setCurrentQuoteIndex(Math.floor(Math.random() * quotes.length));

    const interval = setInterval(() => {
      setFadeIn(false); // Start fade out
      
      setTimeout(() => {
        setCurrentQuoteIndex((prev) => (prev + 1) % quotes.length);
        setFadeIn(true); // Fade in new quote
      }, 1000); // Wait for fade out to finish

    }, 15000);

    return () => clearInterval(interval);
  }, []);

  // Handle Audio
  const tryPlayMusic = () => {
    const audio = audioRef.current;
    if (!audio || isPlaying) return;
    
    audio.volume = 0; 
    audio.play()
      .then(() => {
        setIsPlaying(true);
        // Fade in
        let vol = 0;
        const fadeInterval = setInterval(() => {
          if (vol < 0.5) { 
            vol += 0.05; 
            audio.volume = Math.min(vol, 1);
          } else {
            clearInterval(fadeInterval);
          }
        }, 200);
      })
      .catch(e => console.log("Waiting for interaction", e));
  };

  useEffect(() => {
    // Try auto-play on mount
    tryPlayMusic();

    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
      }
    };
  }, []);

  const quote = quotes[currentQuoteIndex];

  return (
    <div 
      onClick={tryPlayMusic}
      className="absolute inset-0 z-50 flex flex-col items-center justify-center overflow-hidden bg-slate-900/80 backdrop-blur-xl transition-all duration-700 cursor-pointer"
    >
      
      {/* Audio Element */}
      <audio ref={audioRef} src={MUSIC_URL} loop preload="auto" />

      {/* Decorative Elements */}
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden z-0 opacity-20 pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-500 rounded-full mix-blend-multiply filter blur-3xl animate-pulse"></div>
        <div className="absolute bottom-1/3 right-1/4 w-96 h-96 bg-purple-500 rounded-full mix-blend-multiply filter blur-3xl animate-pulse" style={{ animationDelay: '2s' }}></div>
      </div>

      <div className="z-10 max-w-4xl px-8 text-center pointer-events-none">
        {/* Animated Icon */}
        <div className="mb-12 flex justify-center">
          <div className="relative">
            <div className="absolute inset-0 bg-white/20 rounded-full blur-xl animate-pulse"></div>
            <div className="relative bg-white/10 p-4 rounded-full border border-white/20 shadow-2xl backdrop-blur-md">
               <Sparkles className="text-amber-300 w-12 h-12 animate-spin-slow" style={{ animationDuration: '8s' }} />
            </div>
          </div>
        </div>

        {/* Quote Container */}
        <div className={`transition-opacity duration-1000 ease-in-out transform ${fadeIn ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'}`}>
          <blockquote className="text-2xl md:text-4xl font-serif font-medium text-white leading-relaxed tracking-wide drop-shadow-lg">
            "{quote.text}"
          </blockquote>
          <div className="mt-8 flex items-center justify-center space-x-3">
             <div className="h-px w-12 bg-indigo-300/50"></div>
             <cite className="text-indigo-200 font-medium text-xl not-italic tracking-wider">
               {quote.author}
             </cite>
             <div className="h-px w-12 bg-indigo-300/50"></div>
          </div>
        </div>

        {/* Status Text */}
        <div className="mt-20 flex flex-col items-center justify-center space-y-2 text-white/60 font-light text-sm tracking-widest">
          <div className="flex items-center space-x-2 uppercase">
            <Music size={14} className={isPlaying ? "animate-bounce" : ""} />
            <span>正在生成 AI 语音体验...</span>
          </div>
          {!isPlaying && (
             <span className="text-xs opacity-70 animate-pulse font-normal text-indigo-200 border border-indigo-200/30 px-2 py-1 rounded-full bg-indigo-500/10">
               (点击屏幕任意处开启背景音乐)
             </span>
          )}
        </div>
      </div>
    </div>
  );
};