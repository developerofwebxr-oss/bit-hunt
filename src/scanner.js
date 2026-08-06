// Scanner-signal seam — the SINGLE source everything reads from.
//
// scannerSignal ∈ [0..1] drives every piece of feedback (screen sweep + blip +
// meter, indicator lights, tick rate, hoop pulse). For THIS phase it is a STUB:
//   - idle: a slow breathing oscillation so all the feedback visibly lives.
//   - debug: a manual sweep (toggle) that ramps 0→1→0, plus step nudges, so
//     verification can drive the whole range by hand.
//
// NEXT PHASE plugs real aim-proximity in: replace only the `else` branch of
// update() (the idle formula) with the proximity read. Nothing downstream —
// gun, screen, lights, audio — should need to change. That is the seam's test.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createScanner() {
  let signal = 0;
  let t = 0;
  let manual = null;      // debug step override (0..1) or null
  let sweep = false;      // debug auto-sweep active
  let sweepT = 0;

  function update(dt) {
    t += dt;
    if (sweep) {
      sweepT += dt / 4;                          // 4s for a full 0→1→0
      signal = 1 - Math.abs((sweepT % 2) - 1);    // triangle wave
    } else if (manual != null) {
      signal = manual;
    } else {
      // idle "breathing" — stays lively without ever pinning to 0 or 1
      signal = clamp01(0.3 + 0.22 * Math.sin(t * 0.7) + 0.06 * Math.sin(t * 2.3));
    }
    return signal;
  }

  return {
    update,
    get signal() { return signal; },
    // derived cadence for the Geiger ticks: ~1 Hz idle floor → ~20 Hz at full.
    get ticksPerSec() { return 1 + signal * 19; },
    // ---- debug controls (wired to keys in main.js; removed when real logic lands) ----
    toggleSweep() { sweep = !sweep; sweepT = 0; if (!sweep) manual = null; return sweep; },
    get isSweeping() { return sweep; },
    stepManual(delta) { sweep = false; manual = clamp01((manual ?? signal) + delta); return manual; },
    clearManual() { manual = null; sweep = false; },
  };
}
