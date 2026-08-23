// talvi hub — the explorable world (v9.0).
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

  canvas.style.touchAction = "none";

  const isMobile = window.matchMedia("(max-width: 768px)").matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setClearColor(0x0a0a0c, 1);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0a0c);
  scene.fog = new THREE.FogExp2(0x0a0a0c, 0.008);

  const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 520);

  const world = buildWorld(scene, isMobile ? 80 : 160);
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

  function eat(e) {
    e.preventDefault();
  }
  canvas.addEventListener("touchstart", eat, { passive: false });
  canvas.addEventListener("touchmove", eat, { passive: false });
  canvas.addEventListener("touchend", eat, { passive: false });
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    canvas.addEventListener(type, eat, { passive: false });
    document.addEventListener(type, eat, { passive: false });
  }
  document.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length > 1) e.preventDefault();
    },
    { passive: false },
  );

  // --- drag = orbit, tap = open, hover = highlight -------------------------
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") e.preventDefault();
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
    if (e.pointerType === "touch") e.preventDefault();
    const prev = pointers.get(e.pointerId);
    if (prev) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;

      // Pinch: two pointers → dolly by their distance ratio.
      if (pointers.size === 2) {
        const pts = [...pointers.values()];
        const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (prev._d && d > 0 && prev._d > 0) {
          orbit.dolly(d / prev._d);
          poke();
        }
        for (const p of pts) p._d = d;
        return;
      }

      if (e.pointerId === activePointer) {
        if (!dragging) {
          const moved = Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y);
          if (moved > 5) dragging = true;
        }
        if (dragging) {
          orbit.orbit(dx, dy);
          poke();
        }
      }
    } else if (finePointer && pointers.size === 0 && !dragging) {
      // Hover: only for a fine pointer, when nothing is being dragged.
      setHover(pick(e.clientX, e.clientY));
      poke();
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
      poke();
    },
    { passive: false },
  );

  // --- keyboard = orbit / dolly --------------------------------------------
  window.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        orbit.orbit(0.14, 0);
        poke();
        break;
      case "ArrowRight":
        e.preventDefault();
        orbit.orbit(-0.14, 0);
        poke();
        break;
      case "ArrowUp":
        e.preventDefault();
        orbit.orbit(0, 0.1);
        poke();
        break;
      case "ArrowDown":
        e.preventDefault();
        orbit.orbit(0, -0.1);
        poke();
        break;
      case "+":
      case "=":
        orbit.dolly(1 / 1.18);
        poke();
        break;
      case "-":
      case "_":
        orbit.dolly(1.18);
        poke();
        break;
    }
  });

  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    poke();
  }
  window.addEventListener("resize", resize);

  const resetBtn = document.getElementById("view-reset");
  if (resetBtn) resetBtn.addEventListener("click", () => {
    orbit.reset();
    poke();
  });

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
        wx: b.worldPos.x,
        wy: b.worldPos.y,
        wz: b.worldPos.z,
      };
    });
  };

  let raf = 0;
  let last = performance.now();
  let liveUntil = last + 2200;
  let dustAcc = 0;
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;

  function draw(now) {
    raf = 0;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    const live = now < liveUntil;
    if (!reduceMotion && live) world.update(dt);
    dustAcc += dt;
    if (!reduceMotion && (live || dustAcc >= 0.125)) {
      world.updateDust(dustAcc);
      dustAcc = 0;
    }
    renderer.render(scene, camera);
    renderer.shadowMap.needsUpdate = live;
    if (live && !reduceMotion) schedule();
  }

  function schedule() {
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function poke() {
    liveUntil = performance.now() + 450;
    schedule();
  }

  if (!reduceMotion) setInterval(() => {
    if (performance.now() >= liveUntil) schedule();
  }, 125);

  schedule();
}
