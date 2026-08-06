// Focused decimate for just the scangun (avoids rewriting every shipped asset).
// Same pipeline as decimate-assets.js: dedup -> weld -> simplify(meshopt) -> prune.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, simplify, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
  'draco3d.encoder': await draco3d.createEncoderModule(),
});
await MeshoptSimplifier.ready;

const countTris = (doc) => { let t=0; for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()){const i=p.getIndices(),pos=p.getAttribute('POSITION');t+=Math.floor((i?i.getCount():pos?pos.getCount():0)/3);} return t; };

const doc = await io.read(join(ROOT, 'assets-src', 'raw', 'scangun.glb'));
const before = countTris(doc);
const target = 3000, error = Number(process.argv[2] ?? 0.15), weldTol = Number(process.argv[3] ?? 0.0005);
await doc.transform(
  dedup(), weld({ tolerance: weldTol }),
  simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, target/before), error, lockBorder: false }),
  prune(),
);
const after = countTris(doc);
await io.write(join(ROOT, 'public', 'assets', 'scangun.glb'), doc);
console.log(`scangun: ${before.toLocaleString()} -> ${after.toLocaleString()} tris (target ${target})`);
