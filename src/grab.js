// Heavy grab — drag grabbable props (crates) along the floor. HEAVY feel: damped,
// slow follow (it drags, doesn't snap), speed-clamped, collision-respecting, floor-bound.
// Works for VR (left grip), desktop (E / right-click), and mobile (tap-hold).
//
// Colliders move WITH the prop: each prop's collider box is the SAME object that lives in
// collision.boxes AND in the scanner's cover.colliders, so mutating it in place makes
// collision, walkable tops, and LOS/occlusion all reflect the new position live — a sat
// hiding behind a dragged crate is genuinely revealed. Reset restores original positions.
import * as THREE from 'three';

const FOLLOW_K = 5.5;     // damping (lower = heavier / slower catch-up)
const MAX_SPEED = 1.6;    // m/s cap — a shoved-box pace, not a carried balloon
const GRAB_NEAR = 0.55;   // VR: hand-to-prop distance to grab (m)

export function createGrab({ collision, roomHalf = 7 }) {
  const props = [];       // { mesh, box, orig:{x,z}, half }
  let held = null;
  const ray = new THREE.Raycaster();

  function register(prop) { props.push(prop); }

  // nearest grabbable whose centre is within maxD of (x,z) — VR proximity grab
  function pickNearest(x, z, maxD = GRAB_NEAR) {
    let best = null, bd = maxD;
    for (const p of props) {
      const cx = (p.box.minX + p.box.maxX) / 2, cz = (p.box.minZ + p.box.maxZ) / 2;
      const d = Math.hypot(cx - x, cz - z) - p.half;   // distance to the box, roughly
      if (d < bd) { bd = d; best = p; }
    }
    return best;
  }
  // grabbable hit by a ray within maxD — desktop crosshair / mobile tap
  function pickRay(origin, dir, maxD = 2.5) {
    ray.set(origin, dir); ray.far = maxD;
    const hits = ray.intersectObjects(props.map((p) => p.mesh), true);
    if (!hits.length) return null;
    const obj = hits[0].object;
    return props.find((p) => p.mesh === obj || obj.parent === p.mesh) || null;
  }

  function grab(prop) { held = prop || null; return !!held; }
  function release() { held = null; }        // Y is already floor-bound, so it just stops
  const isHeld = () => !!held;

  // clamp to room + push the crate out of other solid boxes (pillars/vault/decks/crates)
  function resolve(prop, x, z) {
    const h = prop.half, lim = roomHalf - h - 0.02;
    x = Math.max(-lim, Math.min(lim, x)); z = Math.max(-lim, Math.min(lim, z));
    for (let it = 0; it < 3; it++) {
      for (const b of collision.boxes) {
        if (b === prop.box) continue;
        const ox = Math.min(x + h, b.maxX) - Math.max(x - h, b.minX);
        const oz = Math.min(z + h, b.maxZ) - Math.max(z - h, b.minZ);
        if (ox > 0.001 && oz > 0.001) {
          if (ox < oz) x += (x < (b.minX + b.maxX) / 2 ? -ox : ox);
          else z += (z < (b.minZ + b.maxZ) / 2 ? -oz : oz);
        }
      }
    }
    return { x, z };
  }
  function moveProp(prop, x, z) {
    prop.box.minX = x - prop.half; prop.box.maxX = x + prop.half;
    prop.box.minZ = z - prop.half; prop.box.maxZ = z + prop.half;
    prop.mesh.position.x = x; prop.mesh.position.z = z; // Y stays at the floor base
  }

  // heavy damped follow toward the target floor point (tx,tz)
  function drag(dt, tx, tz) {
    if (!held) return;
    const cx = (held.box.minX + held.box.maxX) / 2, cz = (held.box.minZ + held.box.maxZ) / 2;
    const a = 1 - Math.exp(-FOLLOW_K * dt);
    let nx = cx + (tx - cx) * a, nz = cz + (tz - cz) * a;
    const dx = nx - cx, dz = nz - cz, d = Math.hypot(dx, dz), maxD = MAX_SPEED * dt;
    if (d > maxD) { nx = cx + (dx / d) * maxD; nz = cz + (dz / d) * maxD; }
    ({ x: nx, z: nz } = resolve(held, nx, nz));
    moveProp(held, nx, nz);
  }

  function resetAll() { held = null; for (const p of props) moveProp(p, p.orig.x, p.orig.z); }

  return { register, pickNearest, pickRay, grab, release, isHeld, get held() { return held; }, drag, resetAll };
}
