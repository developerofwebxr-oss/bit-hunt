// Hunt state machine — the 4:20 clock and win/lose flow that closes Level 1's loop.
//
// States: idle → running → (won | lost) → (restart) idle→running.
//  - running: timer counts DOWN from HUNT_DURATION; catches are checked for the win.
//  - won:     all 21 caught before time — timer frozen (the clear time), then after the
//             last return flight lands + a short settle the vault door seals + portal flares.
//  - lost:    time hit 0 with sats loose — firing off, remaining sats frozen, door stays open.
// One reset() path clears EVERYTHING (timer, overlay, counter, caught set, portal, door).

// ---- tunables (seconds) ----
export const HUNT_DURATION = 260;   // 4:20
const WIN_SETTLE = 0.5;             // pause AFTER the last sat lands before the door seals
const URGENCY_AT = 30;             // last-30s urgency (pulse + per-second low tick)

// mm:ss
const fmt = (t) => { const s = Math.max(0, Math.round(t)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export function createHunt({ sats, vaultApi, scangun, total = 21, setReturnedHud = () => {} }) {
  let state = 'idle';
  let timeLeft = HUNT_DURATION;
  let settle = 0, winElapsed = 0, lastTickSec = -1, sealed = false;

  const timerEl = document.getElementById('timer');
  const startBtn = document.getElementById('btn-hunt');

  // ---- overlay (DOM; flat/mobile — the 3D door-seal/flare reads in VR) ----
  // Buttons: win → Hunt again · Next level (disabled) · Continue exploring;
  //          lose → Try again · Continue exploring.
  const overlay = document.createElement('div');
  overlay.id = 'hunt-overlay';
  overlay.innerHTML =
    '<div class="hunt-card">' +
      '<h2 id="hunt-title"></h2>' +
      '<div id="hunt-sub"></div>' +
      '<div class="hunt-actions">' +
        '<button id="hunt-again" class="ctl"></button>' +
        '<button id="hunt-next" class="ctl tip" data-tip="Coming soon" disabled>Next level →</button>' +
        '<button id="hunt-continue" class="ctl">Continue exploring</button>' +
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

  function drawTimer() {
    if (!timerEl) return;
    timerEl.textContent = fmt(timeLeft);
    timerEl.classList.toggle('urgent', state === 'running' && timeLeft <= URGENCY_AT);
  }
  function setBtn(label) { if (startBtn) startBtn.textContent = label; }
  function showOverlay(title, sub, win) {
    titleEl.textContent = title; subEl.textContent = sub;
    againBtn.textContent = win ? 'Hunt again' : 'Try again';
    nextBtn.style.display = win ? '' : 'none';        // "Next level →" only on a win
    overlay.classList.toggle('win', !!win); overlay.classList.toggle('lose', !win);
    overlay.classList.add('show');
  }

  // Drop out of the result overlay into free-roam: no hunt running, timer cleared,
  // but the world stays in its END state (vault sealed on win / open on lose, sats
  // as-is). H then starts a fresh hunt via start()→reset()+burst.
  function continueExploring() {
    state = 'idle'; timeLeft = HUNT_DURATION;
    overlay.classList.remove('show');
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
    overlay.classList.remove('show');
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
