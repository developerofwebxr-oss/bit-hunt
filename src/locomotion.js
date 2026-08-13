// Unified locomotion — ONE update fed by all inputs (flat / mobile / VR).
// Move is head-relative; speed comes from stick magnitude (walk 1.4, sustained
// near-full → sprint 2.8 — both FIXED, per the Controller & Input Standard).
// Right-stick X turns (VR): smooth + gently eased by default, snap if comfort.
// Jump = modest hop + gravity, single-gate, lands on floor/catwalk/stairs.
// Fly = right-stick click, behind ENABLE_FLY (default OFF for the hunt).
import * as THREE from 'three';
import { comfort, SPEED, SNAP_TURN_DEG } from './comfort.js';
import { hapticPulse } from './haptics.js';

// Fly OFF by default: in a hunt where sats hide behind/under cover, floating
// above everything would trivialise it. Flip to true to allow fly.
export const ENABLE_FLY = false;

const GRAVITY = 14;
const JUMP_V = 4.4;            // ~0.7 m hop
const MAX_TURN = 1.6;          // rad/s cap for smooth turn (deliberately soft)
const TURN_EASE = 7;           // higher = snappier ramp to target turn rate
const FLY_Y_MIN = 0.2, FLY_Y_MAX = 5.4;

export function createLocomotion({ rig, camera, input, collision, renderer }) {
  let vy = 0;
  let grounded = true;
  let flying = false;
  let enableFly = ENABLE_FLY; // mutable seam; default OFF (the const) for this game
  let turnVel = 0;
  let snapArmed = false;

  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  const camQuat = new THREE.Quaternion();
  const UP = new THREE.Vector3(0, 1, 0);

  // Rotate the rig about the camera's vertical axis so the player spins in place.
  function rotateAroundHead(angle) {
    camera.getWorldPosition(camPos);
    const before = camPos.clone();
    rig.rotation.y += angle;
    rig.updateMatrixWorld(true);
    camera.getWorldPosition(camPos);
    rig.position.x += before.x - camPos.x;
    rig.position.z += before.z - camPos.z;
  }

  function update(dt) {
    const s = input.state;

    // ---- fly toggle (gated by enableFly; F desktop / right-stick click VR) ----
    if (enableFly && s.flyToggle) {
      flying = !flying;
      if (flying) { vy = 0; grounded = false; }
    }

    // ---- turn (VR right stick only; flat/mobile turn via look controls) ----
    if (s.source === 'vr') {
      if (comfort.get('snapTurn')) {
        if (!snapArmed && Math.abs(s.turn) > 0.7) {
          rotateAroundHead(-Math.sign(s.turn) * THREE.MathUtils.degToRad(SNAP_TURN_DEG));
          snapArmed = true;
        }
        if (Math.abs(s.turn) < 0.3) snapArmed = false;
        turnVel = 0;
      } else {
        const target = -s.turn * MAX_TURN;
        turnVel += (target - turnVel) * Math.min(1, dt * TURN_EASE); // gentle ramp
        if (Math.abs(turnVel) > 1e-4) rotateAroundHead(turnVel * dt);
      }
    }

    // ---- head-relative basis on the XZ plane ----
    camera.getWorldQuaternion(camQuat);
    fwd.set(0, 0, -1).applyQuaternion(camQuat);
    if (flying) {
      // full 3D facing (vertical included)
      right.set(1, 0, 0).applyQuaternion(camQuat);
    } else {
      fwd.y = 0; fwd.normalize();
      right.copy(fwd).cross(UP).normalize(); // right = forward × up
    }

    // ---- speed: walk SCALES with stick deflection (gentle push = slow creep, full push = full
    // walk), so there's real slow-vs-fast control; sprint is a clean BINARY (no magnitude
    // threshold that a normal push trips): VR = left-stick click, desktop = Shift, mobile = edge.
    const sprinting = s.sprint;
    const speed = sprinting ? SPEED.run : SPEED.walk * Math.min(1, s.moveMag);

    // ---- apply planar (or 3D, if flying) movement ----
    const move = new THREE.Vector3();
    move.addScaledVector(right, s.move.x);
    move.addScaledVector(fwd, s.move.y);
    if (!flying) move.y = 0;
    if (move.lengthSq() > 1e-6) {
      move.normalize().multiplyScalar(speed * dt);
      rig.position.x += move.x;
      rig.position.z += move.z;
      if (flying) rig.position.y = THREE.MathUtils.clamp(rig.position.y + move.y, FLY_Y_MIN, FLY_Y_MAX);
    }

    // ---- collision (XZ): push out of props, clamp to room ----
    const feetY = rig.position.y;
    collision.resolveXZ(rig.position, feetY);
    collision.clampBounds(rig.position);

    // ---- vertical: gravity + jump + ground (skip while flying) ----
    if (!flying) {
      const groundY = collision.groundHeight(rig.position.x, rig.position.z, rig.position.y);
      if (s.jump && grounded) { vy = JUMP_V; grounded = false; }
      vy -= GRAVITY * dt;
      rig.position.y += vy * dt;
      if (rig.position.y <= groundY) {
        const landed = !grounded && vy < 0;
        rig.position.y = groundY;
        vy = 0; grounded = true;
        if (landed) hapticPulse(renderer, { intensity: 0.5, duration: 50 }); // comfort-gated
      } else {
        grounded = false;
      }
    }
  }

  function setFlying(v) { flying = !!v; if (flying) { vy = 0; grounded = false; } }
  return {
    update, setFlying,
    get flying() { return flying; },
    get grounded() { return grounded; },
    get enableFly() { return enableFly; },
    set enableFly(v) { enableFly = !!v; if (!enableFly) flying = false; },
  };
}
