// Global Time module for fixed-timestep integration and time dilation.
// Separates gameplay physics/animation time from UI, camera smoothing, and audio.
import { Config } from './Config.js';

class TimeManager {
  constructor() {
    this.fixedDt = Config.PHYSICS.FIXED_DT;
    this.maxSubSteps = Config.PHYSICS.MAX_SUB_STEPS;
    this.accumulator = 0;
    this.renderAlpha = 0;

    this.scale = 1.0;
    this._hitStopMs = 0;
    this._slowMoScale = 1.0;
    this._slowMoMs = 0;

    this.simTime = 0;
    this.realTime = 0;
    this.frameCount = 0;
  }

  /**
   * Trigger a momentary hit-stop freeze (e.g. on ball strike, goal, tackle).
   * @param {number} ms Duration in wall-clock milliseconds
   */
  hitStop(ms) {
    this._hitStopMs = Math.max(this._hitStopMs, ms);
  }

  /**
   * Trigger temporary slow motion.
   * @param {number} scale Time scale (0.1 to 1.0)
   * @param {number} ms Duration in wall-clock milliseconds
   */
  slowMo(scale, ms) {
    this._slowMoScale = scale;
    this._slowMoMs = Math.max(this._slowMoMs, ms);
  }

  /**
   * Step the time manager, draining the accumulator into fixed updates.
   * @param {number} rawDt Delta time in seconds from requestAnimationFrame
   * @param {Function} fixedStepCallback Called once per fixed sub-step: (dt) => void
   * @returns {number} renderAlpha (0..1) for render state interpolation
   */
  step(rawDt, fixedStepCallback) {
    const rawMs = rawDt * 1000;
    this.realTime += rawDt;

    // Check hit-stop: freeze simulation if hit-stop is active
    if (this._hitStopMs > 0) {
      this._hitStopMs -= rawMs;
      this.renderAlpha = 0;
      return 0;
    }

    // Check slow-motion
    let currentScale = this.scale;
    if (this._slowMoMs > 0) {
      this._slowMoMs -= rawMs;
      currentScale *= this._slowMoScale;
    }

    const effectiveDt = Math.min(rawDt, 0.12) * currentScale;
    this.accumulator += effectiveDt;

    let subSteps = 0;
    while (this.accumulator >= this.fixedDt && subSteps < this.maxSubSteps) {
      fixedStepCallback(this.fixedDt);
      this.simTime += this.fixedDt;
      this.accumulator -= this.fixedDt;
      subSteps++;
      this.frameCount++;
    }

    // Clamp accumulator if we hit max sub-steps to avoid death spiral
    if (subSteps >= this.maxSubSteps) {
      this.accumulator = 0;
    }

    this.renderAlpha = this.accumulator / this.fixedDt;
    return this.renderAlpha;
  }

  reset() {
    this.accumulator = 0;
    this.renderAlpha = 0;
    this._hitStopMs = 0;
    this._slowMoMs = 0;
    this.scale = 1.0;
  }
}

export const Time = new TimeManager();
