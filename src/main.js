// Bit-Hunt — Prompt 1: scene assembly + multi-device viewing.
// Rig holds the camera. Eye height lives on the CAMERA in flat mode only; in
// XR the headset supplies head pose relative to local-floor, so the rig stays
// at floor level (no double-counting).
import * as THREE from 'three';
import { buildRoom, ROOM } from './room.js';
import { buildLayout } from './layout.js';
import { buildVault } from './vault.js';
import { createControls, isCoarsePointer } from './controls.js';
import { createModeSwitcher } from './modeswitcher.js';
import { createPostFX } from './postfx.js';
import { createInput } from './input.js';
import { createCollision } from './collision.js';
import { createLocomotion } from './locomotion.js';
import { createInteraction } from './interaction.js';
import { createEnvironment } from './environment.js';
import { createArBounds } from './arbounds.js';
import { createPauseMenu } from './pausemenu.js';
import { createVignette } from './vignette.js';
import { createSats, SAT_COUNT } from './sats.js';
import { createScanner } from './scanner.js';
import { createScangun, GUN_MOUNT_ROT } from './scangun.js';
import { createLeftHand, HAND_MOUNT_ROT } from './lefthand.js';
import { createGrab } from './grab.js';
import { createHunt } from './hunt.js';
import { hapticPulse } from './haptics.js';
import { comfort } from './comfort.js';

const HUNT_SEED = 1337; // single seed -> swap for a server seed in v4 (multiplayer)
let sats = null;
const scanner = createScanner();   // the single scanner-signal seam (real: aim × proximity)
let scangun = null;
let leftHand = null;               // VR/AR left-hand glove (the grab hand)
let grab = null;                   // heavy grab mechanic (drag crates on the floor)
let arBounds = null;               // AR comfort layer (boundary shimmer + ground disc)
let hunt = null;

const EYE_HEIGHT = 1.6;
const app = document.getElementById('app');

// ---- renderer ----
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.xr.enabled = true;
app.appendChild(renderer.domElement);
const canvas = renderer.domElement;
if (isCoarsePointer()) document.body.classList.add('mobile'); // show joystick/jump

// ---- scene + atmosphere ----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05100b);
scene.fog = new THREE.FogExp2(0x05100b, 0.022);

// ---- rig + camera ----
const rig = new THREE.Group();
rig.name = 'rig';
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, EYE_HEIGHT, 0);
rig.add(camera);
rig.position.set(0, 0, 5.0); // spawn in the clear centre aisle, facing the vault (-Z)
                              // (clear of the mining rig at (1.0, 3.6))
scene.add(rig);

// ---- lights (few; emissive + bloom do the work) ----
const hemi = new THREE.HemisphereLight(0xbfffe0, 0x10201a, 1.05);
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff, 0.5);
dir.position.set(6, 10, 4);
scene.add(dir);

// ---- post-processing (flat mode) ----
const postfx = createPostFX({ renderer, scene, camera });

// ---- input + locomotion + interaction systems ----
const collision = createCollision();
const controls = createControls({ rig, camera, canvas });
const input = createInput({ renderer, canvas });
const locomotion = createLocomotion({ rig, camera, input, collision, renderer });
const vignette = createVignette({ camera });
let pauseMenu = null; // set after modeswitcher (needs its exit path)
const interaction = createInteraction({
  renderer, scene, camera, rig, input, canvas, isPaused: () => !!pauseMenu?.isOpen(),
});
// Trigger/click/tap = fire(): muzzle flash + hoop pulse always; shoot-to-return on hit.
interaction.setFireHook((hand) => { scangun?.resumeAudio(); scangun?.flash(); fireShot(hand); });

let environment = null;
let currentMode = 'Screen';
const modeswitcher = createModeSwitcher({
  renderer,
  onModeChange: (mode) => {
    currentMode = mode;
    const inXR = mode === 'VR' || mode === 'AR';
    controls.setEnabled(!inXR);
    pauseMenu?.close();
    if (inXR) {
      camera.position.y = 0;                       // headset supplies eye height
      renderer.toneMapping = THREE.ACESFilmicToneMapping; // direct render in XR
      if (mode === 'AR') scene.background = null;  // passthrough
    } else {
      camera.position.set(0, EYE_HEIGHT, 0);
      camera.rotation.set(0, 0, 0);
      renderer.toneMapping = THREE.NoToneMapping;  // composer/OutputPass handles it
      scene.background = new THREE.Color(0x05100b);
    }
    mountGun(mode);                                // hand-mount in XR, viewmodel in flat
    // Free look is a flat-mode concept — the whole #controls bar is hidden in XR (CSS
    // body.xr-active), and we also disable/grey the button so it's inert if ever shown.
    document.getElementById('btn-freelook')?.toggleAttribute('disabled', inXR);
    environment?.applyMode(mode);                  // AR shell-off + collision bounds
  },
});
pauseMenu = createPauseMenu({
  input, camera, renderer, interaction,
  onExit: () => modeswitcher.exitToScreen(),       // X menu "Exit to screen mode"
  getHunt: () => hunt,                             // enables the in-VR Start/Reset Hunt row
});
// on-screen menu button (flat/mobile) → same as Left-X
document.getElementById('btn-pause')?.addEventListener('click', () => pauseMenu.toggle());

// ---- aim ray (the gun's muzzle ray): right controller in XR, camera/crosshair in flat.
// Shared by the scanner sample and the shot, so "where it scans" == "where it shoots". ----
const _so = new THREE.Vector3(), _sd = new THREE.Vector3(), _sm = new THREE.Matrix4();
function aimRay() {
  if (renderer.xr.isPresenting) {
    // VR: the LASER (target-ray) is aim truth. Cast the shot from the target-ray pose so the hit
    // ray is IDENTICAL to the laser by construction (grip pose is tilted ~45° on Quest, so the gun
    // mesh's forward must NOT drive the shot — the gun is only visually aligned to this ray).
    const src = interaction.getController('right');
    src.updateWorldMatrix?.(true, false);
    _so.setFromMatrixPosition(src.matrixWorld);
    _sm.identity().extractRotation(src.matrixWorld);
    _sd.set(0, 0, -1).applyMatrix4(_sm).normalize();
  } else {
    camera.getWorldPosition(_so);                    // flat: aim = where you look (crosshair)
    camera.getWorldDirection(_sd);
  }
  return { ox: _so.x, oy: _so.y, oz: _so.z, dx: _sd.x, dy: _sd.y, dz: _sd.z };
}
function scannerSample() {
  const r = aimRay();
  r.targets = sats ? sats.targets : [];
  return r;
}

// ---- the shot: catch a hidden sat along the aim ray (LOS-checked). On catch:
// rising ding (respects scanner-sound mute), counter tick, VR haptic (if enabled).
// Miss/blocked = nothing beyond the muzzle flash already fired. ----
function fireShot(hand) {
  if (!sats || pauseMenu?.isOpen() || !hunt?.isRunning()) return;   // only during a running hunt
  const r = aimRay();
  const caught = sats.tryCatch(r.ox, r.oy, r.oz, r.dx, r.dy, r.dz);
  if (!caught) return;
  scangun?.catchArc(caught.pos);                          // lightning bolt arcs to the caught sat
  scangun?.ding();
  updateReturnedHud(sats.caughtCount);
  hunt.onCatch();                                          // check for the 21/21 win
  hapticPulse(renderer, { hand: hand || 'right', intensity: 0.7, duration: 60 }); // self-gates on comfort.haptics + XR
}

// ---- "X / 21 returned" HUD (emphasis pulse on change) ----
const returnedEl = document.getElementById('returned');
function updateReturnedHud(n) {
  if (!returnedEl) return;
  returnedEl.textContent = `${n} / ${SAT_COUNT} returned`;
  returnedEl.classList.remove('bump'); void returnedEl.offsetWidth; returnedEl.classList.add('bump');
}

// ---- hand mounting (gun on the RIGHT grip, glove on the LEFT) ----
// The grip spaces are rig-parented, poll-driven Groups (see interaction.js), so mounting a
// viewmodel to one guarantees it renders and tracks. Mounting is IDEMPOTENT and re-checked
// every frame by ensureHandMounts(), so it can NOT depend on any connect event ever firing
// (the event is only a fast path) NOR on the asset being loaded at connect time — whichever
// frame both the grip is present and the viewmodel exists, the mount happens. This is the
// belt-and-suspenders fix for "gun/glove absent on the real Quest."
function isXR(mode = currentMode) { return mode === 'VR' || mode === 'AR'; } // hoisted: mountGun runs during modeswitcher init
function mountHandTo(hand, grip) {
  if (!grip || !isXR()) return;
  if (hand === 'right') { if (scangun && scangun.object.parent !== grip) scangun.mountHand(grip); }
  else if (hand === 'left') { if (leftHand && leftHand.object.parent !== grip) leftHand.mountHand(grip); }
}
// Called every VR frame: mount each hand whose grip is present and whose viewmodel isn't yet
// riding it. Guaranteed by the poll alone — no reliance on the connect event.
function ensureHandMounts() {
  if (!isXR()) return;
  if (interaction.isConnected('right')) mountHandTo('right', interaction.getGrip('right'));
  if (interaction.isConnected('left')) mountHandTo('left', interaction.getGrip('left'));
}
function mountGun(mode) {                              // (name kept; now mounts both hands)
  if (isXR(mode)) {
    ensureHandMounts();                               // mount whatever's already present; poll re-tries the rest
  } else {
    scangun?.mountFlat(camera);                        // flat: gun viewmodel only, no glove
    leftHand?.unmount();
  }
}
interaction.onControllerConnected((hand, grip) => mountHandTo(hand, grip)); // fast path only

// ---- align hand viewmodels to the TARGET-RAY (fix the ~45° grip tilt) ----
// The model rides the grip (correct fist position) but its ORIENTATION is set each frame so its
// forward (-Z) is parallel to the laser: localQuat = gripWorldQuat⁻¹ · rayWorldQuat · baseOffset.
// baseOffset (GUN/HAND_MOUNT_ROT, default 0) is the on-device fine-tune for the mesh's own axis.
const _qGrip = new THREE.Quaternion(), _qRay = new THREE.Quaternion();
const _gunBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(GUN_MOUNT_ROT.x, GUN_MOUNT_ROT.y, GUN_MOUNT_ROT.z));
const _handBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(HAND_MOUNT_ROT.x, HAND_MOUNT_ROT.y, HAND_MOUNT_ROT.z));
function alignModelToRay(model, hand, base) {
  if (!model || model.parent !== interaction.getGrip(hand) || !interaction.isConnected(hand)) return;
  interaction.getGrip(hand).getWorldQuaternion(_qGrip);
  interaction.getController(hand).getWorldQuaternion(_qRay);
  model.quaternion.copy(_qGrip).invert().multiply(_qRay).multiply(base);
}
function alignHandsToRay() {
  if (!isXR()) return;
  alignModelToRay(scangun?.object, 'right', _gunBase);
  alignModelToRay(leftHand?.object, 'left', _handBase);
}
// angular gap between the gun's forward and the laser — logged/shown; ~0 once aligned.
const _vGun = new THREE.Vector3(), _vRay = new THREE.Vector3(), _qTmp = new THREE.Quaternion();
function aimDeltaDeg() {
  if (!isXR() || !scangun?.object || !interaction.isConnected('right')) return null;
  _vGun.set(0, 0, -1).applyQuaternion(scangun.object.getWorldQuaternion(_qTmp));
  _vRay.set(0, 0, -1).applyQuaternion(interaction.getController('right').getWorldQuaternion(_qTmp));
  return THREE.MathUtils.radToDeg(_vGun.angleTo(_vRay));
}

// Control-bar buttons must not keep DOM focus: a focused <button> is activated by
// Space/Enter, so jumping (Space) would re-fire the last-clicked control — e.g.
// after enabling Free look, the button stays focused and Space toggles pointer-lock
// back OFF. Blur on click so keys never reach a control. (Fixes free-look-after-jump.)
document.querySelectorAll('#controls .ctl').forEach((b) => b.addEventListener('click', () => b.blur()));

// ---- Start Hunt / Reset (button + H); R always resets. Overlay actions restart via hunt.start() ----
function triggerHunt() { if (hunt) hunt.isRunning() ? hunt.reset() : hunt.start(); }
document.getElementById('btn-hunt')?.addEventListener('click', triggerHunt);
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.code === 'KeyH') triggerHunt();
  else if (e.code === 'KeyR') hunt?.reset();
  // ---- scanner-signal DEBUG (stub phase): sweep the seam 0→1 by hand ----
  else if (e.code === 'Backslash') { const on = scanner.toggleSweep(); modeswitcher.setStatus(`scanner sweep: ${on ? 'ON (auto 0→1)' : 'off (idle)'}`); }
  else if (e.code === 'BracketRight') modeswitcher.setStatus(`scanner: ${Math.round(scanner.stepManual(+0.1) * 100)}%`);
  else if (e.code === 'BracketLeft') modeswitcher.setStatus(`scanner: ${Math.round(scanner.stepManual(-0.1) * 100)}%`);
  // M = scanner sound toggle (same flag as the pause-menu row; comfort keeps them in sync)
  else if (e.code === 'KeyM') { const on = comfort.toggle('sound'); modeswitcher.setStatus(`scanner sound: ${on ? 'on' : 'off'}`); }
});
// Scanner sound lives in comfort ('sound', default ON, persisted): the pause-menu row
// and the M key flip the SAME flag; scangun mutes when it's off. One source of truth.
comfort.onChange((s) => scangun?.setMuted(!s.sound));
// flat/mobile: click/tap = fire() (muzzle flash + hoop pulse + shoot-to-return),
// matching the VR trigger. Also unlocks WebAudio on the first gesture.
// Mobile grab discrimination: a tap that LANDS ON a crate and is HELD grabs it (drag to
// shove); a quick tap still fires. Desktop keeps instant click-to-shoot (its grab is E /
// right-click, handled in updateGrab), so this deferral only applies to coarse pointers.
const mobileGrab = { pending: null, active: false };
const _rc = new THREE.Raycaster(), _ndc = new THREE.Vector2();
function grabUnderPointer(e) {
  if (!grab) return null;
  const r = canvas.getBoundingClientRect();
  _ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  _rc.setFromCamera(_ndc, camera);
  return grab.pickRay(_rc.ray.origin, _rc.ray.direction, 2.5);
}
// Tap-vs-drag: a shot fires ONLY on pointerup that stayed within TAP_MAX_PX and under
// TAP_MAX_MS — so click-drag is look-only (no phantom shots), and firing on UP (not down)
// means a click can't be swallowed by pointer-lock acquisition (the "dead first click").
// Mobile keeps the grab discrimination: tap-hold on a crate = grab, short tap = shoot, drag = look.
const TAP_MAX_PX = 5, TAP_MAX_MS = 250;
let press = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== undefined && e.button !== 0) return;   // primary only
  if (renderer.xr.isPresenting || pauseMenu?.isOpen()) return;
  scangun?.resumeAudio();
  press = { x: e.clientX, y: e.clientY, t: performance.now(), dist: 0 };
  if (isCoarsePointer()) {
    const prop = grabUnderPointer(e);
    if (prop) mobileGrab.pending = { prop, t0: performance.now() }; // may become a grab (updateGrab)
  }
});
window.addEventListener('pointermove', (e) => {
  if (press) press.dist += Math.hypot(e.movementX || 0, e.movementY || 0); // works locked & unlocked
});
window.addEventListener('pointerup', (e) => {
  const p = press; press = null;
  if (mobileGrab.active) { mobileGrab.active = false; grab?.release(); mobileGrab.pending = null; return; } // grab end ≠ shot
  mobileGrab.pending = null;
  if (!p || renderer.xr.isPresenting || pauseMenu?.isOpen()) return;
  const moved = Math.max(p.dist, Math.hypot((e.clientX ?? p.x) - p.x, (e.clientY ?? p.y) - p.y));
  const dur = performance.now() - p.t;
  if (moved < TAP_MAX_PX && dur < TAP_MAX_MS) { scangun?.flash(); fireShot(null); } // tap = shoot; drag = look only
});

// ---- build the world ----
let vaultApi = null;
modeswitcher.setStatus('loading assets…');
Promise.all([
  Promise.resolve(buildRoom(scene)),
  buildLayout(scene),
  buildVault(scene, new THREE.Vector3(0, 0, -5.5)),
])
  .then(([room, layout, v]) => {
    vaultApi = v;
    // register colliders (single source of truth from layout + vault)
    for (const b of layout.colliders) collision.addBox(b);
    for (const s of layout.surfaces) collision.addSurface(s);
    for (const r of layout.ramps) collision.addRamp(r);
    if (v.collider) collision.addBox(v.collider);
    // AR comfort layer (boundary shimmer + ground disc) — AR-only, toggled by the environment
    arBounds = createArBounds({ scene, half: ROOM.size / 2, wallHeight: ROOM.height, floorY: 0 });
    // environment adapter owns the shell + AR comfort layer; apply the current mode now
    environment = createEnvironment({ shell: room.group, collision, half: ROOM.size / 2, arBounds });
    environment.applyMode(currentMode);

    // ---- Gameplay Phase 1: vault burst + 21 hidden sats (seeded) ----
    const cover = {
      ...layout.cover,
      center: [0, 0], eyeY: EYE_HEIGHT, coinR: 0.13,
      vault: v.collider,
      colliders: [...layout.colliders, v.collider], // occlusion + embedding source
    };
    sats = createSats({ scene, vaultApi: v, coinObj: layout.coinObj, cover, seed: HUNT_SEED });
    // (exposed via the window.__sat `sats` getter)

    // ---- Heavy grab: drag the vault crates along the floor (colliders move live) ----
    grab = createGrab({ collision, roomHalf: ROOM.size / 2 - 0.5 });
    for (const p of layout.grabbables) grab.register(p);

    // ---- Scanner gun + left-hand glove: mounted via one shared connected-driven path ----
    return Promise.all([createScangun({ scene, scanner }), createLeftHand({ scene })]).then(([g, lh]) => {
      scangun = g;                                 // exposed via window.__sat getter
      leftHand = lh;                               // VR/AR grab hand (no flat viewmodel)
      g.setMuted(!comfort.get('sound'));           // honor the persisted scanner-sound setting
      mountGun(currentMode);                       // viewmodels now; re-mount on XR entry / connect
      // ---- Hunt: the 4:20 clock + win/lose flow (owns timer HUD + overlay + start button) ----
      hunt = createHunt({ sats, vaultApi: v, scangun: g, total: SAT_COUNT, setReturnedHud: updateReturnedHud, renderer, camera, interaction, onReset: () => grab?.resetAll() });
      modeswitcher.setStatus('ready · press Start Hunt (H)');
      reportStats();
    });
  })
  .catch((err) => {
    modeswitcher.setStatus('load error: ' + (err.message || err));
    console.error(err);
  });

modeswitcher.detect();

// ---- resize (mobile visualViewport aware) ----
function resize() {
  const vv = window.visualViewport;
  const w = vv ? vv.width : window.innerWidth;
  const h = vv ? vv.height : window.innerHeight;
  const dpr = Math.min(window.devicePixelRatio, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  postfx.setSize(w, h, dpr);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 250));
window.visualViewport?.addEventListener('resize', resize);
window.visualViewport?.addEventListener('scroll', resize);
resize();

// ---- heavy grab driver (VR left grip / desktop E·right-click / mobile tap-hold) ----
const _gp = new THREE.Vector3(), _go = new THREE.Vector3(), _gd = new THREE.Vector3();
const MOBILE_HOLD_MS = 160;
function floorTarget(origin, dir, maxD) {          // camera ray ∩ floor (y=0), clamped to maxD
  let d = Math.abs(dir.y) > 1e-4 ? -origin.y / dir.y : maxD;
  if (!(d > 0)) d = maxD;
  d = Math.min(d, maxD);
  return { x: origin.x + dir.x * d, z: origin.z + dir.z * d };
}
function updateGrab(dt, paused) {
  if (!grab) return;
  if (paused) { if (grab.isHeld()) grab.release(); return; }
  const s = input.state;
  if (renderer.xr.isPresenting) {
    // VR: squeeze the LEFT grip while the glove is near a crate → grab; the crate then follows the
    // hand's MOVEMENT at the grabbed offset (push/pull/side), not crawling toward the hand.
    const gripL = interaction.getGrip('left');
    if (s.gripL && gripL) {
      gripL.getWorldPosition(_gp);
      if (!grab.isHeld()) {
        const p = grab.pickNearest(_gp.x, _gp.z);
        if (p) { grab.grab(p, _gp.x, _gp.z); hapticPulse(renderer, { hand: 'left', intensity: 0.6, duration: 40 }); }
      }
      if (grab.isHeld()) grab.drag(dt, _gp.x, _gp.z);
    } else if (grab.isHeld()) grab.release();
    return;
  }
  // desktop (E / right-click) or an active mobile grab: the "controller point" is the looked-at
  // floor point; the crate holds its grabbed offset from it, so it moves in every direction.
  if (mobileGrab.pending && !mobileGrab.active && (performance.now() - mobileGrab.pending.t0) > MOBILE_HOLD_MS) {
    mobileGrab.active = true; // the block below grabs pending.prop once we have the floor point
  }
  if (s.grabFlat || mobileGrab.active) {
    camera.getWorldPosition(_go); camera.getWorldDirection(_gd);
    const t = floorTarget(_go, _gd, 2.5);
    if (!grab.isHeld()) {
      const p = mobileGrab.active ? mobileGrab.pending?.prop : grab.pickRay(_go, _gd, 2.5);
      if (p) grab.grab(p, t.x, t.z);
    }
    if (grab.isHeld()) grab.drag(dt, t.x, t.z);
  } else if (grab.isHeld()) grab.release();
}

// ---- in-VR diagnostic readout: device-side truth the emulated checks can't show ----
// A tiny always-on panel in the headset reporting what actually reaches the game on-device:
// input-source count, per-hand presence, gun/glove mounted, live stick magnitude, and the
// last caught render-loop error. This is the reporting-from-the-device that turns a blind
// strap-in/guess cycle into an informed one. (Hidden entirely in flat/mobile.)
const vrDiag = (() => {
  const W = 512, H = 116, cnv = document.createElement('canvas'); cnv.width = W; cnv.height = H;
  const g2 = cnv.getContext('2d');
  const tex = new THREE.CanvasTexture(cnv); tex.colorSpace = THREE.SRGBColorSpace;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.5, 0.5 * H / W),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false, depthTest: false }),
  );
  mesh.renderOrder = 999; mesh.position.set(0, -0.34, -0.9); mesh.visible = false;
  camera.add(mesh);
  let lastErr = '';
  const gripName = (obj) => (obj && obj.parent && obj.parent.name) || '';
  function update() {
    if (!renderer.xr.isPresenting) { mesh.visible = false; return; }
    mesh.visible = true;
    const ses = renderer.xr.getSession?.();
    const n = ses ? ses.inputSources.length : 0;
    const L = interaction.isConnected('left'), R = interaction.isConnected('right');
    const gunM = gripName(scangun?.object) === 'grip-right';
    const gloveM = gripName(leftHand?.object) === 'grip-left';
    const mag = (input.state.moveMag || 0).toFixed(2);
    const spr = input.state.sprint ? 'SPRINT' : 'walk';
    const dd = aimDeltaDeg();
    g2.clearRect(0, 0, W, H); g2.fillStyle = 'rgba(4,12,8,0.82)'; g2.fillRect(0, 0, W, H);
    g2.strokeStyle = '#19ff9b'; g2.lineWidth = 2; g2.strokeRect(2, 2, W - 4, H - 4);
    g2.textBaseline = 'top'; g2.font = '20px monospace'; g2.fillStyle = '#7CFFC4';
    g2.fillText(`src:${n}  L:${L ? 'ok' : '--'}  R:${R ? 'ok' : '--'}  gun:${gunM ? 'HAND' : '--'} glove:${gloveM ? 'HAND' : '--'}`, 12, 10);
    g2.fillText(`stick:${mag} ${spr}   aimΔ:${dd == null ? '--' : dd.toFixed(1) + '°'}`, 12, 40);
    g2.fillStyle = lastErr ? '#ff6b6b' : '#3a6b52';
    g2.fillText(lastErr ? `ERR ${lastErr}` : 'no errors', 12, 74);
    tex.needsUpdate = true;
  }
  return { update, setErr(m) { lastErr = m ? String(m).slice(0, 46) : ''; } };
})();

// ---- render loop ----
const clock = new THREE.Clock();
let loopErrLogged = false;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05); // clamp to avoid huge post-tab-switch steps
  try {
    input.update();
    pauseMenu?.update();
    const paused = !!pauseMenu?.isOpen();
    if (!paused) {
      if (!modeswitcher.isInSession()) controls.update(); // flat mouse-look (turn)
      locomotion.update(dt);                               // move / turn / jump / fly
    }
    interaction.update();                                  // lasers, select, fire hook (polls controllers)
    if (renderer.xr.isPresenting) { ensureHandMounts(); alignHandsToRay(); } // mount + barrel∥laser
    updateGrab(dt, paused);                                // heavy crate drag (all modes)
    arBounds?.update(rig.position);                        // AR comfort: shimmer proximity + disc follow
    vignette.update(!paused && comfort.get('vignette') && input.state.moveMag > 0.05, dt);
    vaultApi?.updateVault(dt);
    sats?.update(dt, clock.elapsedTime);
    scanner.update(dt, scannerSample());                   // advance the signal seam (real: aim×proximity)...
    scangun?.update(dt, clock.elapsedTime, paused);        // ...then drive all gun feedback
    if (!paused) hunt?.update(dt);                          // 4:20 clock + win/lose flow
    vrDiag.update();
  } catch (e) {
    // One bad frame must NOT blank the headset — log once, surface on the in-VR readout,
    // and still render so the player keeps a live world instead of a frozen/black screen.
    vrDiag.setErr(e?.message || e);
    if (!loopErrLogged) { console.error('[loop] caught (recovered):', e); loopErrLogged = true; }
    try { vrDiag.update(); } catch {}
  }
  if (renderer.xr.isPresenting) {
    renderer.render(scene, camera); // XR: direct path, no post
  } else {
    postfx.render();                // flat: composer (tone map + bloom)
  }
});

// ---- expose for headless verification ----
window.__sat = {
  scene, rig, camera, renderer, controls, THREE,
  input, locomotion, collision, comfort, interaction, scanner,
  get scangun() { return scangun; },
  get grab() { return grab; },
  get leftHand() { return leftHand; },
  get arBounds() { return arBounds; },
  get environment() { return environment; },
  get sats() { return sats; },
  get hunt() { return hunt; },
  get vault() { return vaultApi; },
  get pauseMenu() { return pauseMenu; },
  aimRay, fireShot,
  // drive one logic frame manually (for headless verification when the tab is
  // backgrounded and rAF is throttled). Mirrors the render loop's update order.
  step(dt = 0.016) {
    input.update();
    pauseMenu?.update();
    const paused = !!pauseMenu?.isOpen();
    if (!paused) { if (!modeswitcher.isInSession()) controls.update(); locomotion.update(dt); }
    interaction.update();
    if (renderer.xr.isPresenting) { ensureHandMounts(); alignHandsToRay(); }
    updateGrab(dt, paused);
    arBounds?.update(rig.position);
  },
  // full logic+render frame (headless verification when rAF is throttled): mirrors
  // the render loop body so the framebuffer reflects the gun/screen/effects live.
  // Advances a synthetic clock so time-based effects animate under synchronous driving.
  _t: 0,
  frame(dt = 0.016) {
    this._t += dt;
    this.step(dt);
    const paused = !!pauseMenu?.isOpen();
    vignette.update(false, dt);
    vaultApi?.updateVault(dt);
    sats?.update(dt, this._t);
    scanner.update(dt, scannerSample());
    scangun?.update(dt, this._t, paused);
    if (!paused) hunt?.update(dt);
    if (renderer.xr.isPresenting) renderer.render(scene, camera); else postfx.render();
  },
  // place the camera for a screenshot: eye -> target (world coords)
  view(ex, ey, ez, tx, ty, tz) {
    controls.setEnabled(false);
    rig.position.set(0, 0, 0);
    rig.rotation.set(0, 0, 0);
    camera.position.set(ex, ey, ez);
    camera.lookAt(tx, ty, tz);
  },
  freeView: false,
};
function reportStats() {
  let tris = 0, instances = 0, draws = 0;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    draws++;
    const g = o.geometry;
    const idx = g.index ? g.index.count : (g.attributes.position?.count || 0);
    const count = o.isInstancedMesh ? o.count : 1;
    if (o.isInstancedMesh) instances += o.count;
    tris += (idx / 3) * count;
  });
  const stats = { triangles: Math.round(tris), meshNodes: draws, instancedCopies: instances };
  window.__sat.stats = stats;
  console.log('[stats]', JSON.stringify(stats));
}
