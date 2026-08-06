// Basic collision — simple, not full physics.
// - Room bounds: clamp the rig inside the walls (disabled in AR; no walls).
// - Props/pillars/vault: capsule(XZ circle)-vs-AABB push-out.
// - Ground height: floor (0), the staircase ramp, and the catwalk it leads to,
//   so the catwalk is reachable ONLY by walking up the stairs.
//
// One source of truth for both horizontal clamps and landing height (the
// webxr-threejs jump rule: resolve landing from the same clamp source).

export function createCollision() {
  const boxes = [];      // { minX,maxX,minZ,maxZ,minY,maxY } solid obstacles
  const surfaces = [];   // { minX,maxX,minZ,maxZ, y } walkable platforms (catwalk)
  const ramps = [];      // { minX,maxX,minZ,maxZ, lowY, highY, axis:'x'|'z', lowAt }
  let bounds = null;     // { half } room half-size; null = no clamp (AR)
  const PLAYER_R = 0.35;
  const PLAYER_H = 1.6;
  // Step-up: how far below a walkable prop top the feet may be and still "mount" it.
  // resolveXZ stops blocking (lets you move over the footprint) and groundHeight
  // lifts you, using the SAME value so the two agree on on-top vs blocked. Sized so
  // a normal hop (~0.69 m apex) reliably clears a ~0.67 m crate: you enter the
  // footprint well before the apex instead of only in a 2 cm window at the very top.
  const STEP_UP = 0.34;

  function setBounds(half) { bounds = { half }; }
  function clearBounds() { bounds = null; }
  function addBox(b) { boxes.push(b); }
  function addSurface(s) { surfaces.push(s); }
  function addRamp(r) { ramps.push(r); }

  // Push pos (Vector3-like {x,z}) out of any box it overlaps in XZ, considering
  // the player's vertical span [feetY, feetY+H]. Mutates pos.x / pos.z.
  function resolveXZ(pos, feetY) {
    const r = PLAYER_R;
    for (const b of boxes) {
      // vertical overlap? A walkable-top prop lets you move over its footprint once
      // feet are within STEP_UP of the top (so a hop mounts it); pure blockers use a
      // tight 5 cm margin (only "above" when genuinely standing on top).
      const topSkip = b.walkableTop ? STEP_UP : 0.05;
      if (feetY >= b.maxY - topSkip) continue;         // standing on / mounting the top
      if (feetY + PLAYER_H <= b.minY) continue;        // entirely below
      // nearest point on box to the circle centre
      const cx = Math.max(b.minX, Math.min(pos.x, b.maxX));
      const cz = Math.max(b.minZ, Math.min(pos.z, b.maxZ));
      const dx = pos.x - cx, dz = pos.z - cz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;                      // not penetrating
      if (d2 > 1e-6) {
        const d = Math.sqrt(d2);
        pos.x = cx + (dx / d) * r;
        pos.z = cz + (dz / d) * r;
      } else {
        // centre inside the box — push out along least-penetration axis
        const pxMin = pos.x - b.minX, pxMax = b.maxX - pos.x;
        const pzMin = pos.z - b.minZ, pzMax = b.maxZ - pos.z;
        const m = Math.min(pxMin, pxMax, pzMin, pzMax);
        if (m === pxMin) pos.x = b.minX - r;
        else if (m === pxMax) pos.x = b.maxX + r;
        else if (m === pzMin) pos.z = b.minZ - r;
        else pos.z = b.maxZ + r;
      }
    }
  }

  function clampBounds(pos) {
    if (!bounds) return;
    const lim = bounds.half - PLAYER_R;
    pos.x = Math.max(-lim, Math.min(lim, pos.x));
    pos.z = Math.max(-lim, Math.min(lim, pos.z));
  }

  // Resolve walkable ground height under (x,z) given current feet height.
  function groundHeight(x, z, currentY) {
    let g = 0;
    // staircase ramps: interpolate along each run axis
    for (const ramp of ramps) {
      if (x < ramp.minX || x > ramp.maxX || z < ramp.minZ || z > ramp.maxZ) continue;
      const a = ramp.axis === 'x' ? x : z;
      const lo = ramp.axis === 'x' ? ramp.minX : ramp.minZ;
      const hi = ramp.axis === 'x' ? ramp.maxX : ramp.maxZ;
      let t = (a - lo) / (hi - lo);            // 0..1 along run
      if (ramp.lowAt === 'hi') t = 1 - t;       // low end at the high coordinate
      g = Math.max(g, ramp.lowY + t * (ramp.highY - ramp.lowY));
    }
    // catwalk: only "lands" you if you're already up near its level (came via stairs)
    for (const s of surfaces) {
      if (x >= s.minX && x <= s.maxX && z >= s.minZ && z <= s.maxZ) {
        if (currentY > s.y - 1.0) g = Math.max(g, s.y);
      }
    }
    // low props with walkable tops (crates, terminals): land/stand on the top once
    // you're at/above it (cleared its lip by jumping). Below the top, resolveXZ has
    // already pushed you out of the footprint, so this never lifts you from the side.
    for (const b of boxes) {
      if (!b.walkableTop) continue;
      if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) continue;
      if (currentY >= b.maxY - STEP_UP) g = Math.max(g, b.maxY);
    }
    return g;
  }

  return {
    PLAYER_R, PLAYER_H,
    setBounds, clearBounds, addBox, addSurface, addRamp,
    resolveXZ, clampBounds, groundHeight,
    get boxes() { return boxes; },
  };
}
