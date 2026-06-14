// Serverless NLU proxy: turns a spoken transcript into ECHO intents via Gemini.
// The client calls this instead of Google directly, so the key stays server-side.
import { BASE, NLU_MODEL, SYSTEM_PROMPT, json } from './_gemini.mjs';

export default async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const key = process.env.GEMINI_API_KEY;
  if (!key) return json({ commands: [], responsePhrase: 'Server is missing its API key.' }, 500);

  let transcript = '';
  try { ({ transcript } = await req.json()); } catch { /* ignore */ }
  if (!transcript || !transcript.trim()) return json({ commands: [], responsePhrase: 'Say that again?' });

  try {
    const res = await fetch(`${BASE}/${NLU_MODEL}:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: transcript }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    const parsed = JSON.parse(text);
    return json({
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      responsePhrase: parsed.responsePhrase || 'Acknowledged.',
    });
  } catch (err) {
    console.error('parse function error:', err);
    return json({ commands: [], responsePhrase: 'My circuits glitched — try again.' });
  }
};
