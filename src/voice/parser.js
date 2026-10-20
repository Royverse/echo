// Local intent parser — instant, zero-network command understanding.
// Resolves commands with sub-millisecond regex matching.
//
// Shared intent schema (local + Gemini both emit these):
//   { type: 'order', order: 'carry'|'hold'|'press'|'screen'|'support', target?: string }
//   { type: 'move',  dir: 'forward'|'backward'|'forward-left'|..., steps?: number }
//   { type: 'turn',  dir: 'left'|'right'|'around', degrees?: number }
//   { type: 'speed', level: 'run'|'walk'|'faster'|'slower' }
//   { type: 'stop' } | 'jump' | 'wave' | 'dance' | 'reset'
//   { type: 'kick', power?: 'tap'|'pass'|'drive'|'blast',
//                   loft?: 'ground'|'low'|'lofted'|'chip',
//                   curve?: 'left'|'right', aim?: 'left'|'right',
//                   style?: 'finesse'|'knuckle'|'dipper'|'normal',
//                   smart?: boolean,
//                   target?: 'top-left'|'top-right'|'top-center'|'bottom-left'|
//                            'bottom-right'|'low'|'near-post'|'far-post'|'open-corner' }
//   { type: 'feint', dir: 'left'|'right' }
//   { type: 'flick' } | { type: 'onetwo' } | { type: 'nutmeg' } | { type: 'bicycle' }
//   { type: 'dribble', dir: 'forward'|'backward', steps?: number }
//   { type: 'juggle' } | { type: 'trap' } | { type: 'shield' } | { type: 'knock', steps?: number }
//   { type: 'squad', verb: 'overlap'|'cross'|'switch'|'pass_to'|..., target?: string }
//   { type: 'macro_record', name: string }

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, a: 1, an: 1, couple: 2, few: 3, several: 4,
};

const MAX_STEPS = 30;
const CONTINUOUS_STEPS = 999;

const STOP_WORDS = ['stop', 'halt', 'freeze', 'stay', 'wait', 'brake', 'whoa', 'woah', 'hold on', 'hold up', 'cut it', 'enough', 'cease'];
const AROUND_WORDS = ['around', 'about', '180', 'behind you', 'turn back'];
const LEFT_WORDS = ['left', 'port', 'counterclockwise', 'counter clockwise'];
const RIGHT_WORDS = ['right', 'starboard', 'clockwise'];
const FORWARD_WORDS = ['forward', 'forwards', 'ahead', 'straight', 'onward', 'onwards', 'north'];
const BACKWARD_WORDS = ['backward', 'backwards', 'back up', 'backup', 'reverse', 'retreat', 'south', 'back'];
const TURN_VERBS = ['turn', 'rotate', 'spin', 'pivot', 'face', 'swivel'];
const MOVE_VERBS = ['move', 'walk', 'step', 'march', 'proceed', 'travel'];
const KEEP_WORDS = ['keep', 'continuous', 'continuously', 'forever', 'keep going', 'keep walking', 'keep moving'];

// Football vocabulary
const KICK_VERBS = ['kick', 'shoot', 'strike', 'boot', 'volley', 'fire', 'finish', 'slot', 'hit', 'drive', 'launch', 'thump', 'wallop', 'smash', 'blast', 'belt', 'hammer', 'rocket', 'put', 'place', 'tuck', 'stick', 'have a go'];
const BLAST_WORDS = ['blast', 'smash', 'hammer', 'belt', 'rocket', 'thump', 'wallop', 'power', 'hard', 'rip', 'bury', 'leather', 'laces'];
const PASS_WORDS = ['pass', 'square', 'feed', 'lay it', 'find him', 'layoff'];
const TAP_WORDS = ['tap', 'touch', 'nudge', 'poke'];
const SOFT_WORDS = ['soft', 'softly', 'gently', 'gentle', 'easy', 'easily', 'lightly', 'light'];
const CURL_WORDS = ['curl', 'bend', 'swerve', 'hook', 'whip', 'finesse', 'curve'];
const CHIP_WORDS = ['chip', 'dink', 'scoop', 'lob'];
const LOFT_WORDS = ['loft', 'lofted', 'float', 'floated', 'in the air', 'high'];
const GROUND_WORDS = ['ground', 'low', 'driven', 'grounded', 'flat', 'along the ground', 'on the ground', 'keep it low', 'bottom'];
const HIGH_WORDS = ['top', 'upper', 'roof', 'high', 'bar', 'bins', 'top bins'];

// Standing Orders vocabulary
const CARRY_WORDS = ['carry', 'carry it', 'drive it', 'take it on', 'advance', 'push forward', 'drive forward', 'take space'];
const HOLD_WORDS = ['hold', 'hold up', 'hold the ball', 'protect', 'protect the ball', 'shield it', 'shield the ball', 'keep possession'];
const PRESS_WORDS = ['press', 'win it back', 'win it', 'get it', 'get it back', 'win ball', 'close down', 'hunt', 'hunt it', 'tackle'];
const SCREEN_WORDS = ['screen', 'goal side', 'goalside', 'cover', 'cover back', 'protect goal'];
const SUPPORT_WORDS = ['support', 'show for it', 'give an option', 'come short'];

// New Advanced Mechanics
const FEINT_WORDS = ['feint', 'fake', 'drop shoulder', 'shimmy', 'stepover', 'step over', 'dummy'];
const FLICK_WORDS = ['flick', 'rainbow', 'rainbow flick', 'sombrero', 'lift it over'];
const ONETWO_WORDS = ['one two', 'onetwo', '1 2', 'give and go', 'wall pass', 'wall drone'];
const NUTMEG_WORDS = ['nutmeg', 'megs', 'meg', 'through his legs', 'through the legs', 'panna'];
const BICYCLE_WORDS = ['bicycle', 'bicycle kick', 'overhead', 'overhead kick', 'scissor kick', 'acrobatic'];
const KNUCKLE_WORDS = ['knuckle', 'knuckleball', 'dead ball', 'no spin'];
const DIPPER_WORDS = ['dipper', 'topspin', 'dip'];

// Connectors
const SPLIT_RE = /\s*(?:,|;|\.|\bthen\b|\band then\b|\bafter that\b|\bafterwards\b|\bnext\b|\bfollowed by\b|\bnow\b|\band\b)\s*/gi;

let lastExecutedAction = null;

function clean(text) {
  return ` ${text.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()} `;
}

function includesWord(padded, word) {
  return padded.includes(` ${word} `);
}

function anyWord(padded, words) {
  return words.some((w) => (w.includes(' ') ? padded.includes(` ${w} `) : includesWord(padded, w)));
}

function extractNumber(padded) {
  const digit = padded.match(/\b(\d{1,3})\b/);
  if (digit) return Math.max(1, Math.min(MAX_STEPS, parseInt(digit[1], 10)));
  for (const [word, val] of Object.entries(NUMBER_WORDS)) {
    if (includesWord(padded, word) && val > 0) return Math.min(MAX_STEPS, val);
  }
  return null;
}

function parseTarget(padded) {
  if (anyWord(padded, ['open corner', 'away from keeper', 'empty corner', 'far post'])) return 'far-post';
  if (anyWord(padded, ['near post', 'short side'])) return 'near-post';

  const high = anyWord(padded, ['top', 'upper', 'roof', 'bins']);
  const low = anyWord(padded, ['bottom', 'low']);
  const corner = anyWord(padded, ['corner', 'bins']);
  if (!high && !low && !corner) return null;

  const left = anyWord(padded, LEFT_WORDS);
  const right = anyWord(padded, RIGHT_WORDS);
  const h = left ? 'left' : right ? 'right' : null;
  const v = high ? 'top' : low ? 'bottom' : 'top';
  if (h) return `${v}-${h}`;
  return v === 'top' ? 'top-center' : 'low';
}

function parseKick(padded) {
  const isKick = anyWord(padded, KICK_VERBS) || anyWord(padded, PASS_WORDS)
    || anyWord(padded, CHIP_WORDS) || anyWord(padded, LOFT_WORDS)
    || anyWord(padded, CURL_WORDS) || anyWord(padded, TAP_WORDS)
    || anyWord(padded, KNUCKLE_WORDS) || anyWord(padded, DIPPER_WORDS);
  if (!isKick) return null;

  let power = 'drive';
  if (anyWord(padded, BLAST_WORDS)) power = 'blast';
  else if (anyWord(padded, PASS_WORDS)) power = 'pass';
  else if (anyWord(padded, TAP_WORDS) || anyWord(padded, SOFT_WORDS)) power = 'tap';

  let loft = 'low';
  if (anyWord(padded, CHIP_WORDS)) loft = 'chip';
  else if (anyWord(padded, LOFT_WORDS)) loft = 'lofted';
  else if (anyWord(padded, GROUND_WORDS)) loft = 'ground';
  if (loft === 'low' && anyWord(padded, HIGH_WORDS)) loft = 'lofted';

  let style = 'normal';
  if (anyWord(padded, KNUCKLE_WORDS)) style = 'knuckle';
  else if (anyWord(padded, DIPPER_WORDS)) style = 'dipper';
  else if (anyWord(padded, CURL_WORDS)) style = 'finesse';

  const left = anyWord(padded, LEFT_WORDS);
  const right = anyWord(padded, RIGHT_WORDS);
  const intent = { type: 'kick', power, loft, style };
  if (anyWord(padded, CURL_WORDS) || style === 'finesse') {
    intent.curve = right ? 'right' : 'left';
  }

  const target = parseTarget(padded);
  if (target) {
    intent.target = target;
  } else if (left || right) {
    intent.aim = left ? 'left' : 'right';
  } else {
    // Smart default marker: engine will resolve best post/corner against live keeper
    intent.smart = true;
  }
  return intent;
}

function parseFootball(padded) {
  // Advanced tricks
  if (anyWord(padded, FEINT_WORDS)) {
    const dir = anyWord(padded, LEFT_WORDS) ? 'left' : 'right';
    return [{ type: 'feint', dir }];
  }
  if (anyWord(padded, FLICK_WORDS)) return [{ type: 'flick' }];
  if (anyWord(padded, ONETWO_WORDS)) return [{ type: 'onetwo' }];
  if (anyWord(padded, NUTMEG_WORDS)) return [{ type: 'nutmeg' }];
  if (anyWord(padded, BICYCLE_WORDS)) return [{ type: 'bicycle' }];

  // Standing Orders
  if (anyWord(padded, CARRY_WORDS)) {
    let target = 'goal';
    if (anyWord(padded, LEFT_WORDS)) target = 'left';
    else if (anyWord(padded, RIGHT_WORDS)) target = 'right';
    return [{ type: 'order', order: 'carry', target }];
  }
  if (anyWord(padded, HOLD_WORDS)) return [{ type: 'order', order: 'hold' }];
  if (anyWord(padded, PRESS_WORDS)) return [{ type: 'order', order: 'press' }];
  if (anyWord(padded, SCREEN_WORDS)) return [{ type: 'order', order: 'screen' }];
  if (anyWord(padded, SUPPORT_WORDS)) return [{ type: 'order', order: 'support' }];

  // Squad Captain verbs (Phase 3)
  if (anyWord(padded, ['overlap right', 'overlap to the right'])) return [{ type: 'squad', verb: 'overlap', target: 'right' }];
  if (anyWord(padded, ['overlap left', 'overlap to the left', 'overlap'])) return [{ type: 'squad', verb: 'overlap', target: 'left' }];
  if (anyWord(padded, ['make a run', 'run in behind', 'go long'])) return [{ type: 'squad', verb: 'run' }];
  if (anyWord(padded, ['cross', 'cross it', 'whip it in'])) return [{ type: 'squad', verb: 'cross' }];
  if (anyWord(padded, ['switch', 'switch play', 'switch sides'])) return [{ type: 'squad', verb: 'switch' }];
  if (anyWord(padded, ['pass to nova', 'find nova'])) return [{ type: 'squad', verb: 'pass_to', target: 'Nova' }];
  if (anyWord(padded, ['pass to pixel', 'find pixel'])) return [{ type: 'squad', verb: 'pass_to', target: 'Pixel' }];
  if (anyWord(padded, ['leave it', 'my ball', 'mine'])) return [{ type: 'squad', verb: 'call_ball' }];

  // Freestyle / Possession
  if (anyWord(padded, ['juggle', 'keepie', 'keepy'])) return [{ type: 'juggle' }];
  if (anyWord(padded, ['trap', 'control it', 'settle it', 'kill it'])) return [{ type: 'trap' }];
  if (anyWord(padded, ['shield', 'shield ball'])) return [{ type: 'shield' }];
  if (anyWord(padded, ['knock past', 'knock it past', 'push past'])) {
    const steps = extractNumber(padded);
    return [{ type: 'knock', ...(steps ? { steps } : {}) }];
  }
  if (anyWord(padded, ['dribble'])) {
    const dir = anyWord(padded, BACKWARD_WORDS) ? 'backward' : 'forward';
    const steps = extractNumber(padded);
    return [{ type: 'dribble', dir, ...(steps ? { steps } : {}) }];
  }

  const kick = parseKick(padded);
  return kick ? [kick] : [];
}

function parseClause(rawClause) {
  const padded = clean(rawClause);
  if (!padded.trim()) return [];

  // Stop / freeze instant purge
  if (anyWord(padded, STOP_WORDS)) return [{ type: 'stop' }];

  // Repeat last action ("again", "same", "repeat")
  if (anyWord(padded, ['again', 'same', 'repeat', 'one more time']) && lastExecutedAction) {
    return [{ ...lastExecutedAction }];
  }

  // Football and Orders take precedence
  const football = parseFootball(padded);
  if (football.length) {
    lastExecutedAction = football[0];
    return football;
  }

  const intents = [];

  if (anyWord(padded, ['dance', 'boogie', 'groove'])) intents.push({ type: 'dance' });
  if (anyWord(padded, ['wave', 'hello', 'hi', 'hey'])) intents.push({ type: 'wave' });
  if (anyWord(padded, ['jump', 'hop', 'leap'])) intents.push({ type: 'jump' });
  if (anyWord(padded, ['reset', 'home', 'center', 'centre', 'recenter', 'restart'])) {
    intents.push({ type: 'reset' });
  }

  if (anyWord(padded, ['faster', 'speed up', 'quicker', 'hurry', 'sprint'])) {
    intents.push({ type: 'speed', level: 'faster' });
  } else if (anyWord(padded, ['slower', 'slow down', 'ease up', 'take it slow'])) {
    intents.push({ type: 'speed', level: 'slower' });
  }

  const wantsRun = anyWord(padded, ['run', 'sprint', 'dash']);
  const wantsKeep = anyWord(padded, KEEP_WORDS);
  const hasTurnVerb = anyWord(padded, TURN_VERBS);
  const hasMoveVerb = anyWord(padded, MOVE_VERBS) || wantsRun || wantsKeep;
  const number = extractNumber(padded);

  const dirAround = anyWord(padded, AROUND_WORDS);
  const dirLeft = anyWord(padded, LEFT_WORDS);
  const dirRight = anyWord(padded, RIGHT_WORDS);
  const dirForward = anyWord(padded, FORWARD_WORDS);
  const dirBackward = anyWord(padded, BACKWARD_WORDS);

  // Turn
  if (hasTurnVerb || ((dirLeft || dirRight || dirAround) && !hasMoveVerb)) {
    if (dirAround) intents.push({ type: 'turn', dir: 'around' });
    else if (dirLeft) intents.push({ type: 'turn', dir: 'left', ...(number && number > 20 ? { degrees: number } : {}) });
    else if (dirRight) intents.push({ type: 'turn', dir: 'right', ...(number && number > 20 ? { degrees: number } : {}) });
  }

  // Move
  if (hasMoveVerb || dirForward || dirBackward) {
    if (wantsRun && !intents.some((i) => i.type === 'speed')) intents.push({ type: 'speed', level: 'run' });
    const steps = wantsKeep ? CONTINUOUS_STEPS : number || undefined;

    if ((dirLeft || dirRight) && hasMoveVerb && !dirForward && !dirBackward) {
      intents.push({ type: 'turn', dir: dirLeft ? 'left' : 'right' });
      intents.push({ type: 'move', dir: 'forward', ...(steps ? { steps } : {}) });
    } else if (dirBackward) {
      intents.push({ type: 'move', dir: 'backward', ...(steps ? { steps } : {}) });
    } else {
      intents.push({ type: 'move', dir: 'forward', ...(steps ? { steps } : {}) });
    }
  }

  if (intents.length) lastExecutedAction = intents[0];
  return intents;
}

/**
 * Load macros from localStorage.
 */
function getSavedMacros() {
  try {
    return JSON.parse(localStorage.getItem('echo_macros') || '{}');
  } catch {
    return {};
  }
}

/**
 * Save a macro to localStorage.
 */
export function saveMacro(name, intents) {
  try {
    const macros = getSavedMacros();
    macros[name.toLowerCase().trim()] = intents;
    localStorage.setItem('echo_macros', JSON.stringify(macros));
  } catch (err) {
    console.warn('Could not save macro to localStorage', err);
  }
}

/**
 * Parse free text into an ordered list of intents.
 * @param {string} text 
 * @returns {{ intents: object[], confident: boolean, isMacroRecord?: boolean, macroName?: string }}
 */
export function parseCommand(text) {
  if (!text || !text.trim()) return { intents: [], confident: false };

  // Check for macro definition: "call that <name>" or "save that as <name>"
  const macroMatch = text.match(/(?:call that|save that as|name that)\s+([a-z0-9_\-\s]+)/i);
  if (macroMatch) {
    const macroName = macroMatch[1].trim().toLowerCase();
    return { intents: [{ type: 'macro_record', name: macroName }], confident: true, isMacroRecord: true, macroName };
  }

  // Check saved macros
  const cleanedText = text.trim().toLowerCase();
  const macros = getSavedMacros();
  if (macros[cleanedText]) {
    return { intents: JSON.parse(JSON.stringify(macros[cleanedText])), confident: true };
  }

  // Emergency stop short-circuits everything
  if (anyWord(clean(text), STOP_WORDS)) return { intents: [{ type: 'stop' }], confident: true };

  const clauses = text.split(SPLIT_RE);
  const intents = [];
  for (const clause of clauses) {
    for (const intent of parseClause(clause)) {
      if (intent.type === 'stop') return { intents: [{ type: 'stop' }], confident: true };
      intents.push(intent);
    }
  }

  if (intents.length) return { intents, confident: true };
  return { intents: [], confident: false };
}

export { MAX_STEPS, CONTINUOUS_STEPS };
