// Inspect every GLB in public/assets: triangle count, bbox size (m),
// pivot/origin offset, and whether textures are embedded.
// Run: npm run inspect
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'assets');

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

const files = readdirSync(ASSETS).filter((f) => f.endsWith('.glb')).sort();
const f2 = (n) => Number(n).toFixed(2);

const rows = [];
for (const file of files) {
  const doc = await io.read(join(ASSETS, file));
  const root = doc.getRoot();

  // Triangles across all primitives (TRIANGLES mode = 4).
  let tris = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const indices = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      const count = indices ? indices.getCount() : (pos ? pos.getCount() : 0);
      tris += Math.floor(count / 3);
    }
  }

  // World-space bbox of the default scene.
  const scene = root.getDefaultScene() || root.listScenes()[0];
  const b = getBounds(scene);
  const size = [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
  // Pivot: where is origin relative to the mesh? center offset + base (min Y).
  const center = [(b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2];

  const texCount = root.listTextures().length;

  rows.push({
    file,
    tris,
    size: `${f2(size[0])} x ${f2(size[1])} x ${f2(size[2])}`,
    baseY: f2(b.min[1]),
    centerXZ: `${f2(center[0])}, ${f2(center[2])}`,
    tex: texCount,
  });
}

console.log('\nASSET INSPECTION (raw, pre-normalization)\n');
console.log(
  ['file'.padEnd(26), 'tris'.padStart(9), 'bbox W x H x D (m)'.padEnd(22),
   'baseY'.padStart(7), 'centerXZ'.padStart(14), 'tex'.padStart(4)].join(' | ')
);
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(
    [r.file.padEnd(26), String(r.tris.toLocaleString()).padStart(9),
     r.size.padEnd(22), r.baseY.padStart(7), r.centerXZ.padStart(14),
     String(r.tex).padStart(4)].join(' | ')
  );
}
const total = rows.reduce((s, r) => s + r.tris, 0);
console.log('-'.repeat(96));
console.log(`TOTAL (one of each): ${total.toLocaleString()} tris`);
