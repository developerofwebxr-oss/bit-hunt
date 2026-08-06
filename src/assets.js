// Asset loading + real-world scale normalization.
// All GLBs are Draco-compressed and were decimated from ~375k -> ~10-38k tris
// (see scripts/decimate-assets.js). Origins are already bottom-center, so after
// uniform scaling each floor object sits on y=0 with no pivot surgery.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

const BASE = import.meta.env.BASE_URL; // works on GitHub Pages subpaths too

// ---- Tweakable scale targets (real-world metres) --------------------------
// fit: which local-bbox axis to match to `size`. Uniform scale is derived from it.
export const SCALE_TARGETS = {
  pillar:    { file: 'tall-pillar.glb',          fit: 'y', size: 6.0 },
  beam:      { file: 'green-beam.glb',           fit: 'x', size: 6.0 },  // length; spans pillar gap
  catwalk:   { file: 'catwalk-section.glb',      fit: 'z', size: 4.0 },  // deck length per section
  staircase: { file: 'staircase-to-catwalk.glb', fit: null, size: 0 },  // non-uniform scale in layout.js (rise/run/width)
  miningRig: { file: 'mining-rig.glb',           fit: 'y', size: 2.0 },
  crate:     { file: 'storage-crate.glb',        fit: 'x', size: 1.0 },
  terminal:  { file: 'halo-terminal.glb',        fit: 'y', size: 1.2 },
  vault:     { file: 'main-empty-vault.glb',     fit: 'x', size: 3.6 },  // face width
  door:      { file: 'main-vault-door.glb',      fit: null, size: 0 },   // fitted to hole, not here
  coin:      { file: 'bitcoin-sat-coin.glb',     fit: 'x', size: 0.25 }, // diameter
};

let gltfLoader = null;
function loader() {
  if (gltfLoader) return gltfLoader;
  const draco = new DRACOLoader().setDecoderPath(`${BASE}draco/`);
  gltfLoader = new GLTFLoader().setDRACOLoader(draco);
  return gltfLoader;
}

function loadGLB(file) {
  return new Promise((resolve, reject) => {
    loader().load(`${BASE}assets/${file}`, (g) => resolve(g.scene), undefined, reject);
  });
}

// Uniformly scale `obj` so its `fit` axis equals `size`, then recenter on
// XZ and drop to y=0 (sits on the floor). Returns { obj, scale, size:Vector3 }.
function normalize(obj, fit, size) {
  obj.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(obj);
  const dim = new THREE.Vector3();
  box.getSize(dim);

  let s = 1;
  if (fit) {
    const ref = fit === 'x' ? dim.x : fit === 'y' ? dim.y : dim.z;
    if (ref > 1e-6) s = size / ref;
    obj.scale.setScalar(s);
    obj.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(obj);
  }
  const center = new THREE.Vector3();
  box.getCenter(center);
  // shift so XZ centered at origin, base at y=0
  obj.position.x -= center.x;
  obj.position.z -= center.z;
  obj.position.y -= box.min.y;
  obj.updateMatrixWorld(true);

  const finalSize = new THREE.Vector3();
  new THREE.Box3().setFromObject(obj).getSize(finalSize);
  return { obj, scale: s, size: finalSize };
}

// Load one normalized asset by role key.
export async function loadAsset(key) {
  const spec = SCALE_TARGETS[key];
  if (!spec) throw new Error(`Unknown asset key: ${key}`);
  const raw = await loadGLB(spec.file);
  raw.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = false;
      o.receiveShadow = false;
      o.frustumCulled = true;
    }
  });
  if (spec.fit === null) {
    // door: return raw (fitting handled in vault.js)
    return { obj: raw, scale: 1, size: new THREE.Vector3() };
  }
  return normalize(raw, spec.fit, spec.size);
}

// Load a GLB scene RAW (no normalization / no pivot surgery), so authored
// pivot + local coordinates are preserved. Used by the scangun, whose overlay
// primitives are placed against measured gun-local coordinates.
export async function loadRaw(file) {
  const scene = await loadGLB(file);
  scene.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; } });
  return scene;
}

// Load several assets in parallel; returns a map keyed by role.
export async function loadAssets(keys) {
  const entries = await Promise.all(keys.map(async (k) => [k, await loadAsset(k)]));
  return Object.fromEntries(entries);
}
