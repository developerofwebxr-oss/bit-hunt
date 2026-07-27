// EnvironmentAdapter — the seam that makes the bounded shell VR-only.
// Per the webxr-threejs "AR: shell-off" rule: in AR the enclosure (walls, floor,
// ceiling, sky) is suppressed — passthrough IS the environment — while the
// freestanding props stay, anchored to the real floor via local-floor (props
// already sit at y=0 = the floor-level reference space; hit-test re-anchoring is
// a later refinement). Flat and VR paths are untouched: AR simply doesn't show
// the shell, and the room-bounds clamp is dropped so locomotion still works.
export function createEnvironment({ shell, collision, half }) {
  function applyMode(mode) {
    const ar = mode === 'AR';
    if (shell) shell.visible = !ar;          // shell-off in AR
    if (ar) collision.clearBounds();          // no walls → soft/per-prop collision only
    else collision.setBounds(half);           // flat + VR: clamp inside the room
  }
  return { applyMode };
}
