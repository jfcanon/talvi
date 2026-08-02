// Sprite + ambient sound. Loaded as part of /s.js.
//
// TWO copyright constraints drove the design here, and both are hard limits
// rather than preferences (blueprint A.5a):
//
//   1. The film score is in copyright. Nothing from it can ship. This file
//      therefore SYNTHESISES an original drifting pad with the Web Audio API —
//      oscillators and a filter, no recording. That also means no audio file,
//      which means `media-src` is NOT needed and the CSP moves by exactly
//      nothing. A generated tone is script, and script-src 'self' already
//      covers it.
//   2. Film character likenesses are protected. The sprite is an original
//      design — a small patrol drone, drawn as pixels in code.
//
// Both are muted/idle by default and gated behind prefers-reduced-motion.
//
// Self-booting plain script, not an ES module: /s.js is CONCATENATED from raw
// files by scripts/build-assets.mjs rather than bundled, so `export` would be a
// syntax error in the browser and cross-file calls are impossible. This file
// therefore owns its own DOMContentLoaded hook and shares nothing with
// client.js.

(function () {
  "use strict";

  const STORAGE_KEY = "talvi.sound";

  // --------------------------------------------------------------- the sprite

  // Hand-placed pixels, 16 wide. First attempt was 16x9 at 3x with navy hull
  // values — on a near-black ground it read as a smudge rather than as a
  // drawing. Two fixes: a clearer silhouette (dome, saucer body, lamp beneath)
  // and hull values light enough to separate from the background. Pixel art
  // needs CONTRAST against its ground, not just correct shapes.
  //
  // 0 transparent · 1 edge · 2 hull · 3 canopy · 4 lamp · 5 lamp glow
  const DRONE = [
    "0000011111100000",
    "0001133333311000",
    "0011333333331100",
    "0113322222233110",
    "0122222222222210",
    "1222222222222221",
    "1122222222222211",
    "0011122222111100",
    "0000014441000000",
    "0000005550000000",
    "0000000500000000",
  ];

  // Same single green as the rest of the instrument (A.5b), spread across
  // five steps so the hull still reads as a shaded object rather than a flat
  // silhouette. The steps stay inside a narrow band around --phosphor
  // (#7dffc4) and --phosphor-dim (#35d998) — near enough to belong to the
  // palette, far enough apart to model form.
  const PALETTE = {
    1: "#12503a", // shadowed edge
    2: "#1f7f5c", // hull in shade
    3: "#35d998", // hull lit
    4: "#7dffc4", // canopy highlight
    5: "#c6ffe8", // lamp core, the brightest pixel on the page's smallest object
  };

  // Generic: paints any pixel grid. `skip` suppresses one palette index, which
  // is how the drone's lamp blinks without a second grid.
  function drawGrid(ctx, grid, scale, skip) {
    for (let y = 0; y < grid.length; y += 1) {
      const row = grid[y];
      for (let x = 0; x < row.length; x += 1) {
        const cell = row[x];
        if (cell === "0" || cell === skip) continue;
        ctx.fillStyle = PALETTE[cell];
        ctx.fillRect(x * scale, y * scale, scale, scale);
      }
    }
  }

  // ------------------------------------------------------------- the figure

  // A hardboiled detective: long coat, tie, pistol held low, leaning into the
  // wind. The noir archetype, which predates the film by forty years
  // (Hammett, Chandler, Bogart) and belongs to nobody.
  //
  // Deliberately NOT a likeness. A specific actor's or character's appearance
  // is protected; a genre silhouette is not — and at 16x20 pixels a likeness
  // is not achievable anyway. The posture and the coat carry the homage, which
  // is the honest way to pay one.
  //
  // The tie is TWO rows, right under the collar. A first pass ran it the full
  // height of the torso and at 4x it read as a bright stripe down a blob, not
  // as a tie — at this size a detail has to be small AND high-contrast, not
  // large.
  //
  // Two frames: the coat tail streams further in the second. Only the coat
  // moves — the figure stands still, which is what makes it read as bracing
  // against the wind rather than walking.
  const NOIR_A = [
    "0000011111000000",
    "0000122222100000",
    "0000124442100000",
    "0000124442100000",
    "0000112221100000",
    "0001223332210000",
    "0012233533221000",
    "0122233533222100",
    "0122233333222210",
    "0122233333222210",
    "0122233333222211",
    "5122223333222222",
    "5122223333222221",
    "0122222222222100",
    "0012222222221000",
    "0012200022100000",
    "0012200022100000",
    "0012200022100000",
    "0011100011000000",
  ];

  const NOIR_B = [
    "0000011111000000",
    "0000122222100000",
    "0000124442100000",
    "0000124442100000",
    "0000112221100000",
    "0001223332210000",
    "0012233533221000",
    "0122233533222100",
    "0122233333222210",
    "0122233333222211",
    "0122233333222222",
    "5122223333222221",
    "5122223333222210",
    "0122222222222100",
    "0012222222210000",
    "0012200022100000",
    "0012200022100000",
    "0012200022100000",
    "0011100011000000",
  ];

  function initNoir() {
    const canvas = document.getElementById("noir");
    if (!canvas) return;

    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const scale = 4;
    const w = NOIR_A[0].length * scale;
    const h = NOIR_A.length * scale;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false;

    if (still) {
      drawGrid(ctx, NOIR_A, scale, null);
      return;
    }

    let frame = 0;
    let raf = 0;

    function tick() {
      frame += 1;
      ctx.clearRect(0, 0, w, h);
      // The coat changes about twice a second, not every frame.
      drawGrid(ctx, frame % 60 < 30 ? NOIR_A : NOIR_B, scale, null);
      raf = window.requestAnimationFrame(tick);
    }

    tick();

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        window.cancelAnimationFrame(raf);
      } else {
        raf = window.requestAnimationFrame(tick);
      }
    });
  }

  function drawDrone(ctx, scale, lampOn) {
    drawGrid(ctx, DRONE, scale, lampOn ? null : "5");
  }

    function initSprite() {
    const canvas = document.getElementById("drone");
    if (!canvas) return;

    // Reduced motion: draw one static frame and stop. The sprite is still
    // present — it just does not patrol.
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    const scale = 5;
    const w = DRONE[0].length * scale;
    const h = DRONE.length * scale;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false; // pixels stay pixels

    if (still) {
      drawDrone(ctx, scale, true);
      return;
    }

    let frame = 0;
    let raf = 0;

    function tick() {
      frame += 1;
      ctx.clearRect(0, 0, w, h);
      // Bob one pixel every ~40 frames, blink the lamp every ~55.
      const bob = Math.sin(frame / 40) > 0 ? 0 : 1;
      ctx.save();
      ctx.translate(0, bob);
      drawDrone(ctx, scale, frame % 110 < 55);
      ctx.restore();
      raf = window.requestAnimationFrame(tick);
    }

    tick();

    // Stop the loop when the tab is hidden — an animation nobody is watching is
    // just battery draw, which matters on the phone this is most used from.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        window.cancelAnimationFrame(raf);
      } else {
        raf = window.requestAnimationFrame(tick);
      }
    });
  }

  // ---------------------------------------------------------------- the sound

  // An original drifting pad: two detuned oscillators through a low-pass filter,
  // with a slow LFO on the cutoff. Deliberately quiet, deliberately unmelodic —
  // atmosphere, not a tune competing for attention.
  function buildPad(ctx) {
    const out = ctx.createGain();
    out.gain.value = 0;
    out.connect(ctx.destination);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 520;
    filter.Q.value = 6;
    filter.connect(out);

    // A low fifth — open, unresolved, no third, so it states no key.
    const voices = [55, 82.4, 110, 164.8].map((hz, i) => {
      const osc = ctx.createOscillator();
      osc.type = i % 2 === 0 ? "sawtooth" : "triangle";
      osc.frequency.value = hz;
      osc.detune.value = i * 4 - 6; // slight spread, so it breathes
      const g = ctx.createGain();
      g.gain.value = i === 0 ? 0.22 : 0.1;
      osc.connect(g).connect(filter);
      osc.start();
      return osc;
    });

    // Slow sweep of the filter — the "drifting" part.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();

    return { out, voices, lfo };
  }

    function initSound() {
    const button = document.getElementById("sound");
    if (!button) return;

    let ctx = null;
    let pad = null;
    let on = false;

    function label() {
      button.textContent = on ? "SOUND ON" : "SOUND OFF";
      button.setAttribute("aria-pressed", on ? "true" : "false");
    }

    function fade(toValue) {
      if (!pad) return;
      const now = ctx.currentTime;
      pad.out.gain.cancelScheduledValues(now);
      pad.out.gain.setValueAtTime(pad.out.gain.value, now);
      // Long ramps: a pad that snaps on is a jump-scare.
      pad.out.gain.linearRampToValueAtTime(toValue, now + (toValue > 0 ? 2.5 : 1.2));
    }

    function enable() {
      // AudioContext is created on the CLICK, never on load: browsers block
      // autoplay, and an unannounced sound is hostile regardless of policy.
      if (!ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) {
          button.textContent = "NO AUDIO";
          button.disabled = true;
          return;
        }
        ctx = new Ctor();
        pad = buildPad(ctx);
      }
      ctx.resume?.();
      on = true;
      fade(0.05); // quiet by design — atmosphere, not a soundtrack
      label();
      try {
        window.localStorage.setItem(STORAGE_KEY, "on");
      } catch {
        // Private mode or storage disabled: the toggle still works for this
        // page view, it just will not be remembered. Not worth reporting.
      }
    }

    function disable() {
      on = false;
      fade(0);
      label();
      try {
        window.localStorage.setItem(STORAGE_KEY, "off");
      } catch {
        /* see above */
      }
    }

    button.addEventListener("click", () => (on ? disable() : enable()));
    label();

    // Remembered preference does NOT auto-start audio — browsers would block it
    // and it would be rude anyway. It only pre-labels the control, so someone
    // who wants sound sees one obvious click rather than hunting for it.
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "on") {
        button.classList.add("is-armed");
      }
    } catch {
      /* see above */
    }
  }

  function boot() {
    initSprite();
    initNoir();
    initSound();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
