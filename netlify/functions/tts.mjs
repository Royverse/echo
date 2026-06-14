// Serverless TTS proxy: returns Gemini neural audio (base64 PCM) for the client
// to wrap into a WAV. Key stays server-side.
import { BASE, TTS_MODEL, json } from './_gemini.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json({ error: 'Server is missing its API key.' }, 500);

  let text = '';
  let voice = 'Puck';
  try { ({ text, voice = 'Puck' } = await req.json()); } catch { /* ignore */ }
  if (!text || !text.trim()) return json({ error: 'No text' }, 400);

  try {
    const res = await fetch(`${BASE}/${TTS_MODEL}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    const part = data.candidates?.[0]?.content?.parts?.[0];
    const audioBase64 = part?.inlineData?.data;
    if (!audioBase64) throw new Error('No audio returned');
    const mimeType = part.inlineData.mimeType || 'audio/L16;codec=pcm;rate=24000';
    return json({ audioBase64, mimeType });
  } catch (err) {
    console.error('tts function error:', err);
    return json({ error: String(err.message || err) }, 502);
  }
};
