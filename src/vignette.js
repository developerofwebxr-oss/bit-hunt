// Comfort vignette — a camera-attached dark tunnel that fades in while moving
// (opt-in via comfort.vignette). Camera-attached so it works in VR as well as
// flat. Cheap: one transparent plane with a radial-alpha texture.
import * as THREE from 'three';

function radialTexture() {
  const s = 256;
  const c = document.createElement('canvas'); c.width = c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.28, s / 2, s / 2, s * 0.5);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(0.75, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,1)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export function createVignette({ camera }) {
  const dist = 0.2;
  const h = Math.tan(THREE.MathUtils.degToRad(70 / 2)) * dist * 2.4;
  const mat = new THREE.MeshBasicMaterial({
    map: radialTexture(), transparent: true, opacity: 0,
    depthTest: false, depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(h * 2, h * 2), mat);
  mesh.position.set(0, 0, -dist);
  mesh.renderOrder = 999;
  mesh.frustumCulled = false;
  mesh.visible = false;
  camera.add(mesh);

  let target = 0;
  function update(active, dt) {
    target = active ? 0.7 : 0;
    mat.opacity += (target - mat.opacity) * Math.min(1, dt * 6);
    mesh.visible = mat.opacity > 0.01;
  }
  return { update };
}
