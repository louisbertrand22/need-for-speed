/* Title screen: logo, start prompt (click / Enter / Space), loader, controls card, save summary. */
import type { CSSProperties } from 'react';
import { CITY_NAME, GAME_TITLE, STARTING_MONEY } from '../game/catalog';
import { fmtMoney, useApi, useKey, useUI } from './hooks';
import { CONTROLS } from './controls';

function Logo() {
  const [first, ...rest] = GAME_TITLE.split(' ');
  const second = rest.join(' ');
  return (
    <div className="ax-logo ax-in-zoom">
      <svg className="ax-logo-mark" viewBox="0 0 120 64" aria-hidden>
        <defs>
          <linearGradient id="axLogoG" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#22e3ff" />
            <stop offset="0.55" stopColor="#b48cff" />
            <stop offset="1" stopColor="#ff2d95" />
          </linearGradient>
        </defs>
        {/* apex: a racing line clipping the corner of a chevron */}
        <path d="M8 58 L52 6 L66 6 L34 58 Z" fill="url(#axLogoG)" />
        <path d="M60 58 L78 28 L92 28 L112 58 L98 58 L85 38 L74 58 Z" fill="#ffffff" />
        <path d="M2 62 Q60 30 118 10" fill="none" stroke="#ff7a1a" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="1 7" />
      </svg>
      <div className="ax-logo-first ax-display" data-text={first}>
        {first}
      </div>
      <div className="ax-logo-second ax-display">
        <i />
        <span>{second}</span>
        <i />
      </div>
    </div>
  );
}

export function TitleScreen() {
  const api = useApi();
  const loading = useUI((s) => s.loading);
  const loadingLabel = useUI((s) => s.loadingLabel);
  const profile = useUI((s) => s.profile);
  const repLevel = useUI((s) => s.repLevel);

  const start = () => {
    if (api.getState().loading) return;
    api.actions.startGame();
  };

  useKey((e) => {
    if (e.repeat) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
      e.preventDefault();
      start();
    }
  });

  const hasProgress =
    profile.rep > 0 ||
    profile.money !== STARTING_MONEY ||
    Object.keys(profile.garage).length > 1 ||
    profile.stats.racesRun > 0 ||
    profile.stats.playTimeS > 120;

  return (
    <div className="ax-title ax-pe" onClick={start} data-testid="title-screen" role="button" tabIndex={-1}>
      <div className="ax-title-vignette" />
      <div className="ax-title-streaks" aria-hidden>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <i key={i} style={{ '--i': i } as CSSProperties} />
        ))}
      </div>
      <div className="ax-title-frame" aria-hidden>
        <i className="is-tl" />
        <i className="is-tr" />
        <i className="is-bl" />
        <i className="is-br" />
      </div>

      <div className="absolute inset-x-0 top-[13%] flex flex-col items-center">
        <Logo />
        <div className="ax-in-up mt-[1.1rem] flex items-center gap-[0.9rem]" style={{ animationDelay: '0.25s' }}>
          <i className="h-px w-[5rem] bg-gradient-to-r from-transparent to-neon-cyan" />
          <span className="ax-legible font-display text-[0.95rem] font-bold uppercase italic tracking-[0.42em] text-chrome">
            {CITY_NAME} <span className="text-neon-cyan">·</span> Courses de rue nocturnes
          </span>
          <i className="h-px w-[5rem] bg-gradient-to-l from-transparent to-neon-cyan" />
        </div>
      </div>

      <div className="absolute inset-x-0 bottom-[19%] flex flex-col items-center gap-[1rem]">
        {loading ? (
          <div className="flex flex-col items-center gap-[0.7rem]" data-testid="title-loader">
            <div className="ax-loader">
              <i />
            </div>
            <div className="ax-legible font-display text-[0.85rem] font-bold uppercase italic tracking-[0.2em] text-neon-cyan">{loadingLabel || 'Chargement…'}</div>
          </div>
        ) : (
          <>
            <div className="ax-start">
              Appuyez sur <span className="ax-key mx-[0.4em]">ENTRÉE</span> ou cliquez pour démarrer
            </div>
            {hasProgress ? (
              <div className="ax-in-up ax-para flex items-center gap-[0.8rem] bg-ink-900/85 px-[1.8rem] py-[0.4rem] text-[1rem] font-bold" data-testid="title-continue">
                <span className="font-display text-[0.8rem] italic tracking-[0.14em] text-neon-green">CONTINUER</span>
                <span className="text-white/50">—</span>
                <span className="text-chrome">niveau REP {repLevel}</span>
                <span className="text-white/50">·</span>
                <span className="ax-num text-neon-green">{fmtMoney(profile.money)}</span>
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="ax-controls-card ax-in-left" style={{ animationDelay: '0.4s' }}>
        <div className="ax-label mb-[0.4rem] !text-neon-cyan">Commandes</div>
        <div className="grid grid-cols-[auto_1fr] gap-x-[0.8rem] gap-y-[0.22rem]">
          {CONTROLS.map((c) => (
            <div key={c.keys} className="contents">
              <span className="font-display text-[0.66rem] font-bold tracking-[0.04em] text-white">{c.keys}</span>
              <span className="text-[0.82rem] font-semibold text-chrome/90">{c.action}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="absolute bottom-[1.2rem] right-[1.5rem] text-right text-[0.72rem] font-bold uppercase tracking-[0.2em] text-white/40">
        Monde ouvert 100 % procédural
      </div>
    </div>
  );
}
