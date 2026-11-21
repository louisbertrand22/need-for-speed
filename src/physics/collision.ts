/* =============================================================================
 * APEX NOCTURNE — collision geometry + dynamic body resolvers.
 * Every car is approximated by 3 circles along its axis (a capsule). Static
 * boxes follow the StaticCollider convention: local +Z -> (sin rot, cos rot),
 * local +X -> (cos rot, -sin rot).
 * ===========================================================================*/
import type { CollisionResult, IVehicle, KinematicBody, VehicleConfig } from '../core/types';

/** circle radius = factor x car width */
export const BODY_CIRCLE_FACTOR = 0.48;
export const RESTITUTION = 0.2;
const PAIR_FRICTION = 0.28;
const MAX_VERTICAL_GAP = 1.5;

/** Yaw moment of inertia used by the physics and by the resolvers (kg·m²). */
export function yawInertia(c: VehicleConfig): number {
  const a = c.wheelbase * (1 - c.frontWeight);
  const b = c.wheelbase * c.frontWeight;
  return c.mass * a * b;
}

export function bodyCircleRadius(c: VehicleConfig): number {
  return c.width * BODY_CIRCLE_FACTOR;
}

/** distance of the front / rear circle centres from the car centre */
export function bodyCircleOffset(c: VehicleConfig): number {
  return Math.max(0, c.length * 0.5 - c.width * BODY_CIRCLE_FACTOR);
}

/** Scratch output of the narrow-phase tests: unit normal pointing from the obstacle toward the circle. */
export const contactNormal = { x: 0, z: 0 };

/** Returns the penetration depth (> 0 when overlapping) and writes `contactNormal`. */
export function circleVsCircle(cx: number, cz: number, r: number, ox: number, oz: number, or: number): number {
  const dx = cx - ox;
  const dz = cz - oz;
  const rr = r + or;
  const d2 = dx * dx + dz * dz;
  if (d2 >= rr * rr) return 0;
  const d = Math.sqrt(d2);
  if (d > 1e-6) {
    contactNormal.x = dx / d;
    contactNormal.z = dz / d;
  } else {
    contactNormal.x = 1;
    contactNormal.z = 0;
  }
  return rr - d;
}

/**
 * Circle against an oriented box (centre bx/bz, half extents hx/hz along its local X/Z,
 * sinR/cosR = sin/cos of the box yaw). Returns the penetration depth and writes `contactNormal`.
 */
export function circleVsBox(
  cx: number,
  cz: number,
  r: number,
  bx: number,
  bz: number,
  hx: number,
  hz: number,
  sinR: number,
  cosR: number,
): number {
  const dx = cx - bx;
  const dz = cz - bz;
  const lx = dx * cosR - dz * sinR;
  const lz = dx * sinR + dz * cosR;
  const qx = lx < -hx ? -hx : lx > hx ? hx : lx;
  const qz = lz < -hz ? -hz : lz > hz ? hz : lz;
  const ex = lx - qx;
  const ez = lz - qz;
  const e2 = ex * ex + ez * ez;
  if (e2 >= r * r) return 0;
  let nlx: number;
  let nlz: number;
  let depth: number;
  if (e2 > 1e-10) {
    const e = Math.sqrt(e2);
    nlx = ex / e;
    nlz = ez / e;
    depth = r - e;
  } else {
    // centre inside the box: leave through the nearest face
    const px = hx - Math.abs(lx);
    const pz = hz - Math.abs(lz);
    if (px < pz) {
      nlx = lx < 0 ? -1 : 1;
      nlz = 0;
      depth = r + px;
    } else {
      nlx = 0;
      nlz = lz < 0 ? -1 : 1;
      depth = r + pz;
    }
  }
  contactNormal.x = nlx * cosR + nlz * sinR;
  contactNormal.z = -nlx * sinR + nlz * cosR;
  return depth;
}

function damageFor(closing: number, otherMassShare: number): number {
  return closing > 2.5 ? 0.0045 * (closing - 2.5) * (0.5 + otherMassShare) : 0;
}

/**
 * Vehicle against vehicle. Separates the two cars (inverse-mass weighted), exchanges an impulse
 * with linear + yaw inertia (restitution 0.2, light friction), pushes an `impact` event on both
 * and adds damage. Returns null when the capsules do not overlap.
 */
export function resolveVehiclePair(a: IVehicle, b: IVehicle): CollisionResult | null {
  const sa = a.state;
  const sb = b.state;
  if (Math.abs(sa.y - sb.y) > MAX_VERTICAL_GAP) return null;
  const ca = a.config;
  const cb = b.config;
  const dx0 = sa.x - sb.x;
  const dz0 = sa.z - sb.z;
  const reach = (ca.length + cb.length) * 0.5;
  if (dx0 * dx0 + dz0 * dz0 > reach * reach) return null;

  const ra = bodyCircleRadius(ca);
  const rb = bodyCircleRadius(cb);
  const offA = bodyCircleOffset(ca);
  const offB = bodyCircleOffset(cb);
  const fax = Math.sin(sa.heading);
  const faz = Math.cos(sa.heading);
  const fbx = Math.sin(sb.heading);
  const fbz = Math.cos(sb.heading);

  let best = 0;
  let nx = 0;
  let nz = 0;
  let px = 0;
  let pz = 0;
  for (let i = -1; i <= 1; i++) {
    const ax = sa.x + fax * offA * i;
    const az = sa.z + faz * offA * i;
    for (let j = -1; j <= 1; j++) {
      const bx = sb.x + fbx * offB * j;
      const bz = sb.z + fbz * offB * j;
      const depth = circleVsCircle(ax, az, ra, bx, bz, rb);
      if (depth > best) {
        best = depth;
        nx = contactNormal.x;
        nz = contactNormal.z;
        // middle of the overlap region
        px = bx + nx * (rb - depth * 0.5);
        pz = bz + nz * (rb - depth * 0.5);
      }
    }
  }
  if (best <= 0) return null;

  const ma = ca.mass;
  const mb = cb.mass;
  const shareA = mb / (ma + mb);
  const shareB = ma / (ma + mb);
  sa.x += nx * best * shareA;
  sa.z += nz * best * shareA;
  sb.x -= nx * best * shareB;
  sb.z -= nz * best * shareB;

  const rax = px - sa.x;
  const raz = pz - sa.z;
  const rbx = px - sb.x;
  const rbz = pz - sb.z;
  // velocity of the contact point on each body (omega about +Y: v = (w·rz, -w·rx))
  const rvx = sa.vx + sa.yawRate * raz - (sb.vx + sb.yawRate * rbz);
  const rvz = sa.vz - sa.yawRate * rax - (sb.vz - sb.yawRate * rbx);
  const vn = rvx * nx + rvz * nz;
  const closing = vn < 0 ? -vn : 0;
  const y = Math.max(sa.y, sb.y) + 0.45;

  if (closing > 0) {
    const ia = yawInertia(ca);
    const ib = yawInertia(cb);
    const armA = raz * nx - rax * nz;
    const armB = rbz * nx - rbx * nz;
    const j = ((1 + RESTITUTION) * closing) / (1 / ma + 1 / mb + (armA * armA) / ia + (armB * armB) / ib);
    // tangential friction (Coulomb, clamped)
    const tx = -nz;
    const tz = nx;
    const vt = rvx * tx + rvz * tz;
    const armAt = raz * tx - rax * tz;
    const armBt = rbz * tx - rbx * tz;
    let jt = -vt / (1 / ma + 1 / mb + (armAt * armAt) / ia + (armBt * armBt) / ib);
    const jtMax = PAIR_FRICTION * j;
    if (jt > jtMax) jt = jtMax;
    else if (jt < -jtMax) jt = -jtMax;
    const jx = j * nx + jt * tx;
    const jz = j * nz + jt * tz;
    a.applyImpulse(jx, jz, px, pz);
    b.applyImpulse(-jx, -jz, px, pz);
    if (closing > 1) {
      a.events.push({ type: 'impact', x: px, y, z: pz, nx, nz, intensity: closing, collider: null });
      b.events.push({ type: 'impact', x: px, y, z: pz, nx: -nx, nz: -nz, intensity: closing, collider: null });
      sa.damage = Math.min(1, sa.damage + damageFor(closing, shareA));
      sb.damage = Math.min(1, sb.damage + damageFor(closing, shareB));
    }
  }
  return { x: px, y, z: pz, nx, nz, intensity: closing };
}

/**
 * Vehicle against a kinematic rigid body (traffic). The body is an oriented box; its
 * x / z / vx / vz / yawRate are mutated. Normal of the result points from the body toward the vehicle.
 */
export function resolveVehicleVsBody(v: IVehicle, body: KinematicBody): CollisionResult | null {
  const s = v.state;
  const c = v.config;
  const bodyY = (body as { y?: unknown }).y;
  if (typeof bodyY === 'number' && Math.abs(s.y - bodyY) > MAX_VERTICAL_GAP) return null;
  const dx0 = s.x - body.x;
  const dz0 = s.z - body.z;
  const r = bodyCircleRadius(c);
  const reach = c.length * 0.5 + Math.sqrt(body.halfLength * body.halfLength + body.halfWidth * body.halfWidth) + 0.1;
  if (dx0 * dx0 + dz0 * dz0 > reach * reach) return null;

  const off = bodyCircleOffset(c);
  const fx = Math.sin(s.heading);
  const fz = Math.cos(s.heading);
  const sinB = Math.sin(body.heading);
  const cosB = Math.cos(body.heading);
  let best = 0;
  let nx = 0;
  let nz = 0;
  let px = 0;
  let pz = 0;
  for (let i = -1; i <= 1; i++) {
    const cx = s.x + fx * off * i;
    const cz = s.z + fz * off * i;
    const depth = circleVsBox(cx, cz, r, body.x, body.z, body.halfWidth, body.halfLength, sinB, cosB);
    if (depth > best) {
      best = depth;
      nx = contactNormal.x;
      nz = contactNormal.z;
      px = cx - nx * (r - depth * 0.5);
      pz = cz - nz * (r - depth * 0.5);
    }
  }
  if (best <= 0) return null;

  const ma = c.mass;
  const mb = Math.max(1, body.mass);
  const shareA = mb / (ma + mb);
  const shareB = ma / (ma + mb);
  s.x += nx * best * shareA;
  s.z += nz * best * shareA;
  body.x -= nx * best * shareB;
  body.z -= nz * best * shareB;

  const rax = px - s.x;
  const raz = pz - s.z;
  const rbx = px - body.x;
  const rbz = pz - body.z;
  const rvx = s.vx + s.yawRate * raz - (body.vx + body.yawRate * rbz);
  const rvz = s.vz - s.yawRate * rax - (body.vz - body.yawRate * rbx);
  const vn = rvx * nx + rvz * nz;
  const closing = vn < 0 ? -vn : 0;
  const y = s.y + 0.45;

  if (closing > 0) {
    const ia = yawInertia(c);
    const ib = (mb * (body.halfLength * body.halfLength + body.halfWidth * body.halfWidth)) / 3;
    const armA = raz * nx - rax * nz;
    const armB = rbz * nx - rbx * nz;
    const j = ((1 + RESTITUTION) * closing) / (1 / ma + 1 / mb + (armA * armA) / ia + (armB * armB) / ib);
    const tx = -nz;
    const tz = nx;
    const vt = rvx * tx + rvz * tz;
    const armAt = raz * tx - rax * tz;
    const armBt = rbz * tx - rbx * tz;
    let jt = -vt / (1 / ma + 1 / mb + (armAt * armAt) / ia + (armBt * armBt) / ib);
    const jtMax = PAIR_FRICTION * j;
    if (jt > jtMax) jt = jtMax;
    else if (jt < -jtMax) jt = -jtMax;
    const jx = j * nx + jt * tx;
    const jz = j * nz + jt * tz;
    v.applyImpulse(jx, jz, px, pz);
    body.vx -= jx / mb;
    body.vz -= jz / mb;
    body.yawRate += (rbz * -jx - rbx * -jz) / ib;
    if (closing > 1) {
      v.events.push({ type: 'impact', x: px, y, z: pz, nx, nz, intensity: closing, collider: null });
      s.damage = Math.min(1, s.damage + damageFor(closing, shareA));
    }
  }
  return { x: px, y, z: pz, nx, nz, intensity: closing };
}
