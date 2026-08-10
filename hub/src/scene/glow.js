// talvi 3d — glow sprites (blueprint A8).
//
// Halation without post-processing: every bright mark gets a soft radial glow
// sprite behind/in front of it. The sprite texture is a single radial gradient
// canvas, generated once and shared; the colour and scale are per-instance.
// Additive blending + depthWrite false lets glows layer without sorting or
// z-fighting — the same way talvi's CSS text-shadows bloom on the page.
import * as THREE from "three";

let sharedTexture = null;

function glowTexture() {
  if (sharedTexture) return sharedTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.45)");
  g.addColorStop(0.6, "rgba(255,255,255,0.12)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  sharedTexture = new THREE.CanvasTexture(canvas);
  return sharedTexture;
}

export function makeGlow(color, size, opacity = 0.5) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: glowTexture(),
      color: new THREE.Color(color),
      transparent: true,
      opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  sprite.scale.set(size, size, 1);
  return sprite;
}
