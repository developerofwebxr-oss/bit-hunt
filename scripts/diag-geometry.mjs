// Deterministic verification by RAYCASTING real decoded geometry (never bboxes)
// + an analytic overlap pass. Replicates layout.js placement.
// Run: node scripts/diag-geometry.mjs   (exit 0 = all pass)
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const DIR = 'public/assets/';
const f2 = (n) => (n == null ? 'null' : (Math.round(n * 100) / 100).toFixed(2));

async function loadGeom(file) {
  const doc = await io.read(DIR + file);
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const geoms = [];
  const walk = (node, parent) => {
    const t = node.getTranslation(), r = node.getRotation(), s = node.getScale();
    const world = parent.clone().multiply(new THREE.Matrix4().compose(
      new THREE.Vector3(...t), new THREE.Quaternion(...r), new THREE.Vector3(...s)));
    const mesh = node.getMesh();
    if (mesh) for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION'); if (!pos) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(pos.getArray()), 3));
      const idx = prim.getIndices();
      if (idx) g.setIndex(new THREE.BufferAttribute(Uint32Array.from(idx.getArray()), 1));
      g.applyMatrix4(world); geoms.push(g);
    }
    node.listChildren().forEach((c) => walk(c, world));
  };
  scene.listChildren().forEach((n) => walk(n, new THREE.Matrix4()));
  return geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
}
const meshOf = (g) => new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
function surfaceY(mesh, x, z, from = 40) {
  mesh.updateMatrixWorld(true);
  const rc = new THREE.Raycaster(new THREE.Vector3(x, from, z), new THREE.Vector3(0, -1, 0));
  const h = rc.intersectObject(mesh, true);
  return h.length ? h[0].point.y : null;
}
const bb = (g) => { g.computeBoundingBox(); return g.boundingBox; };
const dim = (b) => new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
function normalize(g, axis, size) { // uniform fit + recenter XZ + base y=0 (assets.js)
  let b = bb(g); const d = dim(b); const s = size / (axis === 'x' ? d.x : axis === 'y' ? d.y : d.z);
  g.applyMatrix4(new THREE.Matrix4().makeScale(s, s, s));
  b = bb(g); const c = b.getCenter(new THREE.Vector3());
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(-c.x, -b.min.y, -c.z));
  return g;
}

const half = 7, ring = 4.6;

// ===== CATWALK (grounded) =====
const catG = normalize(await loadGeom('catwalk-section.glb'), 'z', 4);
const cbb = bb(catG), cW = -half + 0.9, cE = half - 0.9;
const catHalfW = dim(cbb).x / 2, catHalfLen = dim(cbb).z / 2;
const catProbe = meshOf(catG); catProbe.position.set(cW, 0, 0);
const DECK_Y = surfaceY(catProbe, cW, 0);
const zEndH = surfaceY(catProbe, cW, catHalfLen * 0.92);
const xSideH = surfaceY(catProbe, cW + catHalfW * 0.92, 0);
const junctionH = surfaceY(catProbe, cW, catHalfLen - 0.2);
const zEndOpen = zEndH == null || zEndH <= DECK_Y + 0.12;

// ===== STAIRS (one per platform, board +Z open end) =====
const stairRaw = await loadGeom('staircase-to-catwalk.glb');
const rd = dim(bb(stairRaw));
const rawMesh = meshOf(stairRaw), rb = bb(stairRaw), rzMid = (rb.min.z + rb.max.z) / 2, rcx = (rb.min.x + rb.max.x) / 2;
let yMinZ = 0, yMaxZ = 0;
for (let z = rb.min.z; z <= rb.max.z; z += rd.z / 24) {
  const y = surfaceY(rawMesh, rcx, z); if (y != null) (z < rzMid ? (yMinZ = Math.max(yMinZ, y)) : (yMaxZ = Math.max(yMaxZ, y)));
}
const STAIR_ROT = yMaxZ > yMinZ ? Math.PI : 0;
const STAIR_WIDTH = 1.4, STAIR_RUN = Math.max(1.6, DECK_Y * 1.7);
const STAIR_TOP_Z = catHalfLen, STAIR_Zc = STAIR_TOP_Z + STAIR_RUN / 2;
const sX = STAIR_WIDTH / rd.x, sZ = STAIR_RUN / rd.z;
function buildStair(catX, sy) {
  const g = stairRaw.clone();
  g.applyMatrix4(new THREE.Matrix4().makeScale(sX, sy, sZ));
  const b = bb(g), c = b.getCenter(new THREE.Vector3());
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(-c.x, -b.min.y, -c.z));
  g.applyMatrix4(new THREE.Matrix4().makeRotationY(STAIR_ROT));
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(catX, 0, STAIR_Zc));
  return meshOf(g);
}
function tread(mesh, catX) {
  let maxY = 0, atZ = STAIR_TOP_Z;
  for (let z = STAIR_TOP_Z - 0.5; z <= STAIR_Zc + STAIR_RUN / 2 + 1e-3; z += 0.08) {
    const y = surfaceY(mesh, catX, z); if (y != null && y > maxY) { maxY = y; atZ = z; }
  }
  return { maxY, atZ };
}
const syGuess = DECK_Y / rd.y;
const t0 = tread(buildStair(cW, syGuess), cW);
const sY = t0.maxY > 0.01 ? syGuess * (DECK_Y / t0.maxY) : syGuess;
const treadW = tread(buildStair(cW, sY), cW);
const stairBox = (catX) => ({ minX: catX - STAIR_WIDTH / 2, maxX: catX + STAIR_WIDTH / 2, minZ: STAIR_TOP_Z, maxZ: STAIR_Zc + STAIR_RUN / 2, y0: 0, y1: DECK_Y, name: `stair@${f2(catX)}` });

// ===== PROP + STRUCTURE FOOTPRINTS =====
const crateG = normalize(await loadGeom('storage-crate.glb'), 'x', 1.0);
const termG = normalize(await loadGeom('halo-terminal.glb'), 'y', 1.2);
const cD = dim(bb(crateG)), tD = dim(bb(termG));
const crateR = Math.hypot(cD.x, cD.z) / 2, termR = Math.hypot(tD.x, tD.z) / 2, crateH = cD.y, termH = tD.y;

const crates = [ { x: -2.6, z: 0.4 }, { x: 2.2, z: 1.4 }, { x: 4.0, z: 3.2 }, { x: cE, z: -1.5, y: DECK_Y } ];
const terms = [ { x: -3.4, z: 4.2 }, { x: 3.4, z: -2.6 }, { x: -3.0, z: -4.0 } ];
const props = [
  ...crates.map((c, i) => ({ x: c.x, z: c.z, r: crateR, y0: c.y || 0, y1: (c.y || 0) + crateH, name: `crate${i}` })),
  ...terms.map((t, i) => ({ x: t.x, z: t.z, r: termR, y0: 0, y1: termH, name: `term${i}` })),
  { x: 0, z: 1.5, r: 0.2, y0: 0, y1: 0.3, name: 'coin' },
];
const pillars = [[-ring,-ring],[ring,-ring],[-ring,0],[ring,0],[-ring,6],[ring,6]]
  .map(([x, z]) => ({ minX: x - 0.75, maxX: x + 0.75, minZ: z - 0.75, maxZ: z + 0.75, y0: 0, y1: 6, name: `pillar@${f2(x)},${f2(z)}` }));
const vault = { minX: -1.9, maxX: 1.9, minZ: -7.2, maxZ: -3.7, y0: 0, y1: 3.4, name: 'vault' };
const decks = [cW, cE].map((x) => ({ minX: x - catHalfW, maxX: x + catHalfW, minZ: -catHalfLen, maxZ: catHalfLen, y0: 0, y1: DECK_Y, name: `deck@${f2(x)}` }));
const stairs = [stairBox(cW), stairBox(cE)];

const yOv = (a, b) => a.y0 < b.y1 - 0.02 && a.y1 > b.y0 + 0.02;
const circleBox = (c, b) => {
  const nx = Math.max(b.minX, Math.min(c.x, b.maxX)), nz = Math.max(b.minZ, Math.min(c.z, b.maxZ));
  return Math.hypot(c.x - nx, c.z - nz) < c.r - 0.02 && yOv(c, b);
};
const circleCircle = (a, b) => Math.hypot(a.x - b.x, a.z - b.z) < a.r + b.r - 0.04 && yOv(a, b);

// ===== OVERLAP PASS =====
const hits = [];
for (let i = 0; i < props.length; i++) {
  for (let j = i + 1; j < props.length; j++) if (circleCircle(props[i], props[j])) hits.push(`${props[i].name} × ${props[j].name}`);
  for (const b of [...pillars, ...stairs, ...decks, vault]) if (circleBox(props[i], b)) hits.push(`${props[i].name} × ${b.name}`);
}

// ===== DECK UNDERSIDE (resolveXZ replica) =====
const R = 0.35, PH = 1.6;
function resolveXZ(px, pz, feetY, boxes) {
  let p = { x: px, z: pz };
  for (const b of boxes) {
    if (feetY >= b.maxY - 0.05) continue; if (feetY + PH <= b.minY) continue;
    const cx = Math.max(b.minX, Math.min(p.x, b.maxX)), cz = Math.max(b.minZ, Math.min(p.z, b.maxZ));
    const dx = p.x - cx, dz = p.z - cz, d2 = dx * dx + dz * dz;
    if (d2 >= R * R) continue;
    if (d2 > 1e-6) { const d = Math.sqrt(d2); p.x = cx + dx / d * R; p.z = cz + dz / d * R; }
    else { const m = Math.min(p.x - b.minX, b.maxX - p.x, p.z - b.minZ, b.maxZ - p.z);
      if (m === p.x - b.minX) p.x = b.minX - R; else if (m === b.maxX - p.x) p.x = b.maxX + R;
      else if (m === p.z - b.minZ) p.z = b.minZ - R; else p.z = b.maxZ + R; }
  }
  return p;
}
const deckBoxes = [cW, cE].map((x) => ({ minX: x - catHalfW, maxX: x + catHalfW, minZ: -catHalfLen, maxZ: catHalfLen - 0.35, minY: 0, maxY: DECK_Y }));
const underPush = resolveXZ(cW, 0, 0, deckBoxes);        // under the deck, feet on floor
const onDeck = resolveXZ(cW, 0, DECK_Y, deckBoxes);      // standing on the deck
const blockedFromBelow = Math.hypot(underPush.x - cW, underPush.z - 0) > 0.1; // pushed out
const walkableOnTop = Math.hypot(onDeck.x - cW, onDeck.z - 0) < 0.01;         // not pushed

// ===== REPORT =====
console.log('\n=== MEZZANINE ===');
console.log(`  platforms: 2 (west x=${f2(cW)}, east x=${f2(cE)}), one section each; deck half ${f2(catHalfW)}×${f2(catHalfLen)}, DECK_Y=${f2(DECK_Y)}`);
console.log(`  +Z end open? ${zEndOpen} (zEnd=${f2(zEndH)}, xSide=${f2(xSideH)}, junction=${f2(junctionH)} vs DECK_Y ${f2(DECK_Y)})`);
console.log(`  staircases: 2, board the +Z open end at z=${f2(STAIR_TOP_Z)} (x=${f2(cW)} / ${f2(cE)}), run to z=${f2(STAIR_Zc + STAIR_RUN / 2)}, rot ${(STAIR_ROT * 180 / Math.PI) | 0}deg`);
console.log(`  top tread Y=${f2(treadW.maxY)} @ z=${f2(treadW.atZ)}`);

console.log('\n=== OVERLAP PASS (prop vs prop / pillar / stair / vault / deck) ===');
console.log(hits.length ? hits.map((h) => '  INTERSECT ' + h).join('\n') : '  no intersections');

console.log('\n=== DECK UNDERSIDE COLLISION ===');
console.log(`  from below (feet@0): pushed to (${f2(underPush.x)},${f2(underPush.z)}) -> blocked=${blockedFromBelow}`);
console.log(`  on top (feet@DECK_Y): stays (${f2(onDeck.x)},${f2(onDeck.z)}) -> walkable=${walkableOnTop}`);

console.log('\n=== VERIFY ===');
const treadOK = Math.abs(treadW.maxY - DECK_Y) <= 0.05;
const openOK = zEndOpen && (junctionH == null || junctionH <= DECK_Y + 0.12);
const checks = [
  [treadOK, `stair top tread (${f2(treadW.maxY)}) ≈ DECK_Y (${f2(DECK_Y)}) within 5cm`],
  [openOK, `staircase boards an OPEN +Z end (rail-free) at z=${f2(STAIR_TOP_Z)}`],
  [hits.length === 0, 'no prop–prop/pillar/stair/vault/deck intersections'],
  [blockedFromBelow, 'deck blocks upward pass from below'],
  [walkableOnTop, 'deck top stays walkable (stairs are the only way up)'],
];
for (const [ok, msg] of checks) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${msg}`);
const allPass = checks.every(([ok]) => ok);
console.log(`\n  ${allPass ? '*** ALL PASS ***' : '*** FAIL — do not deploy ***'}`);
process.exit(allPass ? 0 : 1);
