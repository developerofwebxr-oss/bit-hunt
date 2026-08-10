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
// the endpoints (t in [tMin,tMax]) — used for line-of-sight occlusion. `shrink`
// insets the box on X/Z (not Y): for the SHOT's LOS we shrink so a ray to a
// visually-clear coin (placed ~0.19 m outside its cover's collider) isn't eaten by
// the oversized AABB edge; occlusion (hide-spot gen) calls it with shrink=0.
function segHitsBox(a, b, box, tMin = 0.03, tMax = 0.985, shrink = 0) {
  const lo = [box.minX + shrink, box.minY ?? 0, box.minZ + shrink];
  const hi = [box.maxX - shrink, box.maxY ?? box.y ?? 0, box.maxZ - shrink];
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
  const caught = new Set();   // indices removed from the hunt (returned to the vault)
  const TRAVEL = 1.4;         // s per sat, vault -> hiding spot (burst)
  // ---- shoot-to-return tunables (top-of-feature constants) ----
  const HIT_RADIUS = 0.55;    // generous hunt hit sphere around each sat (m) — hunt, not a precision shooter
  const MAX_RANGE = 40;       // shot reach (m) — comfortably room-sized
  const RETURN_TRAVEL = 1.2;  // s for the catch -> vault flight (mirrors the burst tween)
  const LOS_SHRINK = 0.22;    // inset (m) applied to collider AABBs for the SHOT's LOS only,
                              // so a ray to a visually-clear coin isn't eaten by an oversized edge

  // green catch flash (one pooled additive sphere, reused per catch)
  let flashT = 0;
  const catchFlash = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 12, 12),
    new THREE.MeshBasicMaterial({ color: 0x8dffc4, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }),
  );
  catchFlash.visible = false; catchFlash.frustumCulled = false; group.add(catchFlash);

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
    flashT = 0; catchFlash.visible = false;
    vaultApi?.closeVault?.();
    vaultApi?.resetGlow?.();
    sats.forEach((s) => { s.mesh.visible = false; s.state = 'idle-vault'; s.t = 0; });
  }

  // Shoot: raycast the shot from the gun (origin + normalized dir). If it reaches a
  // hidden, uncaught sat within HIT_RADIUS AND has clear line of sight (walls/props
  // block it), CATCH it — start the return flight and drop it from the hunt. Returns
  // the caught { index, pos } or null (miss / blocked). LOS reuses the SAME collider
  // AABBs the scanner occludes with (cover.colliders) — one geometry source.
  function tryCatch(ox, oy, oz, dx, dy, dz) {
    const al = Math.hypot(dx, dy, dz) || 1;
    const ax = dx / al, ay = dy / al, az = dz / al;
    let best = -1, bestT = Infinity;
    for (let i = 0; i < sats.length; i++) {
      const s = sats[i];
      if (s.state !== 'hidden' || caught.has(i)) continue;
      const p = s.mesh.position;                          // the VISIBLE coin (bob included) — what the player aims at
      const vx = p.x - ox, vy = p.y - oy, vz = p.z - oz;
      const proj = vx * ax + vy * ay + vz * az;          // distance along ray to closest point
      if (proj <= 0 || proj > MAX_RANGE) continue;        // behind the muzzle / out of range
      const perp2 = (vx * vx + vy * vy + vz * vz) - proj * proj; // squared miss distance
      if (perp2 > HIT_RADIUS * HIT_RADIUS) continue;
      if (proj < bestT) { bestT = proj; best = i; }        // nearest sat the ray pierces
    }
    if (best < 0) return null;
    const s = sats[best];
    const p = s.mesh.position;
    const a = [ox, oy, oz], b = [p.x, p.y, p.z];
    if ((cover.colliders || []).some((box) => segHitsBox(a, b, box, 0.02, 0.985, LOS_SHRINK))) return null; // wall/prop in the way (edges relaxed)
    caught.add(best);                                      // scanner drops it (targets filters caught)
    s.state = 'returning'; s.t = 0; s.rStart = p.clone();
    s.arc = 0.5 + p.distanceTo(emit) * 0.12;
    catchFlash.position.copy(p); flashT = 1; catchFlash.visible = true;
    return { index: best, pos: p.clone() };
  }

  const tmp = new THREE.Vector3();
  function update(dt, time) {
    // green catch flash: expand + fade over ~0.35s
    if (flashT > 0) {
      flashT = Math.max(0, flashT - dt / 0.35);
      catchFlash.scale.setScalar(0.6 + (1 - flashT) * 3.2);
      catchFlash.material.opacity = flashT;
      if (flashT === 0) catchFlash.visible = false;
    }
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
      } else if (s.state === 'returning') {
        // reverse of the burst: eased arc from the hiding spot back into the vault
        s.t = Math.min(1, s.t + dt / RETURN_TRAVEL);
        const e = s.t < 0.5 ? 2 * s.t * s.t : 1 - Math.pow(-2 * s.t + 2, 2) / 2;
        tmp.lerpVectors(s.rStart, emit, e);
        tmp.y += Math.sin(Math.PI * s.t) * s.arc;
        s.mesh.position.copy(tmp);
        s.mesh.rotation.y += dt * 8;
        if (s.t >= 1) { s.state = 'returned'; s.mesh.visible = false; vaultApi?.pulseAbsorb?.(caught.size); }
      } else if (s.state === 'hidden') {
        // gentle idle so a found sat reads as a collectible
        s.mesh.position.y = s.spot.y + 0.05 + Math.sin(time * 1.6 + s.phase) * 0.03;
        s.mesh.rotation.y += dt * 0.7;
      }
    }
  }

  return {
    burst, reset, update, tryCatch,
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
    markCaught(i) { caught.add(i); },       // (also called internally by tryCatch)
    resetCaught() { caught.clear(); },
    get caughtCount() { return caught.size; },
    // true while any caught sat is still flying back — the hunt waits for this to clear
    // before sealing the vault on a win.
    get anyReturning() { return sats.some((s) => s.state === 'returning'); },
    // LOSE: stop the remaining hidden sats idling (freeze in place, drop from scanner targets)
    freeze() { for (const s of sats) if (s.state === 'hidden') s.state = 'frozen'; },
  };
}
