// Diagnostic: compute REAL world AABBs by replicating assets.js normalize +
// layout.js placement on the actual decimated GLBs. No browser needed.
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ 'draco3d.decoder': await draco3d.createDecoderModule() });
const DIR = 'public/assets/';
const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
const box2 = (b) => `x[${f2(b.min[0])}, ${f2(b.max[0])}]  y[${f2(b.min[1])}, ${f2(b.max[1])}]  z[${f2(b.min[2])}, ${f2(b.max[2])}]`;

async function rawBox(file) {
  const doc = await io.read(DIR + file);
  const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
  const b = getBounds(scene);
  return { min: b.min, max: b.max, dim: [b.max[0]-b.min[0], b.max[1]-b.min[1], b.max[2]-b.min[2]] };
}
// normalize(): uniform scale to fit `size` on `fit` axis, recenter XZ, base->0
function normLocal(raw, fit, size) {
  const s = size / raw.dim[{x:0,y:1,z:2}[fit]];
  const sx = raw.dim[0]*s, sy = raw.dim[1]*s, sz = raw.dim[2]*s;
  return { s, min: [-sx/2, 0, -sz/2], max: [sx/2, sy, sz/2] };
}
const aabb = (cs) => {
  const mn = [1e9,1e9,1e9], mx = [-1e9,-1e9,-1e9];
  for (const c of cs) for (let i=0;i<3;i++){ mn[i]=Math.min(mn[i],c[i]); mx[i]=Math.max(mx[i],c[i]); }
  return { min: mn, max: mx };
};
// place a LOCAL (baked, centered) bbox: scale*inst, rotateY, translate
function place(local, { x=0,y=0,z=0,ry=0,s=1 }) {
  const cos=Math.cos(ry), sin=Math.sin(ry), cs=[];
  for (const cx of [local.min[0],local.max[0]]) for (const cy of [local.min[1],local.max[1]]) for (const cz of [local.min[2],local.max[2]]) {
    const X=cx*s, Y=cy*s, Z=cz*s;
    cs.push([x + (X*cos + Z*sin), y + Y, z + (-X*sin + Z*cos)]);
  }
  return aabb(cs);
}
// staircase: geometry stays RAW (normalize's recenter position is OVERWRITTEN by
// layout's stair.position.set), only scale s + rotateY + translate applied.
function placeRaw(raw, s, ry, pos) {
  const cos=Math.cos(ry), sin=Math.sin(ry), cs=[];
  for (const cx of [raw.min[0],raw.max[0]]) for (const cy of [raw.min[1],raw.max[1]]) for (const cz of [raw.min[2],raw.max[2]]) {
    const X=cx*s, Y=cy*s, Z=cz*s;
    cs.push([pos[0] + (X*cos + Z*sin), pos[1] + Y, pos[2] + (-X*sin + Z*cos)]);
  }
  return aabb(cs);
}
const overlapXZ = (a, b) => a.min[0] < b.max[0] && a.max[0] > b.min[0] && a.min[2] < b.max[2] && a.max[2] > b.min[2];

const half = 7, ring = 4.6, cy = 3, catLen = 4;

// ---- PILLARS ----
const pillarRaw = await rawBox('tall-pillar.glb');
const pillarLocal = normLocal(pillarRaw, 'y', 6);
const stairPillar = [-ring, 6.0]; // relocated out of the stair run
const pPos = [[-ring,-ring],[ring,-ring],[-ring,0],[ring,0],stairPillar,[ring,ring]];
const pillars = pPos.map(([x,z]) => ({ x, z, box: place(pillarLocal, { x, z }) }));

// ---- STAIRCASE (non-uniform: rise 3, run 4, width 1.4; recentred + wrapped) ----
const STAIR_RISE = 3.0, STAIR_RUN = 4.0, STAIR_WIDTH = 1.4;
const stairRaw = await rawBox('staircase-to-catwalk.glb');
const stairScale = [STAIR_WIDTH/stairRaw.dim[0], STAIR_RISE/stairRaw.dim[1], STAIR_RUN/stairRaw.dim[2]];
const stairLocal = { min: [-STAIR_WIDTH/2, 0, -STAIR_RUN/2], max: [STAIR_WIDTH/2, STAIR_RISE, STAIR_RUN/2] };
const stairBox = place(stairLocal, { x: -half+3.4, y: 0, z: 4.0, ry: -Math.PI/2 });

// ---- CATWALK (west run is the one the stairs serve) ----
const catRaw = await rawBox('catwalk-section.glb');
const catLocal = normLocal(catRaw, 'z', 4);
const catWest = [-1,0,1].map((i) => ({ z: i*catLen, box: place(catLocal, { x:-half+1.0, y:cy, z:i*catLen, ry:0 }) }));

console.log('\n=== PILLARS (visual mesh world AABB) — footprint half ≈', f2(pillarLocal.max[0]), 'm ===');
for (const p of pillars) console.log(`  (${f2(p.x)}, ${f2(p.z)})  ${box2(p.box)}`);

console.log('\n=== STAIRCASE (non-uniform) ===');
console.log(`  raw bbox dim (WxHxD): ${f2(stairRaw.dim[0])} x ${f2(stairRaw.dim[1])} x ${f2(stairRaw.dim[2])}`);
console.log(`  non-uniform scale: X ${f2(stairScale[0])}  Y ${f2(stairScale[1])}  Z ${f2(stairScale[2])}  (rise ${STAIR_RISE} / run ${STAIR_RUN} / width ${STAIR_WIDTH})`);
console.log(`  placed: pos(-3.60, 0, 4.00)  rotY=-90°  (run 4.0 along X, width 1.4 along Z after rotation)`);
console.log(`  world AABB: ${box2(stairBox)}`);
console.log(`  base Y = ${f2(stairBox.min[1])}   top Y = ${f2(stairBox.max[1])}`);
console.log(`  footprint: ${f2(stairBox.max[0]-stairBox.min[0])} (X) x ${f2(stairBox.max[2]-stairBox.min[2])} (Z)`);

console.log('\n=== WEST CATWALK (deck the stairs should meet) ===');
console.log(`  raw bbox dim: ${f2(catRaw.dim[0])} x ${f2(catRaw.dim[1])} x ${f2(catRaw.dim[2])}  (scale ${f2(catLocal.s)}x)`);
for (const c of catWest) console.log(`  z=${f2(c.z)}  ${box2(c.box)}`);
const deckBaseY = catWest[0].box.min[1], deckTopY = catWest[0].box.max[1];
console.log(`  deck mesh base Y = ${f2(deckBaseY)}   deck mesh top Y = ${f2(deckTopY)}   (placed at y=${cy})`);

const rampMinX = -half+1.4, rampMaxX = -half+5.4, rampMinZ = 3.3, rampMaxZ = 4.7;
console.log('\n=== WALK-RAMP collider (layout.js) ===');
console.log(`  x[${f2(rampMinX)}, ${f2(rampMaxX)}]  z[${f2(rampMinZ)}, ${f2(rampMaxZ)}]  axis=x  lowY=0 highY=${cy} lowAt=hi`);
const rampCoversStair = rampMinX <= stairBox.min[0]+0.05 && rampMaxX >= stairBox.max[0]-0.05 && rampMinZ <= stairBox.min[2]+0.05 && rampMaxZ >= stairBox.max[2]-0.05;
console.log(`  covers staircase footprint XZ? ${rampCoversStair ? 'YES' : 'NO — mismatch'}`);

console.log('\n=== Q1: pillar overlapping the staircase footprint? ===');
const stairXZ = { min: stairBox.min, max: stairBox.max };
let any = false;
for (const p of pillars) if (overlapXZ(p.box, stairXZ)) {
  any = true;
  console.log(`  YES — pillar (${f2(p.x)}, ${f2(p.z)}) overlaps. pillar ${box2(p.box)}  vs stair x[${f2(stairBox.min[0])}, ${f2(stairBox.max[0])}] z[${f2(stairBox.min[2])}, ${f2(stairBox.max[2])}]`);
}
if (!any) console.log('  none');

console.log('\n=== Q2: catwalk deck Y vs staircase top-step Y ===');
console.log(`  staircase top Y = ${f2(stairBox.max[1])}`);
console.log(`  catwalk deck mesh spans Y ${f2(deckBaseY)}..${f2(deckTopY)} (walk surface is somewhere in this span)`);
console.log(`  gap (deck base - stair top) = ${f2(deckBaseY - stairBox.max[1])}   (deck top - stair top) = ${f2(deckTopY - stairBox.max[1])}`);

console.log('\n=== Q3: base on floor + scale/rotation ===');
console.log(`  staircase base Y ${f2(stairBox.min[1])} (0 = on floor), top Y ${f2(stairBox.max[1])}`);
console.log(`  scale X ${f2(stairScale[0])} / Y ${f2(stairScale[1])} / Z ${f2(stairScale[2])} (non-uniform), rotY -90°.`);
console.log(`  slope: rise ${STAIR_RISE} over run ${STAIR_RUN} = ${f2(Math.atan2(STAIR_RISE, STAIR_RUN)*180/Math.PI)}°`);
