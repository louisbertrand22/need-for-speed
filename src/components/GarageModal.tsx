/* =============================================================================
 * Garage (screen === 'garage'): the 3D turntable shows through the centre (left
 * empty and click-through so the engine can orbit the camera); the catalogue /
 * tuning / style panel docks left, the stats panel docks right.
 * ===========================================================================*/
import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowDownUp,
  Check,
  CircleDot,
  Cog,
  Disc3,
  Flame,
  GitFork,
  KeyRound,
  Lock,
  LogOut,
  Move3d,
  Paintbrush,
  Warehouse,
  Wind,
  Wrench,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ActionResult, CarSpec, CarVisuals, PerfStats, TuneLevel, TunePart, TuningState } from '../core/types';
import {
  BODY_KITS,
  CAR_CATALOG,
  CITY_NAME,
  GARAGE_COLOR,
  NEON_COLORS,
  NEON_PRICE,
  NITRO_COLORS,
  NITRO_COLOR_PRICE,
  PAINT_COLORS,
  PAINT_COLOR_PRICE,
  PAINT_FINISHES,
  RIM_COLORS,
  RIM_COLOR_PRICE,
  RIM_STYLES,
  SPOILERS,
  STOCK_TUNING,
  TUNE_INFO,
  TUNE_LEVEL_NAMES,
  TUNE_LEVEL_REP,
  TUNE_PARTS,
  WINDOW_TINTS,
  getCarSpec,
  upgradePrice,
  visualsEqual,
  visualsPrice,
} from '../game/catalog';
import { KMH_TO_MPH, fmtInt, fmtMoney, useApi, useFlashError, useKey, useSfx, useUI } from './hooks';
import { Btn, ErrorLine, SectionTitle, TickNumber, cx } from './kit';
import { Toasts } from './Toasts';

export type GarageTab = 'cars' | 'perf' | 'style';

const PART_ICONS: Record<TunePart, LucideIcon> = {
  engine: Cog,
  turbo: Wind,
  transmission: GitFork,
  suspension: ArrowDownUp,
  brakes: Disc3,
  tires: CircleDot,
  nitro: Flame,
};

const DRIVETRAIN_LABEL = { FWD: 'Traction', RWD: 'Propulsion', AWD: 'Intégrale' } as const;

const TABS: { id: GarageTab; label: string; icon: LucideIcon }[] = [
  { id: 'cars', label: 'Voitures', icon: KeyRound },
  { id: 'perf', label: 'Performance', icon: Wrench },
  { id: 'style', label: 'Style', icon: Paintbrush },
];

// -----------------------------------------------------------------------------
// Cars tab
// -----------------------------------------------------------------------------

function CarCard({ spec, selected, owned, current, locked, onSelect }: { spec: CarSpec; selected: boolean; owned: boolean; current: boolean; locked: boolean; onSelect: () => void }) {
  const sfx = useSfx();
  return (
    <button
      type="button"
      data-testid={`car-${spec.id}`}
      className={cx('ax-car-card', selected && 'is-on', locked && !owned && 'is-locked')}
      onMouseEnter={sfx.hover}
      onClick={(e) => {
        e.currentTarget.blur();
        sfx.click();
        onSelect();
      }}
    >
      <span className="flex items-center justify-between gap-[0.6rem]">
        <span className="ax-label !text-[0.66rem]" style={{ color: selected ? 'var(--ac)' : undefined }}>
          {spec.categoryLabel}
        </span>
        {current ? (
          <span className="ax-chip ax-tone-green !text-[0.62rem]">
            <Check size="1em" strokeWidth={3.4} /> Équipée
          </span>
        ) : owned ? (
          <span className="ax-chip ax-tone-cyan !text-[0.62rem]">Possédée</span>
        ) : locked ? (
          <span className="ax-chip ax-tone-red !text-[0.62rem]">
            <Lock size="1em" strokeWidth={3} /> REP {spec.repLevel}
          </span>
        ) : (
          <span className="ax-num text-[0.9rem] italic text-neon-green">{fmtMoney(spec.price)}</span>
        )}
      </span>
      <span className="ax-display mt-[0.25rem] block text-[1.12rem] text-white">{spec.name}</span>
      <span className="mt-[0.2rem] block truncate text-[0.88rem] font-semibold text-chrome/85">{spec.tagline}</span>
      <span className="mt-[0.3rem] flex items-center gap-[0.7rem] text-[0.74rem] font-bold uppercase tracking-[0.08em] text-steel">
        <span>{DRIVETRAIN_LABEL[spec.drivetrain]}</span>
        <i className="h-[0.25rem] w-[0.25rem] rotate-45 bg-steel" />
        <span>{spec.powerHp} ch</span>
        <i className="h-[0.25rem] w-[0.25rem] rotate-45 bg-steel" />
        <span>{fmtInt(spec.massKg)} kg</span>
        {!owned && locked ? <span className="ax-num ml-auto text-[0.8rem] normal-case italic text-white/45">{fmtMoney(spec.price)}</span> : null}
      </span>
    </button>
  );
}

// -----------------------------------------------------------------------------
// Performance tab
// -----------------------------------------------------------------------------

function LevelPips({ level, preview }: { level: number; preview: boolean }) {
  return (
    <span className="flex items-center gap-[0.2rem]">
      {[0, 1, 2, 3].map((i) => (
        <i key={i} className={cx('ax-lvl-pip', i <= level && 'is-on', preview && i === level + 1 && 'is-next')} title={TUNE_LEVEL_NAMES[i]} />
      ))}
    </span>
  );
}

function PartRow({
  part,
  spec,
  level,
  repLevel,
  money,
  enabled,
  hovered,
  onHover,
  onBuy,
}: {
  part: TunePart;
  spec: CarSpec;
  level: TuneLevel;
  repLevel: number;
  money: number;
  enabled: boolean;
  hovered: boolean;
  onHover: (part: TunePart | null) => void;
  onBuy: (part: TunePart, level: TuneLevel) => void;
}) {
  const info = TUNE_INFO[part];
  const Icon = PART_ICONS[part];
  const maxed = level >= 3;
  const next = (maxed ? 3 : level + 1) as TuneLevel;
  const price = maxed ? 0 : upgradePrice(spec, part, next);
  const repNeeded = TUNE_LEVEL_REP[next];
  const repLocked = !maxed && repLevel < repNeeded;
  const poor = !maxed && money < price;
  return (
    <div className={cx('ax-part-row', hovered && 'is-hover')} data-testid={`part-${part}`} onMouseEnter={() => onHover(maxed ? null : part)} onMouseLeave={() => onHover(null)}>
      <div className="flex items-center gap-[0.6rem]">
        <span className="ax-part-ico">
          <Icon className="h-[1.1rem] w-[1.1rem]" strokeWidth={2.3} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-[0.6rem]">
            <span className="ax-display text-[0.98rem] text-white">{info.label}</span>
            <span className="flex items-center gap-[0.5rem]">
              <span className="font-display text-[0.66rem] font-bold uppercase italic tracking-[0.1em]" style={{ color: 'var(--ac)' }}>
                {TUNE_LEVEL_NAMES[level]}
              </span>
              <LevelPips level={level} preview={hovered && !maxed} />
            </span>
          </span>
          <span className="block truncate text-[0.84rem] font-semibold text-chrome/80">{info.levels[level]}</span>
        </span>
      </div>
      <div className="mt-[0.4rem] flex items-center justify-between gap-[0.6rem] pl-[2.6rem]">
        {maxed ? (
          <span className="text-[0.82rem] font-bold uppercase tracking-[0.12em] text-neon-green">Niveau maximum atteint</span>
        ) : (
          <>
            <span className="min-w-0">
              <span className="block truncate text-[0.84rem] font-bold text-white">
                <span className="text-neon-green">▸ {TUNE_LEVEL_NAMES[next]}</span> · {info.levels[next]}
              </span>
              <span className="block text-[0.72rem] font-bold uppercase tracking-[0.08em] text-steel">
                {info.affects}
                {repLocked ? <span className="ml-[0.6rem] text-neon-red">REP {repNeeded} requis</span> : null}
              </span>
            </span>
            <Btn
              size="sm"
              tone={repLocked ? 'red' : poor ? 'steel' : 'green'}
              sound="none"
              disabled={!enabled}
              testId={`buy-${part}`}
              onClick={() => onBuy(part, next)}
              className="shrink-0"
            >
              {repLocked ? <Lock size="1em" strokeWidth={3} /> : null}
              {fmtMoney(price)}
            </Btn>
          </>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Style tab
// -----------------------------------------------------------------------------

function StyleSection({ title, price, value, children }: { title: string; price?: number; value?: string; children: ReactNode }) {
  return (
    <div className="mb-[0.85rem]">
      <SectionTitle
        right={
          <span className="flex items-baseline gap-[0.6rem]">
            {value ? <span className="max-w-[10rem] truncate text-[0.82rem] font-bold text-white">{value}</span> : null}
            {price !== undefined ? <span className="ax-num text-[0.72rem] italic text-neon-green">{fmtMoney(price)}</span> : null}
          </span>
        }
      >
        {title}
      </SectionTitle>
      <div className="mt-[0.45rem]">{children}</div>
    </div>
  );
}

function Swatch({ hex, name, selected, saved, onClick, testId }: { hex: string | null; name: string; selected: boolean; saved: boolean; onClick: () => void; testId?: string }) {
  const sfx = useSfx();
  return (
    <button
      type="button"
      title={name}
      aria-label={name}
      data-testid={testId}
      className={cx('ax-swatch', selected && 'is-on', hex === null && 'is-none')}
      style={{ '--sw': hex ?? 'transparent' } as CSSProperties}
      onMouseEnter={sfx.hover}
      onClick={(e) => {
        e.currentTarget.blur();
        sfx.click();
        onClick();
      }}
    >
      {saved ? <i className="ax-swatch-saved" /> : null}
    </button>
  );
}

function OptBtn({ label, sub, price, selected, saved, onClick, testId }: { label: string; sub?: string; price: number; selected: boolean; saved: boolean; onClick: () => void; testId?: string }) {
  const sfx = useSfx();
  return (
    <button
      type="button"
      data-testid={testId}
      className={cx('ax-opt-btn', selected && 'is-on')}
      onMouseEnter={sfx.hover}
      onClick={(e) => {
        e.currentTarget.blur();
        sfx.click();
        onClick();
      }}
    >
      <span className="block truncate text-[0.9rem] font-bold leading-tight">{label}</span>
      {sub ? <span className="block truncate text-[0.7rem] font-semibold leading-tight opacity-70">{sub}</span> : null}
      <span className="ax-num mt-[0.1rem] block text-[0.68rem] italic opacity-90">{saved ? 'INSTALLÉ' : price > 0 ? fmtMoney(price) : 'GRATUIT'}</span>
    </button>
  );
}

function StyleTab({ saved, preview, onApply }: { saved: CarVisuals; preview: CarVisuals; onApply: (patch: Partial<CarVisuals>) => void }) {
  const nameOf = (list: { name: string; hex: string | null }[], hex: string | null) => list.find((c) => c.hex === hex)?.name ?? 'Personnalisée';
  return (
    <>
      <StyleSection title="Finition peinture" value={PAINT_FINISHES.find((f) => f.id === preview.paintFinish)?.name}>
        <div className="grid grid-cols-3 gap-[0.4rem]">
          {PAINT_FINISHES.map((f) => (
            <OptBtn key={f.id} testId={`finish-${f.id}`} label={f.name} price={f.price} selected={preview.paintFinish === f.id} saved={saved.paintFinish === f.id} onClick={() => onApply({ paintFinish: f.id })} />
          ))}
        </div>
      </StyleSection>

      <StyleSection title="Couleur" price={PAINT_COLOR_PRICE} value={nameOf(PAINT_COLORS, preview.paintColor)}>
        <div className="grid grid-cols-8 gap-[0.4rem]">
          {PAINT_COLORS.map((c, i) => (
            <Swatch key={c.hex} testId={`paint-${i}`} hex={c.hex} name={c.name} selected={preview.paintColor === c.hex} saved={saved.paintColor === c.hex} onClick={() => onApply({ paintColor: c.hex })} />
          ))}
        </div>
      </StyleSection>

      <StyleSection title="Jantes" value={RIM_STYLES[preview.rimStyle]?.name}>
        <div className="grid grid-cols-3 gap-[0.4rem]">
          {RIM_STYLES.map((r, i) => (
            <OptBtn key={r.name} testId={`rim-${i}`} label={r.name} price={r.price} selected={preview.rimStyle === i} saved={saved.rimStyle === i} onClick={() => onApply({ rimStyle: i })} />
          ))}
        </div>
      </StyleSection>

      <StyleSection title="Couleur des jantes" price={RIM_COLOR_PRICE} value={nameOf(RIM_COLORS, preview.rimColor)}>
        <div className="grid grid-cols-9 gap-[0.4rem]">
          {RIM_COLORS.map((c, i) => (
            <Swatch key={c.hex} testId={`rimcolor-${i}`} hex={c.hex} name={c.name} selected={preview.rimColor === c.hex} saved={saved.rimColor === c.hex} onClick={() => onApply({ rimColor: c.hex })} />
          ))}
        </div>
      </StyleSection>

      <StyleSection title="Aileron" value={SPOILERS[preview.spoiler]?.name}>
        <div className="grid grid-cols-3 gap-[0.4rem]">
          {SPOILERS.map((s, i) => (
            <OptBtn key={s.name} testId={`spoiler-${i}`} label={s.name} price={s.price} selected={preview.spoiler === i} saved={saved.spoiler === i} onClick={() => onApply({ spoiler: i })} />
          ))}
        </div>
      </StyleSection>

      <StyleSection title="Kit carrosserie" value={BODY_KITS[preview.bodyKit]?.name}>
        <div className="grid grid-cols-2 gap-[0.4rem]">
          {BODY_KITS.map((k, i) => (
            <OptBtn key={k.name} testId={`kit-${i}`} label={k.name} sub={k.description} price={k.price} selected={preview.bodyKit === i} saved={saved.bodyKit === i} onClick={() => onApply({ bodyKit: i })} />
          ))}
        </div>
      </StyleSection>

      <StyleSection title="Néons sous caisse" price={NEON_PRICE} value={nameOf(NEON_COLORS, preview.neonColor)}>
        <div className="grid grid-cols-9 gap-[0.4rem]">
          {NEON_COLORS.map((c, i) => (
            <Swatch key={c.name} testId={`neon-${i}`} hex={c.hex} name={c.name} selected={preview.neonColor === c.hex} saved={saved.neonColor === c.hex} onClick={() => onApply({ neonColor: c.hex })} />
          ))}
        </div>
      </StyleSection>

      <StyleSection title="Vitres teintées" value={WINDOW_TINTS[preview.windowTint]?.name}>
        <div className="grid grid-cols-4 gap-[0.4rem]">
          {WINDOW_TINTS.map((w, i) => (
            <OptBtn key={w.name} testId={`tint-${i}`} label={w.name} price={w.price} selected={preview.windowTint === i} saved={saved.windowTint === i} onClick={() => onApply({ windowTint: i })} />
          ))}
        </div>
      </StyleSection>

      <StyleSection title="Flamme de nitro" price={NITRO_COLOR_PRICE} value={nameOf(NITRO_COLORS, preview.nitroColor)}>
        <div className="grid grid-cols-9 gap-[0.4rem]">
          {NITRO_COLORS.map((c, i) => (
            <Swatch key={c.hex} testId={`nitrocolor-${i}`} hex={c.hex} name={c.name} selected={preview.nitroColor === c.hex} saved={saved.nitroColor === c.hex} onClick={() => onApply({ nitroColor: c.hex })} />
          ))}
        </div>
      </StyleSection>
    </>
  );
}

// -----------------------------------------------------------------------------
// Stats panel (right)
// -----------------------------------------------------------------------------

function StatBar({ label, value, next }: { label: string; value: number; next: number | null }) {
  const v = Math.min(100, Math.max(0, value));
  const n = next === null ? v : Math.min(100, Math.max(0, next));
  const delta = Math.round(n - v);
  const lo = Math.min(v, n);
  const hi = Math.max(v, n);
  return (
    <div className="mb-[0.5rem]">
      <div className="flex items-baseline justify-between">
        <span className="ax-label">{label}</span>
        <span className="ax-num text-[0.8rem] text-white">
          {Math.round(v)}
          {delta !== 0 ? <span className={cx('ml-[0.35rem]', delta > 0 ? 'text-neon-green' : 'text-neon-red')}>{delta > 0 ? `+${delta}` : delta}</span> : null}
        </span>
      </div>
      <div className="ax-statbar mt-[0.18rem]">
        <i className="ax-statbar-base" style={{ transform: `scaleX(${lo / 100})` }} />
        {delta !== 0 ? (
          <i className={cx('ax-statbar-delta', delta < 0 && 'is-neg')} style={{ left: `${lo}%`, width: `${hi - lo}%` }} />
        ) : null}
      </div>
    </div>
  );
}

function NumStat({ label, value, unit, next, lowerIsBetter, digits = 0 }: { label: string; value: number; unit: string; next: number | null; lowerIsBetter?: boolean; digits?: number }) {
  const delta = next === null ? 0 : next - value;
  const show = Math.abs(delta) >= (digits > 0 ? 0.05 : 0.5);
  const good = lowerIsBetter ? delta < 0 : delta > 0;
  const fmt = (v: number) => (digits > 0 ? v.toFixed(digits).replace('.', ',') : fmtInt(v));
  return (
    <div className="ax-stat-tile !py-[0.4rem]">
      <div className="ax-label !text-[0.62rem]">{label}</div>
      <div className="ax-num text-[1.02rem] italic text-white">
        {fmt(value)}
        <span className="ml-[0.2rem] text-[0.62rem] not-italic text-steel">{unit}</span>
      </div>
      <div className={cx('ax-num h-[0.9rem] text-[0.7rem]', good ? 'text-neon-green' : 'text-neon-red')}>
        {show ? `${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))}` : ''}
      </div>
    </div>
  );
}

function StatsPanel({ stats, next, mph }: { stats: PerfStats; next: PerfStats | null; mph: boolean }) {
  const k = mph ? KMH_TO_MPH : 1;
  const ratingDelta = next ? Math.round(next.rating - stats.rating) : 0;
  return (
    <div>
      <div className="flex items-center gap-[1rem]">
        <div className="ax-rating">
          <span className="text-[0.52rem] font-bold tracking-[0.2em] text-steel">INDICE</span>
          <TickNumber value={Math.round(stats.rating)} duration={500} className="ax-display text-[1.9rem] text-white" />
          <span className={cx('ax-num h-[0.8rem] text-[0.66rem]', ratingDelta >= 0 ? 'text-neon-green' : 'text-neon-red')}>{ratingDelta !== 0 ? (ratingDelta > 0 ? `+${ratingDelta}` : ratingDelta) : ''}</span>
        </div>
        <div className="min-w-0 flex-1">
          <StatBar label="Vitesse max" value={stats.barTopSpeed} next={next ? next.barTopSpeed : null} />
          <StatBar label="Accélération" value={stats.barAcceleration} next={next ? next.barAcceleration : null} />
        </div>
      </div>
      <StatBar label="Maniabilité" value={stats.barHandling} next={next ? next.barHandling : null} />
      <StatBar label="Freinage" value={stats.barBraking} next={next ? next.barBraking : null} />
      <StatBar label="Nitro" value={stats.barNitro} next={next ? next.barNitro : null} />
      <div className="mt-[0.7rem] grid grid-cols-3 gap-[0.4rem]">
        <NumStat label="Puissance" value={stats.powerHp} unit="ch" next={next ? next.powerHp : null} />
        <NumStat label="Couple" value={stats.torqueNm} unit="Nm" next={next ? next.torqueNm : null} />
        <NumStat label="Poids" value={stats.massKg} unit="kg" next={next ? next.massKg : null} lowerIsBetter />
        <NumStat label={mph ? '0–60 mph*' : '0–100 km/h'} value={stats.zeroToHundred} unit="s" next={next ? next.zeroToHundred : null} lowerIsBetter digits={1} />
        <NumStat label="V-max" value={stats.topSpeedKmh * k} unit={mph ? 'mph' : 'km/h'} next={next ? next.topSpeedKmh * k : null} />
        <div className="ax-stat-tile flex flex-col justify-center !py-[0.4rem]">
          <div className="ax-label !text-[0.62rem]">Classe</div>
          <div className="ax-display text-[1.02rem]" style={{ color: 'var(--ac)' }}>
            {stats.rating >= 90 ? 'S' : stats.rating >= 75 ? 'A' : stats.rating >= 58 ? 'B' : stats.rating >= 40 ? 'C' : 'D'}
          </div>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Garage root
// -----------------------------------------------------------------------------

export function GarageModal({ initialTab = 'cars' }: { initialTab?: GarageTab }) {
  const api = useApi();
  const sfx = useSfx();
  const a = api.actions;
  const profile = useUI((s) => s.profile);
  const repLevel = useUI((s) => s.repLevel);
  const garageCarId = useUI((s) => s.garageCarId);
  const garagePreview = useUI((s) => s.garagePreview);
  const paused = useUI((s) => s.paused);

  const [tab, setTab] = useState<GarageTab>(initialTab);
  const [hoverPart, setHoverPart] = useState<TunePart | null>(null);
  const err = useFlashError();
  const [errAt, setErrAt] = useState<'left' | 'right'>('left');

  const carId = garageCarId || profile.currentCarId;
  const spec = getCarSpec(carId);
  const owned = profile.garage[carId] ?? null;
  const isCurrent = profile.currentCarId === carId;
  const editable = owned !== null && isCurrent;
  const tuning: TuningState = owned ? owned.tuning : STOCK_TUNING;
  const savedVisuals: CarVisuals = owned ? owned.visuals : spec.defaultVisuals;
  const preview: CarVisuals = editable && garagePreview ? garagePreview : savedVisuals;
  const hasPreview = editable && garagePreview !== null && !visualsEqual(garagePreview, savedVisuals);
  const total = hasPreview ? visualsPrice(savedVisuals, preview) : 0;
  const carLocked = repLevel < spec.repLevel;
  const mph = profile.settings.units === 'mph';

  const tuningKey = TUNE_PARTS.map((p) => tuning[p]).join('');
  const stats = useMemo(() => api.getPerfStats(carId, tuning), [api, carId, tuningKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextStats = useMemo(() => {
    if (!hoverPart || tab !== 'perf' || !owned) return null;
    const lvl = tuning[hoverPart];
    if (lvl >= 3) return null;
    return api.getPerfStats(carId, { ...tuning, [hoverPart]: (lvl + 1) as TuneLevel });
  }, [api, carId, tuningKey, hoverPart, tab, owned]); // eslint-disable-line react-hooks/exhaustive-deps

  const report = (r: ActionResult, where: 'left' | 'right'): boolean => {
    sfx.result(r);
    if (!r.ok) {
      setErrAt(where);
      err.flash(r.reason);
    } else err.clear();
    return r.ok;
  };

  const dropPreview = () => {
    if (api.getState().garagePreview !== null) a.previewVisuals(null);
  };

  const changeTab = (t: GarageTab) => {
    if (t === tab) return;
    if (tab === 'style') dropPreview();
    setHoverPart(null);
    err.clear();
    setTab(t);
  };

  const showCar = (id: string) => {
    if (id === carId) return;
    dropPreview();
    err.clear();
    a.garageShowCar(id);
  };

  const exit = () => {
    dropPreview();
    sfx.back();
    a.exitGarage();
  };

  useKey((e) => {
    if (e.code === 'Escape' && !e.repeat) {
      e.preventDefault();
      exit();
    }
  }, !paused);

  // a stale preview must never outlive this screen
  useEffect(() => () => {
    if (api.getState().garagePreview !== null) api.actions.previewVisuals(null);
  }, [api]);

  const applyVisual = (patch: Partial<CarVisuals>) => {
    const next: CarVisuals = { ...preview, ...patch };
    a.previewVisuals(visualsEqual(next, savedVisuals) ? null : next);
  };

  const notEditableNotice = !owned ? (
    <div className="ax-notice">
      <Lock className="h-[1.6rem] w-[1.6rem] shrink-0 text-neon-amber" strokeWidth={2.2} />
      <div>
        <div className="ax-display text-[1rem] text-white">Voiture non possédée</div>
        <div className="mt-[0.2rem] text-[0.92rem] font-semibold text-chrome">Achète la {spec.name} dans l’onglet Voitures pour la préparer et la personnaliser.</div>
      </div>
    </div>
  ) : !isCurrent ? (
    <div className="ax-notice">
      <KeyRound className="h-[1.6rem] w-[1.6rem] shrink-0 text-neon-cyan" strokeWidth={2.2} />
      <div className="min-w-0 flex-1">
        <div className="ax-display text-[1rem] text-white">Prends le volant d’abord</div>
        <div className="mt-[0.2rem] text-[0.92rem] font-semibold text-chrome">Les modifications s’appliquent à ta voiture active.</div>
        <Btn size="sm" tone="cyan" sound="none" className="mt-[0.5rem]" testId="notice-drive" onClick={() => report(a.selectCar(carId), 'left')}>
          Conduire la {spec.name}
        </Btn>
      </div>
    </div>
  ) : null;

  return (
    <div className="absolute inset-0" data-testid="garage" style={{ '--ac': GARAGE_COLOR } as CSSProperties}>
      <div className="ax-garage-shade" aria-hidden />

      {/* ------------------------------------------------------------ header */}
      <div className="ax-pe ax-in-down absolute inset-x-[1.3rem] top-[1.1rem] flex h-[4.2rem] items-stretch gap-[1rem]">
        <div className="ax-panel ax-carbon ax-edge-top ax-cut-br flex items-center gap-[0.8rem] px-[1.2rem]">
          <Warehouse className="h-[1.9rem] w-[1.9rem]" style={{ color: GARAGE_COLOR, filter: `drop-shadow(0 0 0.5rem ${GARAGE_COLOR})` }} strokeWidth={2} />
          <div>
            <div className="ax-display ax-glow text-[1.5rem] text-white">GARAGE</div>
            <div className="text-[0.72rem] font-bold uppercase tracking-[0.2em] text-steel">QG · {CITY_NAME}</div>
          </div>
        </div>

        <div className="flex flex-1 items-end justify-center gap-[0.4rem] pb-[0.1rem]">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                data-testid={`tab-${t.id}`}
                className={cx('ax-tab', tab === t.id && 'is-on')}
                onMouseEnter={sfx.hover}
                onClick={(e) => {
                  e.currentTarget.blur();
                  sfx.click();
                  changeTab(t.id);
                }}
              >
                <Icon className="h-[1.05rem] w-[1.05rem]" strokeWidth={2.4} />
                {t.label}
              </button>
            );
          })}
        </div>

        <div className="ax-panel ax-carbon ax-edge-top ax-cut-bl flex items-center gap-[1.3rem] px-[1.3rem]">
          <div className="text-right">
            <div className="ax-label !text-[0.62rem]">Argent</div>
            <TickNumber value={profile.money} suffix={' $'} duration={600} className="ax-display text-[1.35rem] text-neon-green" />
          </div>
          <div className="text-right">
            <div className="ax-label !text-[0.62rem]">Niveau REP</div>
            <div className="ax-display text-[1.35rem] text-neon-cyan">{repLevel}</div>
          </div>
          <Btn tone="violet" sound="none" kbd="Échap" testId="garage-exit" onClick={exit}>
            <LogOut size="1.1em" strokeWidth={2.6} /> Sortir du garage
          </Btn>
        </div>
      </div>

      {/* --------------------------------------------------------- left dock */}
      <div className="ax-pe ax-panel ax-carbon ax-edge-left ax-cut-br ax-in-left absolute bottom-[1.3rem] left-[1.3rem] top-[6.3rem] flex w-[27.5rem] flex-col" style={{ '--cut': '1.4rem' } as CSSProperties}>
        <div className="flex items-center justify-between px-[1.1rem] pb-[0.5rem] pt-[0.9rem]">
          <div className="ax-display text-[1.15rem] text-white">{tab === 'cars' ? 'Catalogue' : tab === 'perf' ? 'Préparation' : 'Personnalisation'}</div>
          <div className="text-[0.74rem] font-bold uppercase tracking-[0.14em] text-steel">
            {tab === 'cars' ? `${Object.keys(profile.garage).length} / ${CAR_CATALOG.length} possédées` : spec.name}
          </div>
        </div>

        <div key={tab} className="ax-scroll ax-in-up min-h-0 flex-1 px-[1.1rem] pb-[0.8rem]">
          {tab === 'cars' ? (
            <div className="flex flex-col gap-[0.5rem]">
              {CAR_CATALOG.map((c) => (
                <CarCard
                  key={c.id}
                  spec={c}
                  selected={c.id === carId}
                  owned={profile.garage[c.id] !== undefined}
                  current={profile.currentCarId === c.id}
                  locked={repLevel < c.repLevel}
                  onSelect={() => showCar(c.id)}
                />
              ))}
            </div>
          ) : null}

          {tab === 'perf' ? (
            <>
              {notEditableNotice}
              <div className={cx('flex flex-col gap-[0.45rem]', !editable && 'pointer-events-none opacity-40')}>
                {TUNE_PARTS.map((p) => (
                  <PartRow
                    key={p}
                    part={p}
                    spec={spec}
                    level={tuning[p]}
                    repLevel={repLevel}
                    money={profile.money}
                    enabled={editable}
                    hovered={hoverPart === p}
                    onHover={setHoverPart}
                    onBuy={(part, level) => report(a.buyUpgrade(part, level), 'left')}
                  />
                ))}
              </div>
            </>
          ) : null}

          {tab === 'style' ? (
            <>
              {notEditableNotice}
              <div className={cx(!editable && 'pointer-events-none opacity-40')}>
                <StyleTab saved={savedVisuals} preview={preview} onApply={applyVisual} />
              </div>
            </>
          ) : null}
        </div>

        {/* footer: running total (style) + errors */}
        {tab !== 'cars' ? (
          <div className="border-t border-white/10 bg-black/30 px-[1.1rem] pb-[1.1rem] pt-[0.7rem]">
            {errAt === 'left' ? <ErrorLine error={err.error} nonce={err.nonce} className="mb-[0.5rem]" /> : null}
            {tab === 'style' ? (
              <div className="flex items-center justify-between gap-[0.8rem]">
                <div>
                  <div className="ax-label !text-[0.62rem]">Total des modifications</div>
                  <div className={cx('ax-display text-[1.45rem]', total > profile.money ? 'text-neon-red' : 'text-neon-green')} data-testid="style-total">
                    {fmtMoney(total)}
                  </div>
                </div>
                <div className="flex gap-[0.5rem] pr-[0.6rem]">
                  <Btn size="sm" tone="steel" sound="back" disabled={!hasPreview} testId="style-cancel" onClick={() => a.previewVisuals(null)}>
                    Annuler
                  </Btn>
                  <Btn tone="green" solid sound="none" disabled={!hasPreview} testId="style-buy" onClick={() => report(a.buyVisuals(preview), 'left')}>
                    Acheter
                  </Btn>
                </div>
              </div>
            ) : (
              <div className="text-[0.82rem] font-semibold text-steel">Survole une pièce pour comparer les performances. Les niveaux s’achètent dans l’ordre.</div>
            )}
          </div>
        ) : null}
      </div>

      {/* -------------------------------------------------------- right dock */}
      <div className="ax-pe ax-panel ax-carbon ax-edge-top ax-cut-bl ax-in-right absolute right-[1.3rem] top-[6.3rem] w-[23.5rem] p-[1.1rem]" style={{ '--cut': '1.4rem' } as CSSProperties}>
        <div className="flex items-start justify-between gap-[0.6rem]">
          <div className="min-w-0">
            <div className="ax-label !text-[0.66rem]" style={{ color: 'var(--ac)' }}>
              {spec.maker} · {spec.categoryLabel}
            </div>
            <div key={spec.id} className="ax-display ax-in-left mt-[0.15rem] text-[1.45rem] text-white">
              {spec.name}
            </div>
          </div>
          {isCurrent ? (
            <span className="ax-chip ax-tone-green shrink-0">
              <Check size="1em" strokeWidth={3.4} /> Équipée
            </span>
          ) : owned ? (
            <span className="ax-chip ax-tone-cyan shrink-0">Possédée</span>
          ) : null}
        </div>
        <p className="mb-[0.8rem] mt-[0.4rem] text-[0.9rem] font-semibold leading-snug text-chrome/85">{spec.description}</p>

        <StatsPanel stats={stats} next={nextStats} mph={mph} />

        <div className="mt-[0.9rem] border-t border-white/10 pt-[0.8rem]">
          {errAt === 'right' ? <ErrorLine error={err.error} nonce={err.nonce} className="mb-[0.6rem]" /> : null}
          {!owned ? (
            <div className="flex items-center justify-between gap-[0.8rem]">
              <div>
                <div className="ax-label !text-[0.62rem]">Prix</div>
                <div className={cx('ax-display text-[1.5rem]', profile.money < spec.price ? 'text-neon-red' : 'text-neon-green')}>{fmtMoney(spec.price)}</div>
                {carLocked ? (
                  <div className="mt-[0.15rem] flex items-center gap-[0.3rem] text-[0.8rem] font-bold uppercase tracking-[0.08em] text-neon-red">
                    <Lock size="1em" strokeWidth={3} /> Niveau REP {spec.repLevel} requis
                  </div>
                ) : null}
              </div>
              <Btn tone={carLocked ? 'red' : 'green'} solid={!carLocked} size="lg" sound="none" testId="car-buy" onClick={() => report(a.buyCar(carId), 'right')}>
                {carLocked ? <Lock size="1em" strokeWidth={3} /> : null}
                Acheter
              </Btn>
            </div>
          ) : isCurrent ? (
            <div className="flex items-center justify-between gap-[0.8rem]">
              <div className="text-[0.9rem] font-bold text-chrome">C’est ta voiture active.</div>
              <div className="flex gap-[0.4rem]">
                <Btn size="sm" tone="cyan" onClick={() => changeTab('perf')} testId="goto-perf">
                  Préparer
                </Btn>
                <Btn size="sm" tone="pink" onClick={() => changeTab('style')} testId="goto-style">
                  Styliser
                </Btn>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-[0.8rem]">
              <div className="text-[0.9rem] font-bold text-chrome">Dans ton garage.</div>
              <Btn tone="cyan" solid size="lg" sound="none" testId="car-drive" onClick={() => report(a.selectCar(carId), 'right')}>
                <KeyRound size="1.1em" strokeWidth={2.6} /> Conduire
              </Btn>
            </div>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------ centre */}
      <div className="pointer-events-none absolute inset-x-0 top-[6.3rem] flex justify-center">
        <Toasts align="center" max={3} />
      </div>
      <div className="pointer-events-none absolute bottom-[1.6rem] left-1/2 flex -translate-x-1/2 flex-col items-center gap-[0.5rem]">
        {hasPreview ? <span className="ax-chip ax-tone-pink ax-in-up">Aperçu non acheté</span> : null}
        <div className="flex items-center gap-[0.5rem] text-[0.8rem] font-bold uppercase tracking-[0.18em] text-white/55">
          <Move3d className="h-[1rem] w-[1rem]" strokeWidth={2.2} />
          Glisser pour tourner autour de la voiture
        </div>
      </div>
    </div>
  );
}

export default GarageModal;
