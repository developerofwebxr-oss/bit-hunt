// Room shell: flat geometry (floor, 4 walls, ceiling) — detail lives in the
// textures. Wall/floor textures get RepeatWrapping + a derived bump so panels
// read as 3D. Green strips glow via emissive material (bloom carries the look).
import * as THREE from 'three';

const BASE = import.meta.env.BASE_URL;

// ---- Tweakable room dimensions (metres) ----
export const ROOM = {
  size: 14,        // floor is size x size
  height: 6,       // floor -> ceiling
  catwalkLevel: 3, // upper deck height
  wallTile: 3.5,   // metres per wall-texture tile
  floorTile: 2.5,  // metres per floor-texture tile
};

const texLoader = new THREE.TextureLoader();

function loadTiled(file, repeat, { srgb = true } = {}) {
  const tex = texLoader.load(`${BASE}assets/${file}`);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A second clone of the colour map used as a cheap bumpMap (no sRGB) so flat
// planes pick up surface relief under lighting.
function bumpClone(file, repeat) {
  const tex = loadTiled(file, repeat, { srgb: false });
  return tex;
}

export function buildRoom(scene) {
  const group = new THREE.Group();
  group.name = 'room';
  const { size, height } = ROOM;
  const half = size / 2;

  // ---- Floor ----
  const floorRepeat = size / ROOM.floorTile;
  const floorMat = new THREE.MeshStandardMaterial({
    map: loadTiled('floor-texture.png', floorRepeat),
    bumpMap: bumpClone('floor-texture.png', floorRepeat),
    bumpScale: 0.04,
    roughness: 0.85,
    metalness: 0.1,
  });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), floorMat);
  floor.rotation.x = -Math.PI / 2;
  floor.name = 'floor';
  group.add(floor);

  // ---- Ceiling (darker, same texture muted) ----
  const ceilTex = loadTiled('walls-texture.png', size / ROOM.wallTile);
  const ceilMat = new THREE.MeshStandardMaterial({
    map: ceilTex,
    color: 0x7a7a7a,
    roughness: 0.95,
    metalness: 0.0,
    // underside faces away from all lights, so self-illuminate faintly with the
    // same texture so the panelling reads instead of going pure black
    emissiveMap: ceilTex,
    emissive: 0x3a3a3a,
    emissiveIntensity: 0.6,
  });
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(size, size), ceilMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = height;
  ceiling.name = 'ceiling';
  group.add(ceiling);

  // ---- Walls ----
  const wallRepeatX = size / ROOM.wallTile;
  const wallRepeatY = height / ROOM.wallTile;
  const wallMat = new THREE.MeshStandardMaterial({
    map: (() => { const t = loadTiled('walls-texture.png', 1); t.repeat.set(wallRepeatX, wallRepeatY); return t; })(),
    bumpMap: (() => { const t = bumpClone('walls-texture.png', 1); t.repeat.set(wallRepeatX, wallRepeatY); return t; })(),
    bumpScale: 0.05,
    roughness: 0.8,
    metalness: 0.15,
    side: THREE.FrontSide,
  });
  const wallGeo = new THREE.PlaneGeometry(size, height);
  const walls = [
    { pos: [0, height / 2, -half], rot: [0, 0, 0] },          // north (-Z), faces +Z
    { pos: [0, height / 2, half], rot: [0, Math.PI, 0] },     // south (+Z), faces -Z
    { pos: [-half, height / 2, 0], rot: [0, Math.PI / 2, 0] },// west (-X), faces +X
    { pos: [half, height / 2, 0], rot: [0, -Math.PI / 2, 0] },// east (+X), faces -X
  ];
  for (const w of walls) {
    const m = new THREE.Mesh(wallGeo, wallMat);
    m.position.set(...w.pos);
    m.rotation.set(...w.rot);
    group.add(m);
  }

  // ---- Green emissive accent strips (restrained) ----
  // Slightly desaturated green + moderate intensity so it reads as glow without
  // blowing out the bloom pass (green is the high-luminance colour).
  const stripMat = new THREE.MeshStandardMaterial({
    color: 0x041a10,
    emissive: new THREE.Color(0x10b86e), // slightly desaturated green
    emissiveIntensity: 0.7,
    roughness: 0.5,
    metalness: 0.0,
  });
  const stripT = 0.05; // thickness
  const stripD = 0.05; // depth off wall
  const heights = [0.25, ROOM.catwalkLevel, height - 0.35]; // base, catwalk line, near-ceiling
  const strips = new THREE.Group();
  strips.name = 'green-strips';
  for (const y of heights) {
    for (const w of walls) {
      const geo = new THREE.BoxGeometry(size - 0.02, stripT, stripD);
      const m = new THREE.Mesh(geo, stripMat);
      m.position.set(w.pos[0], y, w.pos[2]);
      m.rotation.set(0, w.rot[1], 0);
      // nudge strip slightly inward off the wall face
      const inward = new THREE.Vector3(0, 0, 1).applyEuler(m.rotation).multiplyScalar(stripD);
      m.position.add(inward);
      strips.add(m);
    }
  }
  group.add(strips);

  scene.add(group);
  return { group, floor, materials: { floorMat, wallMat, ceilMat, stripMat } };
}
