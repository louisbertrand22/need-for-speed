/* =============================================================================
 * Driving HUD (screens: freeroam, countdown, race).
 * Layout: speed FX behind everything · top-left info strip / race panel ·
 * top-right standings + toasts · centre column (banner, mode widget, pop-ups) ·
 * bottom-left radar · bottom-centre prompt + pursuit · bottom-right gauges.
 * High-frequency values never go through React state (see hooks.ts / useFrame).
 * ===========================================================================*/
import type { CSSProperties } from 'react';
import { CarFront, Lock, Navigation } from 'lucide-react';
import { MIRROR_RECT } from '../core/types';
import type { InteractionPrompt, MapMarker } from '../core/types';
import { MAX_REP_LEVEL, REP_TITLES, getCarSpec } from '../game/catalog';
import { GaugeCluster } from './Gauges';
import { fmtInt, usePoll, useUI } from './hooks';
import { TickNumber, cx, markerColor } from './kit';
import { BannerSlot, PopStack, ShiftTag, usePopups } from './Popups';
import { PursuitHUD } from './PursuitHUD';
import { Countdown, DragStrip, DriftCombo, RacePanel, Standings, WrongWay } from './RaceInfo';
import { Radar } from './Radar';
import { SpeedFx } from './SpeedFx';
import { Toasts } from './Toasts';

// -----------------------------------------------------------------------------
// Free-roam strip (top-left)
// -----------------------------------------------------------------------------

function fmtDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1).replace('.', ',')} km`;
  return `${Math.round(m / 10) * 10} m`;
}

function GpsLine({ marker }: { marker: MapMarker }) {
  const dist = usePoll((t) => Math.round(Math.hypot(marker.x - t.x, marker.z - t.z) / 10) * 10, 3);
  return (
    <div className="ax-in-left mt-[0.5rem] flex items-center gap-[0.5rem] text-[0.92rem]">
      <Navigation className="h-[1rem] w-[1rem] text-neon-violet" strokeWidth={2.6} fill="currentColor" />
      <span className="ax-label !text-neon-violet">GPS</span>
      <span className="ax-legible max-w-[14rem] truncate font-bold text-white">{marker.label}</span>
      <span className="ax-num ax-legible text-[0.82rem] text-neon-violet">{fmtDistance(dist)}</span>
    </div>
  );
}

function FreeRoamStrip() {
  const money = useUI((s) => s.profile.money);
  const rep = useUI((s) => s.profile.rep);
  const level = useUI((s) => s.repLevel);
  const floor = useUI((s) => s.repLevelFloor);
  const ceil = useUI((s) => s.repLevelCeil);
  const carId = useUI((s) => s.profile.currentCarId);
  const gpsId = useUI((s) => s.gpsTargetId);
  const markers = useUI((s) => s.markers);
  const gps = gpsId ? markers.find((m) => m.id === gpsId) : undefined;
  const car = getCarSpec(carId);
  const maxed = level >= MAX_REP_LEVEL;
  const p = maxed ? 1 : Math.min(1, Math.max(0, (rep - floor) / Math.max(1, ceil - floor)));
  const title = REP_TITLES[Math.min(REP_TITLES.length - 1, Math.max(0, level - 1))];

  return (
    <div className="ax-in-left flex items-stretch gap-[0.8rem]">
      <div className="ax-rep-badge">
        <span className="text-[0.56rem] font-bold tracking-[0.2em] text-ink-900">REP</span>
        <span key={level} className="ax-display ax-pop text-[1.75rem] text-ink-950">
          {level}
        </span>
      </div>
      <div className="flex flex-col justify-center">
        <div className="flex items-baseline gap-[0.9rem]">
          <TickNumber value={money} suffix={' $'} duration={700} className="ax-display ax-legible text-[1.7rem] text-neon-green" />
          <span className="ax-legible font-display text-[0.72rem] font-bold uppercase italic tracking-[0.1em] text-neon-cyan">{title}</span>
        </div>
        <div className="mt-[0.3rem] flex items-center gap-[0.6rem]">
          <div className="ax-bar ax-bar-anim w-[13.5rem]" style={{ '--p': p, height: '0.34rem' } as CSSProperties}>
            <i />
          </div>
          <span className="ax-num ax-legible text-[0.68rem] text-chrome">{maxed ? 'MAX' : `${fmtInt(rep)} / ${fmtInt(ceil)}`}</span>
        </div>
        <div className="mt-[0.45rem] flex items-center gap-[0.45rem] text-[0.9rem]">
          <CarFront className="h-[1rem] w-[1rem] text-steel" strokeWidth={2.3} />
          <span className="ax-legible font-bold text-chrome">{car.name}</span>
        </div>
        {gps ? <GpsLine marker={gps} /> : null}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Interaction prompt (bottom-centre)
// -----------------------------------------------------------------------------

function PromptCard({ prompt }: { prompt: InteractionPrompt }) {
  const markers = useUI((s) => s.markers);
  const marker = markers.find((m) => m.id === prompt.markerId);
  const color = prompt.locked ? '#ff3344' : marker ? markerColor(marker) : '#22e3ff';
  return (
    <div key={`${prompt.markerId}-${prompt.locked}`} className={cx('ax-prompt ax-in-up', prompt.locked && 'is-locked')} style={{ '--ac': color } as CSSProperties}>
      {prompt.locked ? (
        <span className="ax-prompt-lock">
          <Lock className="h-[1.3rem] w-[1.3rem]" strokeWidth={2.6} />
        </span>
      ) : (
        <span className="ax-key ax-prompt-key">{prompt.key}</span>
      )}
      <span className="flex min-w-0 flex-col">
        <span className="ax-display truncate text-[1.15rem] text-white">{prompt.title}</span>
        {prompt.subtitle ? <span className="truncate text-[0.95rem] font-bold" style={{ color }}>{prompt.subtitle}</span> : null}
      </span>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Rear-view mirror bezel: exactly around MIRROR_RECT, transparent inside
// -----------------------------------------------------------------------------

function MirrorFrame() {
  return (
    <div
      className="ax-mirror"
      style={{
        top: `${MIRROR_RECT.top}px`,
        width: `min(${MIRROR_RECT.maxWidth}px, ${MIRROR_RECT.widthFrac * 100}vw)`,
        aspectRatio: String(MIRROR_RECT.aspect),
      }}
    >
      <i className="ax-mirror-stem" />
      <i className="ax-mirror-glass" />
      <i className="ax-mirror-corner is-tl" />
      <i className="ax-mirror-corner is-tr" />
      <i className="ax-mirror-corner is-bl" />
      <i className="ax-mirror-corner is-br" />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Root
// -----------------------------------------------------------------------------

export function RaceHUD() {
  const screen = useUI((s) => s.screen);
  const settings = useUI((s) => s.profile.settings);
  const prompt = useUI((s) => s.prompt);
  const activeEvent = useUI((s) => s.activeEvent);
  const raceActive = usePoll((t) => t.race.active, 10);
  const raceMode = usePoll((t) => t.race.mode, 10);
  const popups = usePopups();

  const inEvent = raceActive || (screen !== 'freeroam' && activeEvent !== null);
  const mode = activeEvent ? activeEvent.mode : raceMode;
  const drag = inEvent && mode === 'drag';
  const drift = inEvent && mode === 'drift';

  return (
    <div className="absolute inset-0" data-testid="race-hud">
      <SpeedFx lines={settings.speedLines} />
      {settings.mirror ? <MirrorFrame /> : null}

      {/* top-left */}
      <div className="absolute left-[1.3rem] top-[1.2rem]">{inEvent ? <RacePanel event={activeEvent} /> : <FreeRoamStrip />}</div>

      {/* top-right */}
      <div className="absolute right-[1.3rem] top-[1.2rem] flex flex-col items-end gap-[0.8rem]">
        {inEvent ? <Standings /> : null}
        <Toasts />
      </div>

      {/* centre column */}
      <div className="absolute left-1/2 top-[8.3rem] flex -translate-x-1/2 flex-col items-center">
        {drag ? <DragStrip /> : null}
        <BannerSlot banner={popups.state.banner} onDone={popups.clearBanner} />
        {drift ? <DriftCombo /> : null}
        <WrongWay />
        <PopStack stack={popups.state.stack} onDone={popups.removePop} />
      </div>

      {screen !== 'freeroam' ? <Countdown event={activeEvent} /> : null}

      {/* bottom-left */}
      <div className="absolute bottom-[1.1rem] left-[1.3rem]">
        <Radar showMarkers={!inEvent} />
      </div>

      {/* bottom-centre */}
      <div className="absolute bottom-[1.3rem] left-1/2 flex -translate-x-1/2 flex-col items-center gap-[0.8rem]">
        {prompt && screen === 'freeroam' ? <PromptCard prompt={prompt} /> : null}
        <PursuitHUD />
      </div>

      {/* bottom-right */}
      <div className="absolute bottom-[20.6rem] right-[3.2rem] flex w-[16rem] justify-center">
        <ShiftTag pop={popups.state.shift} onDone={popups.clearShift} />
      </div>
      <GaugeCluster dragMode={drag} />
    </div>
  );
}

export default RaceHUD;
