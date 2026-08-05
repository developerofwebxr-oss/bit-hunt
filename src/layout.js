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

  // ---- Pillars: 6 in two rows (corners + side mids), leaving the centre
  // aisle to the vault clear (no pillar in front of the vault). ----
  // The far-west pillar was at [-ring, ring] — squarely inside the staircase
  // run — so it's relocated along the west row to the corner (z = 6.0), clear
  // of the stair footprint and the wall.
  const stairPillar = [-ring, 6.0];
  const pPos = [
    [-ring, -ring], [ring, -ring],
    [-ring, 0], [ring, 0],
    stairPillar, [ring, ring],
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
    [[-ring, -ring], [-ring, 0]], [[-ring, 0], stairPillar], // west run (to relocated pillar)
    [[ring, -ring], [ring, 0]], [[ring, 0], [ring, ring]],   // east run
    [[-ring, -ring], [ring, -ring]],                          // north top (spans aisle, up high)
    [stairPillar, [ring, ring]],                             // south top (angled to the moved pillar)
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

  // ---- Catwalk / mezzanine along the west (-X) and east (+X) walls. GROUNDED
  // on the floor (support bottom at y=0), NOT floating. The walkable deck height
  // DECK_Y is measured by raycasting the real platform top (never the bbox base)
  // and drives placement + locomotion ground height. ----
  const catW = -half + 1.0, catE = half - 1.0, catLen = 4.0;
  const catBaked = bake(A.catwalk.obj); // geometry recentred XZ, base at y=0
  catBaked.geometry.computeBoundingBox();
  const catHalfW = (catBaked.geometry.boundingBox.max.x - catBaked.geometry.boundingBox.min.x) / 2;
  // probe one grounded section; raycast its centre (between the edge rails) to
  // find the actual walkable deck surface.
  const catProbe = new THREE.Mesh(catBaked.geometry, catBaked.material);
  catProbe.position.set(catW, 0, 0);
  catProbe.updateMatrixWorld(true);
  const DECK_Y = surfaceYAt(catProbe, catW, 0) ?? 1.5;
  const catT = [];
  for (let i = -1; i <= 1; i++) catT.push({ x: catW, y: 0, z: i * catLen, ry: 0 });         // west (grounded)
  for (let i = -1; i <= 1; i++) catT.push({ x: catE, y: 0, z: i * catLen, ry: Math.PI });    // east (grounded)
  group.add(instanced('catwalk', catBaked, catT));

  // ---- Staircase up to the west deck ----
  // Sized/oriented by RAYCAST, not bbox: (1) probe the RAW model to see which run
  // end is high, then pick the rotation that lands the HIGH end at the -X deck;
  // (2) scale so the top walkable TREAD (raycast, ignoring the handrail) meets
  // DECK_Y. Run/width give a believable slope; recentred + wrapped so rotation
  // pivots about its own centre and the base stays on the floor.
  const STAIR_Z = 4.0, STAIR_WIDTH = 1.4;
  const STAIR_RUN = Math.max(1.6, DECK_Y * 1.7); // gentle slope to the (grounded) deck
  const stairTopX = -half + 1.7;                  // west deck inner edge (~ -5.3)
  const STAIR_X = stairTopX + STAIR_RUN / 2;      // run centre; top at deck, base toward interior

  // raw dims + ascent direction
  A.staircase.obj.updateMatrixWorld(true);
  const rawStair = new THREE.Box3().setFromObject(A.staircase.obj);
  const rawDim = rawStair.getSize(new THREE.Vector3());
  const rcx = (rawStair.min.x + rawStair.max.x) / 2, rzMid = (rawStair.min.z + rawStair.max.z) / 2;
  let yMinZ = 0, yMaxZ = 0;
  for (let z = rawStair.min.z; z <= rawStair.max.z; z += rawDim.z / 24) {
    const y = surfaceYAt(A.staircase.obj, rcx, z);
    if (y != null) (z < rzMid ? (yMinZ = Math.max(yMinZ, y)) : (yMaxZ = Math.max(yMaxZ, y)));
  }
  // rotateY sends local +Z -> -X at -90°, local -Z -> -X at +90°. Face high end at -X deck.
  const STAIR_ROT = yMaxZ > yMinZ ? -Math.PI / 2 : Math.PI / 2;
  const sX = STAIR_WIDTH / rawDim.x, sZ = STAIR_RUN / rawDim.z;

  const buildStair = (sy) => {
    const mesh = A.staircase.obj.clone(true);
    mesh.scale.set(sX, sy, sZ);
    mesh.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(mesh);
    const c = bb.getCenter(new THREE.Vector3());
    mesh.position.set(-c.x, -bb.min.y, -c.z);     // recenter XZ + base to y=0
    const g = new THREE.Group();
    g.name = 'staircase';
    g.add(mesh);
    g.position.set(STAIR_X, 0, STAIR_Z);
    g.rotation.y = STAIR_ROT;
    g.updateMatrixWorld(true);
    return g;
  };
  // top tread = max surface Y along the run at centre-width (rails are at the edges)
  const topTread = (g) => {
    let maxY = 0, atX = STAIR_X;
    for (let x = STAIR_X - STAIR_RUN / 2; x <= STAIR_X + STAIR_RUN / 2 + 1e-3; x += 0.08) {
      const y = surfaceYAt(g, x, STAIR_Z);
      if (y != null && y > maxY) { maxY = y; atX = x; }
    }
    return { maxY, atX };
  };
  // one linear correction so the top tread hits DECK_Y (tread ∝ scale.y)
  const syGuess = DECK_Y / rawDim.y;
  const t0 = topTread(buildStair(syGuess));
  const sY = t0.maxY > 0.01 ? syGuess * (DECK_Y / t0.maxY) : syGuess;
  const stair = buildStair(sY);
  group.add(stair);
  const stairTread = topTread(stair); // for the log/collider
  console.log(`[layout] DECK_Y=${DECK_Y.toFixed(2)}  stairTopTread=${stairTread.maxY.toFixed(2)} @x=${stairTread.atX.toFixed(2)}  rot=${(STAIR_ROT * 180 / Math.PI).toFixed(0)}deg`);

  // ---- Scattered props (hiding spots). Mining rigs removed for now. ----
  const crateT = [
    { x: -3.6, z: -1.2, ry: 0.2 },
    { x: 2.2, z: 1.4, ry: 1.1 },
    { x: -1.0, z: -3.4, ry: -0.5 },
    { x: 4.0, z: 3.2, ry: 0.9 },
    { x: catE, y: DECK_Y, z: -1.5, ry: 0.3 }, // one up on the (grounded) east deck
  ];
  group.add(instanced('crates', bake(A.crate.obj), crateT));

  const termT = [
    { x: -4.2, z: 4.0, ry: 0.7 },
    { x: 4.4, z: -3.6, ry: -1.2 },
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

  // Catwalk walkable surfaces (west + east runs) — grounded deck at DECK_Y.
  const surfaces = [
    { minX: catW - catHalfW, maxX: catW + catHalfW, minZ: -catLen * 1.5, maxZ: catLen * 1.5, y: DECK_Y }, // west
    { minX: catE - catHalfW, maxX: catE + catHalfW, minZ: -catLen * 1.5, maxZ: catLen * 1.5, y: DECK_Y }, // east
  ];

  // Walk-ramp collider matched to the corrected staircase: footprint = the tread
  // run/width, base (y=0) at the interior/high-X end, top = DECK_Y at the deck side.
  const ramp = {
    minX: STAIR_X - STAIR_RUN / 2, maxX: STAIR_X + STAIR_RUN / 2,
    minZ: STAIR_Z - STAIR_WIDTH / 2, maxZ: STAIR_Z + STAIR_WIDTH / 2,
    axis: 'x', lowY: 0, highY: DECK_Y, lowAt: 'hi',
  };

  scene.add(group);
  return { group, colliders, surfaces, ramp };
}
