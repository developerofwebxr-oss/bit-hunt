// Hunt state machine — the 4:20 clock and win/lose flow that closes Level 1's loop.
//
// States: idle → running → (won | lost) → (restart) idle→running.
//  - running: timer counts DOWN from HUNT_DURATION; catches are checked for the win.
//  - won:     all 21 caught before time — timer frozen (the clear time), then after the
//             last return flight lands + a short settle the vault door seals + portal flares.
//  - lost:    time hit 0 with sats loose — firing off, remaining sats frozen, door stays open.
// One reset() path clears EVERYTHING (timer, overlay, counter, caught set, portal, door).
// In VR/AR the DOM overlay is invisible, so the result also shows as an in-world,
// laser-selectable panel (Hunt again / Try again · Exit).
import * as THREE from 'three';

// ---- tunables (seconds) ----
export const HUNT_DURATION = 260;   // 4:20
const WIN_SETTLE = 0.5;             // pause AFTER the last sat lands before the door seals
const URGENCY_AT = 30;             // last-30s urgency (pulse + per-second low tick)

// mm:ss
const fmt = (t) => { const s = Math.max(0, Math.round(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function createHunt({ sats, vaultApi, scangun, total = 21, setReturnedHud = () => {}, renderer, camera, interaction }) {
  let state = 'idle';
  let timeLeft = HUNT_DURATION;
  let settle = 0, winElapsed = 0, lastTickSec = -1, sealed = false;

  const timerEl = document.getElementById('timer');
  const startBtn = document.getElementById('btn-hunt');

  // ---- overlay (DOM; flat/mobile — the 3D door-seal/flare reads in VR) ----
  // Buttons: win → Hunt again · Next level (disabled) · Exit;
  //          lose → Try again · Exit. ("Exit" closes the overlay into free-roam.)
  const overlay = document.createElement('div');
  overlay.id = 'hunt-overlay';
  overlay.innerHTML =
    '<div class="hunt-card">' +
      '<h2 id="hunt-title"></h2>' +
      '<div id="hunt-sub"></div>' +
      '<div class="hunt-actions">' +
        '<button id="hunt-again" class="ctl"></button>' +
        '<button id="hunt-next" class="ctl tip" data-tip="Coming soon" disabled>Next level →</button>' +
        '<button id="hunt-continue" class="ctl">Exit</button>' +
      '</div>' +
    '</div>';
  document.getElementById('hud').appendChild(overlay);
  const titleEl = overlay.querySelector('#hunt-title');
  const subEl = overlay.querySelector('#hunt-sub');
  const againBtn = overlay.querySelector('#hunt-again');
  const nextBtn = overlay.querySelector('#hunt-next');
  const continueBtn = overlay.querySelector('#hunt-continue');
  againBtn.addEventListener('click', () => { againBtn.blur(); start(); });
  nextBtn.addEventListener('click', () => { nextBtn.blur(); startNextLevel(); }); // disabled today (no-op)
  continueBtn.addEventListener('click', () => { continueBtn.blur(); continueExploring(); });
  // Esc closes the result overlay into free-roam. (input.js suppresses the pause-menu
  // route to Esc while the overlay is showing, so these don't conflict.)
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && overlay.classList.contains('show')) continueExploring();
  });

  // ---- VR in-world result panel (laser-selectable: Hunt again/Try again · Exit) ----
  const vr = (renderer && camera && interaction) ? createVrResult() : null;
  function createVrResult() {
    const W = 512, H = 300, cnv = document.createElement('canvas'); cnv.width = W; cnv.height = H;
    const g2 = cnv.getContext('2d');
    const tex = new THREE.CanvasTexture(cnv); tex.colorSpace = THREE.SRGBColorSpace;
    const group = new THREE.Group(); group.visible = false;
    const PW = 0.66, PH = PW * H / W;
    group.add(new THREE.Mesh(new THREE.PlaneGeometry(PW, PH), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false })));
    camera.add(group); group.position.set(0, 0.03, -0.9);
    const cyToPy = (cy) => PH / 2 - (cy / H) * PH, rowPH = (54 / H) * PH;
    const AGAIN_CY = 196, EXIT_CY = 252;
    let hovered = null, isLose = false, titleTxt = '', subTxt = '', againLabel = '';
    const rows = ['again', 'exit'].map((key, i) => {
      const cy = i ? EXIT_CY : AGAIN_CY;
      const mat = new THREE.MeshBasicMaterial({ color: 0x19ff9b, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(PW * 0.9, rowPH * 0.9), mat);
      m.position.set(0, cyToPy(cy), 0.002); m.renderOrder = 2; group.add(m);
      return { mesh: m, mat, key, cy };
    });
    function draw() {
      g2.clearRect(0, 0, W, H); g2.fillStyle = 'rgba(6,18,12,0.95)'; g2.fillRect(0, 0, W, H);
      g2.strokeStyle = isLose ? '#ff5a5a' : '#19ff9b'; g2.lineWidth = 4; g2.strokeRect(4, 4, W - 8, H - 8);
      g2.textAlign = 'center'; g2.textBaseline = 'middle';
      g2.fillStyle = isLose ? '#ff7a7a' : '#19ff9b'; g2.font = 'bold 40px monospace'; g2.fillText(titleTxt, W / 2, 60);
      g2.fillStyle = '#cffce6'; g2.font = '24px monospace'; g2.fillText(subTxt, W / 2, 112);
      rows.forEach((r) => {
        const hov = r.key === hovered;
        if (hov) { g2.fillStyle = 'rgba(25,255,155,0.18)'; g2.fillRect(20, r.cy - 27, W - 40, 54); }
        g2.fillStyle = hov ? '#eafff5' : '#cffce6'; g2.font = '28px monospace';
        g2.fillText(r.key === 'again' ? againLabel : 'Exit', W / 2, r.cy);
      });
      g2.textAlign = 'left'; tex.needsUpdate = true;
    }
    function setHover(key, on) {
      const next = on ? key : (hovered === key ? null : hovered);
      if (next === hovered) return;
      hovered = next; rows.forEach((r) => (r.mat.opacity = r.key === hovered ? 0.28 : 0)); draw();
    }
    let registered = false;
    return {
      show(title, sub, label, lose) {
        titleTxt = title; subTxt = sub; againLabel = label; isLose = lose; hovered = null;
        rows.forEach((r) => (r.mat.opacity = 0)); draw(); group.visible = true;
        if (!registered) { for (const r of rows) interaction.addTarget(r.mesh, () => (r.key === 'again' ? start() : continueExploring()), { onHover: (h) => setHover(r.key, h) }); registered = true; }
      },
      hide() { group.visible = false; if (registered) { for (const r of rows) interaction.removeTarget(r.mesh); registered = false; } hovered = null; },
    };
  }

  function drawTimer() {
    if (!timerEl) return;
    timerEl.textContent = fmt(timeLeft);
    timerEl.classList.toggle('urgent', state === 'running' && timeLeft <= URGENCY_AT);
  }
  function setBtn(label) { if (startBtn) startBtn.textContent = label; }
  function showOverlay(title, sub, win) {
    // DOM overlay (flat/mobile)
    titleEl.textContent = title; subEl.textContent = sub;
    againBtn.textContent = win ? 'Hunt again' : 'Try again';
    nextBtn.style.display = win ? '' : 'none';        // "Next level →" only on a win
    overlay.classList.toggle('win', !!win); overlay.classList.toggle('lose', !win);
    overlay.classList.add('show');
    // in-world panel (VR/AR — the DOM overlay is invisible in a headset)
    if (renderer?.xr?.isPresenting) vr?.show(title, sub, win ? 'Hunt again' : 'Try again', !win);
  }
  function hideOverlays() { overlay.classList.remove('show'); vr?.hide(); }

  // Drop out of the result overlay into free-roam: no hunt running, timer cleared,
  // but the world stays in its END state (vault sealed on win / open on lose, sats
  // as-is). H then starts a fresh hunt via start()→reset()+burst.
  function continueExploring() {
    state = 'idle'; timeLeft = HUNT_DURATION;
    hideOverlays();
    drawTimer(); setBtn('Start Hunt');
  }
  // Level 2 flow point — button is disabled until it lands.
  function startNextLevel() { console.log('[hunt] startNextLevel() — coming soon (Level 2 stub)'); }

  function start() {
    reset();
    sats.burst();
    state = 'running'; timeLeft = HUNT_DURATION; lastTickSec = -1;
    drawTimer(); setBtn('Reset');
  }
  function reset() {
    state = 'idle'; timeLeft = HUNT_DURATION; settle = WIN_SETTLE; winElapsed = 0; sealed = false;
    sats.reset();                 // clears caught + catch flash + portal glow + closes the door
    setReturnedHud(0);
    hideOverlays();
    drawTimer(); setBtn('Start Hunt');
  }
  function onCatch() {
    if (state !== 'running') return;
    if (sats.caughtCount >= total) {          // WIN: freeze the clock now (the clear time)
      state = 'won'; winElapsed = HUNT_DURATION - timeLeft; settle = WIN_SETTLE; sealed = false;
    }
  }
  function lose() {
    state = 'lost';
    const got = total - sats.caughtCount;
    sats.freeze();                            // remaining sats stop idling
    showOverlay("TIME'S UP", `${got} got away`, false);
    // vault door stays OPEN — the job isn't done
  }
  function update(dt) {
    if (state === 'running') {
      timeLeft = Math.max(0, timeLeft - dt);
      if (timeLeft <= URGENCY_AT && timeLeft > 0) {           // per-second low urgency tick
        const sec = Math.ceil(timeLeft);
        if (sec !== lastTickSec) { lastTickSec = sec; scangun?.urgencyTick?.(); }
      }
      drawTimer();
      if (timeLeft <= 0) lose();
    } else if (state === 'won' && !sealed) {
      if (!sats.anyReturning) {                                // last coin has landed in the vault
        settle -= dt;
        if (settle <= 0) {
          sealed = true;
          vaultApi?.closeVault?.();
          vaultApi?.flarePortal?.();
          showOverlay('VAULT SECURED', `21 / 21 in ${fmt(winElapsed)}`, true);
        }
      }
    }
  }

  drawTimer();
  return { start, reset, update, onCatch, isRunning: () => state === 'running', get state() { return state; } };
}
