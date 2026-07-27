// Interaction — the laser/grip foundation ("target and select").
// Both VR controllers always emit a laser ray + reticle (targetRaySpace).
// Trigger = click/select on world objects AND menu UI (raycast). Grip = grab &
// move objects (used by builder mode). B = builder toggle (stub), Y = scanner
// ping (stub). Triggers also call a fire() hook for the future gun (placeholder).
// On flat/mobile, the centred crosshair + click is the select equivalent.
import * as THREE from 'three';
import { hapticPulse } from './haptics.js';

export function createInteraction({ renderer, scene, camera, input, canvas, isPaused = () => false }) {
  const targets = [];                 // { object, onSelect, grabbable }
  let fireHook = () => {};
  let builderMode = false;
  const builderEl = document.getElementById('builder-indicator');

  const raycaster = new THREE.Raycaster();
  const tmpMat = new THREE.Matrix4();
  const held = { left: null, right: null }; // grabbed object per hand (VR)
  let heldFlat = null;                       // grabbed object (desktop/mobile)

  // ---- controller laser + reticle ----
  function makeController(i, hand) {
    const ctrl = renderer.xr.getController(i);
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x19ff9b, transparent: true, opacity: 0.8 }));
    line.scale.z = 5;
    line.name = 'laser';
    ctrl.add(line);
    const reticle = new THREE.Mesh(
      new THREE.SphereGeometry(0.02, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0x19ff9b }),
    );
    reticle.visible = false;
    scene.add(reticle);
    ctrl.userData = { hand, line, reticle, grip: renderer.xr.getControllerGrip(i) };
    ctrl.visible = false; // until a real controller connects (no stray laser in flat)
    scene.add(ctrl);
    return ctrl;
  }
  const controllers = [makeController(0, 'right'), makeController(1, 'left')];
  // handedness from the actual inputSource (index→hand isn't guaranteed)
  for (const c of controllers) {
    c.addEventListener('connected', (e) => {
      if (e.data?.handedness) c.userData.hand = e.data.handedness;
      c.visible = true;
    });
    c.addEventListener('disconnected', () => { c.visible = false; c.userData.reticle.visible = false; });
  }

  function rayFrom(objMatrixWorld) {
    tmpMat.identity().extractRotation(objMatrixWorld);
    raycaster.ray.origin.setFromMatrixPosition(objMatrixWorld);
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tmpMat).normalize();
  }

  function pickFromController(ctrl) {
    rayFrom(ctrl.matrixWorld);
    const objs = targets.map((t) => t.object).filter((o) => o.visible);
    const hits = raycaster.intersectObjects(objs, true);
    return hits[0] || null;
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
  function setBuilder(on) {
    builderMode = on;
    if (builderEl) { builderEl.textContent = `Builder: ${on ? 'ON' : 'off'}`; builderEl.classList.toggle('show', on); }
    console.log('[builder] mode', on ? 'ON' : 'off');
  }
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

    // B / Y stubs (work in VR via buttons and in flat via keys for testing).
    // Gated while the pause menu is open so menu clicks don't double-fire.
    if (s.builder && !paused) setBuilder(!builderMode);
    if (s.scanner && !paused) scannerPing();

    if (renderer.xr.isPresenting) {
      for (const ctrl of controllers) {
        const { hand, line, reticle } = ctrl.userData;
        const grabbed = held[hand];
        const hit = grabbed ? null : pickFromController(ctrl);
        // laser length + reticle
        if (hit) {
          line.scale.z = hit.distance;
          reticle.visible = true;
          reticle.position.copy(hit.point);
        } else {
          line.scale.z = grabbed ? 0.01 : 5;
          reticle.visible = false;
        }
        // trigger = select (always, so menu UI is clickable) + fire hook (gated)
        const selected = hand === 'right' ? s.selectR : s.selectL;
        if (selected) {
          if (hit) { const t = targetFor(hit.object); t?.onSelect?.(hit); }
          else if (!paused) fireHook(hand, ctrl);
          hapticPulse(renderer, { hand, intensity: 0.4, duration: 30 });
        }
        // grip = grab/move (builder mode), gated while paused
        const gripDown = hand === 'right' ? s.gripR : s.gripL;
        if (builderMode && !paused && gripDown && !grabbed && hit) {
          const t = targetFor(hit.object);
          if (t?.grabbable) {
            held[hand] = t.object;
            ctrl.attach(t.object);
            hapticPulse(renderer, { hand, intensity: 0.7, duration: 40 });
          }
        } else if (grabbed && !gripDown) {
          scene.attach(grabbed); // drop, preserving world transform
          held[hand] = null;
        }
      }
    } else {
      // ---- flat/mobile grab: E-hold / right-click-hold → same grab path as VR ----
      const canGrab = builderMode && !paused;
      if (canGrab && s.grabFlat && !heldFlat) {
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera); // crosshair
        const objs = targets.map((t) => t.object).filter((o) => o.visible);
        const hit = raycaster.intersectObjects(objs, true)[0];
        const t = hit && targetFor(hit.object);
        if (t?.grabbable) { heldFlat = t.object; camera.attach(heldFlat); } // follow the view
      } else if (heldFlat && (!s.grabFlat || !canGrab)) {
        scene.attach(heldFlat); // drop, preserving world transform
        heldFlat = null;
      }
    }
  }

  return {
    update,
    addTarget(object, onSelect, opts = {}) { targets.push({ object, onSelect, grabbable: !!opts.grabbable }); },
    removeTarget(object) { const i = targets.findIndex((t) => t.object === object); if (i >= 0) targets.splice(i, 1); },
    setFireHook(fn) { fireHook = fn || (() => {}); },
    get builderMode() { return builderMode; },
    setLasersVisible(v) { for (const c of controllers) c.userData.line.visible = v; },
  };
}
