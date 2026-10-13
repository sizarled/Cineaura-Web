/* CineAura — watch-time clock.
 *
 * Counts whole watched minutes, but only while the viewer is really watching:
 *   - the tab is visible (not switched away to another tab or minimised),
 *   - the browser window has focus (not switched to another application or window),
 *   - the browser is online (counting stops during a network outage),
 *   - the player is playing (checked by the caller through isActive).
 *
 * Seconds are accumulated across pauses, so a partly watched minute is not lost when
 * the viewer leaves and comes back. A time step only counts when the clock was active
 * at both ends of the step: a pause never adds time it should not, and the step where
 * the viewer comes back is skipped (at most one second per resume is left uncounted).
 *
 * Exposed as window.CineAuraWatchClock.createWatchClock(options).
 */
(() => {
  "use strict";

  const TICK_MS = 1000;
  const MINUTE_MS = 60 * 1000;
  // A gap longer than this (laptop sleep, a frozen tab) never counts as watching.
  const MAX_STEP_MS = 5000;

  function createWatchClock({
    isActive,
    onMinute,
    now = () => Date.now(),
    setTimer = (fn, ms) => setInterval(fn, ms),
    clearTimer = (id) => clearInterval(id),
  }) {
    let timer = null;
    let last = 0;
    let wasActive = false;
    let pendingMs = 0;

    function tick() {
      const t = now();
      const step = Math.min(Math.max(0, t - last), MAX_STEP_MS);
      last = t;
      const active = Boolean(isActive());
      if (active && wasActive) {
        pendingMs += step;
        if (pendingMs >= MINUTE_MS) {
          pendingMs -= MINUTE_MS;
          try {
            const result = onMinute();
            if (result && typeof result.catch === "function") result.catch(() => {});
          } catch {
            /* a failed minute must not stop the clock */
          }
        }
      }
      wasActive = active;
    }

    return {
      start() {
        if (timer !== null) return;
        pendingMs = 0;
        wasActive = Boolean(isActive());
        last = now();
        timer = setTimer(tick, TICK_MS);
      },
      stop() {
        if (timer === null) return;
        clearTimer(timer);
        timer = null;
        pendingMs = 0;
        wasActive = false;
      },
      isRunning() {
        return timer !== null;
      },
      // Seconds watched since the last whole minute (for tests and debugging).
      pendingSeconds() {
        return Math.floor(pendingMs / 1000);
      },
    };
  }

  const root = typeof window !== "undefined" ? window : globalThis;
  root.CineAuraWatchClock = { createWatchClock, TICK_MS, MINUTE_MS };
})();
