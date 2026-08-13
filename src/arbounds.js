// AR comfort bounds — the play area still confines you in AR even though the walls are
// invisible passthrough. Two subtle hints, AR-only (VR/flat never show these):
//   • Guardian-style boundary shimmer: faint green hex-grid wall planes at the room edge
//     that fade IN only as you approach (opacity ramps with proximity), invisible otherwise.
//   • Under-player floor disc: a soft hex-tinted circle that follows you at real-floor height,
//     brightest underfoot and fading to nothing at the rim — reads as "the game's ground"
//     without hiding your real floor.
// Cheap: a handful of opacity-driven ShaderMaterials; update() only writes uniform scalars +
// the disc position (no per-frame allocation).
import * as THREE from 'three';

// ---- tunables (on-device tuning) ----
export const SHIMMER_NEAR = 1.0;    // m from a wall where the shimmer starts fading in
export const SHIMMER_MAX_OP = 0.34; // peak wall opacity (right at the boundary)
export const SHIMMER_HEX_M = 0.85;  // hex cell size on the walls (m)
export const DISC_RADIUS = 2.8;     // under-player disc radius (m)
export const DISC_MAX_OP = 0.26;    // peak disc opacity (directly underfoot)
export const DISC_HEX_M = 0.6;      // hex cell size on the disc (m)
const COLOR = 0x19ff9b;

// hex-grid helpers shared by both shaders (edge-lit cells)
const HEX_GLSL = `
  float hexDist(vec2 p){ p = abs(p); return max(dot(p, vec2(0.5, 0.8660254)), p.x); }
  vec2 hexGV(vec2 uv){
    vec2 r = vec2(1.0, 1.7320508), h = 0.5 * r;
    vec2 a = mod(uv, r) - h, b = mod(uv - h, r) - h;
    return dot(a,a) < dot(b,b) ? a : b;
  }
`;

const WALL_FRAG = `
  precision mediump float;
  uniform vec3 uColor; uniform float uOpacity; uniform vec2 uRepeat;
  varying vec2 vUv;
  ${HEX_GLSL}
  void main(){
    vec2 gv = hexGV(vUv * uRepeat);
    float d = hexDist(gv);                         // 0 center .. 0.5 edge
    float line = smoothstep(0.44, 0.5, d);          // bright near each cell edge
    float vfade = 1.0 - smoothstep(0.55, 1.0, vUv.y); // soften toward the ceiling
    float a = line * uOpacity * vfade;
    if (a < 0.003) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

const DISC_FRAG = `
  precision mediump float;
  uniform vec3 uColor; uniform float uOpacity; uniform float uHex;
  varying vec2 vUv;
  ${HEX_GLSL}
  void main(){
    vec2 p = (vUv - 0.5) * 2.0;                     // -1..1 across the disc
    float r = length(p);
    if (r > 1.0) discard;
    float radial = 1.0 - smoothstep(0.0, 1.0, r);   // 1 underfoot -> 0 at the rim
    vec2 gv = hexGV((vUv - 0.5) * uHex);
    float hl = smoothstep(0.44, 0.5, hexDist(gv));  // faint hex tint
    float a = radial * uOpacity * (1.0 + hl * 0.6);
    gl_FragColor = vec4(uColor, a);
  }
`;

const VERT = `
  varying vec2 vUv;
  void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

export function createArBounds({ scene, half = 7, wallHeight = 6, floorY = 0 }) {
  const color = new THREE.Color(COLOR);
  const group = new THREE.Group();
  group.name = 'ar-bounds';
  group.visible = false;
  scene.add(group);

  // ---- boundary shimmer: one plane per wall, each with its own opacity uniform ----
  const wallGeo = new THREE.PlaneGeometry(half * 2, wallHeight);
  const repeat = new THREE.Vector2((half * 2) / SHIMMER_HEX_M, wallHeight / SHIMMER_HEX_M);
  // { pos, ry, dist(p) = metres from the rig to this wall } — inward-facing planes
  const wallDefs = [
    { x: 0, z: -half, ry: 0, dist: (p) => p.z + half },        // -Z wall (normal +Z)
    { x: 0, z: half, ry: Math.PI, dist: (p) => half - p.z },   // +Z
    { x: -half, z: 0, ry: Math.PI / 2, dist: (p) => p.x + half }, // -X
    { x: half, z: 0, ry: -Math.PI / 2, dist: (p) => half - p.x }, // +X
  ];
  const walls = wallDefs.map((d) => {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: color }, uOpacity: { value: 0 }, uRepeat: { value: repeat } },
      vertexShader: VERT, fragmentShader: WALL_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(wallGeo, mat);
    mesh.position.set(d.x, floorY + wallHeight / 2, d.z);
    mesh.rotation.y = d.ry;
    mesh.frustumCulled = false;
    group.add(mesh);
    return { mesh, mat, dist: d.dist };
  });

  // ---- under-player floor disc ----
  const discMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color }, uOpacity: { value: DISC_MAX_OP }, uHex: { value: (DISC_RADIUS * 2) / DISC_HEX_M } },
    vertexShader: VERT, fragmentShader: DISC_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  const disc = new THREE.Mesh(new THREE.CircleGeometry(DISC_RADIUS, 64), discMat);
  disc.rotation.x = -Math.PI / 2;                 // lie flat
  disc.position.y = floorY + 0.01;                // just above the real floor (no z-fight)
  disc.frustumCulled = false;
  group.add(disc);

  let enabled = false;
  function setEnabled(on) { enabled = !!on; group.visible = enabled; }

  // per-frame: walls fade with proximity, disc follows the rig. Scalars only — no allocation.
  function update(rigPos) {
    if (!enabled || !rigPos) return;
    for (const w of walls) {
      const t = Math.max(0, Math.min(1, 1 - w.dist(rigPos) / SHIMMER_NEAR));
      w.mat.uniforms.uOpacity.value = t * SHIMMER_MAX_OP;
    }
    disc.position.x = rigPos.x;
    disc.position.z = rigPos.z;
  }

  return {
    group, setEnabled, update,
    get enabled() { return enabled; },
    // exposed for headless verification / on-device probing
    _walls: walls, _disc: disc,
  };
}
