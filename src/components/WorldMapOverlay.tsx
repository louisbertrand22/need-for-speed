/* =============================================================================
 * World map (UIState.mapOpen): pan / zoom canvas map with inertia, DOM markers,
 * event list with filters, detail card (GPS, fast travel, start event).
 * Static layer (districts, water, roads) is redrawn only when the view changes;
 * a second canvas carries the animated layer (route, player, selection rings).
 * ===========================================================================*/
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import { Check, Crosshair, Lock, Maximize, Minus, Navigation, Play, Plus, Rocket, X } from 'lucide-react';
import type { ActionResult, EventMode, EventSummary, MapData, MapMarker } from '../core/types';
import { DISTRICTS } from '../core/layout';
import { CITY_NAME, GARAGE_COLOR, MODE_INFO } from '../game/catalog';
import { KMH_TO_MPH, fitCanvas, fmtInt, fmtMoney, fmtTime, useApi, useFlashError, useFrame, useResize, useSfx, useUI } from './hooks';
import { Btn, ErrorLine, MARKER_KIND_LABEL, MODE_ICONS, MODE_ORDER, MedalBadge, MEDAL_INFO, ModeChip, Pips, SectionTitle, cx, markerColor, markerIcon } from './kit';
import { TAU, drawArrow, getMapPaths, getRoutePath } from './mapDraw';

type Filter = 'all' | EventMode;

interface View {
  cx: number;
  cz: number;
  scale: number;
  tcx: number;
  tcz: number;
  tscale: number;
  vx: number;
  vz: number;
  minScale: number;
  maxScale: number;
  /** screen position (CSS px) of the view centre */
  ox: number;
  oy: number;
  dirty: boolean;
  ready: boolean;
}

function markerTransform(v: View, m: MapMarker): string {
  const x = (m.x - v.cx) * v.scale + v.ox;
  const y = (m.z - v.cz) * v.scale + v.oy;
  return `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
}

function fmtKm(km: number): string {
  return `${km.toFixed(1).replace('.', ',')} km`;
}

function recordText(ev: EventSummary, mph: boolean): string | null {
  const r = ev.record;
  if (!r) return null;
  if (r.bestScore !== null) {
    if (ev.mode === 'speedtrap') return `${fmtInt(r.bestScore * (mph ? KMH_TO_MPH : 1))} ${mph ? 'mph' : 'km/h'}`;
    return `${fmtInt(r.bestScore)} pts`;
  }
  if (r.bestTimeMs !== null) return fmtTime(r.bestTimeMs);
  return null;
}

// -----------------------------------------------------------------------------
// Static layer
// -----------------------------------------------------------------------------

function drawStatic(ctx: CanvasRenderingContext2D, map: MapData, v: View, w: number, h: number, dpr: number): void {
  const paths = getMapPaths(map);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // backdrop
  const bg = ctx.createLinearGradient(0, 0, w * 0.4, h);
  bg.addColorStop(0, '#070912');
  bg.addColorStop(1, '#04050a');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const k = v.scale * dpr;
  const tx = v.ox * dpr - v.cx * k;
  const ty = v.oy * dpr - v.cz * k;
  ctx.setTransform(k, 0, 0, k, tx, ty);
  const pxw = 1 / k; // one device pixel in world units

  // survey grid (300 m)
  const b = map.bounds;
  ctx.lineWidth = pxw;
  ctx.strokeStyle = 'rgba(34,227,255,0.055)';
  ctx.beginPath();
  for (let x = Math.ceil(b.minX / 300) * 300; x <= b.maxX; x += 300) {
    ctx.moveTo(x, b.minZ);
    ctx.lineTo(x, b.maxZ);
  }
  for (let z = Math.ceil(b.minZ / 300) * 300; z <= b.maxZ; z += 300) {
    ctx.moveTo(b.minX, z);
    ctx.lineTo(b.maxX, z);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(207,214,228,0.22)';
  ctx.lineWidth = 1.5 * pxw;
  ctx.strokeRect(b.minX, b.minZ, b.maxX - b.minX, b.maxZ - b.minZ);

  // districts
  for (const d of paths.districts) {
    ctx.globalAlpha = 0.075;
    ctx.fillStyle = d.color;
    ctx.fill(d.path);
    ctx.globalAlpha = 0.3;
    ctx.strokeStyle = d.color;
    ctx.lineWidth = 1.2 * pxw;
    ctx.setLineDash([8 * pxw, 6 * pxw]);
    ctx.stroke(d.path);
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;

  // water
  ctx.fillStyle = '#0a2646';
  ctx.fill(paths.water);
  ctx.strokeStyle = 'rgba(34,227,255,0.35)';
  ctx.lineWidth = 1.5 * pxw;
  ctx.stroke(paths.water);

  // roads: casing, then fill by importance
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  const minor: ('industrial' | 'street' | 'hill' | 'ramp')[] = ['industrial', 'street', 'hill', 'ramp'];
  const wOf = (real: number, minPx: number) => Math.max(real, minPx * dpr * pxw);
  ctx.strokeStyle = 'rgba(2,3,8,0.9)';
  for (const kind of minor) {
    ctx.lineWidth = wOf(paths.roads[kind].width, 2.2) + 3 * dpr * pxw;
    ctx.stroke(paths.roads[kind].path);
  }
  ctx.lineWidth = wOf(paths.roads.avenue.width, 3.2) + 3 * dpr * pxw;
  ctx.stroke(paths.roads.avenue.path);
  const minorColor = { industrial: '#4d566e', street: '#59647f', hill: '#5a7272', ramp: '#8a7cc0' };
  for (const kind of minor) {
    ctx.strokeStyle = minorColor[kind];
    ctx.lineWidth = wOf(paths.roads[kind].width, 2.2);
    ctx.stroke(paths.roads[kind].path);
  }
  ctx.strokeStyle = '#8f9bb8';
  ctx.lineWidth = wOf(paths.roads.avenue.width, 3.2);
  ctx.stroke(paths.roads.avenue.path);
  // highway: glow + body + centre line
  const hw = wOf(paths.roads.highway.width, 5);
  ctx.strokeStyle = 'rgba(180,140,255,0.2)';
  ctx.lineWidth = hw + 12 * dpr * pxw;
  ctx.stroke(paths.roads.highway.path);
  ctx.strokeStyle = 'rgba(2,3,8,0.95)';
  ctx.lineWidth = hw + 3.5 * dpr * pxw;
  ctx.stroke(paths.roads.highway.path);
  ctx.strokeStyle = '#cdb9ff';
  ctx.lineWidth = hw;
  ctx.stroke(paths.roads.highway.path);
  ctx.strokeStyle = 'rgba(20,14,40,0.75)';
  ctx.lineWidth = Math.max(pxw, hw * 0.12);
  ctx.stroke(paths.roads.highway.path);

  // tunnels (dimmed + dashed outline) and bridges (bright rails)
  ctx.fillStyle = 'rgba(4,5,10,0.6)';
  ctx.fill(paths.tunnels);
  ctx.strokeStyle = 'rgba(207,214,228,0.6)';
  ctx.lineWidth = 1.3 * dpr * pxw;
  ctx.setLineDash([5 * dpr * pxw, 4 * dpr * pxw]);
  ctx.stroke(paths.tunnels);
  ctx.setLineDash([]);
  ctx.strokeStyle = '#22e3ff';
  ctx.lineWidth = 1.6 * dpr * pxw;
  ctx.stroke(paths.bridges);

  // labels (screen space)
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const fs = Math.max(11, Math.min(30, 46 * v.scale + 6)) * dpr;
  ctx.font = `italic 900 ${fs}px Orbitron, sans-serif`;
  for (const d of paths.districts) {
    const x = d.labelX * k + tx;
    const y = d.labelZ * k + ty;
    ctx.lineWidth = 4 * dpr;
    ctx.strokeStyle = 'rgba(4,5,10,0.85)';
    ctx.strokeText(d.name.toUpperCase(), x, y);
    ctx.globalAlpha = 0.72;
    ctx.fillStyle = d.color;
    ctx.fillText(d.name.toUpperCase(), x, y);
    ctx.globalAlpha = 1;
  }
  const small = Math.max(9, Math.min(13, 16 * v.scale + 6)) * dpr;
  ctx.font = `700 ${small}px Rajdhani, sans-serif`;
  const tag = (poly: { x: number; z: number }[], text: string, color: string) => {
    if (poly.length === 0) return;
    let sx = 0;
    let sz = 0;
    for (const p of poly) {
      sx += p.x;
      sz += p.z;
    }
    const x = (sx / poly.length) * k + tx;
    const y = (sz / poly.length) * k + ty;
    const tw = ctx.measureText(text).width + 10 * dpr;
    ctx.fillStyle = 'rgba(4,5,10,0.85)';
    ctx.fillRect(x - tw / 2, y - small * 0.75, tw, small * 1.5);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y + dpr);
  };
  if (v.scale > 0.22) {
    for (const t of map.tunnels) tag(t, 'TUNNEL', '#cfd6e4');
    for (const br of map.bridges) tag(br, 'PONT', '#22e3ff');
  }
}

// -----------------------------------------------------------------------------
// Side panel pieces
// -----------------------------------------------------------------------------

function EventRow({ marker, selected, isGps, mph, onSelect }: { marker: MapMarker; selected: boolean; isGps: boolean; mph: boolean; onSelect: () => void }) {
  const sfx = useSfx();
  const ev = marker.event;
  const Icon = markerIcon(marker);
  const color = markerColor(marker);
  const rec = ev ? recordText(ev, mph) : null;
  return (
    <button
      type="button"
      data-testid={`map-row-${marker.id}`}
      className={cx('ax-map-row', selected && 'is-on', ev?.locked && 'is-locked')}
      style={{ '--ac': color } as CSSProperties}
      onMouseEnter={sfx.hover}
      onClick={(e) => {
        e.currentTarget.blur();
        sfx.click();
        onSelect();
      }}
    >
      <span className="ax-map-row-ico">
        <Icon className="h-[1.05rem] w-[1.05rem]" strokeWidth={2.4} />
      </span>
      <span className="min-w-0 flex-1 text-left">
        <span className="flex items-center gap-[0.4rem]">
          <span className="truncate text-[0.98rem] font-bold text-white">{ev ? ev.name : marker.label}</span>
          {isGps ? <Navigation className="h-[0.8rem] w-[0.8rem] shrink-0 text-neon-violet" strokeWidth={3} fill="currentColor" /> : null}
        </span>
        <span className="mt-[0.1rem] flex items-center gap-[0.5rem] text-[0.72rem] font-bold uppercase tracking-[0.08em] text-steel">
          {ev ? (
            <>
              <span style={{ color }}>{ev.modeLabel}</span>
              <Pips value={ev.difficulty} size="0.3rem" color={color} />
              <span>{fmtKm(ev.lengthKm)}</span>
            </>
          ) : (
            <span style={{ color }}>{MARKER_KIND_LABEL[marker.kind]}</span>
          )}
        </span>
      </span>
      {ev ? (
        <span className="flex shrink-0 flex-col items-end gap-[0.1rem]">
          {ev.locked ? (
            <span className="flex items-center gap-[0.25rem] text-[0.78rem] font-bold text-neon-red">
              <Lock size="0.9em" strokeWidth={3} /> REP {ev.repLevelRequired}
            </span>
          ) : (
            <span className="ax-num text-[0.82rem] italic text-neon-green">{fmtMoney(ev.rewardMoney)}</span>
          )}
          <span className="flex h-[1rem] items-center gap-[0.3rem]">
            {ev.record?.medal ? <MedalBadge medal={ev.record.medal} size="0.95rem" /> : ev.record?.completed ? <Check className="h-[0.9rem] w-[0.9rem] text-neon-green" strokeWidth={3.4} /> : null}
            {rec ? <span className="ax-num text-[0.68rem] text-chrome">{rec}</span> : null}
          </span>
        </span>
      ) : null}
    </button>
  );
}

function InfoCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ax-stat-tile !py-[0.35rem]">
      <div className="ax-label !text-[0.6rem]">{label}</div>
      <div className="ax-num mt-[0.1rem] text-[0.92rem] italic text-white">{children}</div>
    </div>
  );
}

function DetailCard({
  marker,
  isGps,
  mph,
  onGps,
  onTravel,
  onStart,
}: {
  marker: MapMarker;
  isGps: boolean;
  mph: boolean;
  onGps: () => void;
  onTravel: () => void;
  onStart: () => void;
}) {
  const ev = marker.event;
  const color = markerColor(marker);
  const Icon = markerIcon(marker);
  const rec = ev ? recordText(ev, mph) : null;
  const kindBlurb =
    marker.kind === 'garage'
      ? 'Ton QG : achète des voitures, améliore les performances et personnalise le style. Y entrer fait aussi retomber la pression policière.'
      : marker.kind === 'breaker'
        ? 'Structure fragile : fonce dans son point faible pendant une poursuite pour ensevelir les unités qui te collent.'
        : 'Tremplin : prends-le à pleine vitesse pour un saut spectaculaire.';
  return (
    <div key={marker.id} className="ax-in-up" style={{ '--ac': color } as CSSProperties} data-testid="map-detail">
      <div className="flex items-start gap-[0.7rem]">
        <span className="ax-map-row-ico !h-[2.4rem] !w-[2.4rem]">
          <Icon className="h-[1.3rem] w-[1.3rem]" strokeWidth={2.4} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="ax-display truncate text-[1.2rem] text-white">{ev ? ev.name : marker.label}</div>
          <div className="mt-[0.2rem] flex flex-wrap items-center gap-[0.5rem]">
            {ev ? <ModeChip mode={ev.mode} label={ev.modeLabel} /> : <span className="ax-chip">{MARKER_KIND_LABEL[marker.kind]}</span>}
            {ev ? <span className="text-[0.78rem] font-bold uppercase tracking-[0.1em]" style={{ color: DISTRICTS[ev.district].color }}>{DISTRICTS[ev.district].name}</span> : null}
            {ev?.locked ? (
              <span className="ax-chip ax-tone-red">
                <Lock size="1em" strokeWidth={3} /> REP {ev.repLevelRequired} requis
              </span>
            ) : null}
          </div>
        </div>
      </div>
      <p className="mt-[0.55rem] text-[0.9rem] font-semibold leading-snug text-chrome/90">{ev ? ev.description : kindBlurb}</p>

      {ev ? (
        <>
          <div className="mt-[0.6rem] grid grid-cols-4 gap-[0.35rem]">
            <InfoCell label="Longueur">{fmtKm(ev.lengthKm)}</InfoCell>
            <InfoCell label="Tours">{ev.laps > 1 ? ev.laps : '—'}</InfoCell>
            <InfoCell label="Rivaux">{ev.rivals > 0 ? ev.rivals : 'Solo'}</InfoCell>
            <InfoCell label="Difficulté">
              <Pips value={ev.difficulty} size="0.34rem" color={color} />
            </InfoCell>
          </div>
          <div className="mt-[0.35rem] grid grid-cols-2 gap-[0.35rem]">
            <InfoCell label="Récompense">
              <span className="text-neon-green">{fmtMoney(ev.rewardMoney)}</span>
              <span className="ml-[0.6rem] text-[0.8rem] text-neon-cyan">+{fmtInt(ev.rewardRep)} REP</span>
            </InfoCell>
            <InfoCell label="Record">
              {rec ? (
                <span className="flex items-center gap-[0.4rem]">
                  {ev.record?.medal ? <MedalBadge medal={ev.record.medal} size="1rem" /> : null}
                  {rec}
                </span>
              ) : (
                <span className="text-steel">Aucun</span>
              )}
            </InfoCell>
          </div>
          {ev.targets ? (
            <div className="mt-[0.35rem] flex items-center gap-[1rem] px-[0.2rem] text-[0.82rem] font-bold">
              <span className="ax-label !text-[0.6rem]">Objectifs</span>
              {(['gold', 'silver', 'bronze'] as const).map((m) => (
                <span key={m} className="ax-num flex items-center gap-[0.25rem]" style={{ color: MEDAL_INFO[m].color }}>
                  <MedalBadge medal={m} size="0.9rem" />
                  {fmtInt(ev.targets ? ev.targets[m] : 0)}
                </span>
              ))}
            </div>
          ) : null}
          {ev.record && ev.record.attempts > 0 ? (
            <div className="mt-[0.3rem] px-[0.2rem] text-[0.76rem] font-bold uppercase tracking-[0.08em] text-steel">
              {ev.record.attempts} tentative{ev.record.attempts > 1 ? 's' : ''} · {ev.record.wins} victoire{ev.record.wins > 1 ? 's' : ''}
            </div>
          ) : null}
        </>
      ) : null}

      <div className="mt-[0.75rem] flex flex-wrap items-center gap-[0.45rem]">
        <Btn size="sm" tone="violet" solid={isGps} testId="map-gps" onClick={onGps}>
          <Navigation size="1.05em" strokeWidth={2.8} /> {isGps ? 'Retirer le GPS' : 'GPS'}
        </Btn>
        <Btn size="sm" tone="cyan" sound="none" disabled={!marker.teleportable} testId="map-travel" onClick={onTravel} title={marker.teleportable ? undefined : 'Indisponible ici ou pendant une poursuite'}>
          <Rocket size="1.05em" strokeWidth={2.6} /> Voyage rapide
        </Btn>
        {ev ? (
          <Btn size="sm" tone={ev.locked ? 'red' : 'green'} solid={!ev.locked} sound="none" testId="map-start" onClick={onStart}>
            {ev.locked ? <Lock size="1.05em" strokeWidth={3} /> : <Play size="1.05em" strokeWidth={3} fill="currentColor" />} Lancer l’épreuve
          </Btn>
        ) : null}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Overlay
// -----------------------------------------------------------------------------

export function WorldMapOverlay() {
  const api = useApi();
  const sfx = useSfx();
  const a = api.actions;
  const markers = useUI((s) => s.markers);
  const gpsId = useUI((s) => s.gpsTargetId);
  const units = useUI((s) => s.profile.settings.units);
  const mph = units === 'mph';

  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(() => api.getState().gpsTargetId);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const err = useFlashError();

  const rootRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const markerEls = useRef(new Map<string, HTMLButtonElement>());
  const view = useRef<View>({ cx: 0, cz: 0, scale: 0.3, tcx: 0, tcz: 0, tscale: 0.3, vx: 0, vz: 0, minScale: 0.1, maxScale: 3, ox: 0, oy: 0, dirty: true, ready: false });
  const drag = useRef<{ active: boolean; moved: number; lastX: number; lastY: number; lastT: number; id: number }>({ active: false, moved: 0, lastX: 0, lastY: 0, lastT: 0, id: -1 });

  const visible = useMemo(
    () =>
      markers.filter((m) => {
        if (filter === 'all') return true;
        if (m.kind === 'garage') return true;
        return m.kind === 'event' && m.event !== null && m.event.mode === filter;
      }),
    [markers, filter],
  );
  const listed = useMemo(() => {
    const rank = (m: MapMarker) => (m.kind === 'garage' ? -1 : m.event ? MODE_ORDER.indexOf(m.event.mode) : 99);
    return visible
      .filter((m) => m.kind === 'garage' || (m.kind === 'event' && m.event))
      .slice()
      .sort((p, q) => rank(p) - rank(q) || (p.event?.repLevelRequired ?? 0) - (q.event?.repLevelRequired ?? 0) || (p.event?.difficulty ?? 0) - (q.event?.difficulty ?? 0));
  }, [visible]);
  const selected = selectedId ? (markers.find((m) => m.id === selectedId) ?? null) : null;
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: 0 };
    for (const m of markers) {
      if (m.kind !== 'event' || !m.event) continue;
      c.all++;
      c[m.event.mode] = (c[m.event.mode] ?? 0) + 1;
    }
    return c;
  }, [markers]);

  // ---- view helpers ---------------------------------------------------------
  const layout = () => {
    const root = rootRef.current;
    if (!root) return;
    const v = view.current;
    const W = root.clientWidth;
    const H = root.clientHeight;
    const panelW = panelRef.current ? panelRef.current.offsetWidth + 24 : 0;
    v.ox = (W - panelW) / 2;
    v.oy = H / 2;
    const map = api.getMapData();
    if (map) {
      const spanX = map.bounds.maxX - map.bounds.minX;
      const spanZ = map.bounds.maxZ - map.bounds.minZ;
      const fit = Math.min((W - panelW - 60) / spanX, (H - 90) / spanZ);
      v.minScale = fit * 0.85;
      v.maxScale = Math.max(fit * 9, 2.4);
      if (!v.ready) {
        v.ready = true;
        v.scale = v.tscale = fit;
        v.cx = v.tcx = (map.bounds.minX + map.bounds.maxX) / 2;
        v.cz = v.tcz = (map.bounds.minZ + map.bounds.maxZ) / 2;
      }
    }
    if (staticRef.current) fitCanvas(staticRef.current);
    if (liveRef.current) fitCanvas(liveRef.current);
    v.dirty = true;
  };
  useResize(rootRef, layout);

  const clampView = (v: View) => {
    const map = api.getMapData();
    if (!map) return;
    v.tscale = Math.min(v.maxScale, Math.max(v.minScale, v.tscale));
    v.tcx = Math.min(map.bounds.maxX, Math.max(map.bounds.minX, v.tcx));
    v.tcz = Math.min(map.bounds.maxZ, Math.max(map.bounds.minZ, v.tcz));
  };

  const zoomAt = (factor: number, sx: number, sy: number) => {
    const v = view.current;
    const next = Math.min(v.maxScale, Math.max(v.minScale, v.tscale * factor));
    // keep the world point under (sx, sy) fixed, computed against the TARGET view
    const wx = v.tcx + (sx - v.ox) / v.tscale;
    const wz = v.tcz + (sy - v.oy) / v.tscale;
    v.tscale = next;
    v.tcx = wx - (sx - v.ox) / next;
    v.tcz = wz - (sy - v.oy) / next;
    v.vx = v.vz = 0;
    clampView(v);
  };

  const focusOn = (x: number, z: number, minScale?: number) => {
    const v = view.current;
    v.tcx = x;
    v.tcz = z;
    if (minScale !== undefined && v.tscale < minScale) v.tscale = minScale;
    v.vx = v.vz = 0;
    clampView(v);
  };

  const fitAll = () => {
    const map = api.getMapData();
    if (!map) return;
    const v = view.current;
    v.tscale = v.minScale / 0.85;
    v.tcx = (map.bounds.minX + map.bounds.maxX) / 2;
    v.tcz = (map.bounds.minZ + map.bounds.maxZ) / 2;
    v.vx = v.vz = 0;
  };

  // wheel zoom (non-passive listener so the page never scrolls)
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
      e.preventDefault();
      const rect = root.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0016), e.clientX - rect.left, e.clientY - rect.top);
    };
    root.addEventListener('wheel', onWheel, { passive: false });
    return () => root.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- frame: view animation + drawing --------------------------------------
  useFrame((dt, time) => {
    const v = view.current;
    const map = api.getMapData();
    const sc = staticRef.current;
    const lc = liveRef.current;
    if (!sc || !lc) return;
    if (!v.ready) layout();

    // inertia after a drag
    if (!drag.current.active && (Math.abs(v.vx) > 1 || Math.abs(v.vz) > 1)) {
      v.tcx += v.vx * dt;
      v.tcz += v.vz * dt;
      const decay = Math.exp(-4.5 * dt);
      v.vx *= decay;
      v.vz *= decay;
      clampView(v);
    }
    // ease toward the target
    const kEase = 1 - Math.exp(-14 * dt);
    const ds = v.tscale - v.scale;
    const dx = v.tcx - v.cx;
    const dz = v.tcz - v.cz;
    if (Math.abs(ds) > v.scale * 0.0005 || Math.abs(dx) * v.scale > 0.05 || Math.abs(dz) * v.scale > 0.05) {
      v.scale += ds * kEase;
      v.cx += dx * kEase;
      v.cz += dz * kEase;
      v.dirty = true;
    }

    const dpr = sc.width / Math.max(1, sc.clientWidth);
    if (v.dirty) {
      v.dirty = false;
      const sctx = sc.getContext('2d');
      if (sctx && map) drawStatic(sctx, map, v, sc.width, sc.height, dpr);
      // DOM markers follow the view
      const state = api.getState();
      for (const m of state.markers) {
        const el = markerEls.current.get(m.id);
        if (!el) continue;
        el.style.transform = markerTransform(v, m);
      }
    }

    // live layer
    const ctx = lc.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, lc.width, lc.height);
    const t = api.telemetry;
    const k = v.scale * dpr;
    const tx = v.ox * dpr - v.cx * k;
    const ty = v.oy * dpr - v.cz * k;
    const route = t.route;
    if (route && route.length > 1) {
      const path = getRoutePath(route);
      ctx.setTransform(k, 0, 0, k, tx, ty);
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(4,5,10,0.8)';
      ctx.lineWidth = (7 * dpr) / k;
      ctx.stroke(path);
      ctx.lineWidth = (3.6 * dpr) / k;
      if (t.routeIsGps) {
        ctx.strokeStyle = '#b48cff';
        ctx.setLineDash([(10 * dpr) / k, (8 * dpr) / k]);
        ctx.lineDashOffset = (-time * 30 * dpr) / k;
      } else ctx.strokeStyle = MODE_INFO[t.race.mode]?.color ?? '#22e3ff';
      ctx.stroke(path);
      ctx.setLineDash([]);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    // player
    const px = t.x * k + tx;
    const py = t.z * k + ty;
    const pulse = (time * 0.9) % 1;
    ctx.beginPath();
    ctx.arc(px, py, (10 + pulse * 26) * dpr, 0, TAU);
    ctx.strokeStyle = `rgba(34,227,255,${(0.7 * (1 - pulse)).toFixed(3)})`;
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
    ctx.shadowColor = '#22e3ff';
    ctx.shadowBlur = 12 * dpr;
    ctx.lineWidth = 2 * dpr;
    drawArrow(ctx, px, py, Math.PI - t.heading, 10 * dpr, '#ffffff', '#0b1220');
    ctx.shadowBlur = 0;
  });

  // re-place markers when the list changes
  useEffect(() => {
    view.current.dirty = true;
  }, [markers, filter]);

  // ---- pointer handling -----------------------------------------------------
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const d = drag.current;
    d.active = true;
    d.moved = 0;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.lastT = performance.now();
    d.id = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    const v = view.current;
    v.vx = v.vz = 0;
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d.active || e.pointerId !== d.id) return;
    const v = view.current;
    const dx = e.clientX - d.lastX;
    const dy = e.clientY - d.lastY;
    const now = performance.now();
    const dt = Math.max(1, now - d.lastT) / 1000;
    d.lastX = e.clientX;
    d.lastY = e.clientY;
    d.lastT = now;
    d.moved += Math.abs(dx) + Math.abs(dy);
    const wx = -dx / v.scale;
    const wz = -dy / v.scale;
    v.tcx += wx;
    v.tcz += wz;
    clampView(v);
    v.cx = v.tcx;
    v.cz = v.tcz;
    v.vx = v.vx * 0.6 + (wx / dt) * 0.4;
    v.vz = v.vz * 0.6 + (wz / dt) * 0.4;
    v.dirty = true;
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d.active || e.pointerId !== d.id) return;
    d.active = false;
    if (performance.now() - d.lastT > 90) view.current.vx = view.current.vz = 0;
    if (d.moved < 5) setSelectedId(null);
  };

  // ---- actions ----------------------------------------------------------------
  const report = (r: ActionResult, okSound: 'buy' | 'click' = 'click'): boolean => {
    if (r.ok) {
      sfx.play(okSound);
      err.clear();
    } else {
      sfx.play('error');
      err.flash(r.reason);
    }
    return r.ok;
  };
  const closeIfOpen = () => {
    if (api.getState().mapOpen) a.setMapOpen(false);
  };
  const select = (m: MapMarker, focus: boolean) => {
    setSelectedId(m.id);
    err.clear();
    if (focus) focusOn(m.x, m.z, view.current.minScale * 2.2);
  };

  return (
    <div ref={rootRef} className="ax-map ax-pe ax-in-fade" data-testid="world-map">
      <canvas ref={staticRef} className="absolute inset-0 block h-full w-full" />
      <canvas ref={liveRef} className="pointer-events-none absolute inset-0 block h-full w-full" />
      <div className="ax-map-drag" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp} data-testid="map-surface" />

      {/* markers */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {visible.map((m) => {
          const Icon = markerIcon(m);
          const color = markerColor(m);
          const locked = m.kind === 'event' && m.event !== null && m.event.locked;
          const minor = m.kind === 'breaker' || m.kind === 'ramp';
          return (
            <button
              key={m.id}
              type="button"
              ref={(el) => {
                if (el) markerEls.current.set(m.id, el);
                else markerEls.current.delete(m.id);
              }}
              data-testid={`map-marker-${m.id}`}
              className={cx('ax-marker', minor && 'is-minor', locked && 'is-locked', selectedId === m.id && 'is-on', gpsId === m.id && 'is-gps', hoverId === m.id && 'is-hover')}
              style={{ '--ac': color, transform: markerTransform(view.current, m) } as CSSProperties}
              onMouseEnter={() => {
                sfx.hover();
                setHoverId(m.id);
              }}
              onMouseLeave={() => setHoverId((h) => (h === m.id ? null : h))}
              onClick={(e) => {
                e.currentTarget.blur();
                sfx.click();
                select(m, false);
              }}
            >
              <span className="ax-marker-disc">
                <Icon className="h-[58%] w-[58%]" strokeWidth={2.5} />
                {locked ? (
                  <span className="ax-marker-lock">
                    <Lock strokeWidth={3.4} />
                  </span>
                ) : null}
              </span>
              {hoverId === m.id ? (
                <span className="ax-marker-tip">
                  <span className="block font-display text-[0.74rem] font-bold uppercase italic tracking-[0.06em] text-white">{m.event ? m.event.name : m.label}</span>
                  <span className="block text-[0.72rem] font-bold uppercase tracking-[0.1em]" style={{ color }}>
                    {m.event ? `${m.event.modeLabel} · ${fmtMoney(m.event.rewardMoney)}` : MARKER_KIND_LABEL[m.kind]}
                    {locked && m.event ? <span className="ml-[0.5rem] text-neon-red">REP {m.event.repLevelRequired}</span> : null}
                  </span>
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {/* title */}
      <div className="ax-in-left pointer-events-none absolute left-[1.4rem] top-[1.2rem]">
        <div className="ax-display ax-glow text-[2.2rem] text-white">CARTE</div>
        <div className="mt-[0.2rem] font-display text-[0.8rem] font-bold uppercase italic tracking-[0.3em] text-neon-cyan">{CITY_NAME}</div>
        <div className="mt-[0.5rem] text-[0.78rem] font-bold uppercase tracking-[0.14em] text-white/50">Glisser : déplacer · Molette : zoom · Clic : sélectionner</div>
      </div>

      {/* zoom controls */}
      <div className="absolute bottom-[10.4rem] left-[1.4rem] flex flex-col gap-[0.3rem]">
        {(
          [
            { icon: Plus, label: 'Zoom avant', id: 'in', run: () => zoomAt(1.6, view.current.ox, view.current.oy) },
            { icon: Minus, label: 'Zoom arrière', id: 'out', run: () => zoomAt(1 / 1.6, view.current.ox, view.current.oy) },
            { icon: Crosshair, label: 'Centrer sur ma voiture', id: 'me', run: () => focusOn(api.telemetry.x, api.telemetry.z, view.current.minScale * 2.2) },
            { icon: Maximize, label: 'Vue d’ensemble', id: 'fit', run: fitAll },
          ] as const
        ).map((b) => {
          const Icon = b.icon;
          return (
            <button
              key={b.id}
              type="button"
              title={b.label}
              aria-label={b.label}
              data-testid={`map-zoom-${b.id}`}
              className="ax-map-tool"
              onMouseEnter={sfx.hover}
              onClick={(e) => {
                e.currentTarget.blur();
                sfx.click();
                b.run();
              }}
            >
              <Icon className="h-[1.1rem] w-[1.1rem]" strokeWidth={2.6} />
            </button>
          );
        })}
      </div>

      {/* legend */}
      <div className="ax-panel ax-cut-tr ax-in-up pointer-events-none absolute bottom-[1.3rem] left-[1.4rem] w-[25rem] px-[0.9rem] py-[0.65rem]" style={{ '--cut': '0.9rem' } as CSSProperties}>
        <div className="grid grid-cols-4 gap-x-[0.7rem] gap-y-[0.35rem] text-[0.74rem] font-bold uppercase tracking-[0.06em] text-chrome">
          {MODE_ORDER.map((mode) => {
            const Icon = MODE_ICONS[mode];
            return (
              <span key={mode} className="flex items-center gap-[0.35rem]">
                <Icon className="h-[0.9rem] w-[0.9rem]" style={{ color: MODE_INFO[mode].color }} strokeWidth={2.6} />
                {MODE_INFO[mode].label}
              </span>
            );
          })}
          <span className="flex items-center gap-[0.35rem]">
            <i className="block h-[0.7rem] w-[0.7rem] rounded-full border-2" style={{ borderColor: GARAGE_COLOR }} />
            Garage
          </span>
          <span className="flex items-center gap-[0.35rem]">
            <i className="block h-[0.7rem] w-[0.7rem] rounded-full border-2 border-neon-orange" />
            Brise-pours.
          </span>
          <span className="flex items-center gap-[0.35rem]">
            <i className="block h-[0.7rem] w-[0.7rem] rounded-full border-2 border-neon-amber" />
            Tremplin
          </span>
          <span className="flex items-center gap-[0.35rem]">
            <i className="block h-[0.28rem] w-[1.1rem]" style={{ background: '#cdb9ff', boxShadow: '0 0 0.4rem #b48cff' }} />
            Orbitale
          </span>
          <span className="flex items-center gap-[0.35rem]">
            <i className="block h-[0.2rem] w-[1.1rem] bg-[#8f9bb8]" />
            Avenue
          </span>
          <span className="flex items-center gap-[0.35rem]">
            <i className="block h-[0.14rem] w-[1.1rem] bg-[#59647f]" />
            Rue
          </span>
          <span className="flex items-center gap-[0.35rem]">
            <i className="block h-0 w-[1.1rem] border-t-2 border-dashed border-neon-violet" />
            GPS
          </span>
        </div>
      </div>

      {/* side panel */}
      <div ref={panelRef} className="ax-panel ax-carbon ax-edge-top ax-cut-bl ax-in-right absolute bottom-[1.3rem] right-[1.3rem] top-[1.2rem] flex w-[28rem] flex-col" style={{ '--cut': '1.4rem' } as CSSProperties}>
        <div className="flex items-center justify-between px-[1.1rem] pb-[0.5rem] pt-[0.9rem]">
          <div>
            <div className="ax-display text-[1.2rem] text-white">Épreuves</div>
            <div className="text-[0.72rem] font-bold uppercase tracking-[0.14em] text-steel">{counts.all} épreuves dans la ville</div>
          </div>
          <Btn size="sm" tone="steel" sound="back" kbd="M" testId="map-close" onClick={() => a.setMapOpen(false)}>
            <X size="1.1em" strokeWidth={3} /> Fermer
          </Btn>
        </div>

        <div className="flex flex-wrap gap-[0.35rem] px-[1.1rem] pb-[0.6rem]">
          <button
            type="button"
            data-testid="map-filter-all"
            className={cx('ax-chip ax-chip-btn ax-tone-steel', filter === 'all' && 'ax-chip-on')}
            onMouseEnter={sfx.hover}
            onClick={(e) => {
              e.currentTarget.blur();
              sfx.click();
              setFilter('all');
            }}
          >
            Tout · {counts.all}
          </button>
          {MODE_ORDER.map((mode) => {
            const Icon = MODE_ICONS[mode];
            return (
              <button
                key={mode}
                type="button"
                data-testid={`map-filter-${mode}`}
                className={cx('ax-chip ax-chip-btn', filter === mode && 'ax-chip-on')}
                style={{ '--ac': MODE_INFO[mode].color } as CSSProperties}
                onMouseEnter={sfx.hover}
                onClick={(e) => {
                  e.currentTarget.blur();
                  sfx.click();
                  setFilter(filter === mode ? 'all' : mode);
                }}
              >
                <Icon size="1em" strokeWidth={2.6} />
                {MODE_INFO[mode].label} · {counts[mode] ?? 0}
              </button>
            );
          })}
        </div>

        <div className="ax-scroll min-h-0 flex-1 px-[1.1rem]">
          <div className="flex flex-col gap-[0.3rem] pb-[0.6rem]">
            {listed.map((m) => (
              <EventRow key={m.id} marker={m} selected={selectedId === m.id} isGps={gpsId === m.id} mph={mph} onSelect={() => select(m, true)} />
            ))}
            {listed.length === 0 ? <div className="py-[1rem] text-center text-[0.95rem] font-semibold text-steel">Aucune épreuve pour ce filtre.</div> : null}
          </div>
        </div>

        <div className="border-t border-white/10 bg-black/30 px-[1.1rem] pb-[1.2rem] pt-[0.8rem]">
          <ErrorLine error={err.error} nonce={err.nonce} className="mb-[0.5rem]" />
          {selected ? (
            <DetailCard
              marker={selected}
              isGps={gpsId === selected.id}
              mph={mph}
              onGps={() => a.setGpsTarget(gpsId === selected.id ? null : selected.id)}
              onTravel={() => {
                if (report(a.teleportTo(selected.id))) closeIfOpen();
              }}
              onStart={() => {
                if (report(a.startEvent(selected.id))) closeIfOpen();
              }}
            />
          ) : (
            <div>
              <SectionTitle>Détail</SectionTitle>
              <p className="mt-[0.5rem] text-[0.92rem] font-semibold text-steel">
                Sélectionne une épreuve dans la liste ou un point sur la carte pour afficher sa fiche, tracer un itinéraire GPS ou t’y rendre en voyage rapide.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default WorldMapOverlay;
