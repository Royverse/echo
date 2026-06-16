// Gemini integration with two paths:
//   • Local dev  — if VITE_GEMINI_API_KEY is set (.env.local), call Google directly.
//   • Production — no client key; call the Netlify Function proxy (/.netlify/functions/*)
//                  so the key stays server-side.
// The local parser (commands.js) still handles the common cases instantly; this is
// the "smart" fallback for fuzzy, conversational phrasing.

const DEV_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const NLU_MODEL = 'gemini-2.5-flash';
const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

// We can reach Gemini if we have a dev key (direct) or we're a prod build (proxy).
export const hasApiKey = Boolean(DEV_KEY) || import.meta.env.PROD;

// Dev-direct only; production uses the prompt in netlify/functions/_gemini.mjs.
// NOTE: keep the two prompts in sync — if you change the intent schema here
// (e.g. the football kick/dribble/juggle/trap shapes below), mirror it there.
const SYSTEM_PROMPT = `You are the intent parser for ECHO, a sassy, upbeat robot the player drives by voice in a 3D playground.
Convert the player's speech into a JSON list of movement intents, and write one short in-character spoken reply.

It's a football game: a goal with a diving GOALKEEPER and an outfield DEFENDER who
pressures and can tackle the ball off the robot. The robot is the athlete — you (the
player) call intent in natural language, it does the run-up, dribble and strike. You
keep possession through any move; place shots into goal corners past the keeper; lose
the ball to a tackle and win it back.

Intent schema (emit only these shapes):
- {"type":"move","dir":"forward"|"backward","steps":N}   // omit "steps" to keep moving until told to stop
- {"type":"turn","dir":"left"|"right"|"around"}
- {"type":"speed","level":"run"|"walk"|"faster"|"slower"}
- {"type":"stop"}
- {"type":"jump"}
- {"type":"wave"}
- {"type":"dance"}
- {"type":"reset"}
- {"type":"kick","power":"tap"|"pass"|"drive"|"blast","loft":"ground"|"low"|"lofted"|"chip","curve":"left"|"right","aim":"left"|"right","target":"top-left"|"top-right"|"top-center"|"bottom-left"|"bottom-right"|"low"|"near-post"|"far-post"}
    // power/loft default to "drive"/"low". Prefer "target" for a placed shot at a goal corner; use "aim" only for a vague left/right nudge. Include "curve" only for curl/bend. Omit fields you're unsure about.
- {"type":"dribble","dir":"forward"|"backward","steps":N}   // close-control run that keeps the ball
- {"type":"juggle"}    // keepie-uppies / show off with the ball
- {"type":"trap"}      // control / settle / kill the ball
- {"type":"shield"}    // hold the ball up, back to the defender, protect possession
- {"type":"knock","steps":N}   // knock it past the defender and sprint onto it
- {"type":"win"}       // chase / press to win back a loose ball

Rules:
- Ignore filler ("uh", "hey", "could you", "please").
- Map intuitively: "head over there"->move forward; "spin around"->turn around; "say hi"->wave; "show me a move"->dance; "freeze"->stop; "go home"->reset.
- "go left"/"head right" => a turn in that direction followed by {"type":"move","dir":"forward"}.
- Compound football is common — emit an ordered list: "go left then shoot top corner" => [{turn left},{move forward},{kick target:top-left}]. "take it past him and finish bottom right" => [{knock},{kick target:bottom-right}].
- kick fields:
  - power: tap/touch->tap; pass/square/lay->pass; shoot/strike/drive->drive; blast/smash/hammer/rocket/"hard"/"laces"->blast.
  - loft: "keep it low"/driven->ground; normal->low; loft/lob->lofted; chip/dink/scoop/"over the keeper"->chip.
  - target (placed shot): "top left/right corner", "bottom left/right", "top bins"->top corner, "roof of the net"->top-center, "near/far post". left/right = the player's view of the goal.
  - curve: "curl/bend/whip/finesse it left|right".
- "shield"/"hold it up"/"back to goal"->shield. "knock it past"/"take it past him"/"nutmeg"->knock. "win it"/"get the ball back"/"close him down"->win. "trap/control/settle"->trap. "juggle/keepie-uppies/show off"->juggle. "dribble/run with the ball"->dribble.
- steps: integer 1-30. Only include steps when the player gives a count; otherwise omit it.
- responsePhrase: under 9 words, playful (footballer swagger welcome). If no intent is found, leave commands empty and ask for clarification.

Respond with ONLY this JSON object:
{"commands":[ ... ],"responsePhrase":"..."}`;

/**
 * Natural-language fallback parser.
 * @returns {Promise<{commands: object[], responsePhrase: string}>}
 */
export async function parseIntentWithGemini(transcript) {
  try {
    if (DEV_KEY) {
      const res = await fetch(`${BASE}/${NLU_MODEL}:generateContent?key=${DEV_KEY}`, {
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
      const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
      const parsed = JSON.parse(jsonText);
      return {
        commands: Array.isArray(parsed.commands) ? parsed.commands : [],
        responsePhrase: parsed.responsePhrase || 'Acknowledged.',
      };
    }

    // Production: serverless proxy keeps the key server-side.
    const res = await fetch('/.netlify/functions/parse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript }),
    });
    const data = await res.json();
    return {
      commands: Array.isArray(data.commands) ? data.commands : [],
      responsePhrase: data.responsePhrase || 'Acknowledged.',
    };
  } catch (err) {
    console.error('Gemini NLU error:', err);
    return { commands: [], responsePhrase: 'My circuits glitched — say that again?' };
  }
}

// ---------------------------------------------------------------------------
// Neural TTS
// ---------------------------------------------------------------------------

function pcmToWav(pcmBytes, sampleRate = 24000) {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = new ArrayBuffer(44 + pcmBytes.length);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes.length, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, pcmBytes.length, true);
  new Uint8Array(buffer, 44).set(pcmBytes);
  return new Blob([buffer], { type: 'audio/wav' });
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Synthesize speech (dev-direct or via the proxy).
 * @returns {Promise<string|null>} an object URL for a WAV blob, or null on failure.
 */
export async function synthesizeSpeech(text, voiceName = 'Puck') {
  if (!text) return null;

  let audioBase64;
  let mimeType;
  if (DEV_KEY) {
    const res = await fetch(`${BASE}/${TTS_MODEL}:generateContent?key=${DEV_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const part = data.candidates?.[0]?.content?.parts?.[0];
    audioBase64 = part?.inlineData?.data;
    mimeType = part?.inlineData?.mimeType;
  } else {
    const res = await fetch('/.netlify/functions/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: voiceName }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    audioBase64 = data.audioBase64;
    mimeType = data.mimeType;
  }

  if (!audioBase64) throw new Error('No audio returned');
  const rate = parseInt(mimeType?.match(/rate=(\d+)/)?.[1] ?? '24000', 10);
  const wav = pcmToWav(base64ToBytes(audioBase64), rate);
  return URL.createObjectURL(wav);
}
