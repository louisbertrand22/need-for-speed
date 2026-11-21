/* =============================================================================
 * Body definitions: the 7 player body styles, 3 police vehicles and the
 * civilian traffic shapes. All fictional, generic silhouettes.
 * ===========================================================================*/
import type { BodyStyle, CarDimensions, PoliceKind, TrafficKind } from '../../core/types';
import type { BodyBuilder, BodyDef } from './carBody';
import type { P2, P3 } from './geo';
import { CH, PART } from './materials';
import type { AtlasRegion } from './textures';

/** Compact description of the lamps / grilles of a body (fractions of the nose / tail faces). */
interface FaceSpec {
  /** headlight quad: x0..x1 (fraction of the nose half width), y0..y1 (fraction chin → hood edge), outer-end rise */
  head: { x0: number; x1: number; y0: number; y1: number; rise: number; tex: AtlasRegion };
  /** thin daytime running strip (same units), null = none */
  drl: { x0: number; x1: number; y0: number; y1: number } | null;
  /** lower intake: half width fraction, y range, texture */
  intake: { w: number; y0: number; y1: number; tex: AtlasRegion };
  /** upper grille (between the lamps) */
  grille: { w: number; y0: number; y1: number; tex: AtlasRegion } | null;
  /** side intakes of the bumper */
  sideIntake: { x0: number; x1: number; y0: number; y1: number } | null;
  /** tail lamps: list of quads [x0, x1, y0, y1] (fractions of the tail half width / face height) */
  tail: readonly (readonly [number, number, number, number])[];
  tailTex: AtlasRegion;
  /** full-width light bar [y0, y1] */
  tailBar: readonly [number, number] | null;
  /** reverse lamps [x0, x1, y0, y1] */
  reverse: readonly [number, number, number, number];
  /** rear plate centre height fraction (negative = none) and front plate */
  plateY: number;
  frontPlate: boolean;
  plate: AtlasRegion;
  /** dark lower rear valance [y0, y1] */
  valance: readonly [number, number];
}

function faceFeatures(spec: FaceSpec, extra?: (b: BodyBuilder) => void): (b: BodyBuilder) => void {
  return (b) => {
    const s = b.s;
    const d = b.def;
    const p = b.parts;
    // --- front face frame
    const zF = s.zNose - Math.max(d.nose.r, d.nose.rv) - 0.04;
    const cF = s.section(zF);
    const wF = cF.W;
    const yHiF = cF.ys;
    const yLoF = s.section(s.zNose - 0.04).yb;
    const fy = (t: number): number => yLoF + (yHiF - yLoF) * t;
    const fx = (t: number): number => wF * t;
    // headlights (left = +X uses channel headL, right = headR)
    const h = spec.head;
    for (const sgn of [1, -1]) {
      b.lamp(sgn > 0 ? CH.headL : CH.headR).setPart(PART.body);
      b.quadPatch(
        'front',
        p,
        [sgn * fx(h.x0), fy(h.y0)],
        [sgn * fx(h.x1), fy(h.y0 + h.rise)],
        [sgn * fx(h.x1), fy(h.y1 + h.rise)],
        [sgn * fx(h.x0), fy(h.y1)],
        { nu: 10, nv: 2, tex: h.tex, off: 0.004 },
      );
      const xm = sgn * fx((h.x0 + h.x1) / 2);
      const ym = fy((h.y0 + h.y1) / 2 + h.rise / 2);
      b.headlights.push([xm, ym, s.frontZ(Math.abs(xm), ym) + 0.02] as P3);
    }
    p.channel(CH.none);
    b.mirrored(() => {
      if (spec.drl) {
        const r = spec.drl;
        p.color(0xe8f0ff).surface(0.2, 0.2).channel(CH.drl).setPart(PART.body);
        b.rect('front', p, fx(r.x0), fy(r.y0), fx(r.x1), fy(r.y1), { nu: 8, nv: 1, off: 0.005 });
        p.channel(CH.none);
      }
      if (spec.sideIntake) {
        const r = spec.sideIntake;
        p.color(0xffffff).surface(0.7, 0.1).setPart(PART.frontBumper);
        b.rect('front', p, fx(r.x0), fy(r.y0), fx(r.x1), fy(r.y1), { nu: 6, nv: 2, tex: 'grilleHex', off: 0.004 });
      }
    });
    // intakes / grille (centre, not mirrored)
    p.color(0xffffff).surface(0.7, 0.1).channel(CH.none).setPart(PART.frontBumper);
    b.rect('front', p, -fx(spec.intake.w), fy(spec.intake.y0), fx(spec.intake.w), fy(spec.intake.y1), { nu: 14, nv: 2, tex: spec.intake.tex, off: 0.004 });
    if (spec.grille) {
      p.setPart(PART.body);
      b.rect('front', p, -fx(spec.grille.w), fy(spec.grille.y0), fx(spec.grille.w), fy(spec.grille.y1), { nu: 10, nv: 2, tex: spec.grille.tex, off: 0.004 });
    }
    if (spec.frontPlate && b.detail !== 'traffic') {
      p.color(0xffffff).surface(0.5, 0).setPart(PART.frontBumper);
      const yc = fy((spec.intake.y0 + spec.intake.y1) / 2);
      b.rect('front', p, -0.24, yc - 0.055, 0.24, yc + 0.055, { nu: 2, nv: 1, tex: spec.plate, off: 0.012 });
    }

    // --- rear face frame
    const zR = s.zTail + Math.max(d.tail.r, d.tail.rv) + 0.04;
    const cR = s.section(zR);
    const wR = cR.W;
    const yHiR = cR.ys;
    const yLoR = s.section(s.zTail + 0.04).yb;
    const ry = (t: number): number => yLoR + (yHiR - yLoR) * t;
    const rx = (t: number): number => wR * t;
    b.mirrored(() => {
      p.color(0x7a0a0a).surface(0.15, 0.3).channel(CH.tail).setPart(PART.body);
      for (const [x0, x1, y0, y1] of spec.tail) b.rect('rear', p, rx(x0), ry(y0), rx(x1), ry(y1), { nu: 8, nv: 2, tex: spec.tailTex, off: 0.004 });
      p.color(0xd8dce4).surface(0.15, 0.3).channel(CH.reverse);
      const r = spec.reverse;
      b.rect('rear', p, rx(r[0]), ry(r[2]), rx(r[1]), ry(r[3]), { nu: 2, nv: 1, off: 0.005 });
      p.channel(CH.none);
    });
    if (spec.tailBar) {
      p.color(0x7a0a0a).surface(0.15, 0.3).channel(CH.tail).setPart(PART.body);
      const inner = Math.min(...spec.tail.map((t) => t[0]));
      b.rect('rear', p, -rx(inner), ry(spec.tailBar[0]), rx(inner), ry(spec.tailBar[1]), { nu: 10, nv: 1, tex: 'tailBars', off: 0.004 });
      p.channel(CH.none);
    }
    // lower valance + plate
    b.trim(0.7, 0.1).setPart(PART.rearBumper);
    b.rect('rear', p, -rx(0.78), ry(spec.valance[0]), rx(0.78), ry(spec.valance[1]), { nu: 12, nv: 2, off: 0.003 });
    if (spec.plateY > 0) {
      p.color(0xffffff).surface(0.5, 0).setPart(PART.body);
      const yc = ry(spec.plateY);
      b.rect('rear', p, 0.25, yc - 0.058, -0.25, yc + 0.058, { nu: 2, nv: 1, tex: spec.plate, off: 0.01 });
    }
    // high-mounted brake light at the top of the rear window
    if (d.rearGlass && b.detail !== 'traffic') {
      const z = s.zOf(d.rearGlass[0]) - 0.03;
      p.color(0x7a0a0a).surface(0.2, 0.2).channel(CH.tail).setPart(PART.body);
      b.rect('top', p, -0.16, z - 0.012, 0.16, z + 0.012, { nu: 2, nv: 1, off: 0.004 });
      p.channel(CH.none);
    }
    extra?.(b);
  };
}

/** Painted hood scoop / bulge with a dark mouth (muscle). */
function hoodScoop(b: BodyBuilder, width: number, height: number, f0: number, f1: number): void {
  const s = b.s;
  const z0 = s.zOf(f0);
  const z1 = s.zOf(f1);
  const rows: P3[][] = [];
  const n = 5;
  for (let j = 0; j <= n; j++) {
    const t = j / n;
    const z = z0 + (z1 - z0) * t;
    const hh = height * Math.sin(Math.PI * Math.min(1, 0.18 + t * 0.82)) ** 0.6 * (t > 0.96 ? 0.5 : 1);
    const row: P3[] = [];
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * Math.PI;
      const x = Math.cos(a) * width * (0.8 + 0.2 * t);
      row.push([x, s.topY(z, x) - 0.004 + Math.sin(a) ** 0.7 * hh, z]);
    }
    rows.push(row);
  }
  b.paint.color(0xffffff).setPart(PART.hood);
  b.paint.grid(rows, false);
  b.parts.paint(0x030303, 0.9, 0).setPart(PART.hood);
  const r0 = rows[0];
  const cy = s.topY(z0, 0);
  for (let i = 0; i < r0.length - 1; i++) b.parts.tri([0, cy, z0 + 0.004], [r0[i][0], r0[i][1], z0 + 0.004], [r0[i + 1][0], r0[i + 1][1], z0 + 0.004]);
}

/** Dark textured panel on the top surface between two stations (louvres, vents, bed covers). */
function topPanel(b: BodyBuilder, f0: number, f1: number, w0: number, w1: number, tex: AtlasRegion | undefined, part: number = PART.body): void {
  const s = b.s;
  const z0 = s.zOf(f0);
  const z1 = s.zOf(f1);
  if (tex) b.parts.color(0xffffff).surface(0.6, 0.2);
  else b.trim(0.6, 0.1);
  b.parts.channel(CH.none).setPart(part);
  b.quadPatch('top', b.parts, [-w0, z0], [w0, z0], [w1, z1], [-w1, z1], { nu: 6, nv: 6, tex, off: 0.004 });
}

/** Dark intake on the body side ahead of the rear wheel (mid-engine cars). */
function sideIntake(b: BodyBuilder, h0: number, h1: number, len: number): void {
  const s = b.s;
  const z1 = s.axleZ[1] + s.archR + 0.1;
  const z0 = z1 + len;
  const c = s.section((z0 + z1) / 2);
  const y0 = c.yb + (c.ys - c.yb) * h0;
  const y1 = c.yb + (c.ys - c.yb) * h1;
  b.mirrored(() => {
    b.parts.color(0xffffff).surface(0.7, 0.1).channel(CH.none).setPart(PART.body);
    b.quadPatch('side', b.parts, [z0, (y0 + y1) / 2], [z1, y0], [z1, y1], [z0 - len * 0.2, y1], { nu: 5, nv: 3, tex: 'grilleHex', off: 0.004 });
  });
}

const BASE = {
  floor: [[0, 0.07], [0.08, 0.02], [0.14, 0], [0.84, 0], [0.92, 0.04], [1, 0.13]] as P2[],
  plan: [[0, 0.9], [0.12, 0.965], [0.22, 1], [0.5, 0.985], [0.78, 1], [0.9, 0.97], [1, 0.9]] as P2[],
  wsExp: 0.92,
  rwExp: 0.95,
  wsLag: 0.35,
  rwLag: 0.3,
  tuck: 0.05,
  lean: 0.012,
  inset: 0.07,
  shoulderR: 0.2,
  shoulderA: 2.6,
  pHood: 2.6,
  roofA: 2.6,
  flareFall: 0.25,
  rimRatio: 0.7,
  roofGlass: false,
  mirrorSail: 0.14,
  trunkLid: true,
  doors: 1,
  caliper: 0xc81e1e,
  seatZ: 0.95,
};

// -----------------------------------------------------------------------------
// Player body styles
// -----------------------------------------------------------------------------

const TUNER: BodyDef = {
  ...BASE,
  centre: [[0, 0.52], [0.1, 0.565], [0.22, 0.61], [0.345, 0.665], [0.8, 0.7], [0.9, 0.69], [1, 0.665]],
  shoulder: [[0, 0.5], [0.12, 0.56], [0.21, 0.6], [0.345, 0.645], [0.6, 0.665], [0.79, 0.68], [0.92, 0.67], [1, 0.645]],
  cowl: 0.345,
  roofF: 0.5,
  roofR: 0.68,
  deck: 0.8,
  roofFH: 0.965,
  roofRH: 0.955,
  roofPeak: 0.35,
  roofCrown: 0.07,
  ghW: [[0, 0.88], [0.345, 0.9], [0.6, 0.9], [0.8, 0.84], [1, 0.82]],
  tumble: 0.42,
  nose: { r: 0.5, n: 2.6, drop: 0.09, rv: 0.22 },
  tail: { r: 0.4, n: 3.2, drop: 0.05, rv: 0.14 },
  flareF: 0.01,
  flareR: 0.02,
  axleShift: 0.03,
  tyreW: [0.215, 0.235],
  sideGlassEnd: 0.72,
  pillars: [0.565],
  rearGlass: [0.69, 0.79],
  spoilerAt: 0.955,
  exhaust: { x: [0.42, -0.42], y: 0.05, radius: 0.045 },
  features: faceFeatures({
    head: { x0: 0.42, x1: 0.93, y0: 0.6, y1: 0.86, rise: 0.06, tex: 'headProjector' },
    drl: { x0: 0.45, x1: 0.9, y0: 0.52, y1: 0.56 },
    intake: { w: 0.5, y0: 0.1, y1: 0.4, tex: 'grilleHex' },
    grille: { w: 0.3, y0: 0.6, y1: 0.7, tex: 'grilleSlats' },
    sideIntake: { x0: 0.62, x1: 0.88, y0: 0.14, y1: 0.36 },
    tail: [[0.36, 0.92, 0.62, 0.86]],
    tailTex: 'tailDots',
    tailBar: null,
    reverse: [0.2, 0.34, 0.66, 0.8],
    plateY: 0.36,
    frontPlate: true,
    plate: 'plateA',
    valance: [0.02, 0.2],
  }),
};

const HATCH: BodyDef = {
  ...BASE,
  centre: [[0, 0.5], [0.1, 0.56], [0.2, 0.6], [0.3, 0.645], [0.955, 0.66], [1, 0.64]],
  shoulder: [[0, 0.47], [0.12, 0.545], [0.2, 0.575], [0.3, 0.61], [0.6, 0.63], [0.8, 0.645], [0.93, 0.64], [1, 0.6]],
  floor: [[0, 0.07], [0.08, 0.02], [0.14, 0], [0.86, 0], [0.93, 0.04], [1, 0.12]],
  cowl: 0.3,
  roofF: 0.44,
  roofR: 0.86,
  deck: 0.955,
  roofFH: 0.965,
  roofRH: 0.955,
  roofPeak: 0.3,
  roofCrown: 0.07,
  rwExp: 0.9,
  ghW: [[0, 0.88], [0.3, 0.9], [0.7, 0.9], [0.955, 0.86], [1, 0.84]],
  tumble: 0.3,
  nose: { r: 0.42, n: 2.8, drop: 0.08, rv: 0.18 },
  tail: { r: 0.3, n: 4, drop: 0.04, rv: 0.1 },
  flareF: 0.015,
  flareR: 0.02,
  axleShift: 0.05,
  tyreW: [0.205, 0.205],
  sideGlassEnd: 0.84,
  pillars: [0.57],
  rearGlass: [0.87, 0.945],
  spoilerAt: 0.868,
  trunkLid: false,
  exhaust: { x: [0.4, -0.4], y: 0.05, radius: 0.042 },
  seatZ: 0.9,
  features: faceFeatures({
    head: { x0: 0.5, x1: 0.94, y0: 0.56, y1: 0.9, rise: 0.05, tex: 'headProjector' },
    drl: null,
    intake: { w: 0.56, y0: 0.08, y1: 0.36, tex: 'grilleHex' },
    grille: { w: 0.42, y0: 0.6, y1: 0.76, tex: 'grilleHex' },
    sideIntake: { x0: 0.66, x1: 0.9, y0: 0.12, y1: 0.32 },
    tail: [[0.7, 0.96, 0.5, 1.0]],
    tailTex: 'tailBars',
    tailBar: null,
    reverse: [0.52, 0.66, 0.52, 0.66],
    plateY: 0.56,
    frontPlate: true,
    plate: 'plateB',
    valance: [0.02, 0.22],
  }),
};

const MUSCLE: BodyDef = {
  ...BASE,
  centre: [[0, 0.56], [0.1, 0.61], [0.25, 0.645], [0.4, 0.665], [0.835, 0.7], [0.93, 0.69], [1, 0.66]],
  shoulder: [[0, 0.54], [0.1, 0.59], [0.2, 0.615], [0.4, 0.635], [0.6, 0.64], [0.775, 0.7], [0.9, 0.69], [1, 0.655]],
  plan: [[0, 0.93], [0.1, 0.975], [0.2, 1], [0.5, 0.965], [0.775, 1], [0.9, 0.98], [1, 0.93]],
  cowl: 0.4,
  roofF: 0.535,
  roofR: 0.7,
  deck: 0.835,
  roofFH: 0.96,
  roofRH: 0.94,
  roofPeak: 0.3,
  roofCrown: 0.065,
  wsExp: 0.95,
  rwExp: 0.85,
  ghW: [[0, 0.88], [0.4, 0.88], [0.6, 0.88], [0.835, 0.8], [1, 0.8]],
  tumble: 0.4,
  nose: { r: 0.34, n: 4.2, drop: 0.05, rv: 0.12 },
  tail: { r: 0.32, n: 4.5, drop: 0.04, rv: 0.1 },
  inset: 0.06,
  shoulderR: 0.16,
  shoulderA: 3.6,
  flareF: 0.015,
  flareR: 0.035,
  flareFall: 0.4,
  axleShift: 0.06,
  tyreW: [0.245, 0.295],
  sideGlassEnd: 0.73,
  pillars: [0.6],
  rearGlass: [0.715, 0.82],
  spoilerAt: 0.955,
  exhaust: { x: [0.56, -0.56], y: 0.05, radius: 0.055 },
  caliper: 0xd8d8d8,
  features: faceFeatures(
    {
      head: { x0: 0.6, x1: 0.92, y0: 0.56, y1: 0.86, rise: 0, tex: 'headProjector' },
      drl: null,
      intake: { w: 0.62, y0: 0.08, y1: 0.3, tex: 'grilleSlats' },
      grille: { w: 0.56, y0: 0.52, y1: 0.86, tex: 'grilleHex' },
      sideIntake: null,
      tail: [[0.34, 0.46, 0.56, 0.9], [0.52, 0.64, 0.56, 0.9], [0.7, 0.82, 0.56, 0.9]],
      tailTex: 'tailBars',
      tailBar: null,
      reverse: [0.2, 0.3, 0.6, 0.74],
      plateY: 0.36,
      frontPlate: true,
      plate: 'plateC',
      valance: [0.02, 0.18],
    },
    (b) => hoodScoop(b, 0.26, 0.07, 0.13, 0.33),
  ),
};

const COUPE: BodyDef = {
  ...BASE,
  centre: [[0, 0.5], [0.1, 0.555], [0.22, 0.6], [0.37, 0.655], [0.9, 0.7], [1, 0.675]],
  shoulder: [[0, 0.48], [0.1, 0.54], [0.19, 0.59], [0.37, 0.635], [0.6, 0.655], [0.777, 0.69], [0.9, 0.69], [1, 0.65]],
  plan: [[0, 0.88], [0.12, 0.96], [0.2, 1], [0.5, 0.97], [0.777, 1], [0.9, 0.96], [1, 0.88]],
  cowl: 0.37,
  roofF: 0.51,
  roofR: 0.66,
  deck: 0.9,
  roofFH: 0.965,
  roofRH: 0.93,
  roofPeak: 0.25,
  roofCrown: 0.07,
  wsExp: 0.9,
  rwExp: 0.8,
  ghW: [[0, 0.86], [0.37, 0.89], [0.6, 0.88], [0.9, 0.74], [1, 0.72]],
  tumble: 0.44,
  nose: { r: 0.5, n: 2.7, drop: 0.09, rv: 0.24 },
  tail: { r: 0.42, n: 3, drop: 0.06, rv: 0.16 },
  inset: 0.075,
  shoulderR: 0.22,
  shoulderA: 2.5,
  flareF: 0.01,
  flareR: 0.025,
  axleShift: 0.08,
  tyreW: [0.245, 0.275],
  sideGlassEnd: 0.76,
  pillars: [0.585],
  rearGlass: [0.675, 0.87],
  spoilerAt: 0.945,
  trunkLid: false,
  exhaust: { x: [0.4, -0.4], y: 0.05, radius: 0.05 },
  caliper: 0xd9a300,
  features: faceFeatures({
    head: { x0: 0.4, x1: 0.94, y0: 0.66, y1: 0.84, rise: 0.08, tex: 'headLed' },
    drl: { x0: 0.42, x1: 0.92, y0: 0.6, y1: 0.63 },
    intake: { w: 0.44, y0: 0.08, y1: 0.34, tex: 'grilleHex' },
    grille: { w: 0.3, y0: 0.44, y1: 0.7, tex: 'grilleSlats' },
    sideIntake: { x0: 0.56, x1: 0.9, y0: 0.1, y1: 0.34 },
    tail: [[0.3, 0.95, 0.7, 0.82]],
    tailTex: 'tailBars',
    tailBar: [0.74, 0.78],
    reverse: [0.3, 0.44, 0.56, 0.64],
    plateY: 0.4,
    frontPlate: true,
    plate: 'plateA',
    valance: [0.02, 0.22],
  }),
};

const GT: BodyDef = {
  ...BASE,
  centre: [[0, 0.56], [0.1, 0.61], [0.22, 0.645], [0.355, 0.685], [0.82, 0.72], [0.92, 0.715], [1, 0.69]],
  shoulder: [[0, 0.54], [0.1, 0.6], [0.2, 0.63], [0.355, 0.66], [0.6, 0.67], [0.784, 0.7], [0.92, 0.7], [1, 0.675]],
  cowl: 0.355,
  roofF: 0.49,
  roofR: 0.68,
  deck: 0.82,
  roofFH: 0.96,
  roofRH: 0.95,
  roofPeak: 0.35,
  roofCrown: 0.06,
  wsExp: 0.95,
  rwExp: 0.9,
  ghW: [[0, 0.88], [0.355, 0.9], [0.6, 0.9], [0.82, 0.84], [1, 0.84]],
  tumble: 0.36,
  nose: { r: 0.36, n: 3.6, drop: 0.06, rv: 0.14 },
  tail: { r: 0.3, n: 4.6, drop: 0.03, rv: 0.09 },
  tuck: 0.04,
  inset: 0.05,
  shoulderR: 0.15,
  shoulderA: 4.5,
  flareF: 0.03,
  flareR: 0.04,
  flareFall: 0.13,
  axleShift: 0.04,
  tyreW: [0.275, 0.285],
  sideGlassEnd: 0.735,
  pillars: [0.585],
  rearGlass: [0.69, 0.81],
  spoilerAt: 0.955,
  exhaust: { x: [0.5, -0.5], y: 0.06, radius: 0.06 },
  caliper: 0xd98a00,
  features: faceFeatures(
    {
      head: { x0: 0.54, x1: 0.95, y0: 0.5, y1: 0.88, rise: 0.04, tex: 'headLed' },
      drl: null,
      intake: { w: 0.5, y0: 0.06, y1: 0.5, tex: 'grilleHex' },
      grille: null,
      sideIntake: { x0: 0.6, x1: 0.92, y0: 0.08, y1: 0.36 },
      tail: [[0.3, 0.58, 0.52, 0.9], [0.64, 0.92, 0.52, 0.9]],
      tailTex: 'tailDots',
      tailBar: null,
      reverse: [0.16, 0.26, 0.6, 0.74],
      plateY: 0.34,
      frontPlate: true,
      plate: 'plateB',
      valance: [0.02, 0.22],
    },
    (b) => {
      // hood heat extractors
      b.mirrored(() => {
        const s = b.s;
        const z0 = s.zOf(0.2);
        const z1 = s.zOf(0.29);
        b.parts.color(0xffffff).surface(0.6, 0.2).channel(CH.none).setPart(PART.hood);
        b.quadPatch('top', b.parts, [0.2, z0], [0.42, z0], [0.46, z1], [0.22, z1], { nu: 3, nv: 3, tex: 'louvres', off: 0.004 });
      });
    },
  ),
};

const EXOTIC: BodyDef = {
  ...BASE,
  centre: [[0, 0.4], [0.08, 0.47], [0.18, 0.535], [0.27, 0.6], [0.92, 0.72], [1, 0.7]],
  shoulder: [[0, 0.38], [0.1, 0.5], [0.22, 0.66], [0.33, 0.63], [0.5, 0.62], [0.7, 0.7], [0.805, 0.74], [0.92, 0.73], [1, 0.7]],
  floor: [[0, 0.05], [0.1, 0], [0.8, 0], [0.9, 0.05], [1, 0.16]],
  plan: [[0, 0.84], [0.12, 0.94], [0.22, 1], [0.45, 0.94], [0.7, 0.99], [0.8, 1], [1, 0.95]],
  cowl: 0.27,
  roofF: 0.44,
  roofR: 0.56,
  deck: 0.92,
  roofFH: 0.97,
  roofRH: 0.96,
  roofPeak: 0.4,
  roofCrown: 0.06,
  wsExp: 0.95,
  rwExp: 0.75,
  rwLag: 0.2,
  ghW: [[0, 0.8], [0.27, 0.82], [0.5, 0.78], [0.92, 0.66], [1, 0.66]],
  tumble: 0.5,
  nose: { r: 0.55, n: 2.4, drop: 0.08, rv: 0.2 },
  tail: { r: 0.3, n: 4.2, drop: 0.03, rv: 0.1 },
  tuck: 0.07,
  inset: 0.09,
  shoulderR: 0.25,
  flareF: 0.01,
  flareR: 0.03,
  flareFall: 0.3,
  axleShift: -0.06,
  tyreW: [0.255, 0.325],
  rimRatio: 0.74,
  sideGlassEnd: 0.57,
  pillars: [],
  rearGlass: [0.565, 0.62],
  mirrorSail: 0.2,
  spoilerAt: 0.96,
  trunkLid: false,
  exhaust: { x: [0.16, -0.16], y: 0.3, radius: 0.05 },
  caliper: 0xe6c200,
  seatZ: 0.9,
  features: faceFeatures(
    {
      head: { x0: 0.5, x1: 0.9, y0: 0.72, y1: 0.98, rise: 0.22, tex: 'headLed' },
      drl: null,
      intake: { w: 0.34, y0: 0.1, y1: 0.42, tex: 'grilleHex' },
      grille: null,
      sideIntake: { x0: 0.46, x1: 0.9, y0: 0.1, y1: 0.46 },
      tail: [[0.4, 0.94, 0.74, 0.84]],
      tailTex: 'tailBars',
      tailBar: null,
      reverse: [0.3, 0.38, 0.74, 0.84],
      plateY: 0.44,
      frontPlate: false,
      plate: 'plateC',
      valance: [0.02, 0.36],
    },
    (b) => {
      sideIntake(b, 0.42, 0.86, 0.5);
      topPanel(b, 0.66, 0.88, 0.34, 0.5, 'louvres');
      // rear mesh panel between the lamps
      b.parts.color(0xffffff).surface(0.7, 0.1).setPart(PART.body);
      const s = b.s;
      const c = s.section(s.zTail + 0.15);
      b.rect('rear', b.parts, -c.W * 0.36, c.yb + (c.ys - c.yb) * 0.56, c.W * 0.36, c.yb + (c.ys - c.yb) * 0.86, { nu: 8, nv: 2, tex: 'grilleHex', off: 0.004 });
    },
  ),
};

const HYPER: BodyDef = {
  ...BASE,
  centre: [[0, 0.36], [0.08, 0.44], [0.18, 0.51], [0.26, 0.575], [0.86, 0.66], [1, 0.62]],
  shoulder: [[0, 0.36], [0.1, 0.5], [0.215, 0.7], [0.33, 0.62], [0.5, 0.6], [0.7, 0.7], [0.79, 0.75], [0.9, 0.72], [1, 0.66]],
  floor: [[0, 0.05], [0.1, 0], [0.72, 0], [0.86, 0.08], [1, 0.26]],
  plan: [[0, 0.82], [0.12, 0.93], [0.215, 1], [0.45, 0.9], [0.7, 0.98], [0.79, 1], [1, 0.96]],
  cowl: 0.26,
  roofF: 0.42,
  roofR: 0.52,
  deck: 0.86,
  roofFH: 0.975,
  roofRH: 0.95,
  roofPeak: 0.35,
  roofCrown: 0.09,
  roofA: 2.2,
  wsExp: 0.95,
  rwExp: 0.8,
  rwLag: 0.15,
  ghW: [[0, 0.74], [0.26, 0.76], [0.45, 0.7], [0.86, 0.4], [1, 0.4]],
  tumble: 0.62,
  nose: { r: 0.6, n: 2.3, drop: 0.07, rv: 0.22 },
  tail: { r: 0.26, n: 5, drop: 0.02, rv: 0.08 },
  tuck: 0.08,
  inset: 0.1,
  shoulderR: 0.28,
  flareF: 0.01,
  flareR: 0.03,
  flareFall: 0.32,
  axleShift: -0.02,
  tyreW: [0.265, 0.335],
  rimRatio: 0.75,
  roofGlass: true,
  sideGlassEnd: 0.54,
  pillars: [],
  rearGlass: [0.52, 0.62],
  mirrorSail: 0.22,
  spoilerAt: 0.965,
  trunkLid: false,
  exhaust: { x: [0.09, -0.09], y: 0.42, radius: 0.055 },
  caliper: 0x7a1fff,
  seatZ: 0.88,
  features: faceFeatures(
    {
      head: { x0: 0.56, x1: 0.86, y0: 0.8, y1: 0.92, rise: 0.3, tex: 'headLed' },
      drl: { x0: 0.5, x1: 0.84, y0: 0.6, y1: 0.63 },
      intake: { w: 0.3, y0: 0.1, y1: 0.46, tex: 'grilleHex' },
      grille: null,
      sideIntake: { x0: 0.42, x1: 0.9, y0: 0.08, y1: 0.5 },
      tail: [[0.3, 0.96, 0.84, 0.9]],
      tailTex: 'tailBars',
      tailBar: [0.84, 0.9],
      reverse: [0.3, 0.38, 0.72, 0.78],
      plateY: -1,
      frontPlate: false,
      plate: 'plateA',
      valance: [0.02, 0.7],
    },
    (b) => {
      sideIntake(b, 0.36, 0.9, 0.62);
      // aero channels between the fenders and the canopy
      const s = b.s;
      b.mirrored(() => {
        b.trim(0.5, 0.2).setPart(PART.body);
        const z0 = s.zOf(0.6);
        const z1 = s.zOf(0.9);
        const w0 = s.section(z0).xs;
        const w1 = s.section(z1).xs;
        b.quadPatch('top', b.parts, [w0 * 0.5, z0], [w0 * 0.78, z0], [w1 * 0.8, z1], [w1 * 0.4, z1], { nu: 3, nv: 6, off: 0.004 });
      });
      topPanel(b, 0.66, 0.84, 0.16, 0.2, 'louvres');
      // big diffuser strakes
      b.trim(0.4, 0.3).setPart(PART.rearBumper);
      const yT = s.section(s.zTail + 0.1).yb;
      for (let i = 0; i < 5; i++) {
        const x = (i / 4 - 0.5) * s.halfW * 1.1;
        const zr = s.zTail + 0.01;
        b.parts.box(x, yT - 0.02, zr + 0.3, 0.014, 0.16, 0.6);
      }
    },
  ),
};

export const BODY_DEFS: Record<BodyStyle, BodyDef> = {
  tuner: TUNER,
  hatch: HATCH,
  muscle: MUSCLE,
  coupe: COUPE,
  gt: GT,
  exotic: EXOTIC,
  hyper: HYPER,
};

// -----------------------------------------------------------------------------
// Police
// -----------------------------------------------------------------------------

const SEDAN_FACE: FaceSpec = {
  head: { x0: 0.5, x1: 0.94, y0: 0.6, y1: 0.86, rise: 0.03, tex: 'headProjector' },
  drl: null,
  intake: { w: 0.5, y0: 0.08, y1: 0.3, tex: 'grilleSlats' },
  grille: { w: 0.44, y0: 0.56, y1: 0.82, tex: 'grilleHex' },
  sideIntake: null,
  tail: [[0.44, 0.95, 0.6, 0.86]],
  tailTex: 'tailBars',
  tailBar: null,
  reverse: [0.3, 0.42, 0.64, 0.8],
  plateY: 0.4,
  frontPlate: true,
  plate: 'platePolice',
  valance: [0.02, 0.18],
};

const SEDAN: BodyDef = {
  ...BASE,
  centre: [[0, 0.5], [0.1, 0.56], [0.2, 0.6], [0.3, 0.64], [0.79, 0.665], [0.9, 0.66], [1, 0.63]],
  shoulder: [[0, 0.48], [0.1, 0.545], [0.19, 0.58], [0.3, 0.61], [0.6, 0.625], [0.8, 0.64], [0.92, 0.635], [1, 0.6]],
  cowl: 0.3,
  roofF: 0.43,
  roofR: 0.67,
  deck: 0.79,
  roofFH: 0.965,
  roofRH: 0.955,
  roofPeak: 0.35,
  roofCrown: 0.07,
  ghW: [[0, 0.88], [0.3, 0.9], [0.6, 0.9], [0.79, 0.86], [1, 0.84]],
  tumble: 0.32,
  nose: { r: 0.42, n: 3, drop: 0.07, rv: 0.18 },
  tail: { r: 0.36, n: 3.6, drop: 0.05, rv: 0.13 },
  flareF: 0.01,
  flareR: 0.01,
  axleShift: 0.06,
  tyreW: [0.235, 0.235],
  rimRatio: 0.66,
  sideGlassEnd: 0.7,
  pillars: [0.53],
  rearGlass: [0.68, 0.78],
  spoilerAt: 0.955,
  doors: 2,
  exhaust: { x: [0.45, -0.45], y: 0.05, radius: 0.045 },
  features: faceFeatures(SEDAN_FACE),
};

export const POLICE_DEFS: Record<PoliceKind, BodyDef> = {
  patrol: SEDAN,
  interceptor: {
    ...COUPE,
    features: faceFeatures({
      head: { x0: 0.42, x1: 0.94, y0: 0.64, y1: 0.84, rise: 0.08, tex: 'headLed' },
      drl: null,
      intake: { w: 0.5, y0: 0.08, y1: 0.4, tex: 'grilleHex' },
      grille: null,
      sideIntake: { x0: 0.6, x1: 0.9, y0: 0.1, y1: 0.34 },
      tail: [[0.3, 0.95, 0.7, 0.82]],
      tailTex: 'tailBars',
      tailBar: [0.74, 0.78],
      reverse: [0.3, 0.44, 0.56, 0.64],
      plateY: 0.4,
      frontPlate: true,
      plate: 'platePolice',
      valance: [0.02, 0.22],
    }),
  },
  suv: {
    ...SEDAN,
    centre: [[0, 0.5], [0.08, 0.56], [0.18, 0.59], [0.27, 0.61], [0.97, 0.62], [1, 0.6]],
    shoulder: [[0, 0.48], [0.1, 0.55], [0.18, 0.575], [0.27, 0.59], [0.6, 0.6], [0.85, 0.605], [1, 0.58]],
    floor: [[0, 0.12], [0.08, 0.03], [0.14, 0], [0.86, 0], [0.93, 0.05], [1, 0.16]],
    cowl: 0.27,
    roofF: 0.37,
    roofR: 0.9,
    deck: 0.975,
    roofFH: 0.97,
    roofRH: 0.97,
    roofPeak: 0.3,
    roofCrown: 0.06,
    rwExp: 0.9,
    ghW: [[0, 0.9], [0.27, 0.92], [0.7, 0.92], [1, 0.9]],
    tumble: 0.2,
    nose: { r: 0.36, n: 3.8, drop: 0.05, rv: 0.14 },
    tail: { r: 0.3, n: 4.5, drop: 0.03, rv: 0.1 },
    inset: 0.05,
    shoulderR: 0.14,
    shoulderA: 3.6,
    flareF: 0.03,
    flareR: 0.03,
    flareFall: 0.14,
    axleShift: 0.1,
    tyreW: [0.275, 0.275],
    rimRatio: 0.62,
    sideGlassEnd: 0.88,
    pillars: [0.5, 0.72],
    rearGlass: [0.905, 0.965],
    trunkLid: false,
    doors: 2,
    features: faceFeatures({
      ...SEDAN_FACE,
      head: { x0: 0.56, x1: 0.95, y0: 0.62, y1: 0.86, rise: 0, tex: 'headProjector' },
      grille: { w: 0.5, y0: 0.5, y1: 0.86, tex: 'grilleSlats' },
      tail: [[0.72, 0.96, 0.52, 1.0]],
      plateY: 0.5,
    }),
  },
};

// -----------------------------------------------------------------------------
// Traffic
// -----------------------------------------------------------------------------

const TRAFFIC_FACE: FaceSpec = { ...SEDAN_FACE, frontPlate: false, plate: 'plateB', grille: { w: 0.4, y0: 0.56, y1: 0.8, tex: 'grilleSlats' } };

const BOX_BASE = {
  ...SEDAN,
  floor: [[0, 0.12], [0.06, 0.02], [0.12, 0], [0.9, 0], [1, 0.08]] as P2[],
  plan: [[0, 0.96], [0.1, 1], [0.9, 1], [1, 0.97]] as P2[],
  inset: 0.04,
  shoulderR: 0.1,
  shoulderA: 4,
  tumble: 0.1,
  roofCrown: 0.05,
  roofA: 4,
  flareF: 0,
  flareR: 0,
  trunkLid: false,
};

export const TRAFFIC_DEFS: Record<TrafficKind, BodyDef> = {
  sedan: { ...SEDAN, features: faceFeatures(TRAFFIC_FACE) },
  taxi: { ...SEDAN, features: faceFeatures(TRAFFIC_FACE) },
  hatch: { ...HATCH, features: faceFeatures({ ...TRAFFIC_FACE, tail: [[0.7, 0.96, 0.5, 0.98]], plateY: 0.54 }) },
  pickup: {
    ...BOX_BASE,
    centre: [[0, 0.5], [0.1, 0.56], [0.22, 0.585], [0.28, 0.6], [0.56, 0.6], [1, 0.58]],
    shoulder: [[0, 0.48], [0.1, 0.55], [0.28, 0.58], [0.56, 0.58], [1, 0.57]],
    cowl: 0.28,
    roofF: 0.37,
    roofR: 0.52,
    deck: 0.56,
    roofFH: 0.97,
    roofRH: 0.97,
    roofPeak: 0.5,
    rwExp: 1,
    ghW: [[0, 0.9], [1, 0.9]],
    nose: { r: 0.3, n: 4, drop: 0.05, rv: 0.12 },
    tail: { r: 0.14, n: 6, drop: 0.01, rv: 0.05 },
    sideGlassEnd: 0.52,
    pillars: [],
    rearGlass: [0.525, 0.555],
    tyreW: [0.27, 0.27],
    features: faceFeatures({ ...TRAFFIC_FACE, tail: [[0.84, 0.97, 0.4, 0.9]], plateY: 0.3 }, (b) => topPanel(b, 0.6, 0.97, b.s.halfW * 0.8, b.s.halfW * 0.8, undefined)),
  },
  van: {
    ...BOX_BASE,
    centre: [[0, 0.38], [0.06, 0.45], [0.14, 0.5], [1, 0.5]],
    shoulder: [[0, 0.38], [0.08, 0.46], [0.14, 0.5], [1, 0.5]],
    cowl: 0.14,
    roofF: 0.26,
    roofR: 0.965,
    deck: 0.985,
    roofFH: 0.96,
    roofRH: 0.99,
    roofPeak: 0.4,
    ghW: [[0, 0.94], [1, 0.94]],
    nose: { r: 0.3, n: 3.6, drop: 0.04, rv: 0.12 },
    tail: { r: 0.12, n: 6, drop: 0.01, rv: 0.04 },
    sideGlassEnd: 0.36,
    pillars: [],
    rearGlass: null,
    tyreW: [0.24, 0.24],
    features: faceFeatures({ ...TRAFFIC_FACE, head: { x0: 0.56, x1: 0.94, y0: 0.5, y1: 0.86, rise: 0, tex: 'headProjector' }, grille: null, tail: [[0.84, 0.97, 0.3, 0.8]], plateY: 0.24 }),
  },
  truck: {
    ...BOX_BASE,
    centre: [[0, 0.42], [0.04, 0.5], [1, 0.5]],
    shoulder: [[0, 0.42], [0.04, 0.5], [1, 0.5]],
    floor: [[0, 0.1], [0.05, 0], [1, 0]],
    cowl: 0.04,
    roofF: 0.1,
    roofR: 0.9,
    deck: 0.97,
    roofFH: 0.98,
    roofRH: 0.99,
    roofPeak: 0.5,
    wsExp: 0.8,
    ghW: [[0, 0.95], [1, 0.95]],
    nose: { r: 0.22, n: 4.5, drop: 0.03, rv: 0.1 },
    tail: { r: 0.1, n: 6, drop: 0.01, rv: 0.04 },
    sideGlassEnd: 0.2,
    mirrorSail: 0.1,
    pillars: [],
    rearGlass: null,
    tyreW: [0.3, 0.3],
    features: faceFeatures({ ...TRAFFIC_FACE, head: { x0: 0.6, x1: 0.94, y0: 0.42, y1: 0.7, rise: 0, tex: 'headProjector' }, grille: { w: 0.5, y0: 0.5, y1: 0.95, tex: 'grilleSlats' }, tail: [[0.8, 0.96, 0.3, 0.6]], plateY: -1 }),
  },
  bus: {
    ...BOX_BASE,
    centre: [[0, 0.36], [0.03, 0.42], [1, 0.42]],
    shoulder: [[0, 0.36], [0.03, 0.42], [1, 0.42]],
    floor: [[0, 0.08], [0.04, 0], [1, 0]],
    cowl: 0.03,
    roofF: 0.09,
    roofR: 0.985,
    deck: 0.995,
    roofFH: 0.97,
    roofRH: 0.99,
    roofPeak: 0.5,
    wsExp: 0.7,
    ghW: [[0, 0.95], [1, 0.95]],
    tumble: 0.05,
    nose: { r: 0.3, n: 4, drop: 0.02, rv: 0.1 },
    tail: { r: 0.2, n: 5, drop: 0.01, rv: 0.06 },
    sideGlassEnd: 0.95,
    mirrorSail: 0.1,
    pillars: [0.14, 0.26, 0.38, 0.5, 0.62, 0.74, 0.86],
    rearGlass: null,
    tyreW: [0.3, 0.3],
    features: faceFeatures({ ...TRAFFIC_FACE, head: { x0: 0.6, x1: 0.94, y0: 0.3, y1: 0.6, rise: 0, tex: 'headProjector' }, grille: null, tail: [[0.8, 0.96, 0.3, 0.75]], plateY: 0.3 }),
  },
};

/** Synthesised wheel geometry for traffic bodies (TRAFFIC_DIMS only has the envelope). */
export function trafficDims(kind: TrafficKind, length: number, width: number, height: number): CarDimensions {
  const big = kind === 'truck' || kind === 'bus';
  const tall = kind === 'van' || kind === 'pickup';
  return {
    length,
    width,
    height,
    wheelbase: kind === 'bus' ? length * 0.56 : length * 0.6,
    track: width * 0.86,
    wheelRadius: big ? 0.5 : tall ? 0.37 : 0.32,
    rideHeight: big ? 0.42 : tall ? 0.24 : 0.17,
  };
}
