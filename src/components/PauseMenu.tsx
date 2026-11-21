/* Pause menu: resume / event actions / map + Options, Commandes, Statistiques, Réinitialiser. */
import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { ChartNoAxesColumn, Flag, Keyboard, LogOut, Map as MapIcon, Play, RotateCcw, Settings, Trash, TriangleExclamationPoint } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { GameSettings, PlayerStats } from '../core/types';
import { REP_TITLES } from '../game/catalog';
import { CONTROLS } from './controls';
import { KMH_TO_MPH, fmtDuration, fmtInt, fmtMoney, useApi, useSfx, useUI } from './hooks';
import { Btn, SectionTitle, cx } from './kit';

type Page = 'options' | 'controls' | 'stats' | 'reset';

// -----------------------------------------------------------------------------
// Option controls
// -----------------------------------------------------------------------------

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="ax-opt-row">
      <div className="min-w-0">
        <div className="text-[1.02rem] font-bold text-white">{label}</div>
        {hint ? <div className="text-[0.8rem] font-semibold text-steel">{hint}</div> : null}
      </div>
      <div className="flex items-center justify-end">{children}</div>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, testId }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; testId?: string }) {
  const sfx = useSfx();
  return (
    <div className="ax-segmented" data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={cx('ax-segmented-btn', o.id === value && 'is-on')}
          onMouseEnter={sfx.hover}
          onClick={(e) => {
            e.currentTarget.blur();
            if (o.id !== value) {
              sfx.click();
              onChange(o.id);
            }
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider({ value, onChange, testId }: { value: number; onChange: (v: number) => void; testId?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="flex w-[17rem] items-center gap-[0.8rem]">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={pct}
        data-testid={testId}
        className="ax-range"
        style={{ '--v': `${pct}%` } as CSSProperties}
        onChange={(e) => onChange(Number(e.currentTarget.value) / 100)}
        onPointerUp={(e) => e.currentTarget.blur()}
      />
      <span className="ax-num w-[2.8rem] text-right text-[0.9rem] text-white">{pct}%</span>
    </div>
  );
}

function Toggle({ value, onChange, testId }: { value: boolean; onChange: (v: boolean) => void; testId?: string }) {
  const sfx = useSfx();
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      data-testid={testId}
      className={cx('ax-toggle', value && 'is-on')}
      onMouseEnter={sfx.hover}
      onClick={(e) => {
        e.currentTarget.blur();
        sfx.click();
        onChange(!value);
      }}
    >
      <i />
      <span>{value ? 'OUI' : 'NON'}</span>
    </button>
  );
}

function OptionsPage() {
  const api = useApi();
  const s = useUI((st) => st.profile.settings);
  const set = (patch: Partial<GameSettings>) => api.actions.updateSettings(patch);
  return (
    <div className="flex flex-col">
      <SectionTitle className="mb-[0.3rem]">Conduite</SectionTitle>
      <Row label="Transmission" hint="Manuelle : A / E pour passer les rapports">
        <Segmented
          testId="opt-transmission"
          value={s.transmission}
          options={[
            { id: 'auto', label: 'Automatique' },
            { id: 'manual', label: 'Manuelle' },
          ]}
          onChange={(transmission) => set({ transmission })}
        />
      </Row>
      <Row label="Caméra">
        <Segmented
          testId="opt-camera"
          value={s.cameraMode}
          options={[
            { id: 'chaseNear', label: 'Proche' },
            { id: 'chaseFar', label: 'Éloignée' },
            { id: 'hood', label: 'Capot' },
          ]}
          onChange={(cameraMode) => set({ cameraMode })}
        />
      </Row>
      <Row label="Unités de vitesse">
        <Segmented
          testId="opt-units"
          value={s.units}
          options={[
            { id: 'kmh', label: 'km/h' },
            { id: 'mph', label: 'mph' },
          ]}
          onChange={(units) => set({ units })}
        />
      </Row>
      <Row label="Densité du trafic" hint="Nombre de véhicules civils en ville">
        <Slider testId="opt-traffic" value={s.trafficDensity} onChange={(trafficDensity) => set({ trafficDensity })} />
      </Row>

      <SectionTitle className="mb-[0.3rem] mt-[1rem]">Son</SectionTitle>
      <Row label="Volume général">
        <Slider testId="opt-master" value={s.masterVolume} onChange={(masterVolume) => set({ masterVolume })} />
      </Row>
      <Row label="Volume musique">
        <Slider testId="opt-music" value={s.musicVolume} onChange={(musicVolume) => set({ musicVolume })} />
      </Row>

      <SectionTitle className="mb-[0.3rem] mt-[1rem]">Affichage</SectionTitle>
      <Row label="Qualité graphique" hint="Ombres, reflets, distance d’affichage">
        <Segmented
          testId="opt-quality"
          value={s.quality}
          options={[
            { id: 'low', label: 'Basse' },
            { id: 'medium', label: 'Moyenne' },
            { id: 'high', label: 'Haute' },
          ]}
          onChange={(quality) => set({ quality })}
        />
      </Row>
      <Row label="Rétroviseur">
        <Toggle testId="opt-mirror" value={s.mirror} onChange={(mirror) => set({ mirror })} />
      </Row>
      <Row label="Lignes de vitesse">
        <Toggle testId="opt-speedlines" value={s.speedLines} onChange={(speedLines) => set({ speedLines })} />
      </Row>
    </div>
  );
}

function ControlsPage() {
  return (
    <div>
      <SectionTitle className="mb-[0.6rem]">Clavier</SectionTitle>
      <div className="grid grid-cols-2 gap-x-[1.6rem] gap-y-[0.45rem]">
        {CONTROLS.map((c) => (
          <div key={c.keys} className="flex items-center justify-between gap-[0.8rem] border-b border-white/10 py-[0.5rem]">
            <span className="text-[1rem] font-bold text-chrome">{c.action}</span>
            <span className="flex shrink-0 items-center gap-[0.3rem]">
              {c.keys.split(' / ').map((k, i) => (
                <span key={k} className="flex items-center gap-[0.3rem]">
                  {i > 0 ? <span className="text-[0.75rem] text-steel">/</span> : null}
                  <span className="ax-key ax-key-dark text-[0.82rem]">{k}</span>
                </span>
              ))}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-[1rem] text-[0.9rem] font-semibold text-steel">
        Disposition AZERTY ou QWERTY : les touches de conduite suivent la position physique des touches (ZQSD = WASD).
      </p>
    </div>
  );
}

function StatsPage() {
  const profile = useUI((s) => s.profile);
  const level = useUI((s) => s.repLevel);
  const st: PlayerStats = profile.stats;
  const mph = profile.settings.units === 'mph';
  const winRate = st.racesRun > 0 ? Math.round((st.racesWon / st.racesRun) * 100) : 0;
  const tiles: { label: string; value: string; color?: string }[] = [
    { label: 'Courses disputées', value: fmtInt(st.racesRun) },
    { label: 'Victoires', value: `${fmtInt(st.racesWon)}`, color: '#ffc233' },
    { label: 'Taux de victoire', value: `${winRate} %` },
    { label: 'Vitesse max', value: `${Math.round(st.topSpeedKmh * (mph ? KMH_TO_MPH : 1))} ${mph ? 'mph' : 'km/h'}`, color: '#22e3ff' },
    { label: 'Meilleur drift', value: `${fmtInt(st.bestDrift)} pts`, color: '#ff2d95' },
    { label: 'Frôlements', value: fmtInt(st.nearMisses) },
    { label: 'Poursuites semées', value: fmtInt(st.pursuitsEvaded), color: '#7dff6a' },
    { label: 'Arrestations', value: fmtInt(st.timesBusted), color: '#ff3344' },
    { label: 'Prime cumulée', value: fmtInt(st.totalBounty), color: '#ffc233' },
    { label: 'Unités neutralisées', value: fmtInt(st.copsDisabled) },
    { label: 'Brise-poursuites', value: fmtInt(st.breakersUsed) },
    { label: 'Niveau de recherche max', value: `${st.maxHeat} / 5`, color: '#ff7a1a' },
    { label: 'Distance parcourue', value: `${st.distanceKm.toFixed(1).replace('.', ',')} km` },
    { label: 'Temps de jeu', value: fmtDuration(st.playTimeS) },
    { label: 'Voitures possédées', value: String(Object.keys(profile.garage).length) },
  ];
  return (
    <div>
      <div className="mb-[0.9rem] flex items-center gap-[1.2rem]">
        <div className="ax-rep-badge shrink-0">
          <span className="text-[0.56rem] font-bold tracking-[0.2em] text-ink-900">REP</span>
          <span className="ax-display text-[1.75rem] text-ink-950">{level}</span>
        </div>
        <div>
          <div className="ax-display text-[1.3rem] text-white">{REP_TITLES[Math.min(REP_TITLES.length - 1, Math.max(0, level - 1))]}</div>
          <div className="mt-[0.2rem] text-[0.95rem] font-bold text-steel">
            {fmtInt(profile.rep)} REP · <span className="text-neon-green">{fmtMoney(profile.money)}</span>
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-[0.55rem]">
        {tiles.map((t) => (
          <div key={t.label} className="ax-stat-tile">
            <div className="ax-label">{t.label}</div>
            <div className="ax-num mt-[0.2rem] text-[1.25rem] italic" style={{ color: t.color ?? '#fff' }}>
              {t.value}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResetPage({ onDone }: { onDone: () => void }) {
  const api = useApi();
  const [armed, setArmed] = useState(false);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-[1rem] text-center">
      <TriangleExclamationPoint className="h-[3.4rem] w-[3.4rem] text-neon-red" strokeWidth={2} />
      <div className="ax-display text-[1.5rem] text-white">Réinitialiser la sauvegarde ?</div>
      <p className="max-w-[26rem] text-[1rem] font-semibold text-chrome">
        Argent, réputation, voitures, améliorations, records et réglages seront définitivement effacés. Cette action est irréversible.
      </p>
      {armed ? (
        <div className="ax-in-up flex flex-col items-center gap-[0.8rem]">
          <div className="text-[0.95rem] font-bold uppercase tracking-[0.14em] text-neon-red">Dernière confirmation</div>
          <div className="flex gap-[1rem]">
            <Btn tone="steel" sound="back" onClick={() => setArmed(false)} testId="reset-cancel">
              Annuler
            </Btn>
            <Btn
              tone="red"
              solid
              testId="reset-confirm"
              onClick={() => {
                api.actions.resetSave();
                setArmed(false);
                onDone();
              }}
            >
              <Trash size="1.1em" strokeWidth={2.6} /> Tout effacer
            </Btn>
          </div>
        </div>
      ) : (
        <Btn tone="red" onClick={() => setArmed(true)} testId="reset-arm">
          <Trash size="1.1em" strokeWidth={2.6} /> Réinitialiser…
        </Btn>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Menu
// -----------------------------------------------------------------------------

function NavItem({ icon: Icon, label, active, onClick, tone = 'cyan', testId }: { icon: LucideIcon; label: string; active?: boolean; onClick: () => void; tone?: 'cyan' | 'red' | 'green'; testId?: string }) {
  const sfx = useSfx();
  return (
    <button
      type="button"
      data-testid={testId}
      className={cx('ax-nav-item', `ax-tone-${tone}`, active && 'is-on')}
      onMouseEnter={sfx.hover}
      onClick={(e) => {
        e.currentTarget.blur();
        sfx.click();
        onClick();
      }}
    >
      <Icon className="h-[1.15rem] w-[1.15rem] shrink-0" strokeWidth={2.4} />
      <span>{label}</span>
    </button>
  );
}

export function PauseMenu() {
  const api = useApi();
  const activeEvent = useUI((s) => s.activeEvent);
  const screen = useUI((s) => s.screen);
  const [page, setPage] = useState<Page>('options');
  const a = api.actions;
  const inEvent = activeEvent !== null && (screen === 'race' || screen === 'countdown');

  const unpause = () => {
    if (api.getState().paused) a.setPaused(false);
  };

  return (
    <div className="ax-overlay ax-pe ax-in-fade" data-testid="pause-menu">
      <div className="ax-panel ax-carbon ax-edge-top ax-cut ax-in-zoom flex h-[41rem] max-h-[92vh] w-[66rem] max-w-[96vw]" style={{ '--cut': '1.4rem' } as CSSProperties}>
        {/* nav */}
        <div className="flex w-[19rem] shrink-0 flex-col border-r border-white/10 bg-black/25 p-[1.3rem]">
          <div className="ax-display ax-glow text-[2.6rem] text-white">PAUSE</div>
          <div className="mb-[1.1rem] mt-[0.3rem] h-[1.2rem] truncate text-[0.9rem] font-bold uppercase tracking-[0.12em] text-neon-cyan">
            {inEvent && activeEvent ? `${activeEvent.modeLabel} · ${activeEvent.name}` : 'Conduite libre'}
          </div>
          <div className="flex flex-col gap-[0.35rem]">
            <NavItem icon={Play} label="Reprendre" tone="green" testId="pause-resume" onClick={() => a.setPaused(false)} />
            {inEvent ? (
              <>
                <NavItem
                  icon={RotateCcw}
                  label="Recommencer l’épreuve"
                  testId="pause-restart"
                  onClick={() => {
                    a.restartEvent();
                    unpause();
                  }}
                />
                <NavItem
                  icon={Flag}
                  label="Abandonner l’épreuve"
                  tone="red"
                  testId="pause-abandon"
                  onClick={() => {
                    a.exitToFreeRoam();
                    unpause();
                  }}
                />
              </>
            ) : null}
            {screen === 'freeroam' ? <NavItem icon={MapIcon} label="Carte" testId="pause-map" onClick={() => a.setMapOpen(true)} /> : null}
            <div className="my-[0.5rem] h-px bg-white/10" />
            <NavItem icon={Settings} label="Options" active={page === 'options'} testId="pause-options" onClick={() => setPage('options')} />
            <NavItem icon={Keyboard} label="Commandes" active={page === 'controls'} testId="pause-controls" onClick={() => setPage('controls')} />
            <NavItem icon={ChartNoAxesColumn} label="Statistiques" active={page === 'stats'} testId="pause-stats" onClick={() => setPage('stats')} />
          </div>
          <div className="mt-auto">
            <NavItem icon={LogOut} label="Réinitialiser la sauvegarde" tone="red" active={page === 'reset'} testId="pause-reset" onClick={() => setPage('reset')} />
          </div>
        </div>

        {/* page */}
        <div className="flex min-w-0 flex-1 flex-col p-[1.4rem]">
          <div className="mb-[0.8rem] flex items-end justify-between">
            <div className="ax-display text-[1.35rem] text-white">
              {page === 'options' ? 'Options' : page === 'controls' ? 'Commandes' : page === 'stats' ? 'Statistiques' : 'Sauvegarde'}
            </div>
            <div className="text-[0.8rem] font-bold uppercase tracking-[0.14em] text-steel">
              <span className="ax-key ax-key-dark mr-[0.4em]">Échap</span>Reprendre
            </div>
          </div>
          <div key={page} className="ax-scroll ax-in-up min-h-0 flex-1 pr-[0.6rem]">
            {page === 'options' ? <OptionsPage /> : page === 'controls' ? <ControlsPage /> : page === 'stats' ? <StatsPage /> : <ResetPage onDone={() => setPage('options')} />}
          </div>
        </div>
      </div>
    </div>
  );
}
