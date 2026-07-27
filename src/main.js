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
import { comfort } from './comfort.js';

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
interaction.setFireHook((hand) => console.log(`[fire] trigger (${hand}) — placeholder, no gun yet`));

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
    environment?.applyMode(mode);                  // AR shell-off + collision bounds
  },
});
pauseMenu = createPauseMenu({
  input, camera, renderer, interaction,
  onExit: () => modeswitcher.exitToScreen(),       // X menu "Exit to screen mode"
});
// on-screen menu button (flat/mobile) → same as Left-X
document.getElementById('btn-pause')?.addEventListener('click', () => pauseMenu.toggle());

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
    collision.setRamp(layout.ramp);
    if (v.collider) collision.addBox(v.collider);
    // the coin is a grabbable target demo for builder mode
    const coin = scene.getObjectByName('sat-coin');
    if (coin) interaction.addTarget(coin, () => console.log('[select] sat coin'), { grabbable: true });
    // environment adapter owns the shell; apply the current mode now
    environment = createEnvironment({ shell: room.group, collision, half: ROOM.size / 2 });
    environment.applyMode(currentMode);
    modeswitcher.setStatus('ready · flat mode');
    reportStats();
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
  if (renderer.xr.isPresenting) {
    renderer.render(scene, camera); // XR: direct path, no post
  } else {
    postfx.render();                // flat: composer (tone map + bloom)
  }
});

// ---- expose for headless verification ----
window.__sat = {
  scene, rig, camera, renderer, controls, THREE,
  input, locomotion, collision, comfort, interaction,
  get vault() { return vaultApi; },
  get pauseMenu() { return pauseMenu; },
  // drive one logic frame manually (for headless verification when the tab is
  // backgrounded and rAF is throttled). Mirrors the render loop's update order.
  step(dt = 0.016) {
    input.update();
    pauseMenu?.update();
    const paused = !!pauseMenu?.isOpen();
    if (!paused) { if (!modeswitcher.isInSession()) controls.update(); locomotion.update(dt); }
    interaction.update();
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
