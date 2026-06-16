// Local intent parser — instant, zero-network command understanding.
//
// Resolves the common cases (keyboard, quick buttons, clearly-phrased speech)
// with no round-trip. Anything it can't confidently parse returns
// { confident: false } and the caller escalates to the Gemini NLU.
//
// It splits run-on speech into ORDERED clauses, so "walk forward then turn left
// and jump" becomes [move, turn, jump] — a sequence the engine runs in order.
//
// Shared intent schema (local + Gemini both emit these):
//   { type: 'move',  dir: 'forward'|'backward', steps?: number }   // steps omitted => engine default
//   { type: 'turn',  dir: 'left'|'right'|'around', degrees?: number }
//   { type: 'speed', level: 'run'|'walk'|'faster'|'slower' }
//   { type: 'stop' } | 'jump' | 'wave' | 'dance' | 'reset' | 'unknown'
//   { type: 'kick', power?: 'tap'|'pass'|'drive'|'blast',
//                   loft?: 'ground'|'low'|'lofted'|'chip',
//                   curve?: 'left'|'right', aim?: 'left'|'right',
//                   target?: 'top-left'|'top-right'|'top-center'|'bottom-left'|
//                            'bottom-right'|'low'|'near-post'|'far-post' }   // all optional
//   { type: 'dribble', dir: 'forward'|'backward', steps?: number }
//   { type: 'juggle' } | { type: 'trap' }
//   { type: 'shield' } | { type: 'knock', steps?: number } | { type: 'win' }

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, a: 1, an: 1, couple: 2, few: 3, several: 4,
};

const MAX_STEPS = 30;
const CONTINUOUS_STEPS = 999; // "keep walking" — bounded but effectively endless

const STOP_WORDS = ['stop', 'halt', 'freeze', 'stay', 'wait', 'brake', 'whoa', 'woah', 'hold on', 'hold up', 'cut it', 'enough'];
const AROUND_WORDS = ['around', 'about', '180', 'behind you', 'turn back'];
const LEFT_WORDS = ['left', 'port', 'counterclockwise', 'counter clockwise'];
const RIGHT_WORDS = ['right', 'starboard', 'clockwise'];
const FORWARD_WORDS = ['forward', 'forwards', 'ahead', 'straight', 'onward', 'onwards', 'north'];
const BACKWARD_WORDS = ['backward', 'backwards', 'back up', 'backup', 'reverse', 'retreat', 'south', 'back'];
const TURN_VERBS = ['turn', 'rotate', 'spin', 'pivot', 'face', 'swivel'];
const MOVE_VERBS = ['move', 'walk', 'go', 'head', 'step', 'march', 'proceed', 'advance', 'travel', 'come'];
const KEEP_WORDS = ['keep', 'continuous', 'continuously', 'forever', 'keep going', 'keep walking', 'keep moving'];

// --- Football vocabulary -----------------------------------------------------
const KICK_VERBS = ['kick', 'shoot', 'strike', 'boot', 'volley', 'fire', 'finish', 'slot', 'knock', 'hit', 'drive', 'launch', 'thump', 'wallop', 'smash', 'blast', 'belt', 'hammer', 'rocket', 'put', 'place', 'tuck', 'stick'];
const BLAST_WORDS = ['blast', 'smash', 'hammer', 'belt', 'rocket', 'thump', 'wallop', 'power', 'hard', 'rip', 'bury', 'leather', 'laces'];
const PASS_WORDS = ['pass', 'square', 'feed', 'lay it'];
const TAP_WORDS = ['tap', 'touch', 'nudge', 'poke'];
const SOFT_WORDS = ['soft', 'softly', 'gently', 'gentle', 'easy', 'easily', 'lightly', 'light'];
const CURL_WORDS = ['curl', 'bend', 'swerve', 'hook', 'whip', 'finesse', 'curve'];
const CHIP_WORDS = ['chip', 'dink', 'scoop'];
const LOFT_WORDS = ['loft', 'lofted', 'lob', 'float', 'floated', 'in the air'];
const GROUND_WORDS = ['low', 'driven', 'grounded', 'flat', 'along the ground', 'on the ground', 'keep it low'];
const HIGH_WORDS = ['top', 'upper', 'roof', 'high', 'bar'];
const DRIBBLE_WORDS = ['dribble', 'run with it', 'carry it', 'knock it forward', 'push it forward'];
const JUGGLE_WORDS = ['juggle', 'juggling', 'keepie', 'keepy', 'keep ups', 'keep up', 'keep it up', 'keepie uppies', 'keepy uppies'];
const TRAP_WORDS = ['trap', 'control it', 'control', 'settle it', 'settle', 'kill it', 'first touch'];
const SHIELD_WORDS = ['shield', 'hold it up', 'hold up the ball', 'hold the ball', 'protect the ball', 'back to goal', 'screen it', 'shield the ball'];
const KNOCK_WORDS = ['knock it past', 'push it past', 'knock past', 'poke it past', 'take it past', 'go past him', 'nutmeg', 'knock it by'];
const WIN_WORDS = ['win it', 'win the ball', 'win it back', 'get the ball', 'get it back', 'close him down', 'close down', 'go get it', 'win possession', 'win the ball back'];

// Connectors that separate one command from the next.
const SPLIT_RE = /\s*(?:,|;|\.|\bthen\b|\band then\b|\bafter that\b|\bafterwards\b|\bnext\b|\bfollowed by\b|\bnow\b|\band\b)\s*/gi;

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

// A spoken placement → a goal-mouth target zone, or null if no clear placement
// was called. Needs a real cue (top/bottom/corner/post), so a casual "shoot left"
// stays a light aim nudge rather than a committed corner.
function parseTarget(padded) {
  const post = padded.includes(' post ');
  if (post && includesWord(padded, 'near')) return 'near-post';
  if (post && includesWord(padded, 'far')) return 'far-post';

  const high = anyWord(padded, ['top', 'upper', 'roof', 'bins']);
  const low = anyWord(padded, ['bottom']);
  const corner = anyWord(padded, ['corner', 'bins']);
  if (!high && !low && !corner) return null;

  const left = anyWord(padded, LEFT_WORDS);
  const right = anyWord(padded, RIGHT_WORDS);
  const h = left ? 'left' : right ? 'right' : null;
  const v = high ? 'top' : low ? 'bottom' : 'top';   // a bare "corner" reads as the top corner
  if (h) return `${v}-${h}`;
  return v === 'top' ? 'top-center' : 'low';
}

// A spoken strike → a kick intent with optional power/loft/curve/aim/target.
// Returns null if the clause isn't about kicking the ball.
function parseKick(padded) {
  const isKick = anyWord(padded, KICK_VERBS) || anyWord(padded, PASS_WORDS)
    || anyWord(padded, CHIP_WORDS) || anyWord(padded, LOFT_WORDS)
    || anyWord(padded, CURL_WORDS) || anyWord(padded, TAP_WORDS);
  if (!isKick) return null;

  let power = 'drive';
  if (anyWord(padded, BLAST_WORDS)) power = 'blast';
  else if (anyWord(padded, PASS_WORDS)) power = 'pass';
  else if (anyWord(padded, TAP_WORDS) || anyWord(padded, SOFT_WORDS)) power = 'tap';

  let loft = 'low';
  if (anyWord(padded, CHIP_WORDS)) loft = 'chip';
  else if (anyWord(padded, LOFT_WORDS)) loft = 'lofted';
  else if (anyWord(padded, GROUND_WORDS)) loft = 'ground';
  if (loft === 'low' && anyWord(padded, HIGH_WORDS)) loft = 'lofted'; // "top corner" lifts it

  const left = anyWord(padded, LEFT_WORDS);
  const right = anyWord(padded, RIGHT_WORDS);
  const intent = { type: 'kick', power, loft };
  if (anyWord(padded, CURL_WORDS)) intent.curve = right ? 'right' : 'left'; // curl defaults left

  const target = parseTarget(padded);
  if (target) intent.target = target;          // a placed shot at a goal corner
  else if (left || right) intent.aim = left ? 'left' : 'right'; // otherwise a light aim nudge
  return intent;
}

// Football actions take precedence within a clause (a clause is one command).
function parseFootball(padded) {
  if (anyWord(padded, JUGGLE_WORDS)) return [{ type: 'juggle' }];
  if (anyWord(padded, SHIELD_WORDS)) return [{ type: 'shield' }];
  if (anyWord(padded, KNOCK_WORDS)) {
    const steps = extractNumber(padded);
    return [{ type: 'knock', ...(steps ? { steps } : {}) }];
  }
  if (anyWord(padded, WIN_WORDS)) return [{ type: 'win' }];
  if (anyWord(padded, TRAP_WORDS)) return [{ type: 'trap' }];
  if (anyWord(padded, DRIBBLE_WORDS)) {
    const dir = anyWord(padded, BACKWARD_WORDS) ? 'backward' : 'forward';
    const steps = extractNumber(padded);
    return [{ type: 'dribble', dir, ...(steps ? { steps } : {}) }];
  }
  const kick = parseKick(padded);
  return kick ? [kick] : [];
}

// Parse a single clause into zero or more intents (in order).
function parseClause(rawClause) {
  const padded = clean(rawClause);
  if (!padded.trim()) return [];

  if (anyWord(padded, STOP_WORDS)) return [{ type: 'stop' }];

  const football = parseFootball(padded);
  if (football.length) return football;

  const intents = [];

  if (anyWord(padded, ['dance', 'boogie', 'groove', 'party'])) intents.push({ type: 'dance' });
  if (anyWord(padded, ['wave', 'hello', 'hi', 'hey there', 'greet', 'salute'])) intents.push({ type: 'wave' });
  if (anyWord(padded, ['jump', 'hop', 'leap', 'bounce', 'spring'])) intents.push({ type: 'jump' });
  if (anyWord(padded, ['reset', 'home', 'center', 'centre', 'restart', 'recall', 'go home', 'return home', 'recenter'])) {
    intents.push({ type: 'reset' });
  }

  if (anyWord(padded, ['faster', 'speed up', 'quicker', 'hurry'])) intents.push({ type: 'speed', level: 'faster' });
  else if (anyWord(padded, ['slower', 'slow down', 'ease up', 'take it slow'])) intents.push({ type: 'speed', level: 'slower' });

  const wantsRun = anyWord(padded, ['run', 'sprint', 'dash', 'jog', 'bolt']);
  const wantsKeep = anyWord(padded, KEEP_WORDS);
  const hasTurnVerb = anyWord(padded, TURN_VERBS);
  const hasMoveVerb = anyWord(padded, MOVE_VERBS) || wantsRun || wantsKeep;
  const number = extractNumber(padded);

  const dirAround = anyWord(padded, AROUND_WORDS);
  const dirLeft = anyWord(padded, LEFT_WORDS);
  const dirRight = anyWord(padded, RIGHT_WORDS);
  const dirForward = anyWord(padded, FORWARD_WORDS);
  const dirBackward = anyWord(padded, BACKWARD_WORDS);

  // Turning: "turn left/around" or a bare "left"/"right" without a move verb.
  if (hasTurnVerb || ((dirLeft || dirRight || dirAround) && !hasMoveVerb)) {
    if (dirAround) intents.push({ type: 'turn', dir: 'around' });
    else if (dirLeft) intents.push({ type: 'turn', dir: 'left', ...(number && number > 20 ? { degrees: number } : {}) });
    else if (dirRight) intents.push({ type: 'turn', dir: 'right', ...(number && number > 20 ? { degrees: number } : {}) });
  }

  // Movement.
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

  return intents;
}

/**
 * Parse free text into an ordered list of intents.
 * @returns {{ intents: object[], confident: boolean }}
 */
export function parseCommand(text) {
  if (!text || !text.trim()) return { intents: [], confident: false };

  // Emergency stop short-circuits everything.
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
