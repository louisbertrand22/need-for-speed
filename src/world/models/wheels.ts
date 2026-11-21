/* Procedural wheels: profiled tyre, rim barrel, 6 rim designs, brake disc. Axis = X, outer face = +X. */
import * as THREE from 'three';
import type { BodyDetail } from './carBody';
import { GeoBuilder, trs, type P2, type P3 } from './geo';

const RUBBER = 0x0a0a0b;

/** One spoke from radius r0 to r1 (half widths w0 → w1, front face x0 → x1, thickness th, sweep angle, blade twist). */
function spoke(b: GeoBuilder, ang: number, r0: number, r1: number, w0: number, w1: number, x0: number, x1: number, th: number, sweep: number, n: number, twist = 0): void {
  const fl: P3[] = [];
  const fr: P3[] = [];
  const bl: P3[] = [];
  const br: P3[] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    const r = r0 + (r1 - r0) * t;
    const a = ang + sweep * Math.pow(t, 1.4);
    const w = w0 + (w1 - w0) * t;
    const x = x0 + (x1 - x0) * Math.pow(t, 0.75);
    const cy = Math.cos(a);
    const sz = Math.sin(a);
    const py = r * cy;
    const pz = r * sz;
    fl.push([x + twist, py + w * sz, pz - w * cy]);
    fr.push([x - twist, py - w * sz, pz + w * cy]);
    bl.push([x + twist - th, py + w * sz, pz - w * cy]);
    br.push([x - twist - th, py - w * sz, pz + w * cy]);
  }
  for (let k = 0; k < n; k++) {
    b.quad(fl[k], fl[k + 1], fr[k + 1], fr[k]);
    b.quad(bl[k], bl[k + 1], fl[k + 1], fl[k]);
    b.quad(fr[k], fr[k + 1], br[k + 1], br[k]);
    if (th > 0.021) b.quad(br[k], br[k + 1], bl[k + 1], bl[k]);
  }
}

/**
 * Adds a wheel to `b` (centred on the origin of the current transform).
 * R = tyre radius, w = tyre width, rimRatio = rim radius / R, style = index into RIM_STYLES.
 */
export function addWheel(b: GeoBuilder, R: number, w: number, rimRatio: number, style: number, detail: BodyDetail): void {
  const hi = detail === 'high';
  const traffic = detail === 'traffic';
  const Rr = R * rimRatio;
  const hw = w / 2;
  const sw = R - Rr;
  const seg = hi ? 30 : traffic ? 10 : 16;
  b.channel(0).setPart(0);

  // --- tyre (outer bead → tread → inner bead)
  b.paint(RUBBER, 0.9, 0);
  const prof: P2[] = [];
  prof.push([hw - 0.014, Rr - 0.004], [hw + 0.002, Rr + sw * 0.18], [hw + 0.008, Rr + sw * 0.5], [hw, R - sw * 0.2], [hw - 0.022, R - 0.007]);
  if (hi) {
    prof.push([hw * 0.6, R]);
    for (const g of [hw * 0.34, 0, -hw * 0.34]) prof.push([g + 0.008, R], [g + 0.005, R - 0.008], [g - 0.005, R - 0.008], [g - 0.008, R]);
    prof.push([-hw * 0.6, R]);
  }
  prof.push([-hw + 0.022, R - 0.007], [-hw, R - sw * 0.2], [-hw - 0.008, Rr + sw * 0.5], [-hw + 0.014, Rr - 0.004]);
  b.latheX(prof, seg);

  // --- barrel + lip
  const deep = style === 4;
  const xf = deep ? hw - 0.085 : hw - 0.03;
  const chrome = (): void => {
    b.paint(0xe9ecf1, 0.08, 1);
  };
  const rim = (rough = 0.22): void => {
    b.paint(0xffffff, rough, 1, true);
  };
  if (deep) chrome();
  else rim();
  b.latheX(
    [
      [-hw + 0.03, Rr - 0.022],
      [hw - 0.016, Rr - 0.016],
      [hw - 0.006, Rr + 0.005],
    ],
    seg,
  );
  // back plate (hides the far side)
  b.paint(0x050506, 0.9, 0.2);
  b.addGeometry(new THREE.CircleGeometry(Rr - 0.02, seg), trs(-hw + 0.035, 0, 0, 0, Math.PI / 2, 0));

  // --- brake disc
  if (!traffic) {
    const xd = xf - 0.075;
    b.paint(0x8d9096, 0.32, 1);
    b.addGeometry(new THREE.CylinderGeometry(Rr * 0.8, Rr * 0.8, 0.02, hi ? 24 : 12), trs(xd, 0, 0, 0, 0, Math.PI / 2));
    b.paint(0x2a2b2e, 0.5, 0.8);
    b.addGeometry(new THREE.CylinderGeometry(Rr * 0.36, Rr * 0.36, 0.05, hi ? 14 : 8), trs(xd + 0.02, 0, 0, 0, 0, Math.PI / 2));
  }

  // --- spokes
  const r0 = Rr * 0.2;
  const r1 = Rr - 0.014;
  const n = hi ? 4 : 2;
  const TAU = Math.PI * 2;
  switch (style) {
    case 1: // five thin, concave
      rim(0.2);
      for (let i = 0; i < 5; i++) spoke(b, (i / 5) * TAU, r0, r1, Rr * 0.1, Rr * 0.065, xf - 0.045, xf, 0.03, 0, n);
      break;
    case 2: // multi-spoke mesh
      rim(0.2);
      for (let i = 0; i < 10; i++) {
        spoke(b, (i / 10) * TAU, r0, r1, Rr * 0.04, Rr * 0.035, xf - 0.012, xf, 0.02, 0.44, n);
        spoke(b, (i / 10) * TAU, r0, r1, Rr * 0.04, Rr * 0.035, xf - 0.012, xf, 0.02, -0.44, n);
      }
      break;
    case 3: // turbine blades
      rim(0.18);
      for (let i = 0; i < 11; i++) spoke(b, (i / 11) * TAU, r0, r1, Rr * 0.08, Rr * 0.13, xf - 0.02, xf, 0.022, 0.55, n, 0.016);
      break;
    case 4: // deep dish
      rim(0.24);
      for (let i = 0; i < 6; i++) spoke(b, (i / 6) * TAU, r0, r1 - 0.006, Rr * 0.12, Rr * 0.14, xf - 0.01, xf, 0.035, 0, n);
      chrome();
      b.latheX(
        [
          [xf - 0.02, Rr - 0.03],
          [hw - 0.016, Rr - 0.016],
        ],
        seg,
      );
      break;
    case 5: // aero monoblock (five wide petals)
      rim(0.3);
      for (let i = 0; i < 5; i++) spoke(b, (i / 5) * TAU, r0, r1, r0 * 0.6, r1 * 0.6, xf, xf, 0.03, 0, n);
      b.paint(0x060607, 0.8, 0.3);
      b.addGeometry(new THREE.CircleGeometry(r1, seg), trs(xf - 0.02, 0, 0, 0, Math.PI / 2, 0));
      break;
    default: // stock five-spoke, steel look
      rim(0.42);
      for (let i = 0; i < 5; i++) spoke(b, (i / 5) * TAU, r0, r1, Rr * 0.2, Rr * 0.25, xf - 0.012, xf - 0.004, 0.03, 0, n);
      break;
  }
  // hub + centre cap
  rim(0.25);
  b.addGeometry(new THREE.CylinderGeometry(Rr * 0.25, Rr * 0.28, 0.05, hi ? 14 : 8), trs(xf - 0.02, 0, 0, 0, 0, -Math.PI / 2));
  if (hi) {
    b.paint(0x1a1b1e, 0.3, 0.9);
    b.addGeometry(new THREE.CylinderGeometry(Rr * 0.1, Rr * 0.11, 0.012, 10), trs(xf + 0.008, 0, 0, 0, 0, -Math.PI / 2));
    b.paint(0x9a9da3, 0.3, 1);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU + 0.3;
      b.addGeometry(new THREE.CylinderGeometry(0.008, 0.008, 0.014, 6), trs(xf + 0.008, Math.cos(a) * Rr * 0.18, Math.sin(a) * Rr * 0.18, 0, 0, -Math.PI / 2));
    }
  }
}

export function buildWheelGeometry(R: number, w: number, rimRatio: number, style: number, detail: BodyDetail): THREE.BufferGeometry {
  const b = new GeoBuilder();
  addWheel(b, R, w, rimRatio, style, detail);
  return b.build({ crease: 42 });
}

/** Brake caliper (static, does not spin): arc block over the disc. */
export function buildCaliperGeometry(R: number, w: number, rimRatio: number, color: number, deep: boolean): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const Rr = R * rimRatio;
  const xf = deep ? w / 2 - 0.085 : w / 2 - 0.03;
  const xd = xf - 0.075;
  b.paint(color, 0.35, 0.3);
  const poly: P2[] = [];
  const a0 = 0.5;
  const a1 = 1.55;
  for (let i = 0; i <= 5; i++) {
    const a = a0 + ((a1 - a0) * i) / 5;
    poly.push([Math.cos(a) * Rr * 0.86, Math.sin(a) * Rr * 0.86]);
  }
  for (let i = 5; i >= 0; i--) {
    const a = a0 + ((a1 - a0) * i) / 5;
    poly.push([Math.cos(a) * Rr * 0.48, Math.sin(a) * Rr * 0.48]);
  }
  // (a, b) = (z, y): caliper sits at the rear-top of the disc
  b.prism(poly, xd - 0.03, xd + 0.04, (a, bb, d) => [d, bb, -a]);
  return b.build({ crease: 40 });
}
