// Unified input layer — the ONE place that maps raw devices to game intents.
// Implements the webxr-threejs "Controller & Input Standard" button map.
//
// VR: xr-standard gamepad. We key by `handedness` (reliable for xr-standard) and
// read by index. Querying components by id via WebXR input profiles is the
// documented-preferred path; index mapping is the sanctioned fallback and is
// correct for Quest's xr-standard profile.
//   buttons[0] trigger · [1] grip · [3] stick-press · [4] primary (A/X) · [5] secondary (B/Y)
//   axes[2],[3] thumbstick X/Y
//
// Everything downstream (locomotion, interaction, pause menu) reads `state`.
// Edge flags (jump, flyToggle, pause, scanner, selectL/R) are true for
// exactly one frame; held flags (move, turn, grips, triggers) reflect now.

import { SPRINT_MAG } from './comfort.js';

const DEAD = 0.15;
const applyDead = (v) => (Math.abs(v) < DEAD ? 0 : v);

export function createInput({ renderer, canvas }) {
  let vrPeakMag = 0;   // logged so the Quest's full-deflection magnitude is observable
  const state = {
    source: 'flat',            // 'flat' | 'mobile' | 'vr'
    move: { x: 0, y: 0 },       // x = strafe (+right), y = forward (+fwd)
    moveMag: 0,
    sprint: false,
    turn: 0,                    // continuous right-stick X (VR only; flat turns via mouse-look)
    // edges (one frame):
    jump: false, flyToggle: false, pause: false, scanner: false,
    selectL: false, selectR: false,
    // held:
    triggerL: false, triggerR: false, gripL: false, gripR: false,
    grabFlat: false,           // desktop grab held (E or right-click), parity w/ VR grip
    // raw analog triggers 0..1
    triggerValL: 0, triggerValR: 0,
  };

  // ---- buffered one-frame edges from async sources (keyboard / DOM) ----
  // Set by event handlers, drained by pollFlat, cleared at end of update().
  const edgeBuf = { jump: false, pause: false, scanner: false, fly: false };

  // ---- keyboard (flat) — bindings follow the cross-input parity table ----
  const keys = new Set();
  const down = (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'Space') edgeBuf.jump = true;
    // menu: Esc (flat). When pointer-lock (free look) is active, Esc is the browser's
    // lock-release — don't also open the menu on that press. When the win/lose overlay
    // is up, Esc closes THAT (hunt.js) — don't also open the menu. (M is scanner-sound
    // now, not a menu alias, so it can't double-fire the menu.)
    if (e.code === 'Escape' && !document.pointerLockElement
        && !document.getElementById('hunt-overlay')?.classList.contains('show')) edgeBuf.pause = true;
    if (e.code === 'KeyF') edgeBuf.fly = true;     // fly toggle (gated by ENABLE_FLY)
    if (e.code === 'KeyY') edgeBuf.scanner = true; // game verb (scanner) — B is a free slot now
  };
  const up = (e) => keys.delete(e.code);
  window.addEventListener('keydown', down);
  window.addEventListener('keyup', up);

  // ---- desktop grab: E (hold) primary, right-click (hold) alias ----
  let rightMouseDown = false;
  window.addEventListener('mousedown', (e) => { if (e.button === 2) rightMouseDown = true; });
  window.addEventListener('mouseup', (e) => { if (e.button === 2) rightMouseDown = false; });
  // suppress the context menu over the canvas so right-click can mean "grab"
  canvas?.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- mobile joystick + buttons ----
  const joy = { active: false, id: null, cx: 0, cy: 0, dx: 0, dy: 0, r: 55 };
  const joyEl = document.getElementById('joystick');
  const joyKnob = document.getElementById('joystick-knob');
  const jumpBtn = document.getElementById('btn-jump');
  if (joyEl) {
    const start = (e) => {
      const t = e.changedTouches ? e.changedTouches[0] : e;
      const rect = joyEl.getBoundingClientRect();
      joy.active = true; joy.id = t.identifier ?? 'mouse';
      joy.cx = rect.left + rect.width / 2; joy.cy = rect.top + rect.height / 2;
      moveJoy(t); e.preventDefault();
    };
    const moveJoy = (t) => {
      let dx = t.clientX - joy.cx, dy = t.clientY - joy.cy;
      const len = Math.hypot(dx, dy) || 1;
      const clamp = Math.min(len, joy.r) / joy.r;
      dx = (dx / len) * clamp; dy = (dy / len) * clamp;
      joy.dx = dx; joy.dy = dy;
      if (joyKnob) joyKnob.style.transform = `translate(${dx * joy.r}px, ${dy * joy.r}px)`;
    };
    const moveEvt = (e) => {
      if (!joy.active) return;
      const t = [...(e.changedTouches || [e])].find((x) => (x.identifier ?? 'mouse') === joy.id);
      if (t) { moveJoy(t); e.preventDefault(); }
    };
    const end = () => { joy.active = false; joy.dx = joy.dy = 0; if (joyKnob) joyKnob.style.transform = ''; };
    joyEl.addEventListener('touchstart', start, { passive: false });
    window.addEventListener('touchmove', moveEvt, { passive: false });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
  }
  if (jumpBtn) {
    jumpBtn.addEventListener('touchstart', (e) => { edgeBuf.jump = true; e.preventDefault(); }, { passive: false });
    jumpBtn.addEventListener('click', () => { edgeBuf.jump = true; });
  }
  // on-screen game-verb button (mobile) — Y (scanner). Grab is tap-hold on a crate.
  const bindTapBtn = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('touchstart', (e) => { edgeBuf[key] = true; e.preventDefault(); }, { passive: false });
    el.addEventListener('click', () => { edgeBuf[key] = true; });
  };
  bindTapBtn('btn-scanner', 'scanner');

  // ---- VR per-hand previous button snapshots (for edges) ----
  const prev = { left: {}, right: {} };
  const pressedEdge = (hand, idx, gp) => {
    const cur = !!gp.buttons[idx]?.pressed;
    const was = !!prev[hand][idx];
    prev[hand][idx] = cur;
    return cur && !was;
  };

  function pollVR() {
    const session = renderer.xr.getSession();
    if (!session) return false;
    let sawController = false;
    let mx = 0, my = 0, turn = 0;
    let jump = false, flyToggle = false, pause = false, scanner = false;
    let selectL = false, selectR = false;
    let gripL = false, gripR = false, triggerL = false, triggerR = false, tvL = 0, tvR = 0;

    for (const src of session.inputSources) {
      const gp = src.gamepad;
      const hand = src.handedness;
      if (!gp || (hand !== 'left' && hand !== 'right')) continue;
      sawController = true;
      const ax = gp.axes || [];
      const stickX = applyDead(ax[2] ?? ax[0] ?? 0);
      const stickY = applyDead(ax[3] ?? ax[1] ?? 0);
      const trig = gp.buttons[0]?.value ?? 0;
      const trigPressed = !!gp.buttons[0]?.pressed;
      const gripPressed = !!gp.buttons[1]?.pressed;

      if (hand === 'left') {
        mx = stickX; my = -stickY;          // forward = stick up (-Y)
        triggerL = trigPressed; tvL = trig; gripL = gripPressed;
        if (pressedEdge('left', 0, gp)) selectL = true;
        if (pressedEdge('left', 4, gp)) pause = true;     // X → pause/menu
        if (pressedEdge('left', 5, gp)) scanner = true;   // Y → scanner stub
      } else {
        turn = stickX;
        triggerR = trigPressed; tvR = trig; gripR = gripPressed;
        if (pressedEdge('right', 0, gp)) selectR = true;
        if (pressedEdge('right', 3, gp)) flyToggle = true; // stick-press → fly
        if (pressedEdge('right', 4, gp)) jump = true;      // A → jump
        // B (right button 5) is a free slot now — left grip is the grab verb (handled in main)
      }
    }
    if (!sawController) return false;

    const mag = Math.min(1, Math.hypot(mx, my));
    // log the escalating peak stick magnitude so full-deflection can be read on-device
    if (mag > vrPeakMag + 0.02) { vrPeakMag = mag; console.log(`[input] VR stick peak magnitude ${mag.toFixed(3)} (sprint ≥ ${SPRINT_MAG})`); }
    state.source = 'vr';
    state.move.x = mx; state.move.y = my; state.moveMag = mag;
    state.sprint = false;             // VR sprint is sustained full-push (handled in locomotion)
    state.turn = turn;
    state.jump = jump; state.flyToggle = flyToggle; state.pause = pause;
    state.scanner = scanner;
    state.selectL = selectL; state.selectR = selectR;
    state.gripL = gripL; state.gripR = gripR;
    state.grabFlat = false; // VR grab uses grip per-hand, not the desktop flag
    state.triggerL = triggerL; state.triggerR = triggerR;
    state.triggerValL = tvL; state.triggerValR = tvR;
    return true;
  }

  function pollFlat() {
    let x = 0, y = 0;
    if (keys.has('KeyW') || keys.has('ArrowUp')) y += 1;
    if (keys.has('KeyS') || keys.has('ArrowDown')) y -= 1;
    if (keys.has('KeyD') || keys.has('ArrowRight')) x += 1;
    if (keys.has('KeyA') || keys.has('ArrowLeft')) x -= 1;

    // mobile joystick overrides if active (y inverted: up on screen = forward)
    if (joy.active || joy.dx || joy.dy) { x = joy.dx; y = -joy.dy; state.source = 'mobile'; }
    else state.source = 'flat';

    const mag = Math.min(1, Math.hypot(x, y));
    if (mag > 1e-3) { x /= Math.max(1, mag); y /= Math.max(1, mag); }
    state.move.x = x; state.move.y = y; state.moveMag = mag;
    state.sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
    state.turn = 0; // flat turn is mouse-look (controls.js)

    state.jump = edgeBuf.jump;
    state.pause = edgeBuf.pause;
    state.scanner = edgeBuf.scanner;
    state.flyToggle = edgeBuf.fly;                 // F → fly toggle (gated by ENABLE_FLY)
    state.grabFlat = keys.has('KeyE') || rightMouseDown; // E-hold / right-click-hold
    state.selectL = state.selectR = false;
    state.gripL = state.gripR = state.triggerL = state.triggerR = false;
  }

  function update() {
    const vr = renderer.xr.isPresenting && pollVR();
    if (!vr) pollFlat();
    edgeBuf.jump = edgeBuf.pause = edgeBuf.scanner = edgeBuf.fly = false;
  }

  // let DOM controls inject one-frame edges (drained next update)
  function pulse(name) { if (name in edgeBuf) edgeBuf[name] = true; }

  return { state, update, pulse };
}
