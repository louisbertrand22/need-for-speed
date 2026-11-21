/* =============================================================================
 * Heading-up radar minimap (bottom-left of the driving HUD).
 * The road network is rasterised ONCE (mapDraw.getRoadBitmap) and blitted rotated
 * every frame; routes are cached Path2D; markers are pre-tinted sprites.
 * ===========================================================================*/
import { useRef } from 'react';
import type { CSSProperties } from 'react';
import type { BlipKind } from '../core/types';
import { DISTRICTS } from '../core/layout';
import { MODE_INFO } from '../game/catalog';
import { fitCanvas, useApi, useFrame, useResize, useUI } from './hooks';
import { markerColor } from './kit';
import { TAU, drawArrow, drawChecker, drawDiamond, getRoadBitmap, getRoutePath } from './mapDraw';
import { getMarkerSprite, markerIconKey } from './sprites';

const RADIUS_REST = 220;
const RADIUS_FAST = 420;

function buildBezel(size: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const h = size / 2;
  const ring = size * 0.05;
  const rOuter = h - size * 0.012;
  const rMap = rOuter - ring;
  // dark ring body
  ctx.beginPath();
  ctx.arc(h, h, rOuter - ring / 2, 0, TAU);
  ctx.lineWidth = ring;
  ctx.strokeStyle = 'rgba(7,9,16,0.96)';
  ctx.stroke();
  // chrome strokes
  const chrome = ctx.createLinearGradient(0, 0, size, size);
  chrome.addColorStop(0, 'rgba(255,255,255,0.85)');
  chrome.addColorStop(0.35, 'rgba(120,132,156,0.55)');
  chrome.addColorStop(0.65, 'rgba(230,236,248,0.75)');
  chrome.addColorStop(1, 'rgba(70,80,104,0.6)');
  ctx.beginPath();
  ctx.arc(h, h, rOuter, 0, TAU);
  ctx.lineWidth = Math.max(1, size * 0.006);
  ctx.strokeStyle = chrome;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(h, h, rMap, 0, TAU);
  ctx.lineWidth = Math.max(1, size * 0.004);
  ctx.strokeStyle = 'rgba(207,214,228,0.35)';
  ctx.stroke();
  // ticks every 15°
  ctx.strokeStyle = 'rgba(207,214,228,0.5)';
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * TAU;
    const major = i % 6 === 0;
    const r0 = rMap + ring * (major ? 0.15 : 0.38);
    const r1 = rMap + ring * (major ? 0.85 : 0.62);
    ctx.lineWidth = Math.max(1, size * (major ? 0.007 : 0.004));
    ctx.beginPath();
    ctx.moveTo(h + Math.cos(a) * r0, h + Math.sin(a) * r0);
    ctx.lineTo(h + Math.cos(a) * r1, h + Math.sin(a) * r1);
    ctx.stroke();
  }
  // range ring + cross hair
  ctx.strokeStyle = 'rgba(34,227,255,0.13)';
  ctx.lineWidth = Math.max(1, size * 0.003);
  ctx.beginPath();
  ctx.arc(h, h, rMap * 0.5, 0, TAU);
  ctx.stroke();
  // inner vignette
  const vg = ctx.createRadialGradient(h, h, rMap * 0.55, h, h, rMap);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(2,3,8,0.6)');
  ctx.beginPath();
  ctx.arc(h, h, rMap, 0, TAU);
  ctx.fillStyle = vg;
  ctx.fill();
  return c;
}

export function Radar({ showMarkers }: { showMarkers: boolean }) {
  const api = useApi();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const local = useRef<{ radius: number; bezel: HTMLCanvasElement | null }>({ radius: RADIUS_REST, bezel: null });
  const district = useUI((s) => s.district);

  useResize(canvasRef, () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    fitCanvas(canvas);
    local.current.bezel = buildBezel(canvas.width);
  });

  useFrame((dt, time) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const L = local.current;
    const t = api.telemetry;
    const size = canvas.width;
    const h = size / 2;
    const ring = size * 0.05;
    const rOuter = h - size * 0.012;
    const rMap = rOuter - ring;
    const px = size / 248; // design pixel (the radar is drawn for a 248 px box)

    // zoom widens with speed
    const target = RADIUS_REST + (RADIUS_FAST - RADIUS_REST) * Math.min(1, Math.max(0, t.speedKmh / 250));
    L.radius += (target - L.radius) * (1 - Math.exp(-2.2 * dt));
    const s = rMap / L.radius; // device px per metre
    const phi = t.heading - Math.PI;
    const cosP = Math.cos(phi);
    const sinP = Math.sin(phi);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, size, size);

    // --- map disc -----------------------------------------------------------
    ctx.save();
    ctx.beginPath();
    ctx.arc(h, h, rMap, 0, TAU);
    ctx.clip();
    ctx.fillStyle = 'rgba(8,11,20,0.82)';
    ctx.fillRect(0, 0, size, size);

    const map = api.getMapData();
    ctx.translate(h, h);
    ctx.rotate(phi);
    ctx.scale(s, s);
    ctx.translate(-t.x, -t.z);
    if (map) {
      const bmp = getRoadBitmap(map);
      const half = L.radius * 1.45;
      let x0 = Math.max(bmp.minX, t.x - half);
      let z0 = Math.max(bmp.minZ, t.z - half);
      const x1 = Math.min(bmp.minX + bmp.width / bmp.pxPerM, t.x + half);
      const z1 = Math.min(bmp.minZ + bmp.height / bmp.pxPerM, t.z + half);
      if (x1 > x0 && z1 > z0) {
        x0 = Math.floor((x0 - bmp.minX) * bmp.pxPerM) / bmp.pxPerM + bmp.minX;
        z0 = Math.floor((z0 - bmp.minZ) * bmp.pxPerM) / bmp.pxPerM + bmp.minZ;
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(
          bmp.canvas,
          (x0 - bmp.minX) * bmp.pxPerM,
          (z0 - bmp.minZ) * bmp.pxPerM,
          (x1 - x0) * bmp.pxPerM,
          (z1 - z0) * bmp.pxPerM,
          x0,
          z0,
          x1 - x0,
          z1 - z0,
        );
      }
    }
    // route (race = mode colour, GPS = dashed violet)
    const route = t.route;
    if (route && route.length > 1) {
      const path = getRoutePath(route);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.lineWidth = (7 * px) / s;
      ctx.strokeStyle = 'rgba(4,6,12,0.7)';
      ctx.stroke(path);
      ctx.lineWidth = (4 * px) / s;
      if (t.routeIsGps) {
        ctx.setLineDash([(9 * px) / s, (7 * px) / s]);
        ctx.lineDashOffset = (-time * 26 * px) / s;
        ctx.strokeStyle = '#b48cff';
      } else {
        ctx.strokeStyle = t.race.active ? MODE_INFO[t.race.mode].color : '#22e3ff';
      }
      ctx.stroke(path);
      ctx.setLineDash([]);
    }
    ctx.restore();

    // --- bezel --------------------------------------------------------------
    if (L.bezel) ctx.drawImage(L.bezel, 0, 0);

    // pursuit: the ring flashes
    const ps = t.pursuit.status;
    if (ps !== 'idle') {
      const flip = Math.floor(time * 4) % 2 === 0;
      ctx.beginPath();
      ctx.arc(h, h, rOuter - ring / 2, 0, TAU);
      ctx.lineWidth = ring * 0.5;
      if (ps === 'pursuit') ctx.strokeStyle = flip ? 'rgba(255,51,68,0.75)' : 'rgba(58,139,255,0.75)';
      else ctx.strokeStyle = `rgba(58,139,255,${0.35 + 0.3 * Math.sin(time * 5)})`;
      ctx.stroke();
    }

    // --- static markers -----------------------------------------------------
    const edge = rMap - 12 * px;
    if (showMarkers) {
      const state = api.getState();
      const markers = state.markers;
      const spr = 23 * px;
      for (let i = 0; i < markers.length; i++) {
        const m = markers[i];
        const dx = m.x - t.x;
        const dz = m.z - t.z;
        let sx = (dx * cosP - dz * sinP) * s;
        let sy = (dx * sinP + dz * cosP) * s;
        const d = Math.hypot(sx, sy);
        const isGps = m.id === state.gpsTargetId;
        if (d > edge) {
          if (!isGps) continue;
          sx *= edge / d;
          sy *= edge / d;
        }
        const color = markerColor(m);
        const sprite = getMarkerSprite(markerIconKey(m), color);
        const locked = m.kind === 'event' && m.event !== null && m.event.locked;
        ctx.globalAlpha = locked ? 0.45 : m.kind === 'breaker' || m.kind === 'ramp' ? 0.8 : 1;
        const k = m.kind === 'breaker' || m.kind === 'ramp' ? 0.8 : 1;
        if (sprite) ctx.drawImage(sprite, h + sx - (spr * k) / 2, h + sy - (spr * k) / 2, spr * k, spr * k);
        else {
          ctx.beginPath();
          ctx.arc(h + sx, h + sy, 5 * px, 0, TAU);
          ctx.fillStyle = color;
          ctx.fill();
        }
        ctx.globalAlpha = 1;
        if (isGps) {
          ctx.beginPath();
          ctx.arc(h + sx, h + sy, (15 + 2.5 * Math.sin(time * 6)) * px, 0, TAU);
          ctx.lineWidth = 2 * px;
          ctx.strokeStyle = '#b48cff';
          ctx.stroke();
        }
      }
    }

    // --- dynamic blips ------------------------------------------------------
    const blips = t.blips;
    const n = Math.min(t.blipCount, blips.length);
    const modeCol = MODE_INFO[t.race.mode]?.color ?? '#22e3ff';
    ctx.lineWidth = 1.5 * px;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const b = blips[i];
        const kind: BlipKind = b.kind;
        // pass 0 = background blips (traffic), pass 1 = everything else on top
        if ((kind === 'traffic') !== (pass === 0)) continue;
        const dx = b.x - t.x;
        const dz = b.z - t.z;
        let sx = (dx * cosP - dz * sinP) * s;
        let sy = (dx * sinP + dz * cosP) * s;
        const d = Math.hypot(sx, sy);
        let clamped = false;
        if (d > edge) {
          if (kind === 'checkpoint' || kind === 'finish' || kind === 'police' || kind === 'heli' || kind === 'speedtrap') {
            sx *= edge / d;
            sy *= edge / d;
            clamped = true;
          } else continue;
        }
        const x = h + sx;
        const y = h + sy;
        const rot = t.heading - b.heading;
        switch (kind) {
          case 'traffic':
            ctx.fillStyle = 'rgba(170,180,200,0.75)';
            ctx.fillRect(x - 2 * px, y - 2 * px, 4 * px, 4 * px);
            break;
          case 'rival':
            drawArrow(ctx, x, y, rot, 6.5 * px, '#ff7a1a', 'rgba(5,6,13,0.9)');
            break;
          case 'police': {
            const flip = (Math.floor(time * 5) + i) % 2 === 0;
            const col = flip ? '#ff3344' : '#3a8bff';
            ctx.beginPath();
            ctx.arc(x, y, (clamped ? 6 : 10) * px, 0, TAU);
            ctx.fillStyle = flip ? 'rgba(255,51,68,0.28)' : 'rgba(58,139,255,0.28)';
            ctx.fill();
            drawArrow(ctx, x, y, clamped ? Math.atan2(sx, -sy) : rot, (clamped ? 4.5 : 6.5) * px, col, '#ffffff');
            break;
          }
          case 'heli': {
            ctx.strokeStyle = '#dff3ff';
            ctx.lineWidth = 2 * px;
            const a = time * 9;
            const r = 8 * px;
            ctx.beginPath();
            ctx.moveTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
            ctx.lineTo(x - Math.cos(a) * r, y - Math.sin(a) * r);
            ctx.moveTo(x - Math.sin(a) * r, y + Math.cos(a) * r);
            ctx.lineTo(x + Math.sin(a) * r, y - Math.cos(a) * r);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y, 3.5 * px, 0, TAU);
            ctx.fillStyle = Math.floor(time * 5) % 2 === 0 ? '#ff3344' : '#3a8bff';
            ctx.fill();
            ctx.lineWidth = 1.5 * px;
            break;
          }
          case 'roadblock': {
            const c = Math.cos(rot);
            const sn = Math.sin(rot);
            ctx.strokeStyle = '#ff3344';
            ctx.lineWidth = 4 * px;
            ctx.beginPath();
            ctx.moveTo(x - c * 9 * px, y - sn * 9 * px);
            ctx.lineTo(x + c * 9 * px, y + sn * 9 * px);
            ctx.stroke();
            ctx.lineWidth = 1.5 * px;
            break;
          }
          case 'checkpoint': {
            const pulse = 0.5 + 0.5 * Math.sin(time * 7);
            ctx.beginPath();
            ctx.arc(x, y, (6 + pulse * 3) * px, 0, TAU);
            ctx.lineWidth = 2.5 * px;
            ctx.strokeStyle = modeCol;
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y, 2.6 * px, 0, TAU);
            ctx.fillStyle = '#ffffff';
            ctx.fill();
            ctx.lineWidth = 1.5 * px;
            break;
          }
          case 'finish':
            drawChecker(ctx, x, y, 5.5 * px);
            break;
          case 'speedtrap':
            drawDiamond(ctx, x, y, 6 * px);
            ctx.fillStyle = '#7dff6a';
            ctx.fill();
            ctx.strokeStyle = 'rgba(5,6,13,0.9)';
            ctx.stroke();
            break;
        }
      }
    }

    // --- player arrow (always pointing up) ----------------------------------
    ctx.shadowColor = '#22e3ff';
    ctx.shadowBlur = 10 * px;
    ctx.lineWidth = 2 * px;
    drawArrow(ctx, h, h, 0, 8.5 * px, '#ffffff', '#0b1220');
    ctx.shadowBlur = 0;

    // --- north marker on the ring --------------------------------------------
    const nr = rOuter - ring / 2;
    const nx = h + sinP * nr;
    const ny = h - cosP * nr;
    ctx.beginPath();
    ctx.arc(nx, ny, ring * 0.72, 0, TAU);
    ctx.fillStyle = '#ff7a1a';
    ctx.fill();
    ctx.fillStyle = '#05060d';
    ctx.font = `900 ${Math.round(ring * 0.95)}px Orbitron, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + ring * 0.06);
  });

  const d = DISTRICTS[district];
  return (
    <div className="flex flex-col items-center">
      <canvas ref={canvasRef} className="block h-[15.5rem] w-[15.5rem]" style={{ filter: 'drop-shadow(0 0.4rem 1rem rgba(0,0,0,0.7))' }} />
      <div
        key={district}
        className="ax-in-up ax-para -mt-[0.55rem] flex items-center gap-2 bg-ink-900/90 px-5 py-[0.28rem]"
        style={{ '--ac': d.color } as CSSProperties}
      >
        <i className="block h-[0.5rem] w-[0.5rem] rotate-45" style={{ background: d.color, boxShadow: `0 0 0.5rem ${d.color}` }} />
        <span className="font-display text-[0.72rem] font-bold uppercase italic tracking-[0.12em]" style={{ color: d.color }}>
          {d.name}
        </span>
      </div>
    </div>
  );
}
