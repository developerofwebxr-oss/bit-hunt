// Flat-mode look controls (VIEWING ONLY — no locomotion yet).
// Yaw goes on the rig, pitch on the camera, so the rig stays "forward-aware"
// for locomotion in a later prompt. Default = hold-drag look (a plain click
// stays free to interact). Free-look is an opt-in toggle: pointer-lock on
// desktop, gyro on mobile. All of this is disabled while in an XR session.
import * as THREE from 'three';

export const isCoarsePointer = () =>
  window.matchMedia('(pointer: coarse) and (not (pointer: fine))').matches;

export function createControls({ rig, camera, canvas }) {
  const PITCH_LIMIT = Math.PI / 2 - 0.05;
  let yaw = 0, pitch = 0;
  let enabled = true;          // off during XR sessions
  let dragging = false;
  let lastX = 0, lastY = 0;
  const SENS = 0.0025;

  // ---- hold-drag look ----
  const onDown = (e) => {
    if (!enabled || pointerLocked) return;
    if (e.button !== undefined && e.button !== 0) return; // left-drag only (right = grab)
    dragging = true;
    lastX = e.clientX; lastY = e.clientY;
    onFirstInput();
  };
  const onMove = (e) => {
    if (!enabled) return;
    if (pointerLocked) { applyDelta(e.movementX, e.movementY); return; }
    if (!dragging) return;
    applyDelta(e.clientX - lastX, e.clientY - lastY);
    lastX = e.clientX; lastY = e.clientY;
  };
  const onUp = () => { dragging = false; };
  const applyDelta = (dx, dy) => {
    yaw -= dx * SENS;
    pitch -= dy * SENS;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
  };

  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);

  // ---- Free look (opt-in): pointer-lock (desktop) / gyro (mobile) ----
  let pointerLocked = false;
  let gyroActive = false;
  let gyroQuat = null;
  const escHint = document.getElementById('esc-hint');

  function onPointerLockChange() {
    pointerLocked = document.pointerLockElement === canvas;
    escHint?.classList.toggle('show', pointerLocked);
    freeLookBtn && (freeLookBtn.textContent = `Free look: ${pointerLocked || gyroActive ? 'on' : 'off'}`);
    freeLookBtn?.classList.toggle('active', pointerLocked || gyroActive);
  }
  document.addEventListener('pointerlockchange', onPointerLockChange);

  // gyro
  const onDeviceOrientation = (e) => {
    if (!gyroActive || e.alpha == null) return;
    const z = THREE.MathUtils.degToRad(e.alpha);
    const x = THREE.MathUtils.degToRad(e.beta);
    const y = THREE.MathUtils.degToRad(e.gamma);
    const orient = THREE.MathUtils.degToRad(window.orientation || 0);
    const euler = new THREE.Euler();
    const q = new THREE.Quaternion();
    const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 about X
    const zee = new THREE.Vector3(0, 0, 1);
    euler.set(x, z, -y, 'YXZ');
    q.setFromEuler(euler);
    q.multiply(q1);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(zee, -orient));
    gyroQuat = q;
  };

  async function enableGyro() {
    const DOE = window.DeviceOrientationEvent;
    if (DOE && typeof DOE.requestPermission === 'function') {
      try { const res = await DOE.requestPermission(); if (res !== 'granted') return false; }
      catch { return false; }
    }
    window.addEventListener('deviceorientation', onDeviceOrientation, true);
    gyroActive = true;
    return true;
  }
  function disableGyro() {
    window.removeEventListener('deviceorientation', onDeviceOrientation, true);
    gyroActive = false; gyroQuat = null;
  }

  // ---- Free-look button wiring ----
  const freeLookBtn = document.getElementById('btn-freelook');
  freeLookBtn?.addEventListener('click', async () => {
    if (!enabled) return;
    if (isCoarsePointer()) {
      if (gyroActive) { disableGyro(); }
      else { await enableGyro(); }
      freeLookBtn.textContent = `Free look: ${gyroActive ? 'on' : 'off'}`;
      freeLookBtn.classList.toggle('active', gyroActive);
    } else {
      if (pointerLocked) document.exitPointerLock();
      else canvas.requestPointerLock();
      // button state synced via pointerlockchange
    }
  });

  // ---- transient controls hint ----
  const hintEl = document.getElementById('hint');
  let hinted = false;
  if (hintEl) {
    hintEl.textContent = isCoarsePointer() ? 'drag to look' : 'hold-drag to look';
    setTimeout(() => hintEl.classList.add('show'), 400);
    setTimeout(() => hintEl.classList.remove('show'), 5000);
  }
  function onFirstInput() {
    if (hinted) return; hinted = true;
    hintEl?.classList.remove('show');
  }

  // ---- per-frame: write yaw/pitch onto rig/camera (flat mode only) ----
  function update() {
    if (!enabled) return;
    if (gyroActive && gyroQuat) {
      // gyro drives the camera orientation directly
      camera.quaternion.copy(gyroQuat);
    } else {
      rig.rotation.y = yaw;
      camera.rotation.x = pitch;
      camera.rotation.y = 0;
      camera.rotation.z = 0;
    }
  }

  function setEnabled(v) {
    enabled = v;
    if (!v) {
      dragging = false;
      if (pointerLocked) document.exitPointerLock();
      if (gyroActive) disableGyro();
    }
  }

  return { update, setEnabled, get yaw() { return yaw; }, get pitch() { return pitch; } };
}
