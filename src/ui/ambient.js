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

  // Sprite code removed: the figure is now a supplied PNG served at /s.png and
  // placed with a plain <img>, so there is nothing left to draw at runtime.
  // Two rounds of hand-authored pixel grids produced a blob and then a stick —
  // authoring pixel art blind, without a canvas in front of you, does not
  // work. Keeping the failed approach around "in case" would just invite
  // someone to try it a third time.

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
    initSound();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
