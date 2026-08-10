// talvi hub — scroll-to-camera (blueprint A7: scroll stays user-driven, so the
// camera follows scroll even under prefers-reduced-motion).
//
// Five 100vh sections: SIGN (the wordmark), then one instrument per app
// (RELAY, CHAT, CINTO — matching the world.js panel positions), then END, a
// pull-back over the receding instruments for the closing CTA. A Catmull-Rom
// path for position and one for the look target make each section a composed
// shot that eases into the next rather than a hard scene replacement.
import * as THREE from "three";

export function createScrollCamera(camera) {
  const posCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 2.6, 9), //  SIGN — face the wordmark
    new THREE.Vector3(0, 2.4, -8), // RELAY — through panel @ -16
    new THREE.Vector3(0, 2.4, -26), // CHAT — through panel @ -34
    new THREE.Vector3(0, 2.4, -44), // CINTO — through panel @ -52
    new THREE.Vector3(0, 7, -58), //  END — rise, the world recedes
  ]);
  const tgtCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 3.4, 0),
    new THREE.Vector3(0, 3.2, -14),
    new THREE.Vector3(0, 3.2, -32),
    new THREE.Vector3(0, 3.2, -50),
    new THREE.Vector3(0, 1.5, -72),
  ]);

  const pos = new THREE.Vector3();
  const tgt = new THREE.Vector3();

  function progress() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
  }

  function update() {
    const t = progress();
    posCurve.getPoint(t, pos);
    tgtCurve.getPoint(t, tgt);
    camera.position.copy(pos);
    camera.lookAt(tgt);
  }

  return { update };
}
