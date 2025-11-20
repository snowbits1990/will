import { GoogleGenAI, Modality } from "@google/genai";

const getAI = () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) throw new Error("API Key not found");
    return new GoogleGenAI({ apiKey });
}

/**
 * Decodes base64 audio string to AudioBuffer
 */
const decodeAudioData = async (
  base64Data: string,
  ctx: AudioContext
): Promise<AudioBuffer> => {
  const binaryString = atob(base64Data);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  // decodeAudioData requires array buffer
  return await ctx.decodeAudioData(bytes.buffer);
};

/**
 * Generates Speech using Gemini 2.5 Flash TTS
 */
export const generateSpeech = async (text: string): Promise<AudioBuffer> => {
  const ai = getAI();
  
  // Truncate if too long for a single request to avoid errors, though models handle large context.
  // For a real app, chunking logic would be here.
  const safeText = text.substring(0, 4000); 

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: `Read this text clearly and naturally: ${safeText}` }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Fenrir' }, // Options: Puck, Charon, Kore, Fenrir, Zephyr
        },
      },
    },
  });

  const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

  if (!base64Audio) {
    throw new Error("No audio data returned from Gemini");
  }

  // Use a temporary context to decode, the player will use its own context/node
  const tempCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const buffer = await decodeAudioData(base64Audio, tempCtx);
  tempCtx.close();
  
  return buffer;
};

/**
 * Performs OCR on a scanned PDF page image
 */
export const performOCR = async (imageBase64: string): Promise<string> => {
  const ai = getAI();
  
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: {
      parts: [
        {
            inlineData: {
                mimeType: 'image/jpeg',
                data: imageBase64
            }
        },
        {
            text: "Extract all readable text from this document page. Output ONLY the text content. Preserve the paragraph structure."
        }
      ]
    }
  });

  return response.text || "Could not extract text.";
};