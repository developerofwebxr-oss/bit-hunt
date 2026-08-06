// Deterministic verification by RAYCASTING real decoded geometry (never bboxes)
// + an analytic overlap pass. Replicates layout.js placement.
// Pillars intentionally pass UP THROUGH the mezzanine deck (columns through the
// floor) — those contacts are reported, not failed. Run: node scripts/diag-geometry.mjs
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
function normalize(g, axis, size) {
  let b = bb(g); const d = dim(b); const s = size / (axis === 'x' ? d.x : axis === 'y' ? d.y : d.z);
  g.applyMatrix4(new THREE.Matrix4().makeScale(s, s, s));
  b = bb(g); const c = b.getCenter(new THREE.Vector3());
  g.applyMatrix4(new THREE.Matrix4().makeTranslation(-c.x, -b.min.y, -c.z));
  return g;
}
const half = 7, ring = 4.6, MEZZ = 1.45, PEN = 0.05; // penetration tolerance (touching OK)

// ===== CATWALK (scaled, grounded, outer edge at wall) =====
const catG = normalize(await loadGeom('catwalk-section.glb'), 'z', 4);
catG.applyMatrix4(new THREE.Matrix4().makeScale(MEZZ, MEZZ, MEZZ));
const cbb = bb(catG); const catHalfW = dim(cbb).x / 2, catHalfLen = dim(cbb).z / 2;
const cW = -half + catHalfW, cE = half - catHalfW;
const catProbe = meshOf(catG); catProbe.position.set(cW, 0, 0);
const DECK_Y = surfaceY(catProbe, cW, 0);
const zEndH = surfaceY(catProbe, cW, catHalfLen * 0.92);
const junctionH = surfaceY(catProbe, cW, catHalfLen - 0.25);
const zEndOpen = zEndH == null || zEndH <= DECK_Y + 0.12;

// ===== STAIRS =====
const stairRaw = await loadGeom('staircase-to-catwalk.glb');
const rd = dim(bb(stairRaw));
const rawMesh = meshOf(stairRaw), rbx = bb(stairRaw), rzMid = (rbx.min.z + rbx.max.z) / 2, rcx = (rbx.min.x + rbx.max.x) / 2;
let yMinZ = 0, yMaxZ = 0;
for (let z = rbx.min.z; z <= rbx.max.z; z += rd.z / 24) { const y = surfaceY(rawMesh, rcx, z); if (y != null) (z < rzMid ? (yMinZ = Math.max(yMinZ, y)) : (yMaxZ = Math.max(yMaxZ, y))); }
const STAIR_ROT = yMaxZ > yMinZ ? Math.PI : 0;
const STAIR_WIDTH = 2 * catHalfW, STAIR_RUN = DECK_Y * 1.7, STAIR_TOP_Z = catHalfLen, STAIR_Zc = STAIR_TOP_Z + STAIR_RUN / 2;
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
function tread(mesh, catX) { let maxY = 0, atZ = STAIR_TOP_Z; for (let z = STAIR_TOP_Z - 0.5; z <= STAIR_Zc + STAIR_RUN / 2 + 1e-3; z += 0.08) { const y = surfaceY(mesh, catX, z); if (y != null && y > maxY) { maxY = y; atZ = z; } } return { maxY, atZ }; }
const syGuess = DECK_Y / rd.y;
const t0 = tread(buildStair(cW, syGuess), cW);
const sY = t0.maxY > 0.01 ? syGuess * (DECK_Y / t0.maxY) : syGuess;
const treadW = tread(buildStair(cW, sY), cW);

// ===== FOOTPRINTS =====
const crateG = normalize(await loadGeom('storage-crate.glb'), 'x', 1.0);
const termG = normalize(await loadGeom('halo-terminal.glb'), 'y', 1.2);
const cD = dim(bb(crateG)), tD = dim(bb(termG));
const crateR = Math.hypot(cD.x, cD.z) / 2, termR = Math.hypot(tD.x, tD.z) / 2;
const crates = [{ x: -2.6, z: 0.4 }, { x: 2.2, z: 1.4 }, { x: 4.0, z: 3.2 }, { x: cE, z: -1.5, y: DECK_Y }];
const terms = [{ x: -3.4, z: 4.2 }, { x: 3.4, z: -2.6 }, { x: -3.0, z: -4.0 }];
const props = [
  ...crates.map((c, i) => ({ x: c.x, z: c.z, r: crateR, y0: c.y || 0, y1: (c.y || 0) + cD.y, name: `crate${i}` })),
  ...terms.map((t, i) => ({ x: t.x, z: t.z, r: termR, y0: 0, y1: tD.y, name: `term${i}` })),
  { x: 0, z: 1.5, r: 0.2, y0: 0, y1: 0.3, name: 'coin' },
];
const box = (x, z, hx, hz, y0, y1, name) => ({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, y0, y1, name });
const pVis = [[-ring,-ring],[ring,-ring],[-ring,0],[ring,0],[-ring,6],[ring,6]].map(([x, z]) => box(x, z, 0.75, 0.77, 0, 6, `pillar@${f2(x)},${f2(z)}`));
const pCol = [[-ring,-ring],[ring,-ring],[-ring,0],[ring,0],[-ring,6],[ring,6]].map(([x, z]) => ({ minX: x - 0.6, maxX: x + 0.6, minZ: z - 0.6, maxZ: z + 0.6, minY: 0, maxY: 6 }));
const vault = box(0, -5.45, 1.9, 1.75, 0, 3.4, 'vault');
const decksVis = [cW, cE].map((x) => box(x, 0, catHalfW, catHalfLen, 0, DECK_Y, `deck@${f2(x)}`));
const stairsVis = [cW, cE].map((x) => box(x, STAIR_Zc, STAIR_WIDTH / 2, STAIR_RUN / 2 + 1e-9, 0, DECK_Y, `stair@${f2(x)}`));

const yOv = (a, b) => a.y0 < (b.y1 ?? b.maxY) - 0.02 && a.y1 > (b.y0 ?? b.minY) + 0.02;
const circleBoxPen = (c, b) => { const nx = Math.max(b.minX, Math.min(c.x, b.maxX)), nz = Math.max(b.minZ, Math.min(c.z, b.maxZ)); return yOv(c, b) ? c.r - Math.hypot(c.x - nx, c.z - nz) : -1; };
const circleCirclePen = (a, b) => yOv(a, b) ? (a.r + b.r) - Math.hypot(a.x - b.x, a.z - b.z) : -1;
const boxBoxPen = (a, b) => { if (!yOv(a, b)) return -1; const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX), oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ); return (ox > 0 && oz > 0) ? Math.min(ox, oz) : -1; };

// ===== OVERLAP PASS (props kept clear of everything; deck/stair vs vault flagged) =====
const hits = [];
for (let i = 0; i < props.length; i++) {
  for (let j = i + 1; j < props.length; j++) if (circleCirclePen(props[i], props[j]) > PEN) hits.push(`${props[i].name} × ${props[j].name}`);
  for (const b of [...pVis, ...stairsVis, ...decksVis, vault]) if (circleBoxPen(props[i], b) > PEN) hits.push(`${props[i].name} × ${b.name}`);
}
for (const d of decksVis) if (boxBoxPen(d, vault) > PEN) hits.push(`${d.name} × vault`);
for (const s of stairsVis) if (boxBoxPen(s, vault) > PEN) hits.push(`${s.name} × vault`);
// pillar-through-deck / -stair are INTENDED: count, don't flag
const throughDeck = pVis.filter((p) => decksVis.some((d) => boxBoxPen(p, d) > PEN));
const throughStair = pVis.filter((p) => stairsVis.some((s) => boxBoxPen(p, s) > PEN));

// ===== DECK UNDERSIDE + PILLAR-SOLID-ON-DECK (resolveXZ replica) =====
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
const allBoxes = [...deckBoxes, ...pCol];
const underPush = resolveXZ(cW, 0, 0, allBoxes);          // under deck, feet on floor
const onDeck = resolveXZ(cW, 0, DECK_Y, allBoxes);        // standing on deck near wall
const blockedFromBelow = Math.hypot(underPush.x - cW, underPush.z - 0) > 0.1;
const walkableOnTop = Math.hypot(onDeck.x - cW, onDeck.z - 0) < 0.01;
// walk toward the z=0 west pillar ON the deck: must be blocked at the pillar collider face
const pillarColFace = -ring - 0.6; // -5.2
const deckSurfNearPillar = surfaceY(catProbe, pillarColFace - 0.1, 0);   // deck present up to the pillar
const towardPillar = resolveXZ(pillarColFace - 0.05, 0, DECK_Y, allBoxes); // just outside the pillar, push in
const pillarBlocksOnDeck = towardPillar.x <= pillarColFace + 0.02 && deckSurfNearPillar != null && Math.abs(deckSurfNearPillar - DECK_Y) < 0.05;

// ===== REPORT =====
console.log('\n=== MEZZANINE (scaled ' + MEZZ + '×) ===');
console.log(`  DECK_Y=${f2(DECK_Y)} (was ~1.19), deck half ${f2(catHalfW)}×${f2(catHalfLen)}`);
console.log(`  west deck X[${f2(cW - catHalfW)}, ${f2(cW + catHalfW)}]  (wall=-7.0, pillar line=-4.6, pillar face=-5.35)`);
console.log(`   -> outer edge at wall: ${Math.abs((cW - catHalfW) - (-half)) < 0.02}; inner edge ${f2(cW + catHalfW)} reaches into the pillars`);
console.log(`  staircases: 2, board +Z open end at z=${f2(STAIR_TOP_Z)}, run to z=${f2(STAIR_Zc + STAIR_RUN / 2)}; top tread ${f2(treadW.maxY)} @ z=${f2(treadW.atZ)}`);
console.log(`  +Z end open? ${zEndOpen} (zEnd=${f2(zEndH)}, junction=${f2(junctionH)})`);

console.log('\n=== PILLARS THROUGH STRUCTURE (intended) ===');
console.log(`  through deck: ${throughDeck.length} (${throughDeck.map((p) => p.name).join(', ') || 'none'})`);
console.log(`  through stair: ${throughStair.length} (${throughStair.map((p) => p.name).join(', ') || 'none'})`);
console.log(`  pillar solid on deck? deck surf @pillar=${f2(deckSurfNearPillar)}, pushed to x=${f2(towardPillar.x)} (face ${f2(pillarColFace)}) -> ${pillarBlocksOnDeck}`);

console.log('\n=== OVERLAP PASS (prop/structure, >5cm penetration) ===');
console.log(hits.length ? hits.map((h) => '  INTERSECT ' + h).join('\n') : '  no unintended intersections');

console.log('\n=== DECK UNDERSIDE ===');
console.log(`  from below (feet@0): pushed to (${f2(underPush.x)},${f2(underPush.z)}) blocked=${blockedFromBelow}`);
console.log(`  on top (feet@DECK_Y): stays walkable=${walkableOnTop}`);

console.log('\n=== VERIFY ===');
const checks = [
  [Math.abs(treadW.maxY - DECK_Y) <= 0.05, `stair top tread (${f2(treadW.maxY)}) ≈ DECK_Y (${f2(DECK_Y)}) within 5cm`],
  [zEndOpen && (junctionH == null || junctionH <= DECK_Y + 0.12), `staircase boards an OPEN +Z end at z=${f2(STAIR_TOP_Z)}`],
  [Math.abs((cW - catHalfW) - (-half)) < 0.05, 'deck outer edge fills to the wall (no dead space behind)'],
  [throughDeck.length >= 1, 'west pillar(s) pass through the deck (intended)'],
  [pillarBlocksOnDeck, 'pillar stays solid on the deck (walkable up to it, blocked)'],
  [hits.length === 0, 'no unintended prop/structure intersections'],
  [blockedFromBelow, 'deck blocks upward pass from below'],
  [walkableOnTop, 'deck top stays walkable'],
];
for (const [ok, msg] of checks) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${msg}`);
const allPass = checks.every(([ok]) => ok);
console.log(`\n  ${allPass ? '*** ALL PASS ***' : '*** FAIL — do not deploy ***'}`);
process.exit(allPass ? 0 : 1);
