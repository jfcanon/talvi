// talvi 3d — the wordmark sign (blueprint A2, A8; A.5b's "magenta and cyan
// survive only inside the glitch's RGB split — a fault, not a palette").
//
// The sign is drawn onto a canvas at runtime — the same display font stack as
// talvi's CSS, no font file, no image asset — and shown as a sprite. It
// carries two ghost sprites offset by a few centimetres and tinted magenta and
// cyan, whose opacity is 0 except for occasional ~120ms glitch frames. That is
// the entire magenta/cyan budget for the whole site, exactly as on the page.
import * as THREE from "three";

const DISPLAY_STACK =
  '"Bahnschrift", "DIN Alternate", "Oswald", "Avenir Next Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif';

export function createSign() {
  const group = new THREE.Group();
  const texture = drawWordmark();

  const base = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.95,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  base.scale.set(9, 2.6, 1);
  group.add(base);

  const magenta = makeSplit(texture, 0xff2e88, 0.2);
  const cyan = makeSplit(texture, 0x22e8ff, -0.2);
  group.add(magenta.sprite, cyan.sprite);

  let untilNext = 2 + Math.random() * 3;
  let glitching = 0;

  function update(dt) {
    if (glitching > 0) {
      glitching -= dt;
      if (glitching <= 0) {
        magenta.sprite.material.opacity = 0;
        cyan.sprite.material.opacity = 0;
      }
    } else {
      untilNext -= dt;
      if (untilNext <= 0) {
        glitching = 0.12;
        untilNext = 2.5 + Math.random() * 4.5;
        magenta.sprite.material.opacity = 0.85;
        cyan.sprite.material.opacity = 0.85;
      }
    }
  }

  return { group, update };
}

function makeSplit(texture, color, offsetX) {
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      color: new THREE.Color(color),
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  sprite.scale.set(9, 2.6, 1);
  sprite.position.x = offsetX;
  return { sprite };
}

function drawWordmark() {
  const w = 1024;
  const h = 256;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.font = '700 150px ' + DISPLAY_STACK;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const cx = w / 2;
  const cy = h / 2 + 8;

  ctx.shadowColor = "rgba(125,255,196,0.85)";
  ctx.shadowBlur = 70;
  ctx.fillStyle = "#7dffc4";
  ctx.fillText("TALVI", cx, cy);
  ctx.shadowBlur = 18;
  ctx.fillStyle = "#eafff5";
  ctx.fillText("TALVI", cx, cy);

  return new THREE.CanvasTexture(canvas);
}
