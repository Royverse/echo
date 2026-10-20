// Deterministic pseudo-random number generator (Mulberry32).
// Ensures reproducible match scenarios, replays, and daily challenges.

class RNGManager {
  constructor(seed = 1337) {
    this._initialSeed = seed;
    this._state = seed >>> 0;
  }

  seed(seed) {
    this._initialSeed = seed;
    this._state = (typeof seed === 'string' ? this._hashString(seed) : seed) >>> 0;
  }

  getSeed() {
    return this._initialSeed;
  }

  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash >>> 0;
  }

  /**
   * Returns a float in [0, 1)
   */
  random() {
    let s = (this._state += 0x6d2b79f5);
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  }

  range(min, max) {
    return min + this.random() * (max - min);
  }

  int(min, max) {
    return Math.floor(this.range(min, max + 1));
  }

  choice(arr) {
    if (!arr || !arr.length) return null;
    return arr[this.int(0, arr.length - 1)];
  }

  gaussian(mean = 0, std = 1) {
    // Box-Muller transform
    const u1 = Math.max(1e-10, this.random());
    const u2 = this.random();
    const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    return mean + z0 * std;
  }
}

export const RNG = new RNGManager();
