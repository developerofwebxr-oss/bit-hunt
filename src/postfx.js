// Flat-mode post-processing: ACES tone mapping (via OutputPass) + a restrained,
// half-resolution UnrealBloom so the green emissive reads as glow without
// blowing out. Bloom is SKIPPED in immersive XR (the headset render path takes
// over) — the main loop renders the scene directly there.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export function createPostFX({ renderer, scene, camera }) {
  // Tone mapping is applied by OutputPass, so leave the renderer linear here.
  renderer.toneMapping = THREE.NoToneMapping;

  const size = new THREE.Vector2();
  renderer.getSize(size);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));

  // Restrained: modest strength, threshold high enough that only emissive
  // (HDR-ish) green strips bloom, not the lit walls.
  const bloom = new UnrealBloomPass(
    new THREE.Vector2(size.x * 0.5, size.y * 0.5), // half-res buffer
    0.32,  // strength (restrained — green blows out easily)
    0.5,   // radius
    0.9,   // threshold (only the brightest emissive blooms)
  );
  composer.addPass(bloom);

  const output = new OutputPass();
  output.toneMapping = THREE.ACESFilmicToneMapping;
  composer.addPass(output);

  function setSize(w, h, dpr) {
    composer.setPixelRatio(Math.min(dpr, 1.5)); // cap DPR for bloom cost
    composer.setSize(w, h);
    bloom.setSize(w * 0.5, h * 0.5);
  }

  return { composer, bloom, setSize, render: () => composer.render() };
}
