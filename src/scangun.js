// Scangun — the player's held scanner/weapon.
//
// The GLB is a single fused, baked mesh (one material, one primitive): the
// screen, indicator lights and crosshair hoop are all painted into one albedo,
// so NONE of them are separately addressable on the mesh itself. Rather than
// try to carve triangles out of image-to-3D soup, we treat the baked GLB as a
// static SHELL and drive every live region with clean primitive OVERLAYS
// parented at measured gun-local coordinates:
//   • screen  → a plane with a live CanvasTexture (own material, emissive/unlit)
//   • lights  → a row of individually-addressable emissive segments
//   • hoop    → an emissive torus + crosshair bars over the baked reticle
//   • muzzle  → a flash sprite (fire() stub only; no shoot-to-return logic)
// Every one of them reads from the single scanner signal seam.
import * as THREE from 'three';
import { loadRaw } from './assets.js';

// ---- measured gun-local coordinates (raycast against the decimated GLB) ----
// screen face RECEDES as it rises (raycast: y0.30→z0.484, y0.40→z0.461, slope ≈ -0.23),
// so the overlay's top must tilt BACK (-Z) to lie flush — negative rotation.x.
const SCREEN = { x: 0, y: 0.335, z: 0.480, w: 0.10, h: 0.125, tilt: -0.23 };
const LIGHTS = { x: 0, y: 0.408, z0: -0.08, z1: 0.26, n: 8 };
const HOOP   = { x: 0, y: 0.50, z: -0.32, r: 0.052, tube: 0.006 };
const MUZZLE = { x: 0, y: 0.30, z: -0.60 };
const GREEN = 0x19ff9b;

// ---- tunables ----
const FLAT_GUN_SCALE = 0.32;   // bottom-right viewmodel
const VR_GUN_SCALE = 0.45;     // ~1.5× the old 0.30 (bump to ~0.60 for 2×) — held-in-hand size
const BOLT_REACH = 1.05;       // muzzle-bolt length (m); ~2× the old ~0.5 so it reads in VR
// Corrective offset applied when the gun is visually aligned to the TARGET-RAY (the grip pose is
// tilted ~45° up on Quest). 0 = barrel parallel to the laser; tweak on-device if the mesh's own
// axis isn't dead-on -Z (radians).
export const GUN_MOUNT_ROT = { x: 0, y: 0, z: 0 };

export async function createScangun({ scene, scanner }) {
  const shell = await loadRaw('scangun.glb');
  const gun = new THREE.Group();
  gun.name = 'scangun';
  gun.add(shell);

  // ---------- live screen (CanvasTexture) ----------
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const screenTex = new THREE.CanvasTexture(canvas);
  screenTex.colorSpace = THREE.SRGBColorSpace;
  screenTex.anisotropy = 4;
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN.w, SCREEN.h), screenMat);
  screen.position.set(SCREEN.x, SCREEN.y, SCREEN.z);
  screen.rotation.x = SCREEN.tilt; // top tips back to match the angled rear face
  screen.frustumCulled = false;
  gun.add(screen);

  // ---------- indicator light row ----------
  const lights = [];
  const litColor = new THREE.Color(GREEN);
  const seg = (LIGHTS.z1 - LIGHTS.z0) / LIGHTS.n;
  for (let i = 0; i < LIGHTS.n; i++) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x0a2418, emissive: GREEN, emissiveIntensity: 0.05,
      metalness: 0.2, roughness: 0.5, toneMapped: false,
    });
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.006, seg * 0.62), mat);
    m.position.set(LIGHTS.x, LIGHTS.y, LIGHTS.z0 + seg * (i + 0.5));
    m.frustumCulled = false;
    gun.add(m);
    lights.push(m);
  }

  // ---------- crosshair hoop overlay (emissive; pulses with signal) ----------
  const hoopMat = new THREE.MeshBasicMaterial({ color: GREEN, toneMapped: false, transparent: true, opacity: 0.9 });
  const hoop = new THREE.Group();
  hoop.position.set(HOOP.x, HOOP.y, HOOP.z);
  const torus = new THREE.Mesh(new THREE.TorusGeometry(HOOP.r, HOOP.tube, 8, 28), hoopMat);
  hoop.add(torus);
  const barGeo = new THREE.BoxGeometry(HOOP.r * 2, HOOP.tube * 1.4, HOOP.tube * 1.4);
  const barH = new THREE.Mesh(barGeo, hoopMat);
  const barV = new THREE.Mesh(barGeo, hoopMat); barV.rotation.z = Math.PI / 2;
  hoop.add(barH, barV);
  hoop.children.forEach((c) => (c.frustumCulled = false));
  gun.add(hoop);

  // ---------- muzzle flash (fire() stub) ----------
  const flashMat = new THREE.MeshBasicMaterial({
    color: 0xbfffe0, toneMapped: false, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
  });
  const flash = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 10), flashMat);
  flash.position.set(MUZZLE.x, MUZZLE.y, MUZZLE.z);
  flash.scale.set(1, 1, 1.6);
  flash.frustumCulled = false;
  gun.add(flash);

  // ---------- muzzle lightning: pre-allocated jagged bolts (no per-shot allocation) ----------
  // Bolts live in WORLD space (added to the scene) so they render at true scale, not the
  // gun's viewmodel scale. Each shot rewrites the existing position buffers in place.
  const MUZZLE_V = new THREE.Vector3(MUZZLE.x, MUZZLE.y, MUZZLE.z);
  const N_BOLTS = 3, PTS = 8, BOLT_DUR = 0.13;
  const boltMat = new THREE.LineBasicMaterial({ color: 0x9dffcf, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const boltGroup = new THREE.Group(); boltGroup.name = 'muzzle-bolts'; boltGroup.visible = false;
  const bolts = [];
  for (let i = 0; i < N_BOLTS; i++) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PTS * 3), 3));
    const line = new THREE.Line(g, boltMat); line.frustumCulled = false;
    boltGroup.add(line); bolts.push(line);
  }
  if (scene) scene.add(boltGroup);
  let boltT = 0;
  // reused scratch (no per-shot allocation)
  const _mw = new THREE.Vector3(), _fw = new THREE.Vector3(), _rt = new THREE.Vector3(), _upp = new THREE.Vector3(), _end = new THREE.Vector3();
  const _UP = new THREE.Vector3(0, 1, 0);
  function writeBolt(line, fx, fy, fz, tx, ty, tz, jit) {
    const pos = line.geometry.attributes.position;
    _fw.set(tx - fx, ty - fy, tz - fz); const len = _fw.length() || 1; _fw.multiplyScalar(1 / len);
    _rt.crossVectors(_fw, _UP); if (_rt.lengthSq() < 1e-6) _rt.set(1, 0, 0); else _rt.normalize();
    _upp.crossVectors(_rt, _fw).normalize();
    for (let k = 0; k < PTS; k++) {
      const t = k / (PTS - 1);
      const edge = (k === 0 || k === PTS - 1);
      const jx = edge ? 0 : (Math.random() * 2 - 1) * jit;
      const jy = edge ? 0 : (Math.random() * 2 - 1) * jit;
      pos.setXYZ(k,
        fx + _fw.x * len * t + _rt.x * jx + _upp.x * jy,
        fy + _fw.y * len * t + _rt.y * jx + _upp.y * jy,
        fz + _fw.z * len * t + _rt.z * jx + _upp.z * jy);
    }
    pos.needsUpdate = true;
  }
  // targetWorld (optional): on a catch, bolt 0 arcs to the sat; others fan off the muzzle.
  function strike(targetWorld) {
    if (!scene) return;
    gun.updateMatrixWorld();
    _mw.copy(MUZZLE_V).applyMatrix4(gun.matrixWorld);           // muzzle world pos
    _fw.set(0, 0, -1).transformDirection(gun.matrixWorld).normalize(); // gun forward (world)
    const fx = _mw.x, fy = _mw.y, fz = _mw.z;
    const fwx = _fw.x, fwy = _fw.y, fwz = _fw.z;               // cache (writeBolt reuses _fw)
    for (let i = 0; i < bolts.length; i++) {
      if (targetWorld && i === 0) {
        writeBolt(bolts[i], fx, fy, fz, targetWorld.x, targetWorld.y, targetWorld.z, 0.06);
      } else {
        const reach = BOLT_REACH + Math.random() * BOLT_REACH * 0.6;
        _end.set(fx + fwx * reach + (Math.random() * 2 - 1) * 0.12,
                 fy + fwy * reach + (Math.random() * 2 - 1) * 0.12,
                 fz + fwz * reach + (Math.random() * 2 - 1) * 0.12);
        writeBolt(bolts[i], fx, fy, fz, _end.x, _end.y, _end.z, 0.05 + Math.random() * 0.05);
      }
    }
    boltGroup.visible = true; boltT = 1;
  }

  // ---------- audio: soft synthesized Geiger tick ----------
  let audioCtx = null, noiseBuf = null, muted = false, tickAcc = 0, tickIdx = 0;
  function resumeAudio() {
    if (!audioCtx) {
      try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
      const dur = 0.03, n = Math.floor(audioCtx.sampleRate * dur);
      noiseBuf = audioCtx.createBuffer(1, n, audioCtx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) { const e = 1 - i / n; d[i] = (Math.random() * 2 - 1) * e * e; }
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }
  function playTick() {
    if (!audioCtx || !noiseBuf || audioCtx.state !== 'running') return;
    const src = audioCtx.createBufferSource(); src.buffer = noiseBuf;
    const bp = audioCtx.createBiquadFilter(); bp.type = 'bandpass';
    bp.frequency.value = 1500 + ((tickIdx++ * 137) % 700); bp.Q.value = 1.2;
    const g = audioCtx.createGain(); g.gain.value = 0.06;
    src.connect(bp).connect(g).connect(audioCtx.destination); src.start();
  }
  // soft low "tock" for the last-30s countdown urgency — quiet, same mute as the ticks
  function urgencyTick() {
    if (muted || !audioCtx || audioCtx.state !== 'running') return;
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine'; o.frequency.value = 180;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.14);
  }
  // rising "ding" on a catch — same synthesized style + same mute as the ticks
  function ding() {
    if (muted || !audioCtx || audioCtx.state !== 'running') return;
    const t0 = audioCtx.currentTime;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(620, t0);
    o.frequency.exponentialRampToValueAtTime(1040, t0 + 0.16);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.14, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
    o.connect(g).connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.34);
  }

  // ---------- drawing the screen (throttled) ----------
  let sweepAngle = 0, drawAcc = 0, blipSeed = 0;
  function drawScreen(signal, time) {
    const W = 256, H = 256, cx = 128, cy = 104, R = 96;
    ctx.fillStyle = '#02160d'; ctx.fillRect(0, 0, W, H);
    // radar rings + cross
    ctx.strokeStyle = 'rgba(25,255,155,0.22)'; ctx.lineWidth = 2;
    for (const r of [R * 0.4, R * 0.7, R]) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy); ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R); ctx.stroke();
    // sweep wedge + line
    ctx.fillStyle = 'rgba(25,255,155,0.10)';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, sweepAngle - 0.6, sweepAngle); ctx.closePath(); ctx.fill();
    const ex = cx + Math.cos(sweepAngle) * R, ey = cy + Math.sin(sweepAngle) * R;
    const grd = ctx.createLinearGradient(cx, cy, ex, ey);
    grd.addColorStop(0, 'rgba(25,255,155,0.95)'); grd.addColorStop(1, 'rgba(25,255,155,0)');
    ctx.strokeStyle = grd; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(ex, ey); ctx.stroke();
    // signal blip — closer to centre + bigger + hotter as signal rises
    const ba = sweepAngle - 0.35 + blipSeed;
    const br = R * (0.28 + 0.55 * (1 - signal));
    const bx = cx + Math.cos(ba) * br, by = cy + Math.sin(ba) * br;
    const pulse = 0.5 + 0.5 * Math.sin(time * (2 + signal * 16));
    ctx.fillStyle = `rgba(255,${Math.round(120 + 120 * signal)},60,${(0.35 + 0.6 * signal).toFixed(2)})`;
    ctx.beginPath(); ctx.arc(bx, by, 3 + 9 * signal * pulse, 0, Math.PI * 2); ctx.fill();
    // proximity meter
    const bw = W - 40, bx0 = 20, by0 = H - 30;
    ctx.strokeStyle = 'rgba(25,255,155,0.5)'; ctx.lineWidth = 2; ctx.strokeRect(bx0, by0, bw, 16);
    ctx.fillStyle = `rgb(${Math.round(50 + 205 * signal)},255,${Math.round(120 * (1 - signal))})`;
    ctx.fillRect(bx0 + 2, by0 + 2, (bw - 4) * signal, 12);
    ctx.fillStyle = 'rgba(25,255,155,0.85)'; ctx.font = 'bold 15px monospace';
    ctx.fillText('SIGNAL ' + Math.round(signal * 100), bx0, by0 - 7);
    screenTex.needsUpdate = true;
  }

  // ---------- per-frame drive ----------
  let flashT = 0; const FLASH_DUR = 0.12;
  let mode = 'flat', swayT = 0;
  const baseState = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), scale: 1 };

  function update(dt, time, paused = false) {
    const signal = scanner.signal;
    // screen sweep advances faster with signal; redraw ~12fps
    sweepAngle += dt * (2 + signal * 11);
    drawAcc += dt;
    if (drawAcc >= 1 / 12) { blipSeed = Math.sin(time * 0.37) * 0.5; drawScreen(signal, time); drawAcc = 0; }
    // indicator lights fill progressively
    const filled = signal * LIGHTS.n;
    for (let i = 0; i < LIGHTS.n; i++) {
      const on = Math.max(0, Math.min(1, filled - i)); // partial on the boundary light
      const m = lights[i].material;
      m.emissiveIntensity = 0.05 + on * 2.2;
      m.color.copy(litColor).multiplyScalar(0.1 + on * 0.9);
    }
    // hoop pulse — rate follows signal
    const pulse = 0.5 + 0.5 * Math.sin(time * Math.PI * (1 + signal * 9));
    hoopMat.opacity = 0.35 + 0.55 * pulse + (flashT > 0 ? 0.4 : 0);
    const hs = 1 + 0.06 * pulse + (flashT > 0 ? 0.15 : 0);
    hoop.scale.setScalar(hs);
    // muzzle flash decay
    if (flashT > 0) { flashT -= dt; flashMat.opacity = Math.max(0, flashT / FLASH_DUR); }
    // muzzle lightning decay (flicker as it fades)
    if (boltT > 0) {
      boltT = Math.max(0, boltT - dt / BOLT_DUR);
      boltMat.opacity = boltT * (0.6 + 0.4 * Math.random());
      if (boltT === 0) boltGroup.visible = false;
    }
    // audio ticks — rate rises with signal; skip when muted/paused/near-silent
    if (!muted && !paused && signal > 0.04) {
      tickAcc += dt;
      const interval = 1 / scanner.ticksPerSec;
      let guard = 0;
      while (tickAcc >= interval && guard++ < 4) { playTick(); tickAcc -= interval; }
    } else tickAcc = 0;
    // subtle idle sway in flat viewmodel
    if (mode === 'flat') {
      swayT += dt;
      gun.position.copy(baseState.pos);
      gun.position.x += Math.sin(swayT * 1.1) * 0.004;
      gun.position.y += Math.sin(swayT * 1.7) * 0.003;
      gun.quaternion.copy(baseState.quat);
      gun.rotateZ(Math.sin(swayT * 0.9) * 0.01);
    }
  }

  function doFlash() { flashT = FLASH_DUR; strike(null); }         // flash + muzzle lightning every shot
  function catchArc(worldPos) { strike(worldPos); }                // on catch, bolt 0 arcs to the sat

  // ---------- mounting ----------
  function mountFlat(camera) {
    mode = 'flat';
    camera.add(gun);
    gun.scale.setScalar(FLAT_GUN_SCALE);
    gun.position.set(0.125, -0.135, -0.30);      // bottom-right viewmodel, screen readable
    gun.rotation.set(0.11, -0.16, 0);            // muzzle-up + inward yaw tilts screen toward eye
    baseState.pos.copy(gun.position);
    baseState.quat.copy(gun.quaternion);
  }
  // mount into a controller's GRIP space (WebXR grip: -Z ≈ where a held object points),
  // so the gun sits in the hand with the muzzle forward. Orientation unchanged (no flip).
  function mountHand(gripSpace) {
    mode = 'vr';
    gripSpace.add(gun);
    gun.scale.setScalar(VR_GUN_SCALE);
    gun.position.set(0, -0.03, -0.07);           // nudge so the grip sits in the palm
    gun.rotation.set(0, 0, 0);
  }
  function unmount() { if (gun.parent) gun.parent.remove(gun); }

  return {
    object: gun,
    update, flash: doFlash, catchArc, ding, urgencyTick, resumeAudio,
    mountFlat, mountHand, unmount,
    setMuted(v) { muted = !!v; }, get muted() { return muted; },
  };
}
