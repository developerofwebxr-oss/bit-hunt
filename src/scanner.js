// Scanner-signal seam — the SINGLE source everything reads from.
//
// scannerSignal ∈ [0..1] drives every piece of feedback (screen sweep + blip +
// meter, indicator lights, tick rate, hoop pulse). This is the REAL mechanic:
// the gun only reacts near still-hidden sats, and where you AIM matters.
//
//   signal = max over hidden sats of  proximity(distance) × direction(aim vs sat)
//
//   - proximity: 1 at ≤PROX_NEAR m, falling to 0 at ≥PROX_FAR m.
//   - direction: 1 when the aim ray is within ANG_FULL of the sat, fading to 0
//     by ANG_ZERO — so sweeping the gun reads as "warmer / colder".
//   - the strongest single lead wins (max), so one well-aimed nearby sat lights
//     you up even in a crowd; far from everything or aiming nowhere → 0 → silence.
//
// Debug sweep/step still override for testing. Next phase only needs to shrink
// the target set as sats are caught — nothing else changes. Downstream (gun,
// screen, lights, audio) is untouched: that is the seam's whole point.

// ---- tunables (metres / radians) ----
const PROX_NEAR = 2.0, PROX_FAR = 10.0;                 // full signal ≤2 m, none ≥10 m
const ANG_FULL = 10 * Math.PI / 180, ANG_ZERO = 45 * Math.PI / 180; // full ≤10°, none ≥45°

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function createScanner() {
  let signal = 0;
  let t = 0;
  let manual = null;      // debug step override (0..1) or null
  let sweep = false;      // debug auto-sweep active
  let sweepT = 0;

  // sample = { ox,oy,oz, dx,dy,dz, targets:[{x,y,z}] } — aim origin+dir + hidden sats.
  function update(dt, sample) {
    t += dt;
    if (sweep) {
      sweepT += dt / 4;                          // 4s for a full 0→1→0
      signal = 1 - Math.abs((sweepT % 2) - 1);    // triangle wave (debug override)
      return signal;
    }
    if (manual != null) { signal = manual; return signal; }

    // ---- real signal: strongest proximity×direction lead over hidden sats ----
    let best = 0;
    const targets = sample && sample.targets;
    if (targets && targets.length) {
      const { ox, oy, oz, dx, dy, dz } = sample;
      const al = Math.hypot(dx, dy, dz) || 1;
      const ax = dx / al, ay = dy / al, az = dz / al;   // normalized aim
      for (let i = 0; i < targets.length; i++) {
        const tg = targets[i];
        const vx = tg.x - ox, vy = tg.y - oy, vz = tg.z - oz;
        const dist = Math.hypot(vx, vy, vz) || 1e-6;
        const prox = clamp01((PROX_FAR - dist) / (PROX_FAR - PROX_NEAR));
        if (prox <= 0) continue;                          // out of range — skip
        const cosA = (ax * vx + ay * vy + az * vz) / dist;
        const ang = Math.acos(cosA < -1 ? -1 : cosA > 1 ? 1 : cosA);
        const dirW = clamp01((ANG_ZERO - ang) / (ANG_ZERO - ANG_FULL));
        const c = prox * dirW;
        if (c > best) best = c;
      }
    }
    signal = best;                                        // 0 at rest → no ticks
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
