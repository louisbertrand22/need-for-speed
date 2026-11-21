/* Cameras: three driving views (near chase, far chase, hood), look-back, the
 * rear-view mirror camera, plus orbit cameras for the title screen / results
 * and the garage turntable. */
import * as THREE from 'three';
import { angleDiff, clamp, damp, dampAngle, smoothstep } from '../core/math';
import { MIRROR_RECT } from '../core/types';
import type { CameraMode, CityWorld, StaticCollider, VehicleConfig, VehicleState } from '../core/types';
import { distanceToCollider } from './gameModes';

interface ChasePreset {
  distance: number;
  height: number;
  lookHeight: number;
  lookAhead: number;
  yawLambda: number;
  fov: number;
}

const PRESETS: Record<'chaseNear' | 'chaseFar', ChasePreset> = {
  chaseNear: { distance: 5.6, height: 1.75, lookHeight: 1.05, lookAhead: 3.2, yawLambda: 6.5, fov: 62 },
  chaseFar: { distance: 8.4, height: 2.9, lookHeight: 1.1, lookAhead: 4.5, yawLambda: 5, fov: 58 },
};

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly mirrorCamera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chaseNear';

  private yaw = 0;
  private camY = 0;
  private fov = 62;
  private dist = 5.6;
  private shake = 0;
  private shakeTime = 0;
  private snapped = false;
  private readonly look = new THREE.Vector3();
  private readonly colliders: StaticCollider[] = [];
  /** XZ position, exposed to the AI host */
  readonly ground = { x: 0, z: 0 };

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.25, 2600);
    this.mirrorCamera = new THREE.PerspectiveCamera(42, MIRROR_RECT.aspect, 0.5, 420);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** Next chase update jumps straight to its target (teleports, mode changes). */
  snap(): void {
    this.snapped = false;
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.4, this.shake + amount);
  }

  cycleMode(): CameraMode {
    this.mode = this.mode === 'chaseNear' ? 'chaseFar' : this.mode === 'chaseFar' ? 'hood' : 'chaseNear';
    return this.mode;
  }

  /** Driving camera. */
  updateDrive(
    dt: number,
    st: VehicleState,
    cfg: VehicleConfig,
    world: CityWorld,
    lookBack: boolean,
    nitro: boolean,
  ): void {
    const cam = this.camera;
    const sinH = Math.sin(st.heading);
    const cosH = Math.cos(st.heading);
    const speedF = smoothstep(8, 95, Math.abs(st.speed));
    this.shakeTime += dt;
    this.shake = Math.max(0, this.shake - dt * 2.2);
    const rumble = this.shake + speedF * speedF * 0.05 + (nitro ? 0.07 : 0);
    const sx = (Math.sin(this.shakeTime * 61.3) + Math.sin(this.shakeTime * 37.1 + 1.7)) * 0.05 * rumble;
    const sy = (Math.sin(this.shakeTime * 53.7 + 0.6) + Math.sin(this.shakeTime * 29.9)) * 0.05 * rumble;

    let targetFov: number;

    if (this.mode === 'hood') {
      const fwd = cfg.wheelbase * 0.24;
      const up = cfg.height * 0.74 + 0.1;
      cam.position.set(st.x + sinH * fwd + sx, st.y + up + sy, st.z + cosH * fwd);
      const dir = lookBack ? -1 : 1;
      this.look.set(
        cam.position.x + sinH * 12 * dir,
        cam.position.y + Math.sin(st.pitch) * 12 * dir - 0.6,
        cam.position.z + cosH * 12 * dir,
      );
      cam.up.set(Math.sin(st.roll) * -cosH * 0.6, 1, Math.sin(st.roll) * sinH * 0.6).normalize();
      cam.lookAt(this.look);
      targetFov = 70 + speedF * 14 + (nitro ? 8 : 0);
      this.yaw = st.heading;
      this.camY = st.y;
      this.snapped = true;
    } else {
      const p = PRESETS[this.mode];
      // blend the heading toward the velocity direction so drifts are seen from the outside
      let targetYaw = st.heading;
      const planar = Math.hypot(st.vx, st.vz);
      if (planar > 5 && st.speed > 1) {
        const velHeading = Math.atan2(st.vx, st.vz);
        targetYaw = st.heading + clamp(angleDiff(st.heading, velHeading), -0.75, 0.75) * 0.6;
      }
      if (lookBack) targetYaw += Math.PI;
      const targetDist = p.distance + speedF * 1.5 + (nitro ? 0.9 : 0);
      if (!this.snapped) {
        this.yaw = targetYaw;
        this.camY = st.y;
        this.dist = targetDist;
        this.fov = p.fov;
        this.snapped = true;
      } else {
        this.yaw = dampAngle(this.yaw, targetYaw, lookBack ? 14 : p.yawLambda, dt);
        this.camY = damp(this.camY, st.y, 9, dt);
        this.dist = damp(this.dist, targetDist, 4, dt);
      }
      const sinY = Math.sin(this.yaw);
      const cosY = Math.cos(this.yaw);
      let cx = st.x - sinY * this.dist;
      let cz = st.z - cosY * this.dist;
      let cy = this.camY + p.height;

      // keep the camera out of buildings / walls: pull it toward the car when blocked
      const n = world.queryColliders(cx, cz, 1.2, this.colliders);
      let blocked = false;
      for (let i = 0; i < n; i++) {
        const c = this.colliders[i];
        if (c.soft || c.yMax < cy - 0.3 || c.kind === 'prop') continue;
        if (distanceToCollider(c, cx, cz) < 0.6) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        for (let t = 0.85; t >= 0.25; t -= 0.15) {
          const tx = st.x - sinY * this.dist * t;
          const tz = st.z - cosY * this.dist * t;
          const m = world.queryColliders(tx, tz, 1.0, this.colliders);
          let hit = false;
          for (let i = 0; i < m; i++) {
            const c = this.colliders[i];
            if (c.soft || c.yMax < cy - 0.3 || c.kind === 'prop') continue;
            if (distanceToCollider(c, tx, tz) < 0.5) {
              hit = true;
              break;
            }
          }
          cx = tx;
          cz = tz;
          if (!hit) break;
        }
        cy += 0.5;
      }
      const groundY = world.getGroundHeight(cx, cz);
      if (cy < groundY + 0.6) cy = groundY + 0.6;

      cam.position.set(cx + sx, cy + sy, cz);
      cam.up.set(0, 1, 0);
      const ahead = lookBack ? -p.lookAhead : p.lookAhead;
      this.look.set(st.x + sinH * ahead, st.y + p.lookHeight, st.z + cosH * ahead);
      cam.lookAt(this.look);
      targetFov = p.fov + speedF * 15 + (nitro ? 9 : 0);
    }

    this.fov = damp(this.fov, targetFov, 5, dt);
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov;
      cam.updateProjectionMatrix();
    }
    this.ground.x = cam.position.x;
    this.ground.z = cam.position.z;

    // rear-view mirror: on the roof line, looking backwards
    const m = this.mirrorCamera;
    m.position.set(st.x - sinH * 0.3, st.y + cfg.height + 0.15, st.z - cosH * 0.3);
    this.look.set(st.x - sinH * 30, st.y + cfg.height * 0.6, st.z - cosH * 30);
    m.up.set(0, 1, 0);
    m.lookAt(this.look);
  }

  /** Slow cinematic orbit around a point (title screen, results). */
  updateOrbit(dt: number, time: number, cx: number, cy: number, cz: number, radius: number, height: number, speed: number): void {
    const cam = this.camera;
    const a = time * speed;
    cam.position.set(cx + Math.sin(a) * radius, cy + height, cz + Math.cos(a) * radius);
    cam.up.set(0, 1, 0);
    this.look.set(cx, cy, cz);
    cam.lookAt(this.look);
    this.fov = damp(this.fov, 50, 3, dt);
    cam.fov = this.fov;
    cam.updateProjectionMatrix();
    this.ground.x = cam.position.x;
    this.ground.z = cam.position.z;
    this.snapped = false;
  }

  /** Garage turntable orbit. */
  updateGarage(target: THREE.Vector3, yaw: number, pitch: number, distance: number): void {
    const cam = this.camera;
    const cp = Math.cos(pitch);
    cam.position.set(
      target.x + Math.sin(yaw) * cp * distance,
      target.y + Math.sin(pitch) * distance,
      target.z + Math.cos(yaw) * cp * distance,
    );
    cam.up.set(0, 1, 0);
    cam.lookAt(target);
    if (cam.fov !== 40) {
      cam.fov = 40;
      this.fov = 40;
      cam.updateProjectionMatrix();
    }
    this.snapped = false;
  }
}
