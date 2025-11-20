import React, { useMemo, useEffect, useRef } from 'react';

interface HighlightableTextProps {
  text: string;
  currentInfo: {
    charIndex: number; // Current character index being spoken
    isActive: boolean; // Whether TTS is currently active
  };
}

interface SentenceSegment {
  text: string;
  start: number;
  end: number;
}

export const HighlightableText: React.FC<HighlightableTextProps> = ({ text, currentInfo }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLSpanElement>(null);

  // Split text into sentences with their index ranges
  const segments = useMemo(() => {
    if (!text) return [];
    
    // Split by punctuation (.!?) followed by space or newline, capturing the delimiter
    // This regex keeps the delimiter with the sentence
    const regex = /([.!?]+[\s\n]+)/; 
    const parts = text.split(regex);
    
    const results: SentenceSegment[] = [];
    let currentIndex = 0;

    // Reassemble the split parts into coherent sentences
    // The split output alternates between [sentence_body, delimiter, sentence_body, delimiter...]
    for (let i = 0; i < parts.length; i += 2) {
      let sentence = parts[i];
      const delimiter = parts[i + 1] || ''; // Append delimiter if it exists
      
      const fullSentence = sentence + delimiter;
      if (!fullSentence.trim()) continue;

      results.push({
        text: fullSentence,
        start: currentIndex,
        end: currentIndex + fullSentence.length
      });
      currentIndex += fullSentence.length;
    }
    return results;
  }, [text]);

  // Auto-scroll to the active sentence
  useEffect(() => {
    if (currentInfo.isActive && activeRef.current && containerRef.current) {
      activeRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      });
    }
  }, [currentInfo.charIndex, currentInfo.isActive]);

  if (!text) {
    return <span className="italic text-gray-400">Waiting for text...</span>;
  }

  return (
    <div ref={containerRef} className="text-gray-700 leading-relaxed font-serif text-lg whitespace-pre-wrap">
      {segments.map((segment, idx) => {
        // Check if current char index falls within this segment
        const isCurrent = currentInfo.isActive && 
                          currentInfo.charIndex >= segment.start && 
                          currentInfo.charIndex < segment.end;
        
        return (
          <span 
            key={idx} 
            ref={isCurrent ? activeRef : null}
            className={`transition-colors duration-200 rounded px-1 -mx-1 ${
              isCurrent ? 'bg-yellow-200 text-gray-900 shadow-sm font-medium' : ''
            }`}
          >
            {segment.text}
          </span>
        );
      })}
    </div>
  );
};
