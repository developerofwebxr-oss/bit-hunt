// Gameplay Phase 1 — vault burst + 21 sats scatter to hidden spots and sit inert.
// The hide-spot generator is PURE and deterministic (seeded), so both the game
// and scripts/diag-geometry.mjs import the SAME function — one source of truth,
// and a light multiplayer-ready seam (swap the seed for a server seed in v4).
import * as THREE from 'three';

export const SAT_COUNT = 21;

// ---- seeded PRNG (mulberry32) ----
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// segment (a->b) vs AABB slab test; true if it enters the box strictly between
// the endpoints (t in [tMin,tMax]) — used for line-of-sight occlusion.
function segHitsBox(a, b, box, tMin = 0.03, tMax = 0.985) {
  const lo = [box.minX, box.minY ?? 0, box.minZ];
  const hi = [box.maxX, box.maxY ?? box.y ?? 0, box.maxZ];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 3; i++) {
    const d = b[i] - a[i];
    if (Math.abs(d) < 1e-9) { if (a[i] < lo[i] || a[i] > hi[i]) return false; continue; }
    let ta = (lo[i] - a[i]) / d, tb = (hi[i] - a[i]) / d;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return false;
  }
  return t1 > tMin && t0 < tMax;
}

const inBox = (x, y, z, b, pad) =>
  x > b.minX - pad && x < b.maxX + pad && z > b.minZ - pad && z < b.maxZ + pad &&
  y > (b.minY ?? 0) - 0.02 && y < (b.maxY ?? b.y ?? 0) - 0.03;

// cover: { center:[x,z], eyeY, coinR, colliders:[AABB],
//          pillars:[{x,z,r}], crates:[{x,z,r,y}], terminals:[{x,z,r}],
//          vault:AABB, decks:[AABB w/ y], half }
// Returns up to 21 { x,y,z, type } spots, each occluded from the eye + not embedded.
export function generateHideSpots(seed, cover) {
  const rng = makeRng(seed);
  const [cx, cz] = cover.center;
  const eye = [cx, cover.eyeY, cz];
  const R = cover.coinR;

  const occluded = (x, y, z) => cover.colliders.some((b) => segHitsBox(eye, [x, y, z], b));
  const embedded = (x, y, z) => cover.colliders.some((b) => inBox(x, y, z, b, R * 0.4));

  const cand = [];
  // place N spots tucked BEHIND an object (far side from the room centre)
  const behind = (ox, oz, r, y, type, n) => {
    const dx = ox - cx, dz = oz - cz, d = Math.hypot(dx, dz) || 1;
    const ux = dx / d, uz = dz / d, px = -uz, pz = ux; // unit + perpendicular
    for (let k = 0; k < n; k++) {
      const lat = (rng() - 0.5) * r * 1.5;
      const dist = r + R + 0.06 + rng() * 0.22;
      cand.push({ x: ox + ux * dist + px * lat, y, z: oz + uz * dist + pz * lat, type });
    }
  };

  cover.pillars.forEach((p) => behind(p.x, p.z, p.r, 0, 'pillar', 3));      // 6×3 = 18
  cover.crates.forEach((c) => behind(c.x, c.z, c.r, c.y || 0, 'crate', 1)); // 4
  cover.terminals.forEach((t) => behind(t.x, t.z, t.r, 0, 'terminal', 1));  // 3
  if (cover.vault) {                                                        // vault surround
    const vz = (cover.vault.minZ + cover.vault.maxZ) / 2 + 1.2;
    behind(cover.vault.minX - 0.1, vz, 0.45, 0, 'vault', 1);
    behind(cover.vault.maxX + 0.1, vz, 0.45, 0, 'vault', 1);
  }
  cover.decks.forEach((dk) => {                                            // up on the decks, wall-side
    const dcx = (dk.minX + dk.maxX) / 2;
    const wallX = dcx < 0 ? dk.minX + 0.35 : dk.maxX - 0.35;
    // deck-relative Z so on-deck spots ride WITH the deck wherever it sits
    const dcz = (dk.minZ + dk.maxZ) / 2, dhz = (dk.maxZ - dk.minZ) / 2 - 0.4;
    cand.push({ x: wallX, y: dk.y, z: dcz + (rng() - 0.5) * dhz, type: 'deck' });
    cand.push({ x: wallX, y: dk.y, z: dcz + (rng() - 0.5) * dhz, type: 'deck' });
  });

  // validate (raise 0.12 off the surface so a floor sat's own resting surface
  // isn't counted as its occluder) and keep a diverse, seeded selection.
  const valid = cand.filter((s) => !embedded(s.x, s.y, s.z) && occluded(s.x, s.y + 0.12, s.z));
  // seeded shuffle
  for (let i = valid.length - 1; i > 0; i--) { const j = (rng() * (i + 1)) | 0; [valid[i], valid[j]] = [valid[j], valid[i]]; }
  // round-robin by type for spread, then fill
  const byType = {};
  for (const s of valid) (byType[s.type] ??= []).push(s);
  const order = Object.keys(byType);
  const picked = [];
  let idx = 0;
  while (picked.length < SAT_COUNT && order.some((t) => byType[t].length)) {
    const t = order[idx % order.length]; idx++;
    if (byType[t].length) picked.push(byType[t].shift());
  }
  return picked.slice(0, SAT_COUNT);
}

// ---- runtime: spawn, burst-scatter, idle ----
export function createSats({ scene, vaultApi, coinObj, cover, seed = 1 }) {
  const spots = generateHideSpots(seed, cover);
  const orange = new THREE.MeshStandardMaterial({
    color: 0xff8c1a, emissive: 0xff6a00, emissiveIntensity: 0.9, metalness: 0.5, roughness: 0.4,
  });
  const emit = vaultApi?.hole?.center
    ? vaultApi.hole.center.clone()
    : new THREE.Vector3(0, 1.4, -4);

  const group = new THREE.Group(); group.name = 'sats';
  scene.add(group);
  const sats = spots.map((s, i) => {
    const m = coinObj.clone(true);
    m.name = `hunt-sat-${i}`;
    m.traverse((o) => { if (o.isMesh) o.material = orange; });
    m.visible = false;
    group.add(m);
    return {
      mesh: m, spot: new THREE.Vector3(s.x, s.y, s.z), type: s.type,
      state: 'idle-vault', t: 0, delay: 0, arc: 0, phase: Math.random() * Math.PI * 2,
    };
  });

  let active = false;
  const caught = new Set();   // indices removed from the hunt (shoot-to-return, next phase)
  const TRAVEL = 1.4; // s per sat

  function burst() {
    if (active) return;
    active = true;
    vaultApi?.openVault?.();
    sats.forEach((s, i) => {
      s.mesh.visible = true;
      s.mesh.position.copy(emit);
      s.state = 'flying';
      s.t = 0;
      s.delay = 0.15 + (i % 7) * 0.06 + Math.random() * 0.1; // staggered emit
      s.arc = 0.6 + Math.random() * 0.9 + Math.max(0, s.spot.distanceTo(emit) * 0.12);
    });
  }
  function reset() {
    active = false;
    caught.clear();
    vaultApi?.closeVault?.();
    sats.forEach((s) => { s.mesh.visible = false; s.state = 'idle-vault'; s.t = 0; });
  }

  const tmp = new THREE.Vector3();
  function update(dt, time) {
    for (const s of sats) {
      if (s.state === 'flying') {
        if (s.delay > 0) { s.delay -= dt; continue; }
        s.t = Math.min(1, s.t + dt / TRAVEL);
        const e = s.t < 0.5 ? 2 * s.t * s.t : 1 - Math.pow(-2 * s.t + 2, 2) / 2; // easeInOutQuad
        tmp.lerpVectors(emit, s.spot, e);
        tmp.y += Math.sin(Math.PI * s.t) * s.arc;      // arc up and over
        s.mesh.position.copy(tmp);
        s.mesh.rotation.y += dt * 6;
        if (s.t >= 1) { s.state = 'hidden'; s.mesh.position.copy(s.spot); }
      } else if (s.state === 'hidden') {
        // gentle idle so a found sat reads as a collectible
        s.mesh.position.y = s.spot.y + 0.05 + Math.sin(time * 1.6 + s.phase) * 0.03;
        s.mesh.rotation.y += dt * 0.7;
      }
    }
  }

  return {
    burst, reset, update,
    get spots() { return spots; },
    get isActive() { return active; },
    // still-hidden, uncaught sats as world positions — the scanner's target set.
    // Empty until burst (sats are in the vault), so the gun stays silent at rest.
    get targets() {
      const out = [];
      for (let i = 0; i < sats.length; i++) {
        const s = sats[i];
        if (s.state === 'hidden' && !caught.has(i)) out.push({ x: s.spot.x, y: s.spot.y, z: s.spot.z });
      }
      return out;
    },
    markCaught(i) { caught.add(i); },       // wired to shoot-to-return next phase
    resetCaught() { caught.clear(); },
    get caughtCount() { return caught.size; },
  };
}
