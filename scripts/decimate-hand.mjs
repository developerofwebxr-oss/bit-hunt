// Focused decimate for the left-hand glove (same pipeline/rules as the gun).
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

const doc = await io.read(join(ROOT, 'assets-src', 'raw', 'left-hand.glb'));
const before = countTris(doc);
await doc.transform(dedup(), weld({ tolerance: 0.001 }), simplify({ simplifier: MeshoptSimplifier, ratio: Math.min(1, 3000 / before), error: 0.12, lockBorder: false }), prune());
const after = countTris(doc);
await io.write(join(ROOT, 'public', 'assets', 'left-hand.glb'), doc);
console.log(`left-hand: ${before.toLocaleString()} -> ${after.toLocaleString()} tris`);
