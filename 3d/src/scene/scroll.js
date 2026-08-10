// talvi 3d — scroll-to-camera (blueprint A7: scroll stays user-driven, so the
// camera follows scroll even under prefers-reduced-motion).
//
// The page is five 100vh sections; scroll progress 0..1 is mapped onto a
// Catmull-Rom path for the camera position and a second for the look target,
// so each section is a composed shot that eases into the next rather than a
// hard scene replacement (the Kage motion language, implemented from scratch).
import * as THREE from "three";

export function createScrollCamera(camera) {
  const posCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 2.6, 9), //  01 / SIGN — face the wordmark
    new THREE.Vector3(0, 2.4, -6), // 02 / INSTRUMENT — through the panel
    new THREE.Vector3(0, 3.4, -26), // 03 / ATMOSPHERE — above the rain
    new THREE.Vector3(0, 2.2, -36), // 04 / STATUS — approaching the HUD
    new THREE.Vector3(0, 8, -50), //   05 / END — rise, the world recedes
  ]);
  const tgtCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 3.4, 0),
    new THREE.Vector3(0, 3.2, -12),
    new THREE.Vector3(0, 1.2, -40),
    new THREE.Vector3(0, 3.4, -42),
    new THREE.Vector3(0, 1, -66),
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
