/* =============================================================================
 * Race widgets of the driving HUD: position / lap / clock panel with its mode
 * variants (drift, drag, speed trap), live standings, drift combo meter, drag
 * strip + shift cue, wrong-way warning, countdown.
 * ===========================================================================*/
import { useLayoutEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { Check, Thermometer, Timer, Undo2 } from 'lucide-react';
import type { ActiveEventInfo, EventMode, StandingRow } from '../core/types';
import { MODE_INFO } from '../game/catalog';
import { KMH_TO_MPH, fmtClock, fmtInt, fmtTime, ordinalFr, retrigger, setClass, setP, setText, useApi, useFrame, usePoll, useUI } from './hooks';
import { MEDAL_INFO, ModeChip, cx } from './kit';

// -----------------------------------------------------------------------------
// Top-left panel
// -----------------------------------------------------------------------------

function PositionBig({ position, racers }: { position: number; racers: number }) {
  return (
    <div className="flex items-start leading-none">
      <span key={position} className="ax-display ax-pop ax-pos-num" style={{ color: position === 1 ? '#ffc233' : '#ffffff' }}>
        {position}
      </span>
      <span className="ml-[0.15rem] mt-[0.35rem] flex flex-col">
        <span className="ax-display text-[1.25rem] text-white/90">{ordinalFr(position)}</span>
        <span className="ax-display mt-[0.45rem] text-[1.5rem] text-steel">/{racers}</span>
      </span>
    </div>
  );
}

function TargetsRow({ targets, mode, suffix }: { targets: NonNullable<ActiveEventInfo['targets']>; mode: EventMode; suffix: string }) {
  // medal tier reached so far (polled: the score only matters at coarse steps)
  const tier = usePoll((t) => {
    const v = mode === 'drift' ? t.race.driftScore : t.race.trapTotal;
    return v >= targets.gold ? 3 : v >= targets.silver ? 2 : v >= targets.bronze ? 1 : 0;
  }, 4);
  const rows: { key: 'gold' | 'silver' | 'bronze'; rank: number }[] = [
    { key: 'gold', rank: 3 },
    { key: 'silver', rank: 2 },
    { key: 'bronze', rank: 1 },
  ];
  return (
    <div className="mt-[0.5rem] flex gap-[0.9rem]">
      {rows.map((r) => {
        const done = tier >= r.rank;
        const info = MEDAL_INFO[r.key];
        return (
          <div key={r.key} className={cx('flex items-center gap-[0.3rem] text-[0.82rem] font-bold', !done && 'opacity-75')} style={{ color: info.color }}>
            <span
              className="flex h-[1.05rem] w-[1.05rem] items-center justify-center rounded-full border"
              style={{ borderColor: info.color, background: done ? info.color : 'transparent', boxShadow: done ? `0 0 0.5rem ${info.color}` : undefined }}
            >
              {done ? <Check size="0.8rem" strokeWidth={4} color="#05060d" /> : null}
            </span>
            <span className="ax-num text-[0.8rem]">
              {fmtInt(targets[r.key])}
              {suffix}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function RacePanel({ event }: { event: ActiveEventInfo | null }) {
  const api = useApi();
  const units = useUI((s) => s.profile.settings.units);
  const mode = usePoll((t) => t.race.mode);
  const position = usePoll((t) => t.race.position);
  const racers = usePoll((t) => t.race.racers);
  const lap = usePoll((t) => t.race.lap);
  const laps = usePoll((t) => t.race.laps);
  const cp = usePoll((t) => t.race.checkpoint);
  const cps = usePoll((t) => t.race.checkpoints);
  const trapsPassed = usePoll((t) => t.race.trapsPassed);
  const trapsTotal = usePoll((t) => t.race.trapsTotal);

  const timeRef = useRef<HTMLSpanElement>(null);
  const lapRef = useRef<HTMLSpanElement>(null);
  const bestRef = useRef<HTMLSpanElement>(null);
  const progRef = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<HTMLSpanElement>(null);
  const leftRef = useRef<HTMLSpanElement>(null);
  const leftRowRef = useRef<HTMLDivElement>(null);
  const trapRef = useRef<HTMLSpanElement>(null);
  const lastRef = useRef<HTMLSpanElement>(null);
  const distRef = useRef<HTMLSpanElement>(null);

  const mph = units === 'mph';
  const speedUnit = mph ? 'MPH' : 'KM/H';

  useFrame(() => {
    const r = api.telemetry.race;
    setText(timeRef.current, fmtClock(r.timeMs));
    setText(lapRef.current, fmtClock(r.lapTimeMs));
    setText(bestRef.current, r.bestLapMs > 0 ? fmtTime(r.bestLapMs) : '-:--.---');
    setP(progRef.current, r.progress, 500);
    if (r.mode === 'drift') {
      setText(scoreRef.current, fmtInt(r.driftScore));
      if (r.timeLeftMs >= 0) {
        setText(leftRef.current, fmtClock(r.timeLeftMs));
        setClass(leftRowRef.current, 'is-warn', r.timeLeftMs < 10000);
      }
    } else if (r.mode === 'speedtrap') {
      const k = mph ? KMH_TO_MPH : 1;
      setText(trapRef.current, fmtInt(r.trapTotal * k));
      setText(lastRef.current, r.trapLast > 0 ? String(Math.round(r.trapLast * k)) : '—');
    } else if (r.mode === 'drag') {
      setText(distRef.current, `${Math.round(Math.max(0, Math.min(r.dragDistance, r.dragLength)))}`);
    }
  });

  const color = MODE_INFO[mode].color;
  const scoreMode = mode === 'drift' || mode === 'speedtrap';

  return (
    <div className="ax-plate ax-in-left min-w-[19rem] py-[0.7rem] pl-[1rem] pr-[1.6rem]" style={{ '--ac': color } as CSSProperties}>
      <div className="flex items-center gap-[0.6rem]">
        <ModeChip mode={mode} label={event?.modeLabel} />
        <span className="ax-legible max-w-[15rem] truncate font-display text-[0.82rem] font-bold uppercase italic tracking-[0.06em] text-white">{event?.name ?? ''}</span>
      </div>

      <div className="mt-[0.55rem] flex items-end gap-[1.4rem]">
        {/* main figure */}
        {mode === 'drift' ? (
          <div>
            <div className="ax-label">Score</div>
            <span ref={scoreRef} className="ax-display ax-glow text-[2.9rem] text-white" style={{ '--ac': color } as CSSProperties}>
              0
            </span>
          </div>
        ) : mode === 'speedtrap' ? (
          <div>
            <div className="ax-label">Cumul radars</div>
            <div className="flex items-baseline gap-[0.4rem]">
              <span ref={trapRef} className="ax-display ax-glow text-[2.9rem] text-white" style={{ '--ac': color } as CSSProperties}>
                0
              </span>
              <span className="font-display text-[0.8rem] font-bold italic tracking-[0.14em]" style={{ color }}>
                {speedUnit}
              </span>
            </div>
          </div>
        ) : (
          <PositionBig position={position} racers={racers} />
        )}

        {/* side figures */}
        <div className="flex flex-col gap-[0.28rem] pb-[0.25rem]">
          {mode === 'circuit' ? (
            <div className="flex items-baseline gap-[0.5rem]">
              <span className="ax-label">Tour</span>
              <span key={lap} className="ax-display ax-pop text-[1.5rem] text-white">
                {Math.min(lap, laps)}
                <span className="text-[1rem] text-steel">/{laps}</span>
              </span>
            </div>
          ) : null}
          {mode === 'drift' ? (
            <div ref={leftRowRef} className="ax-timeleft flex items-baseline gap-[0.5rem]">
              <Timer className="h-[1rem] w-[1rem] self-center" strokeWidth={2.4} />
              <span ref={leftRef} className="ax-num text-[1.5rem] italic">
                0:00.0
              </span>
            </div>
          ) : (
            <div className="flex items-baseline gap-[0.5rem]">
              <span className="ax-label">Temps</span>
              <span ref={timeRef} className="ax-num ax-legible text-[1.3rem] italic text-white">
                0:00.0
              </span>
            </div>
          )}
          {mode === 'circuit' ? (
            <div className="flex items-baseline gap-[0.5rem] text-[0.82rem]">
              <span className="ax-label">Ce tour</span>
              <span ref={lapRef} className="ax-num text-chrome">
                0:00.0
              </span>
              <span className="ax-label ml-[0.4rem]">Meilleur</span>
              <span ref={bestRef} className="ax-num text-neon-green">
                -:--.---
              </span>
            </div>
          ) : null}
          {mode === 'speedtrap' ? (
            <div className="flex items-baseline gap-[0.5rem] text-[0.82rem]">
              <span className="ax-label">Radars</span>
              <span key={trapsPassed} className="ax-num ax-pop text-[1rem] text-white">
                {trapsPassed}
                <span className="text-steel">/{trapsTotal}</span>
              </span>
              <span className="ax-label ml-[0.4rem]">Dernier</span>
              <span ref={lastRef} className="ax-num text-neon-green">
                —
              </span>
            </div>
          ) : null}
          {mode === 'drag' ? (
            <div className="flex items-baseline gap-[0.5rem] text-[0.82rem]">
              <span className="ax-label">Distance</span>
              <span className="ax-num text-[1rem] text-white">
                <span ref={distRef}>0</span>
                <span className="text-steel"> m</span>
              </span>
            </div>
          ) : null}
          {scoreMode && racers > 1 ? (
            <div className="flex items-baseline gap-[0.5rem] text-[0.82rem]">
              <span className="ax-label">Position</span>
              <span key={position} className="ax-num ax-pop text-[1rem]" style={{ color: position === 1 ? '#ffc233' : '#fff' }}>
                {position}
                <span className="text-steel">/{racers}</span>
              </span>
            </div>
          ) : null}
        </div>
      </div>

      {event?.targets && scoreMode ? <TargetsRow targets={event.targets} mode={mode} suffix={mode === 'speedtrap' ? '' : ''} /> : null}

      {/* progress along the event */}
      <div className="mt-[0.6rem] flex items-center gap-[0.6rem]">
        <div ref={progRef} className="ax-bar flex-1" style={{ height: '0.32rem' }}>
          <i />
        </div>
        {cps > 0 && mode !== 'drag' && mode !== 'drift' ? (
          <span className="ax-num text-[0.72rem] text-chrome">
            CP {Math.min(cp, cps)}/{cps}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Standings (top-right) — rows slide when the order changes (FLIP on transform)
// -----------------------------------------------------------------------------

const MAX_ROWS = 8;

function pickRows(rows: StandingRow[]): StandingRow[] {
  if (rows.length <= MAX_ROWS) return rows;
  const me = rows.findIndex((r) => r.isPlayer);
  if (me < 0 || me < MAX_ROWS) return rows.slice(0, MAX_ROWS);
  return [...rows.slice(0, MAX_ROWS - 1), rows[me]];
}

export function Standings() {
  const standings = usePoll((t) => t.race.standings, 6);
  const mode = usePoll((t) => t.race.mode);
  const rows = pickRows(standings);
  const refs = useRef(new Map<string, HTMLDivElement>());
  const prevIndex = useRef(new Map<string, number>());

  useLayoutEffect(() => {
    const next = new Map<string, number>();
    rows.forEach((r, i) => {
      next.set(r.name, i);
      const before = prevIndex.current.get(r.name);
      const el = refs.current.get(r.name);
      if (el && before !== undefined && before !== i) {
        el.style.setProperty('--dy', `${(before - i) * 2.05}rem`);
        retrigger(el, 'ax-row-anim');
      }
    });
    prevIndex.current = next;
  });

  if (rows.length < 2) return null;
  const color = MODE_INFO[mode].color;
  return (
    <div className="ax-in-right flex w-[17.5rem] flex-col gap-[0.25rem]" style={{ '--ac': color } as CSSProperties}>
      {rows.map((r) => (
        <div
          key={r.name}
          ref={(el) => {
            if (el) refs.current.set(r.name, el);
            else refs.current.delete(r.name);
          }}
          className={cx('ax-stand-row', r.isPlayer && 'is-me', r.finished && 'is-done')}
        >
          <span className="ax-stand-pos">{r.position}</span>
          <span className="flex-1 truncate">{r.name}</span>
          <span className="ax-num text-[0.74rem] opacity-90">{r.detail}</span>
        </div>
      ))}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Drift combo meter (centre)
// -----------------------------------------------------------------------------

export function DriftCombo() {
  const api = useApi();
  const rootRef = useRef<HTMLDivElement>(null);
  const comboRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<HTMLDivElement>(null);
  const angleRef = useRef<HTMLDivElement>(null);
  const angleTxtRef = useRef<HTMLSpanElement>(null);
  const multiplier = usePoll((t) => Math.max(1, Math.round(t.race.driftMultiplier)), 30);

  useFrame(() => {
    const t = api.telemetry;
    const r = t.race;
    const on = r.driftCombo > 0 || t.drifting;
    setClass(rootRef.current, 'is-on', on);
    if (!on) return;
    setText(comboRef.current, `+${fmtInt(r.driftCombo)}`);
    setP(timerRef.current, r.driftComboTimer, 200);
    setClass(timerRef.current, 'is-low', r.driftComboTimer < 0.3 && !t.drifting);
    const a = Math.abs(r.driftAngle);
    setP(angleRef.current, a / 60, 120);
    setText(angleTxtRef.current, `${Math.round(a)}°`);
  });

  return (
    <div ref={rootRef} className="ax-drift ax-tone-pink">
      <div className="flex items-center justify-center gap-[0.9rem]">
        <span ref={comboRef} className="ax-display ax-glow text-[2.6rem] text-white">
          +0
        </span>
        <span key={multiplier} className="ax-display ax-pop ax-drift-mult">
          ×{multiplier}
        </span>
      </div>
      <div ref={timerRef} className="ax-bar ax-drift-timer mx-auto mt-[0.35rem] w-[17rem]" style={{ height: '0.35rem' }}>
        <i />
      </div>
      <div className="mt-[0.4rem] flex items-center justify-center gap-[0.6rem]">
        <span className="ax-label !text-white/70">Angle</span>
        <div ref={angleRef} className="ax-seg w-[9rem]" style={{ '--n': 12, height: '0.5rem', '--ac': '#ffc233' } as CSSProperties}>
          <i />
        </div>
        <span ref={angleTxtRef} className="ax-num ax-legible w-[2.6rem] text-[0.95rem] text-neon-amber">
          0°
        </span>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Drag strip: distance bar + temperature + shift cue
// -----------------------------------------------------------------------------

export function DragStrip() {
  const api = useApi();
  const barRef = useRef<HTMLDivElement>(null);
  const carRef = useRef<HTMLDivElement>(null);
  const tempRef = useRef<HTMLDivElement>(null);
  const tempBoxRef = useRef<HTMLDivElement>(null);
  const tempTxtRef = useRef<HTMLSpanElement>(null);
  const length = usePoll((t) => Math.round(t.race.dragLength));
  const light = usePoll((t) => t.shiftLight, 60);
  const blown = usePoll((t) => t.engineTemp >= 1, 10);

  useFrame(() => {
    const t = api.telemetry;
    const p = t.race.dragLength > 0 ? Math.min(1, Math.max(0, t.race.dragDistance / t.race.dragLength)) : 0;
    setP(barRef.current, p, 600);
    if (carRef.current) carRef.current.style.left = `${(p * 100).toFixed(2)}%`;
    setP(tempRef.current, t.engineTemp, 100);
    setText(tempTxtRef.current, `${Math.round(Math.min(1, t.engineTemp) * 100)}%`);
    setClass(tempBoxRef.current, 'is-warn', t.engineTemp > 0.8);
  });

  return (
    <div className="flex flex-col items-center">
      <div className="flex w-[36rem] max-w-[60vw] items-center gap-[0.7rem]">
        <span className="ax-num ax-legible text-[0.78rem] text-chrome">0</span>
        <div className="relative flex-1">
          <div ref={barRef} className="ax-bar ax-tone-red" style={{ height: '0.5rem' }}>
            <i />
          </div>
          <div className="ax-drag-ticks" />
          <div ref={carRef} className="ax-drag-car" style={{ left: '0%' }} />
        </div>
        <span className="ax-num ax-legible text-[0.78rem] text-white">{length} m</span>
      </div>

      <div ref={tempBoxRef} className="ax-drag-temp mt-[0.7rem]">
        <Thermometer className="h-[1.1rem] w-[1.1rem]" strokeWidth={2.4} />
        <span className="ax-label !text-current">Temp. moteur</span>
        <div ref={tempRef} className="ax-seg w-[11rem]" style={{ '--n': 16, height: '0.6rem' } as CSSProperties}>
          <i />
        </div>
        <span ref={tempTxtRef} className="ax-num w-[2.8rem] text-right text-[0.85rem]">
          0%
        </span>
      </div>

      <div className="mt-[1.1rem] flex h-[4.2rem] items-center justify-center">
        {blown ? (
          <div className="ax-shift-cue is-over">MOTEUR CASSÉ</div>
        ) : light === 'perfect' ? (
          <div className="ax-shift-cue is-perfect">PASSE LE RAPPORT !</div>
        ) : light === 'over' ? (
          <div className="ax-shift-cue is-over">SURRÉGIME !</div>
        ) : null}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Wrong way + countdown
// -----------------------------------------------------------------------------

export function WrongWay() {
  const wrong = usePoll((t) => t.race.active && t.race.wrongWay, 8);
  if (!wrong) return null;
  return (
    <div className="ax-wrongway ax-in-zoom">
      <Undo2 className="h-[1.9rem] w-[1.9rem]" strokeWidth={3} />
      <span className="ax-display text-[1.9rem]">MAUVAIS SENS</span>
    </div>
  );
}

export function Countdown({ event }: { event: ActiveEventInfo | null }) {
  const n = usePoll((t) => t.race.countdown, 60);
  if (n < 0) return null;
  const color = event ? MODE_INFO[event.mode].color : '#22e3ff';
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
      <div className="relative flex h-[14rem] items-center justify-center">
        <div key={`ring-${n}`} className="ax-count-ring" style={{ borderColor: n === 0 ? '#7dff6a' : color }} />
        {n === 0 ? (
          <div key="go" className="ax-display ax-count-go">
            GO!
          </div>
        ) : (
          <div key={n} className="ax-display ax-count-num" style={{ '--ac': n === 1 ? '#ffc233' : color } as CSSProperties}>
            {n}
          </div>
        )}
      </div>
      {n > 0 && event ? (
        <div className="ax-in-up mt-[1.2rem] flex flex-col items-center gap-[0.5rem]">
          <div className="flex items-center gap-[0.7rem]">
            <ModeChip mode={event.mode} label={event.modeLabel} />
            <span className="ax-display ax-legible text-[1.3rem] text-white">{event.name}</span>
          </div>
          {event.hint ? (
            <div className="ax-para bg-ink-900/85 px-[1.6rem] py-[0.4rem] text-[1rem] font-bold tracking-[0.04em] text-chrome">{event.hint}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
