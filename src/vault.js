// Main vault + separate door. The two were generated at different scales, so we
// MEASURE the vault's hole (by raycasting through the front face) and fit the
// door to it rather than trusting the door's native size. The door is parented
// to the vault via a hinge group so it can swing open later. It stays CLOSED now.
import * as THREE from 'three';
import { loadAsset } from './assets.js';

// ---- Tweakable fit constants (verify visually, then adjust) ----------------
export const FRONT_AXIS = '+z';          // which vault face holds the hole
export const DOOR_OFFSET = { x: 0, y: 0, z: 0.02 }; // fine offset from measured hole centre (m)
export const DOOR_SCALE = 1.0;           // multiplier on the auto-fit scale
export const DOOR_ROTATION = { x: 0, y: 0, z: 0 };  // extra door spin (rad), face alignment
export const HINGE_OPEN_ANGLE = -Math.PI * 0.62;    // swing target when open (radians)
export const OPEN_SPEED = 1.8;           // rad/s for the open/close tween

// Fallback if raycast hole-detection fails: hole diameter as fraction of face.
const HOLE_FALLBACK_FRACTION = 0.62;

// Raycast a grid through the front face; rays that punch deep (or miss) are over
// the hole. Returns { center: Vector3(world), diameter } or null.
function measureHole(vault) {
  vault.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(vault);
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);

  const N = 41;                       // grid resolution
  const faceZ = box.max.z;            // front = +Z
  const startZ = faceZ + 0.5;         // launch just outside the face
  const depthThresh = size.z * 0.15;  // "deep" = past the front shell
  const ray = new THREE.Raycaster();
  const dir = new THREE.Vector3(0, 0, -1);

  const meshes = [];
  vault.traverse((o) => o.isMesh && meshes.push(o));

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, hits = 0;
  const margin = 0.06;
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const x = THREE.MathUtils.lerp(box.min.x + margin, box.max.x - margin, ix / (N - 1));
      const y = THREE.MathUtils.lerp(box.min.y + margin, box.max.y - margin, iy / (N - 1));
      ray.set(new THREE.Vector3(x, y, startZ), dir);
      const inter = ray.intersectObjects(meshes, true);
      const frontHit = inter.find((h) => h.point.z > faceZ - depthThresh);
      if (!frontHit) { // no solid front surface here -> over the hole
        hits++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
  }

  if (hits < 8) return null; // detection failed
  const dia = Math.max(maxX - minX, maxY - minY);
  return {
    center: new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, faceZ),
    diameter: dia,
    faceZ,
  };
}

export async function buildVault(scene, position = new THREE.Vector3(0, 0, -6)) {
  const { obj: vault } = await loadAsset('vault');
  vault.name = 'main-vault';
  vault.position.copy(position);
  scene.add(vault);
  vault.updateMatrixWorld(true);

  // ---- Measure the hole (world space) ----
  let hole = measureHole(vault);
  const vbox = new THREE.Box3().setFromObject(vault);
  const vsize = new THREE.Vector3(); vbox.getSize(vsize);
  if (!hole) {
    const c = new THREE.Vector3(); vbox.getCenter(c);
    hole = { center: new THREE.Vector3(c.x, c.y, vbox.max.z), diameter: vsize.x * HOLE_FALLBACK_FRACTION, faceZ: vbox.max.z };
    console.warn('[vault] hole detection failed — using fallback fraction');
  }
  console.log(`[vault] hole Ø=${hole.diameter.toFixed(2)}m @ (${hole.center.x.toFixed(2)}, ${hole.center.y.toFixed(2)})`);

  // ---- Load + fit the door ----
  // The door is parented UNDER the vault, which carries the normalization scale
  // (vaultScale). Everything below is expressed in vault-LOCAL units, so world
  // measurements (hole diameter/centre) are divided by vaultScale.
  const vaultScale = vault.scale.x || 1;
  const { obj: door } = await loadAsset('door');
  door.name = 'vault-door';
  const dbox = new THREE.Box3().setFromObject(door);
  const dsize = new THREE.Vector3(); dbox.getSize(dsize);
  const doorDia = Math.max(dsize.x, dsize.y);
  // desired world diameter = hole diameter; nested scale divides by vaultScale
  const fit = ((hole.diameter / doorDia) * DOOR_SCALE) / vaultScale;

  // Recenter door geometry to its own centre so it scales/rotates about middle.
  const dcenter = new THREE.Vector3(); dbox.getCenter(dcenter);
  const doorInner = new THREE.Group();
  door.position.sub(dcenter);          // centre the door mesh on the group origin
  doorInner.add(door);
  doorInner.scale.setScalar(fit);
  doorInner.rotation.set(DOOR_ROTATION.x, DOOR_ROTATION.y, DOOR_ROTATION.z);

  // ---- Hinge group at the left edge of the hole, parented to the vault ----
  const holeLocal = vault.worldToLocal(hole.center.clone()); // already vault-local
  const rLocal = (hole.diameter / 2) / vaultScale;
  const off = { x: DOOR_OFFSET.x / vaultScale, y: DOOR_OFFSET.y / vaultScale, z: DOOR_OFFSET.z / vaultScale };
  const hinge = new THREE.Group();
  hinge.name = 'vault-hinge';
  hinge.position.set(
    holeLocal.x - rLocal + off.x,   // hinge axis at left rim
    holeLocal.y + off.y,
    holeLocal.z + off.z,
  );
  // Door sits to the +X side of the hinge so it pivots about the rim.
  doorInner.position.set(rLocal, 0, 0);
  hinge.add(doorInner);
  vault.add(hinge);

  // ---- open/close rig (stays closed now) ----
  const state = { target: 0, current: 0 }; // 0 = closed, 1 = open
  function openVault() { state.target = 1; }
  function closeVault() { state.target = 0; }

  // ---- absorb feedback ----
  // Body/door stay DARK (no cumulative brightening — it killed the vibe). They only
  // get a brief, subtle emissive pulse on each catch. ALL cumulative glow lives in the
  // portal (below): the opening comes back to life as coins return.
  const glowMats = [];
  vault.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      if (!m) continue;
      m.emissive = new THREE.Color(0x19ff9b);
      m.emissiveIntensity = 0;
      glowMats.push(m);
    }
  });

  // ---- portal: ONE animated CanvasTexture disc inside the circular opening. Fill
  // (0..1 = count/21) drives intensity: 0 = faint ember, 1 = blazing portal. Swirl +
  // breathe are time-based. Canvas redraws throttled to ~15fps; the mesh/material/
  // canvas/texture are allocated ONCE (no per-frame allocation). ----
  const portalCanvas = document.createElement('canvas'); portalCanvas.width = portalCanvas.height = 256;
  const pctx = portalCanvas.getContext('2d');
  const portalTex = new THREE.CanvasTexture(portalCanvas); portalTex.colorSpace = THREE.SRGBColorSpace;
  const portalMat = new THREE.MeshBasicMaterial({ map: portalTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const portal = new THREE.Mesh(new THREE.CircleGeometry(hole.diameter * 0.5 * 0.96, 48), portalMat);
  // the closed door's central hub protrudes forward of the face — raycast it and sit the
  // portal just in front so the glow reads over the whole opening instead of being occluded.
  // (update world matrices first: the door was just parented and its matrix is otherwise
  // stale, so the ray would miss the door and punch through to the vault's back interior.)
  vault.updateMatrixWorld(true);
  const _hubRc = new THREE.Raycaster(new THREE.Vector3(hole.center.x, hole.center.y, hole.center.z + 1.5), new THREE.Vector3(0, 0, -1));
  const _vm = []; vault.traverse((o) => o.isMesh && _vm.push(o));
  const _hub = _hubRc.intersectObjects(_vm, true)[0];
  // clamp to a sane forward offset in front of the face (guards against a stray deep hit)
  const _hubZ = Math.min(hole.center.z + 0.8, Math.max(hole.center.z + 0.04, (_hub ? _hub.point.z : hole.center.z) + 0.06));
  portal.position.set(hole.center.x, hole.center.y, _hubZ);
  portal.renderOrder = 3; portal.frustumCulled = false;
  scene.add(portal);

  let fill = 0, fillTarget = 0, portalTime = 0, drawAcc = 0, absorbT = 0, flare = 0;
  function drawPortal() {
    const W = 256, c = 128, R = 124;
    pctx.clearRect(0, 0, W, W);
    const breath = 0.85 + 0.15 * Math.sin(portalTime * 2.2);
    const a = (0.14 + 1.05 * fill) * breath * (1 + flare * 1.8); // ember → blazing; flares on the win seal
    const grd = pctx.createRadialGradient(c, c, 2, c, c, R);
    grd.addColorStop(0.0, `rgba(200,255,225,${(0.9 * a).toFixed(3)})`);
    grd.addColorStop(0.25, `rgba(60,255,170,${(0.75 * a).toFixed(3)})`);
    grd.addColorStop(0.7, `rgba(18,190,115,${(0.32 * a).toFixed(3)})`);
    grd.addColorStop(1.0, 'rgba(6,60,40,0)');
    pctx.fillStyle = grd; pctx.beginPath(); pctx.arc(c, c, R, 0, Math.PI * 2); pctx.fill();
    // swirling arms (rotate with time; more visible as fill grows)
    pctx.save(); pctx.translate(c, c); pctx.rotate(portalTime * 0.6);
    pctx.strokeStyle = `rgba(190,255,215,${(0.45 * a).toFixed(3)})`; pctx.lineWidth = 3;
    for (let k = 0; k < 3; k++) {
      pctx.rotate((Math.PI * 2) / 3); pctx.beginPath();
      for (let t = 0; t <= 1.0001; t += 0.05) { const rr = R * (0.15 + 0.8 * t), ang = t * 3.0; const x = Math.cos(ang) * rr, y = Math.sin(ang) * rr; t === 0 ? pctx.moveTo(x, y) : pctx.lineTo(x, y); }
      pctx.stroke();
    }
    pctx.restore();
    // concentric rings light up progressively with fill
    const rings = Math.round(fill * 4);
    pctx.strokeStyle = `rgba(60,255,170,${(0.4 * a).toFixed(3)})`; pctx.lineWidth = 2;
    for (let i = 1; i <= rings; i++) { pctx.beginPath(); pctx.arc(c, c, R * (i / 5), 0, Math.PI * 2); pctx.stroke(); }
    portalTex.needsUpdate = true;
  }
  drawPortal(); // faint ember at 0/21

  function pulseAbsorb(count = 0, total = 21) { absorbT = 1; fillTarget = Math.min(1, count / total); }
  function flarePortal() { flare = 1; }   // one bright surge as the door seals on a win
  function resetGlow() { absorbT = 0; fill = 0; fillTarget = 0; flare = 0; for (const m of glowMats) m.emissiveIntensity = 0; drawPortal(); }

  function updateVault(dt) {
    // door swing (stays closed for now)
    if (state.current !== state.target) {
      const step = (OPEN_SPEED / Math.abs(HINGE_OPEN_ANGLE)) * dt;
      state.current += Math.sign(state.target - state.current) * Math.min(step, Math.abs(state.target - state.current));
      hinge.rotation.y = state.current * HINGE_OPEN_ANGLE;
    }
    // body/door: subtle brief pulse only (stays dark at rest)
    if (absorbT > 0) absorbT = Math.max(0, absorbT - dt / 0.5);
    const bodyE = absorbT * 0.3;
    for (const m of glowMats) m.emissiveIntensity = bodyE;
    // portal: ease fill toward target, decay the win flare; animate & redraw ~15fps
    portalTime += dt;
    fill += (fillTarget - fill) * Math.min(1, dt * 3);
    if (flare > 0) flare = Math.max(0, flare - dt / 0.6);
    drawAcc += dt;
    if (drawAcc >= 1 / 15) { drawPortal(); drawAcc = 0; }
  }

  // ---- collider (vault body AABB in world XZ, base at floor) ----
  // vbox was measured on the vault body before the door was parented in.
  const collider = {
    minX: vbox.min.x, maxX: vbox.max.x,
    minZ: vbox.min.z, maxZ: vbox.max.z,
    minY: 0, maxY: vbox.max.y,
  };

  return { vault, door: doorInner, hinge, hole, size: vsize, collider, openVault, closeVault, updateVault, pulseAbsorb, flarePortal, resetGlow };
}
