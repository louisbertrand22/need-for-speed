/* Pursuit breakers: water towers, gas stations, scaffolds. Dynamic meshes (not merged in
 * the tiles) with a scripted ~2 s collapse towards the road. */
import * as THREE from 'three';
import type { BreakerKind, PursuitBreaker, StaticCollider } from '../../core/types';
import { Batch, box, cyl, flatQuad, rgb, wallQuad } from './batch';
import type { LayerName } from './batch';
import type { Ctx } from './ctx';
import { bigSignUV, wideSignUV } from './look';

interface Site {
  id: string;
  kind: BreakerKind;
  name: string;
  /** point on the road centre line + direction towards the structure */
  x: number;
  z: number;
  nx: number;
  nz: number;
}

/** Road-side sites (the hills one is resolved on the south branch road at build time). */
const SITES: Site[] = [
  { id: 'wt-docks', kind: 'watertower', name: "Château d'eau des Docks", x: 150, z: 750, nx: 0, nz: 1 },
  { id: 'wt-lanterne', kind: 'watertower', name: 'Citerne du Marché', x: 600, z: -375, nx: 1, nz: 0 },
  { id: 'wt-hauts', kind: 'watertower', name: 'Réservoir des Hauts', x: 0, z: 0, nx: 0, nz: 0 },
  { id: 'gs-centre', kind: 'gasstation', name: 'Station Hélios', x: -225, z: -300, nx: 0, nz: -1 },
  { id: 'gs-docks', kind: 'gasstation', name: 'Station Cargo 24', x: 300, z: 675, nx: -1, nz: 0 },
  { id: 'gs-lanterne', kind: 'gasstation', name: 'Relais Lanterne', x: 750, z: -75, nx: 1, nz: 0 },
  { id: 'sc-kessler', kind: 'scaffold', name: 'Échafaudage Tour Kessler', x: 150, z: 75, nx: -1, nz: 0 },
  { id: 'sc-passage', kind: 'scaffold', name: 'Échafaudage du Passage', x: 375, z: -600, nx: 0, nz: -1 },
  { id: 'sc-ferraille', kind: 'scaffold', name: 'Portique de Ferraille', x: 450, z: 900, nx: 0, nz: -1 },
];

interface BreakerRec {
  info: PursuitBreaker;
  group: THREE.Group;
  mover: THREE.Group;
  weak: THREE.Mesh;
  rubble: THREE.Mesh;
  extra: THREE.Mesh | null;
  weakCollider: StaticCollider;
  solids: StaticCollider[];
  solidsRemoved: boolean;
  t: number;
  height: number;
  y: number;
}

export class BreakerSystem {
  readonly group = new THREE.Group();
  readonly list: PursuitBreaker[] = [];
  private recs: BreakerRec[] = [];
  private active: BreakerRec[] = [];
  private geometries: THREE.BufferGeometry[] = [];

  constructor(
    private ctx: Ctx,
    private materials: Record<LayerName, THREE.Material>,
  ) {
    this.group.name = 'breakers';
  }

  /** Resolve the sites and reserve their lots (before the buildings are placed). */
  static reserve(ctx: Ctx): Site[] {
    const sites: Site[] = [];
    for (const s of SITES) {
      const site = { ...s };
      if (s.id === 'wt-hauts') {
        const hill = ctx.graph.edges.filter((e) => e.kind === 'hill')[8];
        const target = hill.length * 0.47;
        let i = 0;
        while (i + 2 < hill.points.length && hill.cum[i + 1] < target) i++;
        const a = hill.points[i];
        const c = hill.points[i + 1];
        const len = Math.hypot(c.x - a.x, c.z - a.z) || 1;
        site.x = a.x;
        site.z = a.z;
        site.nx = -(c.z - a.z) / len;
        site.nz = (c.x - a.x) / len;
      }
      sites.push(site);
      const hit = ctx.graph.nearestRoad(site.x, site.z, 20);
      const hw = hit ? hit.edge.width / 2 : 6;
      ctx.reserved.push({ x: site.x + site.nx * (hw + 10), z: site.z + site.nz * (hw + 10), hx: 13, hz: 13, rot: 0 });
    }
    return sites;
  }

  private mesh(b: Batch, layer: LayerName, parent: THREE.Object3D): THREE.Mesh {
    const geo = b.toGeometry();
    this.geometries.push(geo);
    const m = new THREE.Mesh(geo, this.materials[layer]);
    if (layer === 'add') m.renderOrder = 2;
    parent.add(m);
    return m;
  }

  build(sites: Site[]): void {
    const { ctx } = this;
    for (const site of sites) {
      const hit = ctx.graph.nearestRoad(site.x, site.z, 20);
      const hw = hit ? hit.edge.width / 2 : 6;
      // local frame: +Z points from the structure to the road
      const cx = site.x + site.nx * (hw + 6.5);
      const cz = site.z + site.nz * (hw + 6.5);
      const y = ctx.h(cx, cz);
      const rotY = Math.atan2(-site.nx, -site.nz);
      const weakLocalZ = 3;
      const wx = cx - site.nx * weakLocalZ;
      const wz = cz - site.nz * weakLocalZ;
      const group = new THREE.Group();
      group.position.set(cx, y, cz);
      group.rotation.y = rotY;
      const mover = new THREE.Group();
      group.add(mover);
      const body = new Batch('static');
      const glow = new Batch('glow');
      const weakB = new Batch('glow');
      const rubbleB = new Batch('static');
      const solids: StaticCollider[] = [];
      const toWorld = (lx: number, lz: number): [number, number] => {
        const cs = Math.cos(rotY);
        const sn = Math.sin(rotY);
        return [cx + lx * cs + lz * sn, cz - lx * sn + lz * cs];
      };
      const pillar = (lx: number, lz: number, r: number, top: number) => {
        const [px, pz] = toWorld(lx, lz);
        solids.push(ctx.colliders.add({ shape: 'circle', x: px, z: pz, hx: 0, hz: 0, rot: 0, r, yMin: y - 1, yMax: y + top, kind: 'pillar' }));
      };
      let height = 12;
      let extra: THREE.Mesh | null = null;
      weakB.color(rgb(0xff5a14, 3.2)).anim(0, 1);
      if (site.kind === 'watertower') {
        height = 13;
        mover.position.set(0, 0, 2.3);
        body.color([0.2, 0.17, 0.14]);
        for (const [lx, lz] of [
          [-2.3, -4.6],
          [2.3, -4.6],
          [-2.3, 0],
          [2.3, 0],
        ]) {
          box(body, lx, 0, lz, 0.28, 9.4, 0.28);
          pillar(lx, lz + 2.3, 0.4, 9);
        }
        box(body, 0, 4.5, -2.3, 2.5, 0.2, 2.5, 0, true);
        body.color([0.3, 0.2, 0.12]);
        cyl(body, 0, 9.4, -2.3, 3.4, 3.4, 3.8, 12);
        cyl(body, 0, 13.2, -2.3, 3.4, 0.2, 1.2, 12, false);
        glow.color(rgb(0x9fd8ff, 1.6)).anim(0, 0);
        box(glow, 0, 9.5, -2.3, 3.5, 0.14, 3.5, 0, true);
        // weak point: a rusty brace on the road side
        box(weakB, 0, 0, weakLocalZ, 0.22, 4.4, 0.22);
        box(weakB, 0, 0.05, weakLocalZ, 1.3, 0.12, 1.3);
        // flood left on the road
        const floodB = new Batch('add');
        floodB.color(rgb(0x3f9fff, 0.32));
        flatQuad(floodB, 0, 0.14, hw + 6.5, 13, 13);
        extra = this.mesh(floodB, 'add', group);
        extra.visible = false;
      } else if (site.kind === 'gasstation') {
        height = 6;
        body.color([0.13, 0.13, 0.15]);
        for (const [lx, lz] of [
          [-5, -2.6],
          [5, -2.6],
          [-5, 2.2],
          [5, 2.2],
        ]) {
          box(body, lx, 0, lz, 0.25, 5.2, 0.25);
          if (lz < 0) pillar(lx, lz, 0.4, 5);
        }
        body.color([0.22, 0.22, 0.25]);
        box(body, 0, 5.2, -0.2, 6.2, 0.7, 4, 0, true);
        glow.color(rgb(0xffb020, 2.6)).anim(0, 0);
        box(glow, 0, 5.15, -0.2, 6.25, 0.14, 4.05, 0, true);
        glow.color(rgb(0xfff0d0, 1.5));
        flatQuad(glow, 0, 5.18, -0.2, 5, 3);
        // shop at the back (stays up)
        const shopB = new Batch('static');
        shopB.color([0.12, 0.12, 0.14]);
        box(shopB, 0, 0, -9.5, 6, 4, 3);
        this.mesh(shopB, 'static', group);
        const shopG = new Batch('glow');
        shopG.color(rgb(0xfff0d0, 1.4)).anim(0, 0);
        wallQuad(shopG, 0, 1.9, -6.44, 0, 1, 5, 1.3);
        this.mesh(shopG, 'glow', group);
        const [sx, sz] = toWorld(0, -9.5);
        ctx.colliders.add({ shape: 'box', x: sx, z: sz, hx: 6, hz: 3, rot: rotY, yMin: y - 1, yMax: y + 4, kind: 'building' });
        const signB = new Batch('sign');
        signB.color(rgb(0xffb020, 2.6)).anim(0.2, 0);
        const uv = wideSignUV(site.id === 'gs-centre' ? 9 : 11);
        wallQuad(signB, 0, 5.55, 3.86, 0, 1, 4.6, 0.55, uv[0], uv[1], uv[2], uv[3]);
        this.mesh(signB, 'sign', mover);
        // weak point: the pump island
        box(weakB, -1.6, 0, weakLocalZ, 0.45, 1.9, 0.3);
        box(weakB, 1.6, 0, weakLocalZ, 0.45, 1.9, 0.3);
        box(weakB, 0, 0, weakLocalZ, 2.6, 0.18, 0.7);
      } else {
        height = 15;
        mover.position.set(0, 0, weakLocalZ - 0.5);
        const oz = -(weakLocalZ - 0.5);
        body.color([0.2, 0.2, 0.22]);
        for (const lx of [-4, 0, 4]) {
          for (const lz of [-0.6, 2.2]) box(body, lx, 0, lz + oz, 0.1, 13, 0.1);
        }
        for (let lv = 2.6; lv <= 13; lv += 2.6) {
          box(body, 0, lv, 0.8 + oz, 4.2, 0.1, 1.6, 0, true);
          glow.color(rgb(0xffd000, 1.6)).anim(lv / 13, 3);
          box(glow, 4.2, lv + 0.2, 2.2 + oz, 0.1, 0.2, 0.1, 0, true);
        }
        pillar(-4, -0.6, 0.3, 4);
        pillar(4, -0.6, 0.3, 4);
        const signB = new Batch('sign');
        signB.color(rgb(pickColor(site.id), 2.4)).anim(0.5, 0);
        const uv = bigSignUV(site.id === 'sc-kessler' ? 0 : site.id === 'sc-passage' ? 1 : 3);
        wallQuad(signB, 0, 16.2, 2.3 + oz, 0, 1, 5.2, 2.6, uv[0], uv[1], uv[2], uv[3], true);
        this.mesh(signB, 'sign', mover);
        body.color([0.05, 0.05, 0.06]);
        box(body, 0, 13.5, 2.1 + oz, 5.4, 5.4, 0.12, 0, true);
        // weak point: the front feet
        box(weakB, -2, 0, weakLocalZ, 0.2, 2.6, 0.2);
        box(weakB, 2, 0, weakLocalZ, 0.2, 2.6, 0.2);
        box(weakB, 0, 0.05, weakLocalZ, 2.6, 0.12, 0.5);
      }
      this.mesh(body, 'static', mover);
      if (glow.ni > 0) this.mesh(glow, 'glow', mover);
      const weak = this.mesh(weakB, 'glow', group);
      // rubble pile left on the road (decoration only)
      const rng = ctx.rng;
      for (let k = 0; k < 16; k++) {
        const g = 0.08 + rng() * 0.12;
        rubbleB.color([g * 1.2, g, g * 0.9]);
        const a = rng() * Math.PI * 2;
        const r = rng() * 7;
        box(rubbleB, Math.cos(a) * r, 0, hw + 6.5 + Math.sin(a) * r - 1, 0.5 + rng() * 1.1, 0.12 + rng() * 0.3, 0.4 + rng(), rng() * 3);
      }
      const rubble = this.mesh(rubbleB, 'static', group);
      rubble.visible = false;
      const weakCollider = ctx.colliders.add({ shape: 'circle', x: wx, z: wz, hx: 0, hz: 0, rot: 0, r: 1.7, yMin: y - 1, yMax: y + 3, kind: 'breaker', soft: true, refId: site.id });
      const info: PursuitBreaker = {
        id: site.id,
        kind: site.kind,
        name: site.name,
        x: wx,
        z: wz,
        minSpeedKmh: site.kind === 'gasstation' ? 70 : 60,
        danger: { x: site.x + site.nx * 1.5, z: site.z + site.nz * 1.5, radius: site.kind === 'scaffold' ? 10 : 12 },
        state: 'intact',
        dangerActive: false,
      };
      this.list.push(info);
      this.recs.push({ info, group, mover, weak, rubble, extra, weakCollider, solids, solidsRemoved: false, t: 0, height, y });
      this.group.add(group);
    }
  }

  trigger(id: string): boolean {
    const rec = this.recs.find((r) => r.info.id === id);
    if (!rec || rec.info.state !== 'intact') return false;
    rec.info.state = 'collapsing';
    rec.t = 0;
    rec.weak.visible = false;
    this.ctx.colliders.remove(rec.weakCollider);
    this.active.push(rec);
    return true;
  }

  update(dt: number, fx: number, fz: number): void {
    for (const rec of this.recs) {
      const dx = rec.group.position.x - fx;
      const dz = rec.group.position.z - fz;
      rec.group.visible = dx * dx + dz * dz < 900 * 900;
    }
    for (let i = this.active.length - 1; i >= 0; i--) {
      const rec = this.active[i];
      rec.t += dt;
      const t = rec.t;
      rec.info.dangerActive = t >= 0.3 && t <= 2.5;
      const fall = Math.min(1, Math.max(0, (t - 0.15) / 1.45));
      const ease = fall * fall;
      const squash = Math.min(1, Math.max(0, (t - 1.6) / 0.7));
      const m = rec.mover;
      if (rec.info.kind === 'gasstation') {
        // blown upwards, then the canopy drops flat on the forecourt and the road
        m.position.y = Math.sin(Math.min(1, t / 0.5) * Math.PI) * 1.6 - ease * 4.6;
        m.position.z = ease * 5;
        m.rotation.x = ease * 0.5 * (1 - squash);
        m.rotation.z = Math.sin(t * 9) * 0.05 * (1 - fall);
      } else {
        // topples towards the road around its road-side feet
        m.rotation.x = ease * (Math.PI / 2) * 0.98;
      }
      m.scale.y = 1 - squash * 0.86;
      if (rec.info.kind !== 'gasstation') m.scale.z = 1 - squash * 0.8;
      if (t > 1.3) {
        rec.rubble.visible = true;
        if (rec.extra) {
          rec.extra.visible = true;
          rec.extra.scale.setScalar(Math.min(1, (t - 1.3) / 1));
        }
        if (!rec.solidsRemoved) {
          for (const c of rec.solids) this.ctx.colliders.remove(c);
          rec.solidsRemoved = true;
        }
      }
      if (t >= 2.6) {
        rec.info.state = 'destroyed';
        rec.info.dangerActive = false;
        this.active.splice(i, 1);
      }
    }
  }

  reset(): void {
    for (const rec of this.recs) {
      if (rec.info.state === 'intact') continue;
      rec.info.state = 'intact';
      rec.info.dangerActive = false;
      rec.t = 0;
      rec.weak.visible = true;
      rec.rubble.visible = false;
      if (rec.extra) rec.extra.visible = false;
      const m = rec.mover;
      m.rotation.set(0, 0, 0);
      m.scale.set(1, 1, 1);
      m.position.y = 0;
      if (rec.info.kind === 'gasstation') m.position.z = 0;
      this.ctx.colliders.restore(rec.weakCollider);
      if (rec.solidsRemoved) for (const c of rec.solids) this.ctx.colliders.restore(c);
      rec.solidsRemoved = false;
    }
    this.active.length = 0;
  }

  dispose(): void {
    for (const g of this.geometries) g.dispose();
  }
}

function pickColor(id: string): number {
  return id === 'sc-kessler' ? 0x22e3ff : id === 'sc-passage' ? 0xff4fa3 : 0xffb020;
}
