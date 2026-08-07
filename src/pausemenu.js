// Left-X Pause/Menu — opened by X (or P / the on-screen button in flat).
// Contents: Resume · Exit to screen mode · comfort toggles (vignette, snap turn,
// haptics — all OFF by default, persisted via comfort.js). Flat/mobile use a CSS
// overlay; VR uses an in-world panel attached to the camera, clickable by laser
// (its buttons register as interaction targets). While open, locomotion pauses.
import * as THREE from 'three';
import { comfort } from './comfort.js';

const ROWS = [
  { key: 'resume', label: 'Resume', kind: 'action' },
  { key: 'exit', label: 'Exit to screen mode', kind: 'action' },
  { key: 'sound', label: 'Scanner sound', kind: 'toggle' },
  { key: 'vignette', label: 'Vignette while moving', kind: 'toggle' },
  { key: 'snapTurn', label: 'Snap turn (45°)', kind: 'toggle' },
  { key: 'haptics', label: 'Haptics', kind: 'toggle' },
];

export function createPauseMenu({ input, camera, renderer, interaction, onExit }) {
  let open = false;

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
    b.addEventListener('click', () => activate(r.key));
    rowsEl.appendChild(b);
    domRows[r.key] = b;
  }
  function syncDom() {
    for (const r of ROWS) {
      domRows[r.key].textContent = r.kind === 'toggle'
        ? `${r.label}: ${comfort.get(r.key) ? 'on' : 'off'}`
        : r.label;
      domRows[r.key].classList.toggle('active', r.kind === 'toggle' && comfort.get(r.key));
    }
  }

  // ---------- VR in-world panel ----------
  const W = 512, H = 384;
  const cnv = document.createElement('canvas'); cnv.width = W; cnv.height = H;
  const ctx = cnv.getContext('2d');
  const tex = new THREE.CanvasTexture(cnv);
  const vrPanel = new THREE.Group();
  vrPanel.visible = false;
  const bg = new THREE.Mesh(
    new THREE.PlaneGeometry(0.6, 0.45),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true }),
  );
  vrPanel.add(bg);
  camera.add(vrPanel);
  vrPanel.position.set(0, -0.05, -1.0);

  // invisible per-row hit targets registered with the interaction layer
  const rowH = 0.45 / (ROWS.length + 1);
  const vrButtons = ROWS.map((r, i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.58, rowH * 0.9), new THREE.MeshBasicMaterial({ visible: false }));
    m.position.set(0, 0.45 / 2 - rowH * (i + 1.5), 0.001);
    vrPanel.add(m);
    return { mesh: m, key: r.key };
  });

  function drawCanvas() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(6,18,12,0.92)'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#19ff9b'; ctx.lineWidth = 4; ctx.strokeRect(4, 4, W - 8, H - 8);
    ctx.fillStyle = '#19ff9b'; ctx.font = 'bold 34px monospace'; ctx.textBaseline = 'middle';
    ctx.fillText('PAUSED', 28, 44);
    ctx.font = '24px monospace';
    const top = 92, step = (H - top - 20) / ROWS.length;
    ROWS.forEach((r, i) => {
      const y = top + step * (i + 0.5);
      const on = r.kind === 'toggle' && comfort.get(r.key);
      ctx.fillStyle = on ? '#19ff9b' : '#cffce6';
      const text = r.kind === 'toggle' ? `${r.label}: ${on ? 'ON' : 'off'}` : `▸ ${r.label}`;
      ctx.fillText(text, 28, y);
    });
    tex.needsUpdate = true;
  }

  // ---------- actions ----------
  function activate(key) {
    if (key === 'resume') { close(); return; }
    if (key === 'exit') { close(); onExit?.(); return; }
    comfort.toggle(key); // vignette / snapTurn / haptics
    syncDom(); drawCanvas();
  }

  function registerVRTargets() { for (const b of vrButtons) interaction.addTarget(b.mesh, () => activate(b.key)); }
  function unregisterVRTargets() { for (const b of vrButtons) interaction.removeTarget(b.mesh); }

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

  // keep DOM toggles in sync if comfort changes elsewhere
  comfort.onChange(() => { syncDom(); drawCanvas(); });
  syncDom(); drawCanvas();

  return { update, toggle, isOpen: () => open, close };
}
