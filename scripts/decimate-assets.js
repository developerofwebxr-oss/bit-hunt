// Decimate the raw 375k-tri AI meshes down to per-asset triangle budgets.
// Pipeline per file: dedup -> weld -> simplify (meshopt) -> prune.
// Reads pristine GLBs from public/assets/raw/, writes optimized to public/assets/.
// Run: npm run decimate
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, weld, simplify, prune } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import draco3d from 'draco3dgltf';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'public', 'assets');   // optimized output (shipped)
const RAW = join(ROOT, 'assets-src', 'raw');      // pristine source (not shipped)

// Per-asset: target triangle budget (high end of the brief's ranges),
// meshopt error budget (fraction of mesh radius), and whether to lock
// topological borders. Simple props get a high error budget so they collapse
// hard; the vault keeps a tight error AND locked borders so its hole survives.
const PLAN = {
  'tall-pillar.glb':          { target: 800,   error: 0.30, lockBorder: false },
  'green-beam.glb':           { target: 500,   error: 0.30, lockBorder: false },
  'catwalk-section.glb':      { target: 2000,  error: 0.15, lockBorder: false },
  'staircase-to-catwalk.glb': { target: 2000,  error: 0.15, lockBorder: false },
  'mining-rig.glb':           { target: 4000,  error: 0.12, lockBorder: false },
  'storage-crate.glb':        { target: 1000,  error: 0.20, lockBorder: false },
  'halo-terminal.glb':        { target: 2000,  error: 0.15, lockBorder: false },
  'main-empty-vault.glb':     { target: 12000, error: 0.02, lockBorder: true  },
  'main-vault-door.glb':      { target: 3000,  error: 0.05, lockBorder: false },
  'bitcoin-sat-coin.glb':     { target: 400,   error: 0.20, lockBorder: false },
};

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
  });

await MeshoptSimplifier.ready;

const countTris = (doc) => {
  let t = 0;
  for (const m of doc.getRoot().listMeshes())
    for (const p of m.listPrimitives()) {
      const i = p.getIndices(), pos = p.getAttribute('POSITION');
      t += Math.floor((i ? i.getCount() : pos ? pos.getCount() : 0) / 3);
    }
  return t;
};

const files = readdirSync(RAW).filter((f) => f.endsWith('.glb')).sort();
console.log('\nDECIMATION (weld -> meshopt simplify)\n');
console.log(['file'.padEnd(26), 'before'.padStart(9), 'after'.padStart(8), 'target'.padStart(7)].join(' | '));
console.log('-'.repeat(60));

for (const file of files) {
  const doc = await io.read(join(RAW, file));
  const before = countTris(doc);
  const plan = PLAN[file] ?? { target: 2000, error: 0.1, lockBorder: false };
  const ratio = Math.min(1, plan.target / before);

  await doc.transform(
    dedup(),
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio, error: plan.error, lockBorder: plan.lockBorder }),
    prune(),
  );

  const after = countTris(doc);
  await io.write(join(ASSETS, file), doc);
  console.log([file.padEnd(26), before.toLocaleString().padStart(9),
    after.toLocaleString().padStart(8), String(plan.target).padStart(7)].join(' | '));
}
console.log('-'.repeat(60));
console.log('Done. Optimized GLBs written to public/assets/');
