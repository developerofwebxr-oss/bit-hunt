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

export async function buildLayout(scene) {
  const A = await loadAssets(['pillar', 'beam', 'catwalk', 'staircase', 'miningRig', 'crate', 'terminal', 'coin']);

  const half = ROOM.size / 2;
  const ring = 4.6;             // pillar ring radius (inset from walls)
  const pillarH = 6.0;
  const group = new THREE.Group();
  group.name = 'layout';

  // ---- Pillars: 6 in two rows (corners + side mids), leaving the centre
  // aisle to the vault clear (no pillar in front of the vault). ----
  const pPos = [
    [-ring, -ring], [ring, -ring],
    [-ring, 0], [ring, 0],
    [-ring, ring], [ring, ring],
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
    [[-ring, -ring], [-ring, 0]], [[-ring, 0], [-ring, ring]], // west run
    [[ring, -ring], [ring, 0]], [[ring, 0], [ring, ring]],     // east run
    [[-ring, -ring], [ring, -ring]],                            // north top (spans aisle, up high)
    [[-ring, ring], [ring, ring]],                              // south top
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

  // ---- Catwalk along the west (-X) and east (+X) walls at y = catwalkLevel.
  // (Kept off the north wall so it doesn't collide with the vault.) Deck long
  // axis is +Z, so it runs parallel to these walls with no rotation. ----
  const cy = ROOM.catwalkLevel;
  const catLen = 4.0;
  const catT = [];
  for (let i = -1; i <= 1; i++) catT.push({ x: -half + 1.0, y: cy, z: i * catLen, ry: 0 });          // west
  for (let i = -1; i <= 1; i++) catT.push({ x: half - 1.0, y: cy, z: i * catLen, ry: Math.PI });      // east (mirrored)
  group.add(instanced('catwalk', bake(A.catwalk.obj), catT));

  // ---- Staircase up to the west catwalk ----
  const stair = A.staircase.obj;
  stair.position.set(-half + 3.4, 0, 4.0);
  stair.rotation.y = -Math.PI / 2; // run points toward the west wall; verify visually
  stair.name = 'staircase';
  group.add(stair);

  // ---- Scattered props (hiding spots) ----
  const rigT = [
    { x: -2.4, z: 2.6, ry: 0.4 },
    { x: 3.2, z: -2.0, ry: -0.8 },
    { x: 1.0, z: 3.6, ry: 2.6 },
  ];
  group.add(instanced('mining-rigs', bake(A.miningRig.obj), rigT));

  const crateT = [
    { x: -3.6, z: -1.2, ry: 0.2 },
    { x: 2.2, z: 1.4, ry: 1.1 },
    { x: -1.0, z: -3.4, ry: -0.5 },
    { x: 4.0, z: 3.2, ry: 0.9 },
    { x: half - 1.0, y: cy, z: -1.5, ry: 0.3 }, // one up on the east catwalk
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
  for (const t of rigT) colliders.push(box(t.x, t.z, 0.9, 2.0));            // mining rigs
  for (const t of crateT) colliders.push(box(t.x, t.z, 0.55, (t.y || 0) + 1.0, t.y || 0)); // crates
  for (const t of termT) colliders.push(box(t.x, t.z, 0.4, 1.2));          // terminals

  // Catwalk walkable surfaces (west + east runs), y = catwalk level.
  const surfaces = [
    { minX: -half + 0.3, maxX: -half + 1.7, minZ: -catLen * 1.5, maxZ: catLen * 1.5, y: cy }, // west
    { minX: half - 1.7, maxX: half - 0.3, minZ: -catLen * 1.5, maxZ: catLen * 1.5, y: cy },   // east
  ];

  // Staircase ramp up to the WEST catwalk (run along X toward the wall; base at
  // the interior/high-X end). Tune here if the climb feels off.
  const ramp = {
    minX: -half + 1.4, maxX: -half + 5.4, minZ: 2.2, maxZ: 5.8,
    axis: 'x', lowY: 0, highY: cy, lowAt: 'hi',
  };

  scene.add(group);
  return { group, colliders, surfaces, ramp };
}
