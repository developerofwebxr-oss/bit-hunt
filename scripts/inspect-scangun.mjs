// One-off inspector for the scangun GLB: tris, bbox, pivot, materials, mesh breakdown,
// and an addressability guess for screen / indicator-row / muzzle-hoop.
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] || join(ROOT, 'assets-src', 'raw', 'scangun.glb');

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
const doc = await io.read(file);
const root = doc.getRoot();

const triOf = (p) => { const i = p.getIndices(), pos = p.getAttribute('POSITION'); return Math.floor((i ? i.getCount() : pos ? pos.getCount() : 0) / 3); };
let total = 0;
for (const m of root.listMeshes()) for (const p of m.listPrimitives()) total += triOf(p);

const scene = root.getDefaultScene() || root.listScenes()[0];
const bounds = getBounds(scene);
const dim = [bounds.max[0]-bounds.min[0], bounds.max[1]-bounds.min[1], bounds.max[2]-bounds.min[2]];

console.log(`\n=== SCANGUN GLB: ${file.split('/').pop()} ===`);
console.log(`total triangles: ${total.toLocaleString()}`);
console.log(`bbox min: [${bounds.min.map(n=>n.toFixed(3)).join(', ')}]`);
console.log(`bbox max: [${bounds.max.map(n=>n.toFixed(3)).join(', ')}]`);
console.log(`bbox size (x,y,z): [${dim.map(n=>n.toFixed(3)).join(', ')}]  (metres if authored to scale)`);
console.log(`origin/pivot vs bbox: center=[${bounds.min.map((mn,i)=>((mn+bounds.max[i])/2).toFixed(3)).join(', ')}]`);

console.log(`\n--- MATERIALS (${root.listMaterials().length}) ---`);
root.listMaterials().forEach((mat, i) => {
  const bc = mat.getBaseColorFactor();
  const em = mat.getEmissiveFactor();
  const hasTex = !!mat.getBaseColorTexture();
  console.log(`  [${i}] "${mat.getName()||'(unnamed)'}"  baseColor=[${bc.map(n=>n.toFixed(2)).join(',')}] emissive=[${em.map(n=>n.toFixed(2)).join(',')}]${hasTex?' +baseColorTex':''} metal=${mat.getMetallicFactor().toFixed(2)} rough=${mat.getRoughnessFactor().toFixed(2)}`);
});

console.log(`\n--- MESHES / PRIMITIVES (mesh -> primitive[material] tris, local bbox) ---`);
// Build node->mesh with world-ish local bbox from POSITION accessor
function primBBox(p) {
  const pos = p.getAttribute('POSITION');
  const mn=[Infinity,Infinity,Infinity], mx=[-Infinity,-Infinity,-Infinity];
  for (let i=0;i<pos.getCount();i++){const v=[0,0,0];pos.getElement(i,v);for(let k=0;k<3;k++){mn[k]=Math.min(mn[k],v[k]);mx[k]=Math.max(mx[k],v[k]);}}
  return {mn,mx};
}
root.listMeshes().forEach((m, mi) => {
  console.log(`  mesh[${mi}] "${m.getName()||'(unnamed)'}" — ${m.listPrimitives().length} prim(s)`);
  m.listPrimitives().forEach((p, pi) => {
    const mat = p.getMaterial();
    const bb = primBBox(p);
    const sz = bb.mx.map((v,k)=>(v-bb.mn[k]).toFixed(3));
    const ctr = bb.mx.map((v,k)=>((v+bb.mn[k])/2).toFixed(3));
    console.log(`    prim[${pi}] mat="${mat?.getName()||'(none)'}" tris=${triOf(p).toLocaleString()} size=[${sz.join(',')}] center=[${ctr.join(',')}]`);
  });
});

console.log(`\n--- NODES (name -> mesh) ---`);
scene.traverse((node) => {
  const mesh = node.getMesh?.();
  if (mesh) console.log(`  node "${node.getName()||'(unnamed)'}" -> mesh "${mesh.getName()||'(unnamed)'}"`);
});
