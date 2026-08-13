// Left-X Pause/Menu — opened by X (or Esc / the on-screen button in flat).
// Rows: Resume · Start/Reset Hunt · Exit to screen · comfort toggles (Scanner sound,
// Vignette, Snap turn, Haptics). Flat/mobile use a CSS overlay; VR uses an in-world
// panel whose rows are laser-selectable with a hover highlight. While open, locomotion
// pauses. (Start Hunt here is the in-VR way to begin/reset a hunt.)
import * as THREE from 'three';
import { comfort } from './comfort.js';

// label may be a string or a () => string (for the dynamic Start/Reset Hunt row).
const ROWS = [
  { key: 'resume', label: 'Resume', kind: 'action' },
  { key: 'hunt', label: (ctx) => (ctx.hunt?.()?.isRunning() ? 'Reset Hunt' : 'Start Hunt'), kind: 'action' },
  { key: 'exit', label: 'Exit to screen mode', kind: 'action' },
  { key: 'sound', label: 'Scanner sound', kind: 'toggle' },
  { key: 'vignette', label: 'Vignette while moving', kind: 'toggle' },
  { key: 'snapTurn', label: 'Snap turn (45°)', kind: 'toggle' },
  { key: 'haptics', label: 'Haptics', kind: 'toggle' },
];
const labelOf = (r, ctx) => (typeof r.label === 'function' ? r.label(ctx) : r.label);

export function createPauseMenu({ input, camera, renderer, interaction, onExit, getHunt = () => null }) {
  let open = false;
  const ctx0 = { hunt: getHunt };

  // ---------- flat / mobile DOM overlay ----------
  const panel = document.createElement('div');
  panel.id = 'pause-panel';
  panel.innerHTML = `<div class="pause-card"><h2>Paused</h2><div class="pause-rows"></div></div>`;
  document.getElementById('hud').appendChild(panel);
  const rowsEl = panel.querySelector('.pause-rows');
  const domRows = {};
  for (const r of ROWS) {
    const b = document.createElement('button');
    b.className = 'pause-row ctl';
    b.dataset.key = r.key;
    b.addEventListener('click', () => { b.blur(); activate(r.key); });
    rowsEl.appendChild(b);
    domRows[r.key] = b;
  }
  function syncDom() {
    for (const r of ROWS) {
      domRows[r.key].textContent = r.kind === 'toggle'
        ? `${labelOf(r, ctx0)}: ${comfort.get(r.key) ? 'on' : 'off'}`
        : labelOf(r, ctx0);
      domRows[r.key].classList.toggle('active', r.kind === 'toggle' && comfort.get(r.key));
    }
  }

  // ---------- VR in-world panel (laser-selectable rows + hover highlight) ----------
  const N = ROWS.length;
  const W = 512, TITLE = 84, ROW_PX = 54, H = TITLE + N * ROW_PX + 16;
  const cnv = document.createElement('canvas'); cnv.width = W; cnv.height = H;
  const cx2d = cnv.getContext('2d');
  const tex = new THREE.CanvasTexture(cnv); tex.colorSpace = THREE.SRGBColorSpace;
  const vrPanel = new THREE.Group();
  vrPanel.visible = false;
  const PLANE_W = 0.62, PLANE_H = PLANE_W * (H / W);   // preserve canvas aspect
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_W, PLANE_H), new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false }));
  vrPanel.add(bg);
  camera.add(vrPanel);
  vrPanel.position.set(0, -0.02, -0.9);

  // shared layout so the hit meshes line up EXACTLY with the drawn text
  const rowCanvasY = (i) => TITLE + ROW_PX * (i + 0.5);
  const rowPlaneY = (i) => PLANE_H / 2 - (rowCanvasY(i) / H) * PLANE_H;
  const rowPlaneH = (ROW_PX / H) * PLANE_H;
  let hoveredKey = null;

  // each row: a visible-but-transparent highlight quad, aligned to its text, laser-selectable
  const vrButtons = ROWS.map((r, i) => {
    const mat = new THREE.MeshBasicMaterial({ color: 0x19ff9b, transparent: true, opacity: 0, toneMapped: false, depthWrite: false });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_W * 0.94, rowPlaneH * 0.92), mat);
    m.position.set(0, rowPlaneY(i), 0.002);
    m.renderOrder = 2;
    vrPanel.add(m);
    return { mesh: m, mat, key: r.key };
  });

  function drawCanvas() {
    cx2d.clearRect(0, 0, W, H);
    cx2d.fillStyle = 'rgba(6,18,12,0.94)'; cx2d.fillRect(0, 0, W, H);
    cx2d.strokeStyle = '#19ff9b'; cx2d.lineWidth = 4; cx2d.strokeRect(4, 4, W - 8, H - 8);
    cx2d.textBaseline = 'middle';
    cx2d.fillStyle = '#19ff9b'; cx2d.font = 'bold 34px monospace';
    cx2d.fillText('PAUSED', 28, TITLE / 2);
    cx2d.font = '26px monospace';
    ROWS.forEach((r, i) => {
      const y = rowCanvasY(i);
      const on = r.kind === 'toggle' && comfort.get(r.key);
      const hov = r.key === hoveredKey;
      if (hov) { cx2d.fillStyle = 'rgba(25,255,155,0.18)'; cx2d.fillRect(10, y - ROW_PX / 2 + 3, W - 20, ROW_PX - 6); }
      cx2d.fillStyle = hov ? '#eafff5' : (on ? '#19ff9b' : '#cffce6');
      const text = r.kind === 'toggle' ? `${labelOf(r, ctx0)}: ${on ? 'ON' : 'off'}` : `▸ ${labelOf(r, ctx0)}`;
      cx2d.fillText(text, 28, y);
    });
    tex.needsUpdate = true;
  }

  // ---------- actions ----------
  function activate(key) {
    if (key === 'resume') { close(); return; }
    if (key === 'exit') { close(); onExit?.(); return; }
    if (key === 'hunt') { const h = getHunt(); if (h) (h.isRunning() ? h.reset() : h.start()); close(); return; }
    comfort.toggle(key); // sound / vignette / snapTurn / haptics
    syncDom(); drawCanvas();
  }
  function setHover(key, on) {
    const next = on ? key : (hoveredKey === key ? null : hoveredKey);
    if (next === hoveredKey) return;
    hoveredKey = next;
    for (const b of vrButtons) b.mat.opacity = b.key === hoveredKey ? 0.28 : 0;
    drawCanvas();
  }

  function registerVRTargets() {
    for (const b of vrButtons) interaction.addTarget(b.mesh, () => activate(b.key), { onHover: (h) => setHover(b.key, h) });
  }
  function unregisterVRTargets() {
    for (const b of vrButtons) { interaction.removeTarget(b.mesh); b.mat.opacity = 0; }
    hoveredKey = null;
  }

  function openMenu() {
    open = true;
    syncDom(); drawCanvas();
    if (renderer.xr.isPresenting) { vrPanel.visible = true; registerVRTargets(); }
    else { panel.classList.add('show'); if (document.pointerLockElement) document.exitPointerLock(); }
  }
  function close() {
    open = false;
    vrPanel.visible = false; unregisterVRTargets();
    panel.classList.remove('show');
  }
  function toggle() { open ? close() : openMenu(); }

  function update() {
    if (input.state.pause) toggle();
  }

  comfort.onChange(() => { syncDom(); drawCanvas(); });
  syncDom(); drawCanvas();

  return { update, toggle, isOpen: () => open, close };
}
