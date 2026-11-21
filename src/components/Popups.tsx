/* =============================================================================
 * Transient pop-ups fed by api.onEvent: a banner slot (one at a time), a centre
 * stack (auto-collapsing, never overlapping) and the shift-quality tag near the
 * tachometer.
 * ===========================================================================*/
import { useCallback, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import type { GameUiEvent, ShiftQuality } from '../core/types';
import { KMH_TO_MPH, fmtInt, fmtTime, useGameEvent, useUI } from './hooks';
import { cx } from './kit';

interface Pop {
  id: number;
  text: string;
  sub?: string;
  color: string;
  size: 'sm' | 'md' | 'lg';
  ttl: number;
}

interface Banner {
  id: number;
  title: string;
  subtitle: string;
  color: string;
  police: boolean;
  ttl: number;
}

const C = {
  cyan: '#22e3ff',
  orange: '#ff7a1a',
  pink: '#ff2d95',
  green: '#7dff6a',
  violet: '#b48cff',
  red: '#ff3344',
  amber: '#ffc233',
  blue: '#3a8bff',
};

const QUALITY: Record<ShiftQuality, { text: string; color: string } | null> = {
  perfect: { text: 'PARFAIT !', color: C.green },
  good: { text: 'BON', color: C.cyan },
  early: { text: 'TROP TÔT', color: C.amber },
  late: { text: 'TROP TARD', color: C.red },
  auto: null,
};

const MAX_STACK = 4;

export interface PopupState {
  banner: Banner | null;
  stack: Pop[];
  shift: Pop | null;
}

/** Subscribes to engine events and returns what should currently be displayed. */
export function usePopups(): { state: PopupState; removePop: (id: number) => void; clearBanner: (id: number) => void; clearShift: (id: number) => void } {
  const units = useUI((s) => s.profile.settings.units);
  const [state, setState] = useState<PopupState>({ banner: null, stack: [], shift: null });
  const seq = useRef(1);

  useGameEvent((e: GameUiEvent) => {
    const id = seq.current++;
    const pop = (text: string, color: string, sub?: string, size: Pop['size'] = 'md', ttl = 1.7) =>
      setState((s) => ({ ...s, stack: [...s.stack.slice(-(MAX_STACK - 1)), { id, text, sub, color, size, ttl }] }));
    const banner = (title: string, subtitle: string, color: string, police = false, ttl = 2.6) =>
      setState((s) => ({ ...s, banner: { id, title, subtitle, color, police, ttl } }));

    switch (e.type) {
      case 'nearMiss':
        pop('FRÔLEMENT', C.cyan, `+${fmtInt(e.bonus)}`, 'sm', 1.4);
        break;
      case 'shift': {
        const q = QUALITY[e.quality];
        if (q) setState((s) => ({ ...s, shift: { id, text: q.text, sub: 'Rapport', color: q.color, size: 'md', ttl: 1.1 } }));
        break;
      }
      case 'launch': {
        const q = QUALITY[e.quality];
        if (q) pop(e.quality === 'perfect' ? 'DÉPART PARFAIT !' : e.quality === 'good' ? 'BON DÉPART' : e.quality === 'early' ? 'DÉPART TROP MOU' : 'DÉPART PATINÉ', q.color, undefined, 'lg', 1.9);
        break;
      }
      case 'checkpoint':
        pop(`CHECKPOINT ${e.index}/${e.total}`, C.cyan, fmtTime(e.splitMs), 'sm', 1.6);
        break;
      case 'lap':
        if (e.lap > e.laps) break;
        banner(
          e.lap === e.laps ? 'DERNIER TOUR' : `TOUR ${e.lap}/${e.laps}`,
          `${e.best ? 'Meilleur tour · ' : 'Tour précédent · '}${fmtTime(e.lapTimeMs)}`,
          e.lap === e.laps ? C.pink : C.amber,
        );
        break;
      case 'driftBank':
        pop(`+${fmtInt(e.points)}`, C.pink, `×${e.multiplier}`, e.points >= 5000 ? 'lg' : 'md', 1.8);
        break;
      case 'driftLost':
        pop('COMBO PERDU', C.red, e.points > 0 ? `−${fmtInt(e.points)}` : undefined, 'md', 1.6);
        break;
      case 'wallBonus':
        pop('RASE-MUR', C.amber, 'Bonus', 'sm', 1.4);
        break;
      case 'speedtrap': {
        const mph = units === 'mph';
        pop(`${Math.round(e.speedKmh * (mph ? KMH_TO_MPH : 1))} ${mph ? 'MPH' : 'KM/H'}`, C.green, `Radar ${e.index + 1}`, 'lg', 2.1);
        break;
      }
      case 'jump':
        pop(`SAUT ${Math.round(e.distance)} m`, C.violet, `${e.airTime.toFixed(1)} s en l’air`, 'md', 1.9);
        break;
      case 'heatUp':
        banner(`NIVEAU DE RECHERCHE ${e.heat}`, 'La police durcit le ton', C.red, true);
        break;
      case 'pursuit':
        if (e.phase === 'start') banner('POURSUITE !', 'Sème les unités ou neutralise-les', C.red, true);
        else if (e.phase === 'cooldown') banner('HORS DE VUE', 'Planque-toi le temps que ça se calme', C.blue);
        else if (e.phase === 'resumed') banner('REPÉRÉ !', 'La poursuite reprend', C.red, true);
        else if (e.phase === 'evaded') banner('ÉVASION RÉUSSIE', 'La police a perdu ta trace', C.green, false, 3);
        else banner('ARRÊTÉ', 'Fin de la cavale', C.red, true, 3);
        break;
      case 'copDown':
        pop('UNITÉ NEUTRALISÉE', C.orange, `+${fmtInt(e.bounty)} de prime`, 'md', 1.9);
        break;
      case 'breaker':
        pop('BRISE-POURSUITE', C.orange, e.name, 'lg', 2.2);
        break;
      case 'banner':
        banner(e.title, e.subtitle, e.tone === 'good' ? C.green : e.tone === 'bad' ? C.red : e.tone === 'police' ? C.red : C.cyan, e.tone === 'police');
        break;
      default:
        break;
    }
  });

  const removePop = useCallback((id: number) => setState((s) => ({ ...s, stack: s.stack.filter((p) => p.id !== id) })), []);
  const clearBanner = useCallback((id: number) => setState((s) => (s.banner && s.banner.id === id ? { ...s, banner: null } : s)), []);
  const clearShift = useCallback((id: number) => setState((s) => (s.shift && s.shift.id === id ? { ...s, shift: null } : s)), []);
  return { state, removePop, clearBanner, clearShift };
}

export function BannerSlot({ banner, onDone }: { banner: Banner | null; onDone: (id: number) => void }) {
  return (
    <div className="relative flex h-[4.6rem] w-[44rem] max-w-[92vw] items-center justify-center">
      {banner ? (
        <div
          key={banner.id}
          className={cx('ax-banner', banner.police && 'is-police')}
          style={{ '--ac': banner.color, animationDuration: `${banner.ttl}s` } as CSSProperties}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) onDone(banner.id);
          }}
        >
          <div className="ax-banner-bar" />
          <div className="px-8 py-[0.45rem] text-center">
            <div className="ax-display ax-glow text-[1.9rem] text-white">{banner.title}</div>
            {banner.subtitle ? <div className="mt-[0.2rem] text-[0.95rem] font-bold uppercase tracking-[0.16em]" style={{ color: banner.color }}>{banner.subtitle}</div> : null}
          </div>
          <div className="ax-banner-bar" />
        </div>
      ) : null}
    </div>
  );
}

export function PopStack({ stack, onDone }: { stack: Pop[]; onDone: (id: number) => void }) {
  return (
    <div className="flex flex-col items-center">
      {stack.map((p) => (
        <div
          key={p.id}
          className="ax-pop-wrap"
          style={{ animationDelay: `${p.ttl * 0.86}s`, animationDuration: `${p.ttl * 0.14}s` }}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) onDone(p.id);
          }}
        >
          <div className="ax-pop-inner">
            <div className={cx('ax-popup', `is-${p.size}`)} style={{ '--ac': p.color, animationDuration: `${p.ttl}s` } as CSSProperties}>
              <span className="ax-display ax-glow">{p.text}</span>
              {p.sub ? <span className="ax-popup-sub">{p.sub}</span> : null}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/** Shift quality tag, anchored above the tachometer. */
export function ShiftTag({ pop, onDone }: { pop: Pop | null; onDone: (id: number) => void }) {
  if (!pop) return null;
  return (
    <div
      key={pop.id}
      className="ax-popup is-md"
      style={{ '--ac': pop.color, animationDuration: `${pop.ttl}s` } as CSSProperties}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) onDone(pop.id);
      }}
    >
      <span className="ax-display ax-glow">{pop.text}</span>
    </div>
  );
}
