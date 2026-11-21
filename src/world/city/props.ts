/* Knock-over street furniture (merged into the tile meshes, swapped for a tumbling
 * instance when hit) and the pool of 8 real point lights that follows the camera. */
import * as THREE from 'three';
import type { StaticCollider } from '../../core/types';
import { Batch, box, cyl, rgb } from './batch';
import type { PatchName, RGB, TileSet } from './batch';
import type { ColliderIndex } from './colliders';

export interface LampRec {
  x: number;
  y: number;
  z: number;
  color: number;
  alive: boolean;
}

interface Range {
  batch: Batch;
  start: number;
  count: number;
  saved: Float32Array | null;
}

export interface PropRec {
  id: number;
  tpl: number;
  x: number;
  y: number;
  z: number;
  rot: number;
  collider: StaticCollider;
  ranges: Range[];
  alive: boolean;
  lamp: LampRec | null;
}

type Emit = (b: Batch, x: number, y: number, z: number, rot: number) => void;

interface Template {
  name: string;
  emit: Emit;
  radius: number;
  height: number;
  mesh: THREE.InstancedMesh | null;
  flyers: Flyer[];
}

interface Flyer {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  ground: number;
  rot: number;
  tilt: number;
  spin: number;
  axisX: number;
  axisZ: number;
  t: number;
}

const DARK: RGB = rgb(0x1c1f26);
const WHITE: RGB = [1, 1, 1];
export const LAMP_COLORS: Record<string, number> = { sodium: 0xffa040, white: 0xdfe8ff, cyan: 0x66e0ff, pink: 0xff5fb0 };

function lampEmit(height: number, arm: number, patch: PatchName): Emit {
  return (b, x, y, z, rot) => {
    const sn = Math.sin(rot);
    const cs = Math.cos(rot);
    b.color(DARK);
    box(b, x, y, z, 0.1, height, 0.1, rot);
    box(b, x + sn * arm * 0.5, y + height - 0.1, z + cs * arm * 0.5, 0.07, 0.12, arm * 0.5, rot);
    b.color(WHITE).patch(patch);
    box(b, x + sn * arm, y + height - 0.3, z + cs * arm, 0.24, 0.16, 0.5, rot, true);
    b.patch(null);
  };
}

const MAX_FLYERS = 8;

export class PropSystem {
  readonly records: PropRec[] = [];
  readonly lamps: LampRec[] = [];
  readonly group = new THREE.Group();
  private templates: Template[] = [];
  private byName = new Map<string, number>();
  private dummy = new THREE.Object3D();
  private axis = new THREE.Vector3();
  private activeTemplates: Template[] = [];
  // light pool
  private lights: THREE.PointLight[] = [];
  private lightLamp: (LampRec | null)[] = [];
  private lightTarget: number[] = [];
  private lampCells = new Map<number, LampRec[]>();
  private poolTimer = 0;
  private picked: LampRec[] = [];
  private pickedD: number[] = [];

  constructor(
    private tiles: TileSet,
    private colliders: ColliderIndex,
  ) {
    this.group.name = 'props';
    const add = (name: string, radius: number, height: number, emit: Emit) => {
      this.byName.set(name, this.templates.length);
      this.templates.push({ name, emit, radius, height, mesh: null, flyers: [] });
    };
    add('lamp-sodium', 0.3, 8.5, lampEmit(8.5, 2.6, 'sodium'));
    add('lamp-white', 0.3, 8.5, lampEmit(8.5, 2.6, 'white'));
    add('lamp-cyan', 0.3, 9, lampEmit(9, 3, 'cyan'));
    add('lamp-pink', 0.3, 6, lampEmit(6, 1.6, 'pink'));
    add('cone', 0.3, 0.7, (b, x, y, z) => {
      b.color(rgb(0xff5a14));
      cyl(b, x, y, z, 0.24, 0.05, 0.7, 6);
      b.color(rgb(0x222222));
      box(b, x, y, z, 0.28, 0.04, 0.28);
    });
    add('bin', 0.4, 1, (b, x, y, z, rot) => {
      b.color(rgb(0x1d3a2c));
      box(b, x, y, z, 0.32, 1, 0.32, rot);
    });
    add('hydrant', 0.3, 0.8, (b, x, y, z) => {
      b.color(rgb(0xb01818));
      cyl(b, x, y, z, 0.17, 0.13, 0.8, 6);
    });
    add('barrel', 0.42, 1, (b, x, y, z) => {
      b.color(rgb(0x2a4a6a));
      cyl(b, x, y, z, 0.36, 0.36, 0.98, 8);
    });
    add('bench', 0.9, 0.9, (b, x, y, z, rot) => {
      b.color(rgb(0x3a2a1c));
      box(b, x, y + 0.35, z, 0.95, 0.1, 0.3, rot, true);
      box(b, x - Math.sin(rot) * 0.26, y + 0.45, z - Math.cos(rot) * 0.26, 0.95, 0.45, 0.05, rot);
      b.color(DARK);
      box(b, x, y, z, 0.8, 0.35, 0.05, rot);
    });
    add('sign', 0.25, 2.8, (b, x, y, z, rot) => {
      b.color(DARK);
      box(b, x, y, z, 0.05, 2.6, 0.05, rot);
      b.color(rgb(0x1a55b0));
      box(b, x, y + 2.1, z, 0.4, 0.6, 0.04, rot, true);
    });
    add('signal', 0.3, 5.5, (b, x, y, z, rot) => {
      b.color(DARK);
      box(b, x, y, z, 0.09, 5.2, 0.09, rot);
      box(b, x, y + 4.1, z, 0.2, 1.2, 0.2, rot, true);
      b.color(WHITE).patch('amber');
      box(b, x + Math.sin(rot) * 0.2, y + 4.5, z + Math.cos(rot) * 0.2, 0.13, 0.26, 0.04, rot, true);
      b.patch(null);
    });
  }

  /** Place a knock-over prop: geometry in the tile mesh + soft collider. */
  place(name: string, x: number, y: number, z: number, rot = 0): PropRec {
    const ti = this.byName.get(name)!;
    const tpl = this.templates[ti];
    const b = this.tiles.batch('static', x, z);
    const start = b.nv;
    tpl.emit(b, x, y, z, rot);
    const id = this.records.length;
    const collider = this.colliders.add({
      shape: 'circle',
      x,
      z,
      hx: 0,
      hz: 0,
      rot: 0,
      r: tpl.radius,
      yMin: y - 0.5,
      yMax: y + Math.min(tpl.height, 3),
      kind: 'prop',
      soft: true,
      refId: id,
    });
    const rec: PropRec = { id, tpl: ti, x, y, z, rot, collider, ranges: [{ batch: b, start, count: b.nv - start, saved: null }], alive: true, lamp: null };
    this.records.push(rec);
    return rec;
  }

  /** Attach extra geometry (light pool, halo) emitted since `start` in `batch` to a prop. */
  track(rec: PropRec, batch: Batch, start: number): void {
    if (batch.nv > start) rec.ranges.push({ batch, start, count: batch.nv - start, saved: null });
  }

  addLamp(x: number, y: number, z: number, color: number, rec: PropRec | null): LampRec {
    const lamp: LampRec = { x, y, z, color, alive: true };
    this.lamps.push(lamp);
    if (rec) rec.lamp = lamp;
    return lamp;
  }

  /** Call once after the tile meshes exist. */
  finalize(material: THREE.Material): void {
    for (const tpl of this.templates) {
      const b = new Batch('static');
      tpl.emit(b, 0, 0, 0, 0);
      const mesh = new THREE.InstancedMesh(b.toGeometry(), material, MAX_FLYERS);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.name = `flyer ${tpl.name}`;
      tpl.mesh = mesh;
      this.group.add(mesh);
    }
    for (const l of this.lamps) {
      const key = Math.floor(l.x / 64) * 4096 + Math.floor(l.z / 64);
      let list = this.lampCells.get(key);
      if (!list) this.lampCells.set(key, (list = []));
      list.push(l);
    }
    for (let i = 0; i < 8; i++) {
      const light = new THREE.PointLight(0xffa040, 0, 55, 2);
      light.position.set(0, -50, 0);
      this.lights.push(light);
      this.lightLamp.push(null);
      this.lightTarget.push(0);
      this.group.add(light);
    }
  }

  hit(collider: StaticCollider, vx: number, vz: number): void {
    if (typeof collider.refId !== 'number') return;
    const rec = this.records[collider.refId];
    if (!rec || !rec.alive || rec.collider !== collider) return;
    rec.alive = false;
    if (rec.lamp) rec.lamp.alive = false;
    this.colliders.remove(rec.collider);
    for (const r of rec.ranges) {
      const attr = r.batch.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
      if (!attr) continue;
      const arr = attr.array as Float32Array;
      if (!r.saved) r.saved = arr.slice(r.start * 3, (r.start + r.count) * 3);
      for (let i = r.start; i < r.start + r.count; i++) {
        arr[i * 3] = rec.x;
        arr[i * 3 + 1] = rec.y - 4;
        arr[i * 3 + 2] = rec.z;
      }
      attr.addUpdateRange(r.start * 3, r.count * 3);
      attr.needsUpdate = true;
    }
    const tpl = this.templates[rec.tpl];
    const speed = Math.hypot(vx, vz);
    const k = speed > 0.1 ? Math.min(1, 26 / speed) : 0;
    const f: Flyer = {
      x: rec.x,
      y: rec.y + 0.1,
      z: rec.z,
      vx: vx * 0.7 * k + (speed > 0.1 ? 0 : 2),
      vy: 3 + Math.min(6, speed * 0.16),
      vz: vz * 0.7 * k,
      ground: rec.y,
      rot: rec.rot,
      tilt: 0,
      spin: 2.5 + Math.min(6, speed * 0.2),
      axisX: speed > 0.1 ? vz / speed : 1,
      axisZ: speed > 0.1 ? -vx / speed : 0,
      t: 0,
    };
    if (tpl.flyers.length >= MAX_FLYERS) tpl.flyers.shift();
    tpl.flyers.push(f);
    if (!this.activeTemplates.includes(tpl)) this.activeTemplates.push(tpl);
  }

  reset(): void {
    for (const rec of this.records) {
      if (rec.alive) continue;
      rec.alive = true;
      if (rec.lamp) rec.lamp.alive = true;
      this.colliders.restore(rec.collider);
      for (const r of rec.ranges) {
        const attr = r.batch.geometry?.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (!attr || !r.saved) continue;
        (attr.array as Float32Array).set(r.saved, r.start * 3);
        attr.addUpdateRange(r.start * 3, r.count * 3);
        attr.needsUpdate = true;
      }
    }
    for (const tpl of this.templates) {
      tpl.flyers.length = 0;
      if (tpl.mesh) tpl.mesh.count = 0;
    }
    this.activeTemplates.length = 0;
  }

  update(dt: number, focus: THREE.Vector3): void {
    // tumbling props
    for (let a = this.activeTemplates.length - 1; a >= 0; a--) {
      const tpl = this.activeTemplates[a];
      const mesh = tpl.mesh!;
      for (let i = tpl.flyers.length - 1; i >= 0; i--) {
        const f = tpl.flyers[i];
        f.t += dt;
        if (f.t > 2.6) {
          tpl.flyers.splice(i, 1);
          continue;
        }
        f.vy -= 14 * dt;
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        f.z += f.vz * dt;
        if (f.y < f.ground + 0.15) {
          f.y = f.ground + 0.15;
          f.vy = Math.abs(f.vy) * 0.25;
          f.vx *= 0.82;
          f.vz *= 0.82;
          f.spin *= 0.7;
        }
        f.tilt = Math.min(Math.PI / 2, f.tilt + f.spin * dt);
      }
      for (let i = 0; i < tpl.flyers.length; i++) {
        const f = tpl.flyers[i];
        const d = this.dummy;
        d.position.set(f.x, f.y, f.z);
        d.rotation.set(0, f.rot, 0);
        d.rotateOnWorldAxis(this.axis.set(f.axisX, 0, f.axisZ), f.tilt);
        const fade = f.t > 2.2 ? Math.max(0.01, (2.6 - f.t) / 0.4) : 1;
        d.scale.setScalar(fade);
        d.updateMatrix();
        mesh.setMatrixAt(i, d.matrix);
      }
      mesh.count = tpl.flyers.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (tpl.flyers.length === 0) this.activeTemplates.splice(a, 1);
    }
    // pooled lights: pick the 8 nearest living lamps a few times per second
    this.poolTimer -= dt;
    if (this.poolTimer <= 0) {
      this.poolTimer = 0.2;
      this.pickLamps(focus.x, focus.z);
    }
    const rate = Math.min(1, dt * 5);
    for (let i = 0; i < this.lights.length; i++) {
      const light = this.lights[i];
      light.intensity += (this.lightTarget[i] - light.intensity) * rate;
    }
  }

  private pickLamps(fx: number, fz: number): void {
    const picked = this.picked;
    const pd = this.pickedD;
    picked.length = 0;
    pd.length = 0;
    const ci = Math.floor(fx / 64);
    const cj = Math.floor(fz / 64);
    for (let j = cj - 2; j <= cj + 2; j++) {
      for (let i = ci - 2; i <= ci + 2; i++) {
        const list = this.lampCells.get(i * 4096 + j);
        if (!list) continue;
        for (let k = 0; k < list.length; k++) {
          const l = list[k];
          if (!l.alive) continue;
          let d = (l.x - fx) * (l.x - fx) + (l.z - fz) * (l.z - fz);
          if (this.lightLamp.includes(l)) d *= 0.7; // hysteresis
          // insertion into the sorted top-8
          let q = picked.length;
          if (q === 8 && d >= pd[7]) continue;
          if (q < 8) q++;
          let s = q - 1;
          while (s > 0 && pd[s - 1] > d) {
            picked[s] = picked[s - 1];
            pd[s] = pd[s - 1];
            s--;
          }
          picked[s] = l;
          pd[s] = d;
          picked.length = q;
          pd.length = q;
        }
      }
    }
    // keep the lights whose lamp is still picked, fade the others out then move them
    for (let i = 0; i < this.lights.length; i++) {
      const cur = this.lightLamp[i];
      if (cur && cur.alive && picked.includes(cur)) {
        this.lightTarget[i] = 420;
        continue;
      }
      this.lightTarget[i] = 0;
      if (this.lights[i].intensity < 12) {
        let next: LampRec | null = null;
        for (let k = 0; k < picked.length; k++) {
          if (!this.lightLamp.includes(picked[k])) {
            next = picked[k];
            break;
          }
        }
        this.lightLamp[i] = next;
        if (next) {
          this.lights[i].position.set(next.x, next.y, next.z);
          this.lights[i].color.setHex(next.color);
          this.lightTarget[i] = 420;
        }
      }
    }
  }

  dispose(): void {
    for (const tpl of this.templates) tpl.mesh?.geometry.dispose();
    for (const l of this.lights) l.dispose();
  }
}
