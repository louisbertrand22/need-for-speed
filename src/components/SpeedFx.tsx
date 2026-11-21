/* =============================================================================
 * Full-screen speed effects (behind the HUD widgets): radial speed lines on a
 * half-resolution canvas, speed / nitro vignettes, impact flash, pursuit edges.
 * ===========================================================================*/
import { useRef } from 'react';
import { fitCanvas, setClass, useApi, useFrame, useGameEvent, useResize } from './hooks';

interface Streak {
  a: number;
  r: number;
  v: number;
  len: number;
  w: number;
}

const N_STREAKS = 120;

function makeStreaks(): Streak[] {
  const out: Streak[] = [];
  for (let i = 0; i < N_STREAKS; i++) {
    out.push({ a: Math.random() * Math.PI * 2, r: 0.3 + Math.random() * 0.8, v: 0.5 + Math.random(), len: 0.05 + Math.random() * 0.12, w: 0.6 + Math.random() * 1.6 });
  }
  return out;
}

export function SpeedFx({ lines }: { lines: boolean }) {
  const api = useApi();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const darkRef = useRef<HTMLDivElement>(null);
  const nitroRef = useRef<HTMLDivElement>(null);
  const impactRef = useRef<HTMLDivElement>(null);
  const policeRef = useRef<HTMLDivElement>(null);
  const local = useRef({ streaks: makeStreaks(), fx: 0, nitro: 0, impact: 0, dirty: false, lastDark: -1, lastNitro: -1, lastImpact: -1 });

  useResize(canvasRef, () => {
    if (canvasRef.current) fitCanvas(canvasRef.current, 1, 0.5);
  });

  useGameEvent((e) => {
    if (e.type === 'impact') {
      const k = Math.min(1, Math.max(0.18, e.intensity / 16));
      if (k > local.current.impact) local.current.impact = k;
    }
  });

  useFrame((dt) => {
    const t = api.telemetry;
    const L = local.current;
    const target = Math.min(1, Math.max(0, t.speedFx));
    L.fx += (target - L.fx) * (1 - Math.exp(-6 * dt));
    L.nitro += ((t.nitroActive ? 1 : 0) - L.nitro) * (1 - Math.exp(-9 * dt));
    if (L.impact > 0) L.impact = Math.max(0, L.impact - dt * 1.9);

    // vignettes (opacity only, quantised)
    const dark = Math.round(L.fx * 40) / 40;
    if (dark !== L.lastDark && darkRef.current) {
      L.lastDark = dark;
      darkRef.current.style.opacity = String(dark * 0.75);
    }
    const nit = Math.round(L.nitro * 40) / 40;
    if (nit !== L.lastNitro && nitroRef.current) {
      L.lastNitro = nit;
      nitroRef.current.style.opacity = String(nit);
    }
    const imp = Math.round(L.impact * 40) / 40;
    if (imp !== L.lastImpact && impactRef.current) {
      L.lastImpact = imp;
      impactRef.current.style.opacity = String(imp);
    }
    setClass(policeRef.current, 'is-on', t.pursuit.status !== 'idle' && t.pursuit.inSight);
    setClass(policeRef.current, 'is-cool', t.pursuit.status === 'cooldown');

    // speed lines
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const intensity = lines ? Math.min(1, L.fx + L.nitro * 0.35) : 0;
    if (intensity < 0.04) {
      if (L.dirty) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        L.dirty = false;
      }
      return;
    }
    L.dirty = true;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h * 0.46;
    const maxR = Math.hypot(cx, cy) * 1.05;
    ctx.clearRect(0, 0, w, h);
    ctx.lineCap = 'round';
    const tint = L.nitro > 0.3 ? '170,225,255' : '225,238,255';
    const adv = dt * (0.35 + intensity * 1.5);
    for (let i = 0; i < N_STREAKS; i++) {
      const s = L.streaks[i];
      s.r += adv * s.v * (0.4 + s.r);
      if (s.r > 1.1) {
        s.r = 0.28 + Math.random() * 0.25;
        s.a = Math.random() * Math.PI * 2;
      }
      // fade in from the calm centre toward the edges
      const edge = Math.min(1, Math.max(0, (s.r - 0.3) / 0.45));
      const alpha = edge * intensity * 0.55;
      if (alpha < 0.02) continue;
      const r0 = s.r * maxR;
      const r1 = (s.r + s.len * (0.4 + intensity * 1.2) * (0.5 + s.r)) * maxR;
      const ca = Math.cos(s.a);
      const sa = Math.sin(s.a);
      ctx.strokeStyle = `rgba(${tint},${alpha.toFixed(3)})`;
      ctx.lineWidth = s.w * (0.6 + s.r);
      ctx.beginPath();
      ctx.moveTo(cx + ca * r0, cy + sa * r0);
      ctx.lineTo(cx + ca * r1, cy + sa * r1);
      ctx.stroke();
    }
  });

  return (
    <div className="absolute inset-0" aria-hidden>
      <div ref={darkRef} className="ax-fx-dark" style={{ opacity: 0 }} />
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
      <div ref={nitroRef} className="ax-fx-nitro" style={{ opacity: 0 }} />
      <div ref={policeRef} className="ax-fx-police">
        <i />
        <i />
      </div>
      <div ref={impactRef} className="ax-fx-impact" style={{ opacity: 0 }} />
    </div>
  );
}
