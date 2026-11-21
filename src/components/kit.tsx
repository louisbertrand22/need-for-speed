/* Small shared building blocks: buttons, chips, pips, medals, mode / marker iconography. */
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  Bomb,
  ChevronsUp,
  Flag,
  Gauge,
  Medal as MedalIcon,
  RefreshCw,
  Tornado,
  Warehouse,
  Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { EventMode, MapMarker, Medal, UiSound } from '../core/types';
import { GARAGE_COLOR, MODE_INFO } from '../game/catalog';
import { fmtInt, useSfx } from './hooks';

export type Tone = 'cyan' | 'orange' | 'pink' | 'green' | 'violet' | 'red' | 'amber' | 'blue' | 'steel';

export function cx(...parts: (string | false | null | undefined)[]): string {
  let out = '';
  for (const p of parts) if (p) out += (out ? ' ' : '') + p;
  return out;
}

// -----------------------------------------------------------------------------
// Button
// -----------------------------------------------------------------------------

interface BtnProps {
  children: ReactNode;
  onClick: () => void;
  tone?: Tone;
  size?: 'sm' | 'md' | 'lg';
  solid?: boolean;
  block?: boolean;
  disabled?: boolean;
  /** sound played on click ('none' when the action result decides: buy / error) */
  sound?: UiSound | 'none';
  kbd?: string;
  className?: string;
  title?: string;
  style?: CSSProperties;
  testId?: string;
}

export function Btn({ children, onClick, tone = 'cyan', size = 'md', solid, block, disabled, sound = 'click', kbd, className, title, style, testId }: BtnProps) {
  const sfx = useSfx();
  return (
    <button
      type="button"
      title={title}
      data-testid={testId}
      disabled={disabled}
      style={style}
      className={cx('ax-btn', `ax-tone-${tone}`, size === 'sm' && 'ax-btn-sm', size === 'lg' && 'ax-btn-lg', solid && 'ax-btn-solid', block && 'ax-btn-block', className)}
      onMouseEnter={() => {
        if (!disabled) sfx.hover();
      }}
      onClick={(e) => {
        e.currentTarget.blur();
        if (sound !== 'none') sfx.play(sound);
        onClick();
      }}
    >
      {children}
      {kbd ? <span className={cx('ax-key', !solid && 'ax-key-dark')}>{kbd}</span> : null}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Mode / marker iconography
// -----------------------------------------------------------------------------

export const MODE_ICONS: Record<EventMode, LucideIcon> = {
  sprint: Flag,
  circuit: RefreshCw,
  drift: Tornado,
  drag: Zap,
  speedtrap: Gauge,
};

export const MODE_ORDER: EventMode[] = ['sprint', 'circuit', 'drift', 'drag', 'speedtrap'];

export function modeColor(mode: EventMode): string {
  return MODE_INFO[mode].color;
}

export function markerColor(m: MapMarker): string {
  if (m.kind === 'event' && m.event) return MODE_INFO[m.event.mode].color;
  if (m.kind === 'garage') return GARAGE_COLOR;
  return m.color || '#ffffff';
}

export function markerIcon(m: MapMarker): LucideIcon {
  if (m.kind === 'event' && m.event) return MODE_ICONS[m.event.mode];
  if (m.kind === 'garage') return Warehouse;
  if (m.kind === 'breaker') return Bomb;
  return ChevronsUp;
}

export const MARKER_KIND_LABEL: Record<MapMarker['kind'], string> = {
  garage: 'Garage',
  event: 'Épreuve',
  breaker: 'Brise-poursuite',
  ramp: 'Tremplin',
};

export function ModeChip({ mode, label, className }: { mode: EventMode; label?: string; className?: string }) {
  const Icon = MODE_ICONS[mode];
  return (
    <span className={cx('ax-chip', className)} style={{ '--ac': MODE_INFO[mode].color } as CSSProperties}>
      <Icon size="1.05em" strokeWidth={2.4} />
      {label ?? MODE_INFO[mode].label}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Pips, medals
// -----------------------------------------------------------------------------

/** Difficulty / level pips (skewed blocks). */
export function Pips({ value, max = 5, color = '#ffc233', size = '0.5rem' }: { value: number; max?: number; color?: string; size?: string }) {
  const pips = [];
  for (let i = 0; i < max; i++) {
    const on = i < value;
    pips.push(
      <i
        key={i}
        style={{
          width: size,
          height: `calc(${size} * 1.7)`,
          background: on ? color : 'rgba(255,255,255,0.13)',
          boxShadow: on ? `0 0 0.4rem ${color}` : undefined,
          transform: 'skewX(-16deg)',
          display: 'block',
        }}
      />,
    );
  }
  return <span className="inline-flex items-center gap-[0.18rem]">{pips}</span>;
}

export const MEDAL_INFO: Record<Medal, { label: string; color: string }> = {
  gold: { label: 'Or', color: '#ffc233' },
  silver: { label: 'Argent', color: '#cfd6e4' },
  bronze: { label: 'Bronze', color: '#d98a4a' },
};

export function MedalBadge({ medal, size = '1.1rem', withLabel }: { medal: Medal; size?: string; withLabel?: boolean }) {
  const info = MEDAL_INFO[medal];
  return (
    <span className="inline-flex items-center gap-[0.3em]" style={{ color: info.color }}>
      <MedalIcon style={{ width: size, height: size, filter: `drop-shadow(0 0 0.35rem ${info.color})` }} strokeWidth={2.2} />
      {withLabel ? <span className="font-display text-[0.8em] font-bold uppercase italic tracking-wider">{info.label}</span> : null}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Animated number (tick-up) — eased with rAF, writes textContent directly
// -----------------------------------------------------------------------------

export function TickNumber({
  value,
  duration = 900,
  delay = 0,
  prefix = '',
  suffix = '',
  className,
  style,
}: {
  value: number;
  duration?: number;
  delay?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const start = performance.now() + delay;
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      const e = 1 - Math.pow(1 - t, 3);
      const v = a + (value - a) * e;
      el.textContent = `${prefix}${fmtInt(v)}${suffix}`;
      if (t < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, duration, delay, prefix, suffix]);
  return (
    <span ref={ref} className={className} style={style}>
      {prefix}
      {fmtInt(0)}
      {suffix}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Inline error line (ActionResult failures)
// -----------------------------------------------------------------------------

export function ErrorLine({ error, nonce, className }: { error: string | null; nonce: number; className?: string }) {
  if (!error) return null;
  return (
    <div
      key={nonce}
      role="alert"
      data-testid="action-error"
      className={cx('ax-shake flex items-center gap-2 border border-neon-red/60 bg-neon-red/15 px-3 py-1.5 text-[0.9rem] font-bold text-neon-red', className)}
    >
      <span className="ax-display text-[0.8rem]">!</span>
      {error}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Delayed mount helper for staged reveals
// -----------------------------------------------------------------------------

export function useStage(steps: number, stepMs: number, startMs = 0): number {
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const timers: number[] = [];
    for (let i = 1; i <= steps; i++) timers.push(window.setTimeout(() => setStage(i), startMs + i * stepMs));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [steps, stepMs, startMs]);
  return stage;
}

/** Section title with a skewed neon tick. */
export function SectionTitle({ children, right, className }: { children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <i className="block h-[0.95rem] w-[0.3rem] -skew-x-12" style={{ background: 'var(--ac)', boxShadow: '0 0 0.5rem var(--ac)' }} />
      <span className="ax-label !text-[0.78rem] !text-chrome">{children}</span>
      <i className="h-px flex-1 bg-gradient-to-r from-white/20 to-transparent" />
      {right}
    </div>
  );
}
