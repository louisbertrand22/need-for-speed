/* =============================================================================
 * Gauge cluster (bottom-right): tachometer + speed + gear + NOS / turbo / temp /
 * damage. Everything is driven imperatively from the shared frame loop.
 * ===========================================================================*/
import { useRef } from 'react';
import type { CSSProperties } from 'react';
import { CarFront, Fan, Flame, Thermometer } from 'lucide-react';
import type { ShiftLight } from '../core/types';
import { KMH_TO_MPH, fitCanvas, retrigger, setClass, setP, setText, useApi, useFrame, useResize, useUI } from './hooks';
import { cx } from './kit';

const A0 = (140 * Math.PI) / 180;
const SWEEP = (260 * Math.PI) / 180;
const N_SPEED = 52;
const N_LED = 9;

function buildDial(size: number, maxRpm: number, redline: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  if (!ctx) return c;
  const h = size / 2;
  const px = size / 304;
  const R = h - 5 * px;
  const ang = (rpm: number) => A0 + SWEEP * Math.min(1, Math.max(0, rpm / maxRpm));

  // face
  const face = ctx.createRadialGradient(h, h * 0.9, R * 0.1, h, h, R);
  face.addColorStop(0, 'rgba(20,25,40,0.84)');
  face.addColorStop(0.62, 'rgba(8,10,18,0.88)');
  face.addColorStop(1, 'rgba(3,4,9,0.94)');
  ctx.beginPath();
  ctx.arc(h, h, R, 0, Math.PI * 2);
  ctx.fillStyle = face;
  ctx.fill();
  // chrome rim
  const chrome = ctx.createLinearGradient(0, 0, size, size);
  chrome.addColorStop(0, 'rgba(255,255,255,0.9)');
  chrome.addColorStop(0.3, 'rgba(110,122,148,0.5)');
  chrome.addColorStop(0.6, 'rgba(235,240,250,0.8)');
  chrome.addColorStop(1, 'rgba(60,70,92,0.55)');
  ctx.lineWidth = 1.6 * px;
  ctx.strokeStyle = chrome;
  ctx.stroke();
  // inner machined rings
  ctx.lineWidth = 1 * px;
  ctx.strokeStyle = 'rgba(207,214,228,0.1)';
  for (const f of [0.6, 0.63]) {
    ctx.beginPath();
    ctx.arc(h, h, R * f, 0, Math.PI * 2);
    ctx.stroke();
  }

  // speed arc track (outer segmented ring)
  ctx.lineWidth = 5 * px;
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  const da = SWEEP / N_SPEED;
  ctx.beginPath();
  for (let i = 0; i < N_SPEED; i++) {
    const a = A0 + da * (i + 0.5);
    ctx.moveTo(h + Math.cos(a - da * 0.36) * (R - 6 * px), h + Math.sin(a - da * 0.36) * (R - 6 * px));
    ctx.arc(h, h, R - 6 * px, a - da * 0.36, a + da * 0.36);
  }
  ctx.stroke();

  // rpm band (dim) + red zone
  ctx.lineWidth = 5 * px;
  ctx.strokeStyle = 'rgba(255,255,255,0.09)';
  ctx.beginPath();
  ctx.arc(h, h, R - 16 * px, A0, ang(redline));
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,51,68,0.55)';
  ctx.beginPath();
  ctx.arc(h, h, R - 16 * px, ang(redline), A0 + SWEEP);
  ctx.stroke();

  // ticks + numbers
  const minor = maxRpm > 9500 ? 500 : 250;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `italic 700 ${Math.round(15 * px)}px Orbitron, sans-serif`;
  ctx.lineCap = 'butt';
  for (let rpm = 0; rpm <= maxRpm + 1; rpm += minor) {
    const major = rpm % 1000 === 0;
    const half = rpm % 500 === 0;
    const a = ang(rpm);
    const red = rpm >= redline;
    const r0 = R - 21 * px;
    const r1 = r0 - (major ? 14 : half ? 8 : 4.5) * px;
    ctx.lineWidth = (major ? 2.6 : 1.3) * px;
    ctx.strokeStyle = red ? '#ff3344' : major ? '#ffffff' : 'rgba(207,214,228,0.5)';
    ctx.beginPath();
    ctx.moveTo(h + Math.cos(a) * r0, h + Math.sin(a) * r0);
    ctx.lineTo(h + Math.cos(a) * r1, h + Math.sin(a) * r1);
    ctx.stroke();
    if (major) {
      ctx.fillStyle = red ? '#ff5564' : 'rgba(232,236,244,0.92)';
      ctx.fillText(String(rpm / 1000), h + Math.cos(a) * (R - 50 * px), h + Math.sin(a) * (R - 50 * px) + 1 * px);
    }
  }
  return c;
}

export function GaugeCluster({ dragMode }: { dragMode: boolean }) {
  const api = useApi();
  const units = useUI((s) => s.profile.settings.units);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const speedRef = useRef<HTMLDivElement>(null);
  const rpmRef = useRef<HTMLSpanElement>(null);
  const gearRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLSpanElement>(null);
  const wingRef = useRef<HTMLDivElement>(null);
  const nosRef = useRef<HTMLDivElement>(null);
  const nosPctRef = useRef<HTMLSpanElement>(null);
  const turboRef = useRef<HTMLDivElement>(null);
  const tempRef = useRef<HTMLDivElement>(null);
  const tempRowRef = useRef<HTMLDivElement>(null);
  const dmgRef = useRef<HTMLDivElement>(null);
  const dmgRowRef = useRef<HTMLDivElement>(null);
  const dmgPctRef = useRef<HTMLSpanElement>(null);
  const local = useRef<{ dial: HTMLCanvasElement | null; dialKey: string; gear: number; rpm: number }>({ dial: null, dialKey: '', gear: 99, rpm: 0 });

  useResize(canvasRef, () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    fitCanvas(canvas);
    local.current.dialKey = '';
  });

  useFrame((dt, time) => {
    const t = api.telemetry;
    const L = local.current;
    const mph = units === 'mph';

    // ---- DOM read-outs ------------------------------------------------------
    setText(speedRef.current, String(Math.round(t.speedKmh * (mph ? KMH_TO_MPH : 1))));
    setText(rpmRef.current, String(Math.round(t.rpm / 10) * 10));
    if (t.gear !== L.gear) {
      L.gear = t.gear;
      setText(gearRef.current, t.gear < 0 ? 'R' : t.gear === 0 ? 'N' : String(t.gear));
      retrigger(gearRef.current, 'ax-pop');
    }
    setText(boxRef.current, t.manual ? 'MANU' : 'AUTO');
    setP(nosRef.current, t.nitro, 200);
    setText(nosPctRef.current, `${Math.round(t.nitro * 100)}`);
    setClass(wingRef.current, 'is-nos', t.nitroActive);
    setClass(wingRef.current, 'is-nos-empty', t.nitro < 0.04);
    setP(turboRef.current, t.turbo, 100);
    setP(tempRef.current, t.engineTemp, 100);
    setClass(tempRowRef.current, 'is-warn', t.engineTemp > 0.8);
    setClass(tempRowRef.current, 'is-mid', t.engineTemp > 0.55 && t.engineTemp <= 0.8);
    const integrity = 1 - Math.min(1, Math.max(0, t.damage));
    setP(dmgRef.current, integrity, 100);
    setText(dmgPctRef.current, `${Math.round(integrity * 100)}`);
    setClass(dmgRowRef.current, 'is-warn', integrity < 0.3);
    setClass(dmgRowRef.current, 'is-mid', integrity >= 0.3 && integrity < 0.65);

    // ---- tachometer canvas --------------------------------------------------
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const size = canvas.width;
    const maxRpm = t.maxRpm > 1000 ? t.maxRpm : 9000;
    const redline = t.redlineRpm > 0 ? t.redlineRpm : maxRpm * 0.85;
    const key = `${size}|${maxRpm}|${redline}`;
    if (key !== L.dialKey || !L.dial) {
      L.dialKey = key;
      L.dial = buildDial(size, maxRpm, redline);
    }
    const h = size / 2;
    const px = size / 304;
    const R = h - 5 * px;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(L.dial, 0, 0);

    // speed arc
    const speedMax = mph ? 250 : 400;
    const sv = t.speedKmh * (mph ? KMH_TO_MPH : 1);
    const lit = Math.min(N_SPEED, Math.round((N_SPEED * sv) / speedMax));
    const da = SWEEP / N_SPEED;
    const rs = R - 6 * px;
    ctx.lineWidth = 5 * px;
    ctx.lineCap = 'butt';
    const hot = Math.floor(N_SPEED * 0.72);
    for (let pass = 0; pass < 2; pass++) {
      const from = pass === 0 ? 0 : hot;
      const to = pass === 0 ? Math.min(lit, hot) : lit;
      if (to <= from) continue;
      ctx.strokeStyle = pass === 0 ? (t.nitroActive ? '#9fe8ff' : '#22e3ff') : '#ff7a1a';
      ctx.beginPath();
      for (let i = from; i < to; i++) {
        const a = A0 + da * (i + 0.5);
        ctx.moveTo(h + Math.cos(a - da * 0.36) * rs, h + Math.sin(a - da * 0.36) * rs);
        ctx.arc(h, h, rs, a - da * 0.36, a + da * 0.36);
      }
      ctx.stroke();
    }

    const rpm = Math.min(maxRpm, Math.max(0, t.rpm));
    const aNeedle = A0 + SWEEP * (rpm / maxRpm);
    const rb = R - 16 * px;

    // perfect-shift window
    if ((t.manual || dragMode) && t.perfectShiftHi > t.perfectShiftLo) {
      const a0 = A0 + SWEEP * Math.min(1, t.perfectShiftLo / maxRpm);
      const a1 = A0 + SWEEP * Math.min(1, t.perfectShiftHi / maxRpm);
      const inZone = t.shiftLight === 'perfect';
      ctx.lineWidth = (inZone ? 16 : 9) * px;
      ctx.strokeStyle = inZone ? 'rgba(125,255,106,0.4)' : 'rgba(125,255,106,0.22)';
      ctx.beginPath();
      ctx.arc(h, h, rb, a0, a1);
      ctx.stroke();
      ctx.lineWidth = 5 * px;
      ctx.strokeStyle = '#7dff6a';
      ctx.beginPath();
      ctx.arc(h, h, rb, a0, a1);
      ctx.stroke();
    }

    // rpm fill
    const over = rpm >= redline;
    ctx.lineWidth = 5 * px;
    ctx.strokeStyle = over ? '#ff3344' : t.nitroActive ? '#9fe8ff' : '#22e3ff';
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(h, h, rb, A0, aNeedle);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // needle (edge wedge) with a cheap glow
    const cs = Math.cos(aNeedle);
    const sn = Math.sin(aNeedle);
    const rIn = R * 0.58;
    const rOut = R - 8 * px;
    const needleCol = over ? '#ff3344' : '#ff7a1a';
    ctx.lineCap = 'round';
    ctx.strokeStyle = over ? 'rgba(255,51,68,0.3)' : 'rgba(255,122,26,0.3)';
    ctx.lineWidth = 11 * px;
    ctx.beginPath();
    ctx.moveTo(h + cs * (rIn + 6 * px), h + sn * (rIn + 6 * px));
    ctx.lineTo(h + cs * rOut, h + sn * rOut);
    ctx.stroke();
    const wx = -sn;
    const wy = cs;
    ctx.beginPath();
    ctx.moveTo(h + cs * rIn + wx * 3.6 * px, h + sn * rIn + wy * 3.6 * px);
    ctx.lineTo(h + cs * rOut + wx * 1.1 * px, h + sn * rOut + wy * 1.1 * px);
    ctx.lineTo(h + cs * rOut - wx * 1.1 * px, h + sn * rOut - wy * 1.1 * px);
    ctx.lineTo(h + cs * rIn - wx * 3.6 * px, h + sn * rIn - wy * 3.6 * px);
    ctx.closePath();
    ctx.fillStyle = needleCol;
    ctx.fill();
    ctx.lineWidth = 1.4 * px;
    ctx.strokeStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.moveTo(h + cs * (rIn + 4 * px), h + sn * (rIn + 4 * px));
    ctx.lineTo(h + cs * (rOut - 2 * px), h + sn * (rOut - 2 * px));
    ctx.stroke();
    ctx.lineCap = 'butt';

    // shift light LEDs (arc above the speed read-out)
    const state: ShiftLight = t.shiftLight;
    const frac = Math.min(1, Math.max(0, (rpm - redline * 0.55) / (redline * 0.42)));
    const nLit = state === 'perfect' || state === 'over' ? N_LED : Math.round(frac * N_LED);
    const blinkOff = state === 'over' && Math.floor(time * 12) % 2 === 0;
    const rl = R * 0.47;
    const spread = 0.21;
    for (let i = 0; i < N_LED; i++) {
      const a = -Math.PI / 2 + (i - (N_LED - 1) / 2) * spread;
      const on = i < nLit && !blinkOff;
      let col = 'rgba(255,255,255,0.1)';
      if (on) {
        if (state === 'perfect') col = '#7dff6a';
        else if (state === 'over') col = '#ff3344';
        else if (state === 'approach') col = '#ffc233';
        else col = i < N_LED * 0.45 ? '#22e3ff' : i < N_LED * 0.78 ? '#ffc233' : '#ff7a1a';
      }
      const x = h + Math.cos(a) * rl;
      const y = h + Math.sin(a) * rl;
      if (on && state !== 'none') {
        ctx.beginPath();
        ctx.arc(x, y, 7.5 * px, 0, Math.PI * 2);
        ctx.fillStyle = state === 'perfect' ? 'rgba(125,255,106,0.28)' : state === 'over' ? 'rgba(255,51,68,0.28)' : 'rgba(255,194,51,0.22)';
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, 3.6 * px, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    }
  });

  return (
    <div className="absolute bottom-[1.3rem] right-[1.3rem] flex items-end">
      {/* ---- left wing: NOS / turbo / temp / damage ---- */}
      <div ref={wingRef} className={cx('ax-wing', dragMode && 'is-drag')}>
        <div className="ax-wing-row">
          <Fan className="ax-wing-ico text-neon-orange" strokeWidth={2.2} />
          <span className="ax-wing-lbl">Turbo</span>
          <div ref={turboRef} className="ax-seg ax-tone-orange flex-1" style={{ '--n': 10, height: '0.5rem' } as CSSProperties}>
            <i />
          </div>
        </div>
        <div ref={tempRowRef} className="ax-wing-row ax-temp-row">
          <Thermometer className="ax-wing-ico" strokeWidth={2.2} />
          <span className="ax-wing-lbl">Temp</span>
          <div ref={tempRef} className="ax-seg flex-1" style={{ '--n': 10, height: '0.5rem' } as CSSProperties}>
            <i />
          </div>
        </div>
        <div ref={dmgRowRef} className="ax-wing-row ax-dmg-row">
          <CarFront className="ax-wing-ico" strokeWidth={2.2} />
          <span className="ax-wing-lbl">État</span>
          <div ref={dmgRef} className="ax-seg flex-1" style={{ '--n': 10, height: '0.5rem' } as CSSProperties}>
            <i />
          </div>
          <span className="ax-num w-[2.1rem] text-right text-[0.72rem]">
            <span ref={dmgPctRef}>100</span>
            <span className="text-[0.6rem] opacity-60">%</span>
          </span>
        </div>
        <div className="ax-nos">
          <div className="flex items-end justify-between">
            <span className="ax-nos-title">
              <Flame className="ax-nos-flame" strokeWidth={2.4} />
              NOS
            </span>
            <span className="ax-num text-[1.05rem] leading-none text-white">
              <span ref={nosPctRef}>100</span>
              <span className="text-[0.65rem] opacity-60">%</span>
            </span>
          </div>
          <div className="relative mt-[0.3rem]">
            <div ref={nosRef} className="ax-seg ax-nos-bar" style={{ '--n': 14, height: '1.05rem' } as CSSProperties}>
              <i />
            </div>
            <div className="ax-nos-jets" aria-hidden>
              <i />
              <i />
              <i />
            </div>
          </div>
        </div>
      </div>

      {/* ---- tachometer ---- */}
      <div className="relative h-[19rem] w-[19rem] shrink-0" style={{ filter: 'drop-shadow(0 0.5rem 1.2rem rgba(0,0,0,0.75))' }}>
        <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full" />
        <div className="absolute inset-x-0 top-[33%] flex flex-col items-center">
          <div ref={speedRef} className="ax-display ax-speed-num">
            0
          </div>
          <div className="mt-[0.15rem] flex items-center gap-2">
            <span className="font-display text-[0.72rem] font-bold italic tracking-[0.2em] text-neon-cyan">{units === 'mph' ? 'MPH' : 'KM/H'}</span>
          </div>
          <div className="mt-[0.1rem] text-[0.66rem] font-bold tracking-[0.16em] text-steel">
            <span ref={rpmRef} className="ax-num text-[0.7rem] text-chrome">
              0
            </span>{' '}
            TR/MIN
          </div>
        </div>
        <div className="absolute bottom-[0.15rem] left-1/2 flex -translate-x-1/2 items-end gap-[0.35rem]">
          <div className="ax-gear-box">
            <div ref={gearRef} className="ax-display ax-gear-num">
              N
            </div>
          </div>
          <span ref={boxRef} className="ax-gear-tag">
            AUTO
          </span>
        </div>
      </div>
    </div>
  );
}
