// Scene layout: a ring of pillars with beams across their tops, a catwalk along
// two walls with a staircase up to it, and scattered props (mining rigs, crates,
// holo terminals) placed as future hiding spots. Repeated pieces are drawn with
// InstancedMesh from a single baked geometry/material — no mesh duplication.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { loadAssets } from './assets.js';
import { ROOM } from './room.js';

// Bake a normalized asset group (already scaled, base at y=0) into ONE geometry +
// material so it can be instanced. Assumes a single material (our assets each
// carry one baked texture).
function bake(obj) {
  obj.updateMatrixWorld(true);
  const geoms = [];
  let material = null;
  obj.traverse((o) => {
    if (!o.isMesh) return;
    if (!material) material = o.material;
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld); // into obj-local frame (obj at origin)
    // strip attributes that won't merge uniformly
    for (const key of Object.keys(g.attributes)) {
      if (!['position', 'normal', 'uv'].includes(key)) g.deleteAttribute(key);
    }
    if (!g.attributes.uv) {
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    }
    geoms.push(g);
  });
  const geometry = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
  return { geometry, material };
}

// transforms: [{ x,y,z, ry?, rx?, s? }]
function instanced(name, { geometry, material }, transforms) {
  const mesh = new THREE.InstancedMesh(geometry, material, transforms.length);
  mesh.name = name;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  transforms.forEach((t, i) => {
    e.set(t.rx || 0, t.ry || 0, t.rz || 0);
    q.setFromEuler(e);
    pos.set(t.x, t.y || 0, t.z);
    scl.setScalar(t.s || 1);
    m.compose(pos, q, scl);
    mesh.setMatrixAt(i, m);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false; // instances span the room; cull as a whole is wrong
  return mesh;
}

// Raycast straight DOWN onto `obj` at world (x,z); return the highest real
// surface Y hit, or null. Used to measure walkable surfaces (deck tops, stair
// treads) instead of trusting bounding boxes.
function surfaceYAt(obj, x, z, from = 40) {
  const rc = new THREE.Raycaster(new THREE.Vector3(x, from, z), new THREE.Vector3(0, -1, 0));
  const hits = rc.intersectObject(obj, true);
  return hits.length ? hits[0].point.y : null;
}

export async function buildLayout(scene) {
  // Mining rigs pulled for now (re-placed once the mezzanine's right).
  const A = await loadAssets(['pillar', 'beam', 'catwalk', 'staircase', 'crate', 'terminal', 'coin']);

  const half = ROOM.size / 2;
  const ring = 4.6;             // pillar ring radius (inset from walls)
  const pillarH = 6.0;
  const group = new THREE.Group();
  group.name = 'layout';

  // ---- Pillars: 6 in two rows. Both far (+Z) pillars sit at z = 6.0 (the
  // corners) so they clear the wall-hugging platforms + staircases, and the
  // centre aisle to the vault stays clear. ----
  const farW = [-ring, 6.0], farE = [ring, 6.0];
  const pPos = [
    [-ring, -ring], [ring, -ring],
    [-ring, 0], [ring, 0],
    farW, farE,
  ];
  const pillars = instanced('pillars', bake(A.pillar.obj), pPos.map(([x, z]) => ({ x, z })));
  group.add(pillars);

  // ---- Beams across pillar tops (perimeter of the rectangle) ----
  // beam baked length = SCALE_TARGETS.beam.size (6). Per-instance scale fits the span.
  const beamLen = 6.0;
  const beamBaked = bake(A.beam.obj);
  const beamY = pillarH - 0.25;
  const beamT = [];
  const segs = [ // pairs of pillars to span with a beam
    [[-ring, -ring], [-ring, 0]], [[-ring, 0], farW], // west run
    [[ring, -ring], [ring, 0]], [[ring, 0], farE],    // east run
    [[-ring, -ring], [ring, -ring]],                   // north top (spans aisle, up high)
    [farW, farE],                                      // south top (straight)
  ];
  for (const [[ax, az], [bx, bz]] of segs) {
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const span = Math.hypot(bx - ax, bz - az);
    const ang = Math.atan2(bz - az, bx - ax); // beam long axis is +X
    beamT.push({ x: mx, y: beamY, z: mz, ry: -ang, s: span / beamLen });
  }
  // beams need non-uniform scale (length only) — handle individually:
  {
    const mesh = new THREE.InstancedMesh(beamBaked.geometry, beamBaked.material, beamT.length);
    mesh.name = 'beams';
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
    beamT.forEach((t, i) => {
      e.set(0, t.ry, 0); q.setFromEuler(e);
      m.compose(new THREE.Vector3(t.x, t.y, t.z), q, new THREE.Vector3(t.s, 1, 1));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  // ---- Mezzanine: ONE grounded platform per wall (west + east), centred on the
  // wall. Deck rests on the floor (base y=0); DECK_Y is the raycast-measured
  // walkable top. Sections tile along Z, so the Z-ends are OPEN (no rail) — that's
  // where the staircase boards. ----
  // Uniformly scale the mezzanine + staircase up (MEZZ_SCALE) — taller AND wider
  // together, proportions preserved. The deck extends inward to the pillar line
  // and its outer edge sits at the wall (fills the wall-side dead space); the
  // west pillars pass UP THROUGH the deck (columns through the floor) and stay
  // solid up there via their own colliders, so you walk around them on the deck.
  const MEZZ_SCALE = 1.45;
  const catBaked = bake(A.catwalk.obj);
  catBaked.geometry.applyMatrix4(new THREE.Matrix4().makeScale(MEZZ_SCALE, MEZZ_SCALE, MEZZ_SCALE));
  catBaked.geometry.computeBoundingBox();
  const cbb = catBaked.geometry.boundingBox;
  const catHalfW = (cbb.max.x - cbb.min.x) / 2;
  const catHalfLen = (cbb.max.z - cbb.min.z) / 2;
  const catW = -half + catHalfW, catE = half - catHalfW; // outer edge flush to the wall
  const catProbe = new THREE.Mesh(catBaked.geometry, catBaked.material);
  catProbe.position.set(catW, 0, 0);
  catProbe.updateMatrixWorld(true);
  const DECK_Y = surfaceYAt(catProbe, catW, 0) ?? 1.7;
  // rail check: the +Z end (approach) should be open (~DECK_Y)
  const zEndH = surfaceYAt(catProbe, catW, catHalfLen * 0.92);
  const junctionH = surfaceYAt(catProbe, catW, catHalfLen - 0.25);
  const zEndOpen = zEndH == null || zEndH <= DECK_Y + 0.12;
  group.add(instanced('catwalk', catBaked, [
    { x: catW, y: 0, z: 0, ry: 0 },          // west (one section)
    { x: catE, y: 0, z: 0, ry: Math.PI },     // east (one section)
  ]));

  // ---- Staircases: one per platform, boarding the OPEN +Z end, in-line with the
  // deck (same X + width) so the whole structure scales together. Sized by the
  // top walkable TREAD (raycast, not the handrail) so it meets DECK_Y flush. ----
  const STAIR_WIDTH = 2 * catHalfW;                // match the deck width
  const STAIR_RUN = DECK_Y * 1.7;                  // scales with DECK_Y (uniform)
  const STAIR_TOP_Z = catHalfLen;                  // deck open +Z edge
  const STAIR_Zc = STAIR_TOP_Z + STAIR_RUN / 2;    // run centre; top at deck, base beyond (+Z)
  // raw ascent: which run (Z) end is high? Face that end at the deck (-Z of the stair)
  A.staircase.obj.updateMatrixWorld(true);
  const rawStair = new THREE.Box3().setFromObject(A.staircase.obj);
  const rawDim = rawStair.getSize(new THREE.Vector3());
  const rcx = (rawStair.min.x + rawStair.max.x) / 2, rzMid = (rawStair.min.z + rawStair.max.z) / 2;
  let yMinZ = 0, yMaxZ = 0;
  for (let z = rawStair.min.z; z <= rawStair.max.z; z += rawDim.z / 24) {
    const y = surfaceYAt(A.staircase.obj, rcx, z);
    if (y != null) (z < rzMid ? (yMinZ = Math.max(yMinZ, y)) : (yMaxZ = Math.max(yMaxZ, y)));
  }
  const STAIR_ROT = yMaxZ > yMinZ ? Math.PI : 0;   // send raw high end to -Z (deck edge)
  const sX = STAIR_WIDTH / rawDim.x, sZ = STAIR_RUN / rawDim.z;

  const buildStair = (catX, sy) => {
    const mesh = A.staircase.obj.clone(true);
    mesh.scale.set(sX, sy, sZ);
    mesh.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(mesh);
    const c = bb.getCenter(new THREE.Vector3());
    mesh.position.set(-c.x, -bb.min.y, -c.z);      // recenter XZ + base to y=0
    const g = new THREE.Group();
    g.name = 'staircase';
    g.add(mesh);
    g.position.set(catX, 0, STAIR_Zc);
    g.rotation.y = STAIR_ROT;
    g.updateMatrixWorld(true);
    return g;
  };
  // top tread = max surface Y along the run at centre-width (rails at the edges)
  const topTread = (g, catX) => {
    let maxY = 0, atZ = STAIR_TOP_Z;
    for (let z = STAIR_TOP_Z - 0.5; z <= STAIR_Zc + STAIR_RUN / 2 + 1e-3; z += 0.08) {
      const y = surfaceYAt(g, catX, z);
      if (y != null && y > maxY) { maxY = y; atZ = z; }
    }
    return { maxY, atZ };
  };
  const syGuess = DECK_Y / rawDim.y;
  const t0 = topTread(buildStair(catW, syGuess), catW);
  const sY = t0.maxY > 0.01 ? syGuess * (DECK_Y / t0.maxY) : syGuess;
  group.add(buildStair(catW, sY));
  group.add(buildStair(catE, sY));
  const treadW = topTread(group.getObjectByName('staircase'), catW);
  console.log(`[layout] MEZZx${MEZZ_SCALE} DECK_Y=${DECK_Y.toFixed(2)} deckX[${(catW - catHalfW).toFixed(2)},${(catW + catHalfW).toFixed(2)}] deckZ±${catHalfLen.toFixed(2)} tread=${treadW.maxY.toFixed(2)}@z${treadW.atZ.toFixed(2)} zEndOpen=${zEndOpen} junction=${junctionH?.toFixed(2)}`);

  // ---- Scattered props (hiding spots). Mining rigs + the vault-adjacent crate
  // removed for now (the latter was clipping the vault door). ----
  const crateT = [
    { x: -2.6, z: 0.4, ry: 0.2 },              // moved clear of pillar (-4.6,0)
    { x: 2.2, z: 1.4, ry: 1.1 },
    { x: 4.0, z: 3.2, ry: 0.9 },
    { x: catE, y: DECK_Y, z: -1.5, ry: 0.3 }, // one up on the (grounded) east deck
  ];
  group.add(instanced('crates', bake(A.crate.obj), crateT));

  // Terminals kept clear of the wall-hugging staircases (x ≈ ±6) and pillars.
  const termT = [
    { x: -3.4, z: 4.2, ry: 0.7 },
    { x: 3.4, z: -2.6, ry: -1.2 },             // moved clear of pillar (4.6,-4.6)
    { x: -3.0, z: -4.0, ry: 2.2 },
  ];
  group.add(instanced('terminals', bake(A.terminal.obj), termT));

  // ---- One sat coin as a scale/look check (standing, near centre) ----
  const coin = A.coin.obj;
  coin.position.set(0, 0.0, 1.5);
  coin.name = 'sat-coin';
  group.add(coin);

  // ---- Collision data (single source of truth with the placements above) ----
  // Boxes are XZ AABBs with a vertical [minY,maxY] span; half-extents are the
  // collidable core (a touch tighter than the visual mesh so you don't bump air).
  const box = (x, z, half, top, base = 0) =>
    ({ minX: x - half, maxX: x + half, minZ: z - half, maxZ: z + half, minY: base, maxY: top });

  const colliders = [];
  for (const [x, z] of pPos) colliders.push(box(x, z, 0.6, pillarH));      // pillars
  for (const t of crateT) colliders.push(box(t.x, t.z, 0.55, (t.y || 0) + 1.0, t.y || 0)); // crates
  for (const t of termT) colliders.push(box(t.x, t.z, 0.4, 1.2));          // terminals
  // (mining rigs removed — no colliders either, so nothing invisible to bump)

  // Deck underside collision: each platform footprint is SOLID from floor to
  // DECK_Y, so you can't phase up through the deck from below. resolveXZ skips a
  // box once feet are at/above its maxY, so walking ON the deck (feet = DECK_Y)
  // is unaffected — the only way up is the staircase. Inset the +Z entry edge so
  // the ramp boards without a push-out wall.
  for (const catX of [catW, catE]) {
    const b = box(catX, 0, catHalfW, DECK_Y, 0);
    b.minZ = -catHalfLen; b.maxZ = catHalfLen - 0.35; // full footprint, entry edge inset
    colliders.push(b);
  }

  // Walkable deck surfaces (west + east) at DECK_Y — reachable only via the stairs.
  const surfaces = [
    { minX: catW - catHalfW, maxX: catW + catHalfW, minZ: -catHalfLen, maxZ: catHalfLen, y: DECK_Y },
    { minX: catE - catHalfW, maxX: catE + catHalfW, minZ: -catHalfLen, maxZ: catHalfLen, y: DECK_Y },
  ];

  // Walk-ramps (one per staircase): run along Z, base (y=0) at the +Z end, top
  // (DECK_Y) at the deck edge. Top overlaps the deck edge slightly so you reach
  // DECK_Y before the deck collider begins.
  const rampFor = (catX) => ({
    minX: catX - STAIR_WIDTH / 2, maxX: catX + STAIR_WIDTH / 2,
    minZ: STAIR_TOP_Z - 0.3, maxZ: STAIR_Zc + STAIR_RUN / 2,
    axis: 'z', lowY: 0, highY: DECK_Y, lowAt: 'hi',
  });
  const ramps = [rampFor(catW), rampFor(catE)];

  scene.add(group);
  return { group, colliders, surfaces, ramps, DECK_Y, catW, catE, catHalfW, catHalfLen, STAIR_TOP_Z, STAIR_RUN, STAIR_WIDTH };
}
