// Left-hand glove — a visible left hand in VR/AR that rides the LEFT controller grip
// and is the grab hand (the right hand keeps the gun). Flat/mobile show no viewmodel.
// The GLB is a single baked mesh (like the gun): fingers point -Z (forward, matching
// grip -Z), palm faces -Y (down), wrist/cuff at +Z (toward the arm).
import * as THREE from 'three';
import { loadRaw } from './assets.js';

// ---- tunables (on-device tuning) ----
export const VR_HAND_SCALE = 0.20;                 // hand-sized (glove is ~1.13 m long raw)
export const VR_HAND_ROT = { x: 0, y: 0, z: 0 };   // 0 = fingers forward, palm down; roll z for palm-inward
export const VR_HAND_POS = { x: 0.01, y: -0.02, z: 0.02 }; // grip → palm nudge

export async function createLeftHand({ scene }) {
  const glove = await loadRaw('left-hand.glb');
  const hand = new THREE.Group();
  hand.name = 'left-hand';
  hand.add(glove);
  hand.visible = false;

  function mountHand(gripSpace) {
    gripSpace.add(hand);
    hand.visible = true;
    hand.scale.setScalar(VR_HAND_SCALE);
    hand.position.set(VR_HAND_POS.x, VR_HAND_POS.y, VR_HAND_POS.z);
    hand.rotation.set(VR_HAND_ROT.x, VR_HAND_ROT.y, VR_HAND_ROT.z);
  }
  function unmount() { if (hand.parent) hand.parent.remove(hand); hand.visible = false; }

  return { object: hand, mountHand, unmount };
}
