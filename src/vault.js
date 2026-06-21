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
  function updateVault(dt) {
    if (state.current === state.target) return;
    const step = (OPEN_SPEED / Math.abs(HINGE_OPEN_ANGLE)) * dt;
    state.current += Math.sign(state.target - state.current) * Math.min(step, Math.abs(state.target - state.current));
    hinge.rotation.y = state.current * HINGE_OPEN_ANGLE;
  }

  return { vault, door: doorInner, hinge, hole, size: vsize, openVault, closeVault, updateVault };
}
