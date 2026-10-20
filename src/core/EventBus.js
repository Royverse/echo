// High-performance typed EventBus for ECHO.
// Decouples gameplay events from audio, commentary, juice, telemetry, and progression.

class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event 
   * @param {Function} handler 
   * @returns {Function} unsubscribe function
   */
  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event 
   * @param {Function} handler 
   */
  off(event, handler) {
    const handlers = this._listeners.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) this._listeners.delete(event);
    }
  }

  /**
   * Emit an event with an optional payload.
   * @param {string} event 
   * @param {any} [payload] 
   */
  emit(event, payload) {
    const handlers = this._listeners.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] Error in handler for event "${event}":`, err);
      }
    }
  }

  /**
   * Clear all listeners.
   */
  clear() {
    this._listeners.clear();
  }
}

export const events = new EventBus();
