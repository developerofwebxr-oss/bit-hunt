// Deterministic verification by RAYCASTING real decoded geometry (never bboxes)
// + an analytic overlap pass. Replicates layout.js placement.
// Pillars intentionally pass UP THROUGH the mezzanine deck (columns through the
// floor) — those contacts are reported, not failed. Run: node scripts/diag-geometry.mjs
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { generateHideSpots, SAT_COUNT } from '../src/sats.js';

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
const DECK_Z = -half + catHalfLen; // deck far (-Z) end at the -Z wall; stair points +Z into open
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
const STAIR_WIDTH = 2 * catHalfW, STAIR_RUN = DECK_Y * 1.7, STAIR_TOP_Z = DECK_Z + catHalfLen, STAIR_Zc = STAIR_TOP_Z + STAIR_RUN / 2;
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
const decksVis = [cW, cE].map((x) => box(x, DECK_Z, catHalfW, catHalfLen, 0, DECK_Y, `deck@${f2(x)}`));
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
const deckBoxes = [cW, cE].map((x) => ({ minX: x - catHalfW, maxX: x + catHalfW, minZ: DECK_Z - catHalfLen, maxZ: DECK_Z + catHalfLen - 0.35, minY: 0, maxY: DECK_Y }));
const allBoxes = [...deckBoxes, ...pCol];
const testZ = DECK_Z;                                     // a z inside the moved deck footprint
const underPush = resolveXZ(cW, testZ, 0, allBoxes);      // under deck, feet on floor
const onDeck = resolveXZ(cW, testZ, DECK_Y, allBoxes);    // standing on deck near wall
const blockedFromBelow = Math.hypot(underPush.x - cW, underPush.z - testZ) > 0.1;
const walkableOnTop = Math.hypot(onDeck.x - cW, onDeck.z - testZ) < 0.01;
// pillar now passing through the moved deck (z=-4.6 west pillar): solid on the deck
const catProbeMoved = meshOf(catG); catProbeMoved.position.set(cW, 0, DECK_Z);
const pillarZ = -ring, pillarColFace = -ring - 0.6; // pillar centre z=-4.6, wall-side face x=-5.2
const deckSurfNearPillar = surfaceY(catProbeMoved, pillarColFace - 0.1, pillarZ);
const towardPillar = resolveXZ(pillarColFace - 0.05, pillarZ, DECK_Y, allBoxes);
const pillarBlocksOnDeck = towardPillar.x <= pillarColFace + 0.02 && deckSurfNearPillar != null && Math.abs(deckSurfNearPillar - DECK_Y) < 0.05;

// stair-approach clearance: open walkable floor in front of each stair base (+Z)
function approachClearance(catX) {
  const zBase = STAIR_TOP_Z + STAIR_RUN;   // stair foot z
  const wallClear = half - zBase;          // +Z wall distance
  let pillarClear = Infinity;
  for (const [px, pz] of [[-ring,-ring],[ring,-ring],[-ring,0],[ring,0],[-ring,6],[ring,6]]) {
    if (px + 0.75 > catX - 0.5 && px - 0.75 < catX + 0.5 && pz - 0.77 > zBase) pillarClear = Math.min(pillarClear, pz - 0.77 - zBase);
  }
  return { zBase, wallClear, pillarClear, clear: Math.min(wallClear, pillarClear) };
}
const appW = approachClearance(cW), appE = approachClearance(cE);

// ===== SATS: hide-spot generation (same generateHideSpots the game uses) =====
const colBox = (x, z, hx, hz, minY, maxY) => ({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz, minY, maxY });
const coverColliders = [
  ...[[-ring,-ring],[ring,-ring],[-ring,0],[ring,0],[-ring,6],[ring,6]].map(([x, z]) => colBox(x, z, 0.6, 0.6, 0, 6)),
  ...crates.map((c) => colBox(c.x, c.z, 0.55, 0.55, c.y || 0, (c.y || 0) + 1.0)),
  ...terms.map((t) => colBox(t.x, t.z, 0.4, 0.4, 0, 1.2)),
  ...[cW, cE].map((x) => { const b = colBox(x, DECK_Z, catHalfW, catHalfLen, 0, DECK_Y); b.maxZ = DECK_Z + catHalfLen - 0.35; return b; }),
  colBox(0, -5.45, 1.9, 1.75, 0, 3.4),
];
const cover = {
  half, center: [0, 0], eyeY: 1.6, coinR: 0.13,
  pillars: [[-ring,-ring],[ring,-ring],[-ring,0],[ring,0],[-ring,6],[ring,6]].map(([x, z]) => ({ x, z, r: 0.75 })),
  crates: crates.map((c) => ({ x: c.x, z: c.z, r: 0.55, y: c.y || 0 })),
  terminals: terms.map((t) => ({ x: t.x, z: t.z, r: 0.4 })),
  decks: [cW, cE].map((x) => ({ minX: x - catHalfW, maxX: x + catHalfW, minZ: DECK_Z - catHalfLen, maxZ: DECK_Z + catHalfLen, y: DECK_Y })),
  vault: colBox(0, -5.45, 1.9, 1.75, 0, 3.4),
  colliders: coverColliders,
};
const HUNT_SEED = 1337;
const hideSpots = generateHideSpots(HUNT_SEED, cover);
// independent occlusion + embedding recompute
const segHit = (a, b, box) => { const lo = [box.minX, box.minY, box.minZ], hi = [box.maxX, box.maxY, box.maxZ]; let t0 = 0, t1 = 1; for (let i = 0; i < 3; i++) { const d = b[i] - a[i]; if (Math.abs(d) < 1e-9) { if (a[i] < lo[i] || a[i] > hi[i]) return false; continue; } let ta = (lo[i] - a[i]) / d, tb = (hi[i] - a[i]) / d; if (ta > tb) { const s = ta; ta = tb; tb = s; } t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) return false; } return t1 > 0.03 && t0 < 0.985; };
const eye = [0, 1.6, 0], CR = 0.13;
const occluders = (s) => coverColliders.filter((b) => segHit(eye, [s.x, s.y + 0.12, s.z], b)).length;
const embeddedIn = (s) => coverColliders.filter((b) => s.x > b.minX - CR * 0.4 && s.x < b.maxX + CR * 0.4 && s.z > b.minZ - CR * 0.4 && s.z < b.maxZ + CR * 0.4 && s.y > b.minY - 0.02 && s.y < b.maxY - 0.03).length;
const deckFoot = (s) => cover.decks.some((d) => s.x >= d.minX && s.x <= d.maxX && s.z >= d.minZ && s.z <= d.maxZ);
// rests on a surface if on the floor (y≈0) OR on a deck (y≈DECK_Y within a footprint)
const onSurface = (s) => Math.abs(s.y) < 0.02 || (Math.abs(s.y - DECK_Y) < 0.05 && deckFoot(s));
const occCounts = hideSpots.map(occluders);
const losCount = occCounts.filter((n) => n === 0).length;
const embedCount = hideSpots.filter((s) => embeddedIn(s) > 0).length;
const surfCount = hideSpots.filter(onSurface).length;
const belowFloor = hideSpots.filter((s) => s.y < -0.01).length;
const dist = {}; hideSpots.forEach((s) => (dist[s.type] = (dist[s.type] || 0) + 1));

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

console.log('\n=== MEZZANINE MOVE (deck+stair translated so far end meets the -Z wall) ===');
console.log(`  deck Z[${f2(DECK_Z - catHalfLen)}, ${f2(DECK_Z + catHalfLen)}]  far (-Z) end vs wall -7.0: ${f2(DECK_Z - catHalfLen)} (Δ ${f2(Math.abs((DECK_Z - catHalfLen) - -half))})`);
console.log(`  stair foot z=${f2(appW.zBase)}; approach clearance -> west ${f2(appW.clear)}m (wall ${f2(appW.wallClear)}, pillar ${appW.pillarClear === Infinity ? 'none' : f2(appW.pillarClear)}); east ${f2(appE.clear)}m`);

console.log('\n=== SATS (seed ' + HUNT_SEED + ') ===');
console.log(`  spawned: ${hideSpots.length}/${SAT_COUNT}`);
console.log(`  rest on real surface: ${surfCount}/${hideSpots.length}  (below floor: ${belowFloor})`);
console.log(`  occlusion from room-centre eye: ${hideSpots.length - losCount}/${hideSpots.length} occluded, ${losCount} in direct line of sight`);
console.log(`  embedded in solid geometry: ${embedCount}`);
console.log(`  distribution by cover: ${Object.entries(dist).map(([k, v]) => `${k}:${v}`).join('  ')}`);

console.log('\n=== VERIFY ===');
const checks = [
  [hideSpots.length === SAT_COUNT, `exactly ${SAT_COUNT} sats spawned (${hideSpots.length})`],
  [surfCount === hideSpots.length && belowFloor === 0, `all sats rest on a real surface (${surfCount}/${hideSpots.length}, none below floor)`],
  [losCount === 0, `all sats occluded from the room-centre eye (${losCount} in direct LOS)`],
  [embedCount === 0, `no sats embedded in solid geometry (${embedCount})`],
  [Math.abs(treadW.maxY - DECK_Y) <= 0.05, `stair top tread (${f2(treadW.maxY)}) ≈ DECK_Y (${f2(DECK_Y)}) within 5cm`],
  [zEndOpen && (junctionH == null || junctionH <= DECK_Y + 0.12), `staircase boards an OPEN +Z end at z=${f2(STAIR_TOP_Z)}`],
  [Math.abs((cW - catHalfW) - (-half)) < 0.05, 'deck outer edge fills to the wall (no dead space behind)'],
  [throughDeck.length >= 1, 'west pillar(s) pass through the deck (intended)'],
  [pillarBlocksOnDeck, 'pillar stays solid on the deck (walkable up to it, blocked)'],
  [hits.length === 0, 'no unintended prop/structure intersections'],
  [blockedFromBelow, 'deck blocks upward pass from below'],
  [walkableOnTop, 'deck top stays walkable'],
  [appW.clear >= 1.0 && appE.clear >= 1.0, `each staircase has ≥1m walkable approach (west ${f2(appW.clear)}m, east ${f2(appE.clear)}m)`],
  [Math.abs((DECK_Z - catHalfLen) - -half) < 0.05, `deck far (-Z) end meets the wall (${f2(DECK_Z - catHalfLen)} ≈ -${half})`],
];
for (const [ok, msg] of checks) console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${msg}`);
const allPass = checks.every(([ok]) => ok);
console.log(`\n  ${allPass ? '*** ALL PASS ***' : '*** FAIL — do not deploy ***'}`);
process.exit(allPass ? 0 : 1);
