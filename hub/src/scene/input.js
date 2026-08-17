// talvi hub — orbit/dolly controller (v8.0).
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
    this.lift = 0;
    this.apply();
  }

  floorPitch() {
    const s = (0.4 - this.target.y) / this.radius;
    return Math.asin(clamp(s, -0.999, 0.999));
  }

  apply() {
    this.pitch = clamp(this.pitch, this.floorPitch(), Math.PI / 2 - 0.04);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    this.camera.position.set(
      this.target.x + this.radius * cp * Math.sin(this.yaw),
      this.target.y + this.radius * sp,
      this.target.z + this.radius * cp * Math.cos(this.yaw),
    );
    this.camera.lookAt(this.target.x, this.target.y + this.lift, this.target.z);
  }

  orbit(dx, dy) {
    this.yaw -= dx * 0.0052;
    this.pitch = clamp(this.pitch + dy * 0.0038, this.floorPitch(), Math.PI / 2 - 0.04);
    this.lift = clamp(this.lift - dy * 0.14, 0, 80);
    this.apply();
  }

  dolly(factor) {
    this.radius = clamp(this.radius * factor, this.minRadius, this.maxRadius);
    this.apply();
  }
}
