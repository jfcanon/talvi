// talvi hub — orbit/dolly controller (v7.0).
//
// The camera orbits a focal point: drag = yaw/pitch (look around), wheel /
// pinch / +/- = dolly (zoom toward the world), always clamped so the camera
// stays above the ground and inside a sane radius. The target itself does not
// move — the world is small enough that orbit + dolly is the whole journey.
import * as THREE from "three";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class OrbitController {
  constructor(camera, target, radius) {
    this.camera = camera;
    this.target = target;
    this.yaw = 0.5;
    this.pitch = 0.42;
    this.radius = radius;
    this.minRadius = 6;
    this.maxRadius = 56;
    this.apply();
  }

  apply() {
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    this.camera.position.set(
      this.target.x + this.radius * cp * Math.sin(this.yaw),
      // pitch is clamped so sin(pitch) never pushes the camera below the
      // ground even at max zoom-out.
      this.target.y + this.radius * sp,
      this.target.z + this.radius * cp * Math.cos(this.yaw),
    );
    this.camera.lookAt(this.target);
  }

  orbit(dx, dy) {
    this.yaw -= dx * 0.0052;
    this.pitch = clamp(this.pitch + dy * 0.0038, -0.03, 1.15);
    this.apply();
  }

  dolly(factor) {
    this.radius = clamp(this.radius * factor, this.minRadius, this.maxRadius);
    this.apply();
  }
}
