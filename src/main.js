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
import { createPauseMenu } from './pausemenu.js';
import { createVignette } from './vignette.js';
import { createSats, SAT_COUNT } from './sats.js';
import { createScanner } from './scanner.js';
import { createScangun } from './scangun.js';
import { createHunt } from './hunt.js';
import { hapticPulse } from './haptics.js';
import { comfort } from './comfort.js';

const HUNT_SEED = 1337; // single seed -> swap for a server seed in v4 (multiplayer)
let sats = null;
const scanner = createScanner();   // the single scanner-signal seam (real: aim × proximity)
let scangun = null;
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
  renderer, scene, camera, input, canvas, isPaused: () => !!pauseMenu?.isOpen(),
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
    // VR: shoot along the GUN's forward (it rides the right grip), so the shot goes where
    // the gun points. Fall back to the right controller if the gun isn't mounted yet.
    const gun = scangun?.object;
    const src = gun || interaction.getController('right');
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

// ---- gun mounting: right controller in XR, bottom-right viewmodel in flat ----
function mountGun(mode) {
  if (!scangun) return;
  scangun.unmount();
  if (mode === 'VR' || mode === 'AR') scangun.mountHand(interaction.getGrip('right')); // right controller grip
  else scangun.mountFlat(camera);
}
// Robust hand mount: whenever a controller (re)connects, if it's the right hand and we're
// in an immersive session, (re)mount the gun to its grip. This is what makes the gun follow
// the real controller even though the mount at session-start ran before controllers connected.
interaction.onControllerConnected((hand, grip) => {
  if (hand === 'right' && scangun && (currentMode === 'VR' || currentMode === 'AR')) scangun.mountHand(grip);
});

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
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== undefined && e.button !== 0) return;   // primary only
  if (renderer.xr.isPresenting || pauseMenu?.isOpen()) return;
  scangun?.resumeAudio();
  scangun?.flash();
  fireShot(null);
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
    // environment adapter owns the shell; apply the current mode now
    environment = createEnvironment({ shell: room.group, collision, half: ROOM.size / 2 });
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

    // ---- Scanner gun: held weapon/scanner with live screen + tick effects ----
    return createScangun({ scene, scanner }).then((g) => {
      scangun = g;                                 // exposed via window.__sat getter
      g.setMuted(!comfort.get('sound'));           // honor the persisted scanner-sound setting
      mountGun(currentMode);                       // viewmodel now; re-mounts on XR entry
      // ---- Hunt: the 4:20 clock + win/lose flow (owns timer HUD + overlay + start button) ----
      hunt = createHunt({ sats, vaultApi: v, scangun: g, total: SAT_COUNT, setReturnedHud: updateReturnedHud, renderer, camera, interaction });
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

// ---- render loop ----
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05); // clamp to avoid huge post-tab-switch steps
  input.update();
  pauseMenu?.update();
  const paused = !!pauseMenu?.isOpen();
  if (!paused) {
    if (!modeswitcher.isInSession()) controls.update(); // flat mouse-look (turn)
    locomotion.update(dt);                               // move / turn / jump / fly
  }
  interaction.update();                                  // lasers, select, grip, B/Y
  vignette.update(!paused && comfort.get('vignette') && input.state.moveMag > 0.05, dt);
  vaultApi?.updateVault(dt);
  sats?.update(dt, clock.elapsedTime);
  scanner.update(dt, scannerSample());                   // advance the signal seam (real: aim×proximity)...
  scangun?.update(dt, clock.elapsedTime, paused);        // ...then drive all gun feedback
  if (!paused) hunt?.update(dt);                          // 4:20 clock + win/lose flow
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
