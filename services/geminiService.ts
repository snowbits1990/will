import { GoogleGenAI, Modality } from "@google/genai";

const getAI = () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) throw new Error("API Key not found");
    return new GoogleGenAI({ apiKey });
}

/**
 * Helper: Decodes base64 string to Uint8Array
 */
const decodeBase64 = (base64: string): Uint8Array => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

/**
 * Helper: Converts Raw PCM (Int16) data to AudioBuffer
 * Gemini returns raw PCM data (16-bit signed integer), not a WAV/MP3 file.
 * We must manually convert this to Float32 for the Web Audio API.
 */
const pcmToAudioBuffer = (
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number = 24000,
  numChannels: number = 1
): AudioBuffer => {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      // Convert Int16 (-32768 to 32767) to Float32 (-1.0 to 1.0)
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
};

/**
 * Generates Speech using Gemini 2.5 Flash TTS
 */
export const generateSpeech = async (text: string): Promise<AudioBuffer> => {
  const ai = getAI();
  
  // Truncate text to avoid timeouts or token limits for a single generation request
  const safeText = text.substring(0, 2000); 

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

  // Decode base64 to raw binary
  const pcmData = decodeBase64(base64Audio);

  // Use a temporary context to create the buffer. 
  // The sample rate here (24000) MUST match the model's output.
  const tempCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  const buffer = pcmToAudioBuffer(pcmData, tempCtx, 24000);
  
  // We don't need to keep tempCtx open, we just needed its factory method
  if (tempCtx.state !== 'closed') {
      tempCtx.close().catch(() => {}); 
  }
  
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