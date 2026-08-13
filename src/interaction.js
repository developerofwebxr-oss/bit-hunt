// Interaction — the laser/select foundation ("target and select").
//
// VR controller spaces are driven ENTIRELY by a per-frame poll of the live
// session.inputSources (grip + target-ray poses via frame.getPose), parented to the
// player RIG. We do NOT rely on three.js's `connected` event or its internal
// input-source pairing — both proved unreliable on the real Quest (the event may never
// fire for controllers already active at session start, and getControllerGrip(i) returns
// an ORPHANED object that is never in the scene graph, so anything mounted to it can't
// render). Poll-from-inputSources is handedness-correct (src.handedness) and always
// tracks, so the gun/glove/laser are guaranteed regardless of event timing.
//
// Trigger = click/select on world objects AND menu UI (raycast); the right trigger also
// calls the gun fire() hook. Y = scanner ping (stub). Grabbing (all modes) lives in
// grab.js/main.js. On flat/mobile, the centred crosshair + click is the select equivalent.
import * as THREE from 'three';
import { hapticPulse } from './haptics.js';

export function createInteraction({ renderer, scene, camera, rig, input, canvas, isPaused = () => false }) {
  const targets = [];                 // { object, onSelect, onHover }
  let fireHook = () => {};

  const raycaster = new THREE.Raycaster();
  const tmpMat = new THREE.Matrix4();

  // ---- self-driven controller spaces (poll-based, parented to the rig) ----
  const HANDS = ['left', 'right'];
  const hands = {};                   // per-hand: { ray, grip, line, reticle, present, hovered }
  for (const hand of HANDS) {
    const ray = new THREE.Group();  ray.name = `ray-${hand}`;   ray.matrixAutoUpdate = false;
    const grip = new THREE.Group(); grip.name = `grip-${hand}`; grip.matrixAutoUpdate = false;
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x19ff9b, transparent: true, opacity: 0.8 }));
    line.scale.z = 5; line.name = 'laser';
    ray.add(line);
    const reticle = new THREE.Mesh(new THREE.SphereGeometry(0.02, 12, 12), new THREE.MeshBasicMaterial({ color: 0x19ff9b }));
    reticle.visible = false; scene.add(reticle);       // reticle sits at a WORLD hit point
    ray.visible = false;
    (rig || scene).add(ray);                            // RIG-parented so hands follow locomotion
    (rig || scene).add(grip);
    hands[hand] = { ray, grip, line, reticle, present: false, hovered: null };
  }
  const connectCbs = new Set();       // cb(hand, gripSpace, rayCtrl) fired on a fresh connect

  // Pull the live grip + target-ray poses from the session every frame. This is the ONE
  // source of truth for where the hands are; no event needed, no three.js controller used.
  function pollControllers() {
    for (const hand of HANDS) hands[hand].present = false;
    const session = renderer.xr.getSession?.();
    if (!session) return;
    const frame = renderer.xr.getFrame?.();
    const ref = renderer.xr.getReferenceSpace?.();
    if (!frame || !ref) return;
    if (rig) rig.updateMatrixWorld();                  // parent world current before we place children
    for (const src of session.inputSources) {
      const hand = src.handedness;
      if (hand !== 'left' && hand !== 'right') continue;
      const h = hands[hand];
      const rp = src.targetRaySpace && frame.getPose(src.targetRaySpace, ref);
      if (rp) { h.ray.matrix.fromArray(rp.transform.matrix); h.ray.updateMatrixWorld(true); }
      const gp = src.gripSpace && frame.getPose(src.gripSpace, ref);
      if (gp) { h.grip.matrix.fromArray(gp.transform.matrix); h.grip.updateMatrixWorld(true); }
      const wasPresent = h._wasPresent;
      h.present = true; h._wasPresent = true;
      h.ray.visible = true;
      if (!wasPresent) connectCbs.forEach((cb) => cb(hand, h.grip, h.ray)); // fresh connect → (re)mount
    }
    for (const hand of HANDS) {
      const h = hands[hand];
      if (!h.present) { h._wasPresent = false; h.ray.visible = false; h.reticle.visible = false; }
    }
  }

  function rayFrom(objMatrixWorld) {
    tmpMat.identity().extractRotation(objMatrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(objMatrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpMat).normalize();
  }

  function pickFromRay(rayObj) {
    rayFrom(rayObj.matrixWorld);
    const objs = targets.map((t) => t.object).filter((o) => o.visible);
    return raycaster.intersectObjects(objs, true)[0] || null;
  }

  function targetFor(object) {
    for (let o = object; o; o = o.parent) {
      const t = targets.find((t) => t.object === o);
      if (t) return t;
    }
    return null;
  }

  // ---- flat/mobile: crosshair click/tap = select (primary button only) ----
  let downX = 0, downY = 0, moved = false;
  canvas.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; moved = false; });
  canvas.addEventListener('pointermove', (e) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) moved = true;
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== undefined && e.button !== 0) return; // right-click = grab, not select
    if (moved || renderer.xr.isPresenting) return;
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera); // centred crosshair
    const objs = targets.map((t) => t.object).filter((o) => o.visible);
    const hit = raycaster.intersectObjects(objs, true)[0];
    if (hit) { const t = targetFor(hit.object); t?.onSelect?.(hit); }
  });

  // ---- stubs ----
  let audioCtx = null;
  function scannerPing() {
    console.log('[scanner] ping (stub — reveal logic comes with the hunt)');
    const flash = document.getElementById('scanner-flash');
    if (flash) { flash.classList.add('show'); setTimeout(() => flash.classList.remove('show'), 180); }
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880; g.gain.value = 0.06;
      o.connect(g).connect(audioCtx.destination); o.start();
      o.frequency.exponentialRampToValueAtTime(220, audioCtx.currentTime + 0.18);
      o.stop(audioCtx.currentTime + 0.2);
    } catch {}
    hapticPulse(renderer, { hand: 'left', intensity: 0.6, duration: 60 });
  }

  function update() {
    const s = input.state;
    const paused = isPaused();

    if (s.scanner && !paused) scannerPing();   // Y = scanner ping stub (B is a free slot now)

    if (!renderer.xr.isPresenting) return;      // grabbing (all modes) lives in grab.js/main.js
    pollControllers();                          // refresh hand poses from the live session
    for (const hand of HANDS) {
      const h = hands[hand];
      if (!h.present) continue;
      const { line, reticle } = h;
      const hit = pickFromRay(h.ray);
      // hover highlight: notify targets as the pointed row changes (menus light up)
      const hoveredT = hit ? targetFor(hit.object) : null;
      if (hoveredT !== h.hovered) { h.hovered?.onHover?.(false); hoveredT?.onHover?.(true); h.hovered = hoveredT; }
      // laser length + reticle
      if (hit) { line.scale.z = hit.distance; reticle.visible = true; reticle.position.copy(hit.point); }
      else { line.scale.z = 5; reticle.visible = false; }
      // trigger = select (menu UI clickable) + fire hook (right-hand gun, gated)
      const selected = hand === 'right' ? s.selectR : s.selectL;
      if (selected) {
        if (hit) { const t = targetFor(hit.object); t?.onSelect?.(hit); }
        else if (!paused) fireHook(hand, h.ray);
        hapticPulse(renderer, { hand, intensity: 0.4, duration: 30 });
      }
    }
  }

  return {
    update,
    addTarget(object, onSelect, opts = {}) { targets.push({ object, onSelect, onHover: opts.onHover }); },
    removeTarget(object) { const i = targets.findIndex((t) => t.object === object); if (i >= 0) targets.splice(i, 1); },
    setFireHook(fn) { fireHook = fn || (() => {}); },
    setLasersVisible(v) { for (const hand of HANDS) hands[hand].line.visible = v; },
    // the target-ray space for a hand ('right'/'left') — the laser/pointer origin
    getController(hand) { return hands[hand]?.ray || hands.right.ray; },
    // the GRIP space for a hand — natural "held object" pose; the gun/glove ride this
    getGrip(hand) { return hands[hand]?.grip || hands.right.grip; },
    isConnected(hand) { return !!hands[hand]?.present; },
    // subscribe to controller connects (fires cb(hand, gripSpace, rayCtrl)); returns an unsubscribe
    onControllerConnected(cb) { connectCbs.add(cb); return () => connectCbs.delete(cb); },
  };
}
