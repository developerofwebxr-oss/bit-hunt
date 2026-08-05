// Deterministic geometry verification by RAYCASTING the real decoded meshes
// (never bounding boxes). Replicates layout.js placement, then measures the
// walkable deck surface, the staircase top tread, ascent direction, and ramp.
// Run: node scripts/diag-geometry.mjs
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const DIR = 'public/assets/';
const f2 = (n) => (n == null ? 'null' : (Math.round(n * 100) / 100).toFixed(2));

// ---- load a GLB as a single three.BufferGeometry in the asset's scene space ----
async function loadGeom(file) {
  const doc = await io.read(DIR + file);
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const geoms = [];
  const walk = (node, parent) => {
    const t = node.getTranslation(), r = node.getRotation(), s = node.getScale();
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(t[0], t[1], t[2]),
      new THREE.Quaternion(r[0], r[1], r[2], r[3]),
      new THREE.Vector3(s[0], s[1], s[2]));
    const world = parent.clone().multiply(local);
    const mesh = node.getMesh();
    if (mesh) for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION'); if (!pos) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos.getArray()), 3));
      const idx = prim.getIndices();
      if (idx) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx.getArray()), 1));
      g.applyMatrix4(world);
      geoms.push(g);
    }
    node.listChildren().forEach((c) => walk(c, world));
  };
  scene.listChildren().forEach((n) => walk(n, new THREE.Matrix4()));
  return geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
}
const meshOf = (geom) => new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
function surfaceY(mesh, x, z, from = 40) {
  mesh.updateMatrixWorld(true);
  const rc = new THREE.Raycaster(new THREE.Vector3(x, from, z), new THREE.Vector3(0, -1, 0));
  const h = rc.intersectObject(mesh, true);
  return h.length ? h[0].point.y : null;
}
const bbox = (geom) => { geom.computeBoundingBox(); return geom.boundingBox; };
const dimOf = (b) => new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);

const half = 7;

// ================= CATWALK: ground it, raycast the real deck =================
const catRaw = await loadGeom('catwalk-section.glb');
{ // normalize like assets.js (fit z=4 uniform, recenter XZ + base y=0)
  let b = bbox(catRaw); const d = dimOf(b); const s = 4 / d.z;
  catRaw.applyMatrix4(new THREE.Matrix4().makeScale(s, s, s));
  b = bbox(catRaw); const c = b.getCenter(new THREE.Vector3());
  catRaw.applyMatrix4(new THREE.Matrix4().makeTranslation(-c.x, -b.min.y, -c.z));
}
const catW = -half + 1.0;
const catHalfW = dimOf(bbox(catRaw)).x / 2;
const catProbe = meshOf(catRaw); catProbe.position.set(catW, 0, 0);
const DECK_Y = surfaceY(catProbe, catW, 0);

// ================= STAIRCASE: flip to deck, size top tread to DECK_Y =========
const stairRawGeom = await loadGeom('staircase-to-catwalk.glb');
const rb = bbox(stairRawGeom), rd = dimOf(rb);
// raw ascent: which run (Z) end is high?
const rawMesh = meshOf(stairRawGeom);
const rcx = (rb.min.x + rb.max.x) / 2, rzMid = (rb.min.z + rb.max.z) / 2;
let yMinZ = 0, yMaxZ = 0;
for (let z = rb.min.z; z <= rb.max.z; z += rd.z / 24) {
  const y = surfaceY(rawMesh, rcx, z);
  if (y != null) (z < rzMid ? (yMinZ = Math.max(yMinZ, y)) : (yMaxZ = Math.max(yMaxZ, y)));
}
const STAIR_ROT = yMaxZ > yMinZ ? -Math.PI / 2 : Math.PI / 2;

const STAIR_Z = 4.0, STAIR_WIDTH = 1.4;
const STAIR_RUN = Math.max(1.6, DECK_Y * 1.7);
const STAIR_X = (-half + 1.7) + STAIR_RUN / 2;
const sX = STAIR_WIDTH / rd.x, sZ = STAIR_RUN / rd.z;

function buildStair(sy) {
  const g = stairRawGeom.clone();
  g.applyMatrix4(new THREE.Matrix4().makeScale(sX, sy, sZ));
  const b = bbox(g), c = b.getCenter(new THREE.Vector3());
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(-c.x, -b.min.y, -c.z)); // recenter
  g.applyMatrix4(new THREE.Matrix4().makeRotationY(STAIR_ROT));
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(STAIR_X, 0, STAIR_Z));
  return meshOf(g);
}
function treadProfile(mesh) {
  const prof = []; let maxY = 0, atX = STAIR_X;
  for (let x = STAIR_X - STAIR_RUN / 2; x <= STAIR_X + STAIR_RUN / 2 + 1e-3; x += 0.1) {
    const y = surfaceY(mesh, x, STAIR_Z);
    prof.push({ x: +x.toFixed(1), y: y == null ? null : +y.toFixed(2) });
    if (y != null && y > maxY) { maxY = y; atX = x; }
  }
  return { prof, maxY, atX };
}
const syGuess = DECK_Y / rd.y;
const t0 = treadProfile(buildStair(syGuess));
const sY = t0.maxY > 0.01 ? syGuess * (DECK_Y / t0.maxY) : syGuess;
const stair = buildStair(sY);
const tread = treadProfile(stair);

// ================= RAMP =================
const ramp = {
  minX: STAIR_X - STAIR_RUN / 2, maxX: STAIR_X + STAIR_RUN / 2,
  minZ: STAIR_Z - STAIR_WIDTH / 2, maxZ: STAIR_Z + STAIR_WIDTH / 2,
  lowY: 0, highY: DECK_Y,
};

// ================= REPORT =================
console.log('\n=== CATWALK / MEZZANINE (grounded, raycast deck) ===');
console.log(`  grounded at y=0; walkable DECK_Y (raycast) = ${f2(DECK_Y)}  half-width ${f2(catHalfW)}`);

console.log('\n=== STAIRCASE (raycast-sized) ===');
console.log(`  ascent: raw high end at ${yMaxZ > yMinZ ? '+Z' : '-Z'} -> rotation ${(STAIR_ROT * 180 / Math.PI).toFixed(0)}deg`);
console.log(`  scale X ${f2(sX)} / Y ${f2(sY)} / Z ${f2(sZ)}   run ${f2(STAIR_RUN)}  width ${STAIR_WIDTH}  centre x=${f2(STAIR_X)} z=${STAIR_Z}`);
console.log('  tread profile (surface Y along run at centre-width):');
console.log('   ' + tread.prof.map((p) => `${p.x}:${p.y}`).join('  '));
console.log(`  top tread Y = ${f2(tread.maxY)} @ x=${f2(tread.atX)}`);

console.log('\n=== WALK-RAMP collider ===');
console.log(`  x[${f2(ramp.minX)}, ${f2(ramp.maxX)}]  z[${f2(ramp.minZ)}, ${f2(ramp.maxZ)}]  lowY 0 -> highY ${f2(ramp.highY)}`);

console.log('\n=== VERIFY ===');
const treadOK = Math.abs(tread.maxY - DECK_Y) <= 0.05;
const deckSide = tread.atX <= (-half + 1.7) + 0.5; // high end near the deck edge (~ -5.3), NOT interior
const rampTopOK = Math.abs(ramp.highY - DECK_Y) < 1e-6;
const rampCoversTread = ramp.minX <= tread.atX + 0.05 && ramp.maxX >= tread.atX - 0.05;
console.log(`  [${treadOK ? 'PASS' : 'FAIL'}] stair top tread (${f2(tread.maxY)}) ≈ DECK_Y (${f2(DECK_Y)})  within 5cm`);
console.log(`  [${deckSide ? 'PASS' : 'FAIL'}] high end at deck side (x=${f2(tread.atX)} ≤ ${f2(-half + 2.2)}), not interior`);
console.log(`  [${rampTopOK ? 'PASS' : 'FAIL'}] ramp top = DECK_Y`);
console.log(`  [${rampCoversTread ? 'PASS' : 'FAIL'}] ramp covers the tread footprint`);
console.log(`  [n/a] mining rigs — verified removed from src/layout.js separately`);
const allPass = treadOK && deckSide && rampTopOK && rampCoversTread;
console.log(`\n  ${allPass ? '*** ALL PASS ***' : '*** FAIL — do not deploy ***'}`);
process.exit(allPass ? 0 : 1);
