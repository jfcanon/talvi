// talvi hub — the explorable world (v4, ideas #1 + #2).
//
// The scroll narrative is gone. This is a small world you move through like
// Google Earth:
//   - drag (or arrows)  → orbit the camera around the world
//   - scroll / pinch / +− → dolly toward / away from the focal point
//   - click a building (or its floating label) → open that app
//   - hover a building (fine pointer) → it lights up and the prompt echoes it
//
// All motion is user-driven, so nothing is skipped under prefers-reduced-
// motion except the autonomous world (rain, scan, sign glitch). The labels
// track their buildings every frame so the anchors stay on target.
import * as THREE from "three";
import { buildWorld } from "./world.js";
import { OrbitController } from "./input.js";

export function bootScene() {
  const canvas = document.getElementById("scene");
  if (!canvas) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finePointer = window.matchMedia("(pointer: fine)").matches;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setClearColor(0x05060b, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // v4.3.1: the tiles cast soft shadows onto the floor (the sunrise sun).
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060b);
  scene.fog = new THREE.FogExp2(0x05060b, 0.018);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 240);

  const world = buildWorld(scene);
  const orbit = new OrbitController(camera, world.focal, world.radius);

  // --- pointer / raycast ---------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const promptText = document.querySelector(".prompt__text");

  let hovered = null;
  let activePointer = null; // the pointer currently dragging (or about to tap)
  let dragStart = null;
  let dragging = false;
  const pointers = new Map(); // pointerId -> {x, y}

  function pick(clientX, clientY) {
    ndc.set((clientX / window.innerWidth) * 2 - 1, -(clientY / window.innerHeight) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(world.hitMeshes, false);
    return hits.length ? hits[0].object.userData.building || null : null;
  }

  function setHover(b) {
    if (hovered === b) return;
    if (hovered) world.setHighlight(hovered, false);
    hovered = b;
    if (hovered) world.setHighlight(hovered, true);
    if (promptText) {
      promptText.textContent = hovered ? " open " + hovered.label.toLowerCase() : " ";
    }
  }

  // --- drag = orbit, tap = open, hover = highlight -------------------------
  canvas.addEventListener("pointerdown", (e) => {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Synthetic/edge pointers may refuse capture — dragging still works via
      // the coordinates tracked below; only the capture guarantee is lost.
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activePointer === null) {
      activePointer = e.pointerId;
      dragStart = { x: e.clientX, y: e.clientY };
      dragging = false;
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const prev = pointers.get(e.pointerId);
    if (prev) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      // Pinch: two pointers → dolly by their distance ratio.
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (prev._d && d > 0 && prev._d > 0) orbit.dolly(d / prev._d);
        prev._d = d;
        return;
      }

      if (e.pointerId === activePointer) {
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        if (!dragging) {
          const moved = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
          if (moved > 5) dragging = true;
        }
        if (dragging) orbit.orbit(dx, dy);
      }
    } else if (finePointer && pointers.size === 0 && !dragging) {
      // Hover: only for a fine pointer, when nothing is being dragged.
      setHover(pick(e.clientX, e.clientY));
    }
  });

  canvas.addEventListener("pointerup", (e) => {
    if (e.pointerId === activePointer) {
      if (!dragging) {
        const b = pick(e.clientX, e.clientY);
        if (b) window.location.href = b.href;
      }
      activePointer = null;
      dragging = false;
    }
    pointers.delete(e.pointerId);
  });

  canvas.addEventListener("pointercancel", (e) => {
    if (e.pointerId === activePointer) activePointer = null;
    dragging = false;
    pointers.delete(e.pointerId);
  });

  canvas.addEventListener("pointerleave", () => {
    if (!activePointer) setHover(null);
  });

  // --- wheel = dolly -------------------------------------------------------
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      orbit.dolly(Math.exp(e.deltaY * 0.0012));
    },
    { passive: false },
  );

  // --- keyboard = orbit / dolly --------------------------------------------
  window.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        orbit.orbit(0.14, 0);
        break;
      case "ArrowRight":
        e.preventDefault();
        orbit.orbit(-0.14, 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        orbit.orbit(0, 0.1);
        break;
      case "ArrowDown":
        e.preventDefault();
        orbit.orbit(0, -0.1);
        break;
      case "+":
      case "=":
        orbit.dolly(1 / 1.18);
        break;
      case "-":
      case "_":
        orbit.dolly(1.18);
        break;
    }
  });

  // --- resize / loop -------------------------------------------------------
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  window.addEventListener("resize", resize);

  // Test probe: exposes each building's current screen position so the browser
  // test can click a cube and assert orbit/zoom without depending on the DOM
  // (v4.1: the labels are in-world now, not DOM elements). No secrets — just
  // public building keys, hrefs and projected coordinates.
  window.talviProbe = function () {
    const v = new THREE.Vector3();
    return world.buildings.map((b) => {
      v.copy(b.worldPos).project(camera);
      return {
        key: b.key,
        href: b.href,
        x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
        y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight),
        visible: v.z <= 1,
      };
    });
  };

  let last = performance.now();
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (!reduceMotion) world.update(dt);
    renderer.render(scene, camera);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
