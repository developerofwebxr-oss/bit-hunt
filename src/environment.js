// EnvironmentAdapter — the seam that makes the bounded shell VR-only.
// Per the webxr-threejs "AR: shell-off" rule: in AR the enclosure (walls, floor,
// ceiling, sky) is suppressed — passthrough IS the environment — while the
// freestanding props stay, anchored to the real floor via local-floor (props
// already sit at y=0 = the floor-level reference space; hit-test re-anchoring is
// a later refinement).
//
// The room-bounds CLAMP stays active in AR (same half-size as VR/flat): even though
// the walls are invisible, you still can't wander out of the play area. In place of
// the visible shell, AR shows a comfort layer (arBounds): a boundary shimmer that
// fades in as you approach the edge + a soft ground disc under you. Flat/VR keep the
// solid shell and never show the AR comfort layer.
export function createEnvironment({ shell, collision, half, arBounds = null }) {
  function applyMode(mode) {
    const ar = mode === 'AR';
    if (shell) shell.visible = !ar;          // shell-off in AR (passthrough is the environment)
    collision.setBounds(half);               // ALL modes: clamp inside the play area
    arBounds?.setEnabled(ar);                // AR-only comfort hints (shimmer + ground disc)
  }
  return { applyMode };
}
