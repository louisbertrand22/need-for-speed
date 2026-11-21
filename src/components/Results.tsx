/* End-of-event results screen and the "busted" screen. */
import type { CSSProperties } from 'react';
import { ArrowBigUp, Flame, LockOpen, RotateCcw, Sparkles, Trophy } from 'lucide-react';
import type { BustedInfo, EventResults } from '../core/types';
import { MODE_INFO, REP_TITLES } from '../game/catalog';
import { fmtDuration, fmtInt, fmtMoney, fmtTime, ordinalFr, useApi, useKey, useUI } from './hooks';
import { Btn, MEDAL_INFO, MedalBadge, ModeChip, SectionTitle, TickNumber, cx, useStage } from './kit';

// -----------------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------------

function headline(r: EventResults): { text: string; sub: string; color: string } {
  if (!r.completed) return { text: 'ÉPREUVE ÉCHOUÉE', sub: r.failReason ?? 'Épreuve abandonnée', color: '#ff3344' };
  if (r.won) return { text: 'VICTOIRE !', sub: r.racers > 1 ? `Tu termines 1er sur ${r.racers}` : 'Objectif atteint', color: '#ffc233' };
  if (r.medal) {
    const m = r.medal === 'gold' ? 'MÉDAILLE D’OR' : r.medal === 'silver' ? 'MÉDAILLE D’ARGENT' : 'MÉDAILLE DE BRONZE';
    return { text: m, sub: r.racers > 1 ? `Tu termines ${r.position}${ordinalFr(r.position)} sur ${r.racers}` : 'Épreuve terminée', color: MEDAL_INFO[r.medal].color };
  }
  return {
    text: r.racers > 1 ? 'DÉFAITE' : 'TERMINÉ',
    sub: r.racers > 1 ? `Tu termines ${r.position}${ordinalFr(r.position)} sur ${r.racers}` : 'Objectif manqué — retente ta chance',
    color: '#22e3ff',
  };
}

function Figure({ label, value, accent, big }: { label: string; value: string; accent?: string; big?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-[1rem] border-b border-white/10 py-[0.5rem]">
      <span className="ax-label">{label}</span>
      <span className={cx('ax-num italic', big ? 'text-[1.6rem]' : 'text-[1.15rem]')} style={{ color: accent ?? '#fff' }}>
        {value}
      </span>
    </div>
  );
}

function RewardRow({ label, money, rep, visible, strong }: { label: string; money: number; rep: number; visible: boolean; strong?: boolean }) {
  if (!visible) return <div className="h-[2.1rem]" />;
  return (
    <div className={cx('ax-in-left flex h-[2.1rem] items-center justify-between gap-[0.8rem]', strong ? 'border-t-2 border-neon-amber/70 pt-[0.2rem]' : 'border-b border-white/10')}>
      <span className={cx('truncate', strong ? 'ax-display text-[1rem] text-white' : 'text-[1rem] font-bold text-chrome')}>{label}</span>
      <span className="flex shrink-0 items-baseline gap-[1rem]">
        <TickNumber value={money} prefix="+" suffix={' $'} duration={strong ? 1100 : 600} className={cx('ax-num italic text-neon-green', strong ? 'text-[1.5rem]' : 'text-[1rem]')} />
        <TickNumber value={rep} prefix="+" suffix=" REP" duration={strong ? 1100 : 600} className={cx('ax-num w-[6.2rem] text-right italic text-neon-cyan', strong ? 'text-[1.15rem]' : 'text-[0.9rem]')} />
      </span>
    </div>
  );
}

export function ResultsScreen({ results }: { results: EventResults }) {
  const api = useApi();
  const paused = useUI((s) => s.paused);
  const r = results;
  const head = headline(r);
  const modeCol = MODE_INFO[r.mode].color;
  const totalMoney = r.rewardMoney + r.bonuses.reduce((a, b) => a + b.money, 0);
  const totalRep = r.rewardRep + r.bonuses.reduce((a, b) => a + b.rep, 0);
  // staged reveal: base, each bonus, total, extras
  const stage = useStage(r.bonuses.length + 3, 320, 500);

  useKey((e) => {
    if (e.repeat) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      api.actions.playUiSound('click');
      api.actions.exitToFreeRoam();
    } else if (e.code === 'KeyR') {
      e.preventDefault();
      api.actions.playUiSound('click');
      api.actions.restartEvent();
    }
  }, !paused);

  const scoreMode = r.score !== null;

  return (
    <div className="ax-overlay ax-pe ax-in-fade" data-testid="results-screen" style={{ '--ac': head.color } as CSSProperties}>
      <div className="flex w-[74rem] max-w-[96vw] flex-col items-stretch">
        {/* headline */}
        <div className="mb-[1.1rem] flex flex-col items-center text-center">
          <div className="ax-in-down flex items-center gap-[0.7rem]">
            <ModeChip mode={r.mode} label={r.modeLabel} />
            <span className="ax-display text-[1.1rem] text-white">{r.name}</span>
          </div>
          <div className={cx('ax-display ax-result-head', r.won && 'is-win')} style={{ color: head.color }}>
            {head.text}
          </div>
          <div className="ax-in-up text-[1.1rem] font-bold uppercase tracking-[0.18em] text-chrome" style={{ animationDelay: '0.3s' }}>
            {head.sub}
          </div>
        </div>

        <div className="grid grid-cols-[1fr_1.05fr_1.3fr] gap-[1rem]">
          {/* figures */}
          <div className="ax-panel ax-carbon ax-edge-top ax-cut ax-in-left p-[1.2rem]" style={{ '--ac': modeCol, animationDelay: '0.15s' } as CSSProperties}>
            <SectionTitle>Performance</SectionTitle>
            <div className="mt-[0.7rem] flex items-end justify-between">
              <div className="flex items-start leading-none">
                <span className="ax-display text-[5rem]" style={{ color: r.position === 1 ? '#ffc233' : '#fff', textShadow: '0 0 1.4rem color-mix(in srgb, currentColor 40%, transparent)' }}>
                  {r.position}
                </span>
                <span className="ml-[0.2rem] mt-[0.5rem] flex flex-col">
                  <span className="ax-display text-[1.4rem] text-white/90">{ordinalFr(r.position)}</span>
                  <span className="ax-display mt-[0.5rem] text-[1.6rem] text-steel">/{r.racers}</span>
                </span>
              </div>
              {r.medal ? (
                <div className="ax-in-zoom flex flex-col items-center gap-[0.2rem]" style={{ animationDelay: '0.6s' }}>
                  <MedalBadge medal={r.medal} size="3.2rem" />
                  <span className="font-display text-[0.75rem] font-bold uppercase italic tracking-[0.14em]" style={{ color: MEDAL_INFO[r.medal].color }}>
                    {MEDAL_INFO[r.medal].label}
                  </span>
                </div>
              ) : r.won ? (
                <Trophy className="ax-in-zoom h-[3.4rem] w-[3.4rem] text-neon-amber" strokeWidth={1.8} style={{ animationDelay: '0.6s', filter: 'drop-shadow(0 0 0.8rem #ffc233)' }} />
              ) : null}
            </div>
            <div className="mt-[0.6rem]">
              {scoreMode ? <Figure label={r.scoreLabel ?? 'Score'} value={fmtInt(r.score ?? 0)} accent={modeCol} big /> : null}
              <Figure label="Temps" value={fmtTime(r.timeMs)} big={!scoreMode} />
              {r.bestLapMs !== null ? <Figure label="Meilleur tour" value={fmtTime(r.bestLapMs)} accent="#7dff6a" /> : null}
            </div>
            {r.newRecord ? (
              <div className="ax-record ax-in-zoom mt-[0.9rem]" style={{ animationDelay: '0.9s' }} data-testid="results-record">
                <Sparkles className="h-[1.1rem] w-[1.1rem]" strokeWidth={2.6} />
                NOUVEAU RECORD
              </div>
            ) : null}
          </div>

          {/* standings */}
          <div className="ax-panel ax-carbon ax-edge-top ax-cut ax-in-up p-[1.2rem]" style={{ '--ac': modeCol, animationDelay: '0.25s' } as CSSProperties}>
            <SectionTitle>Classement final</SectionTitle>
            <div className="mt-[0.7rem] flex flex-col gap-[0.3rem]">
              {r.standings.map((row, i) => (
                <div key={row.name} className={cx('ax-stand-row ax-in-left !h-[2.1rem]', row.isPlayer && 'is-me')} style={{ animationDelay: `${0.35 + i * 0.07}s` }}>
                  <span className="ax-stand-pos">{row.position}</span>
                  <span className="flex-1 truncate">{row.name}</span>
                  <span className="ax-num text-[0.8rem] opacity-90">{row.detail}</span>
                </div>
              ))}
              {r.standings.length === 0 ? <div className="text-[0.95rem] font-semibold text-steel">Épreuve en solo.</div> : null}
            </div>
          </div>

          {/* rewards */}
          <div className="ax-panel ax-carbon ax-edge-top ax-cut ax-in-right p-[1.2rem]" style={{ '--ac': '#ffc233', animationDelay: '0.35s' } as CSSProperties}>
            <SectionTitle>Récompenses</SectionTitle>
            <div className="mt-[0.6rem] flex flex-col">
              <RewardRow label={r.completed ? 'Prime de l’épreuve' : 'Participation'} money={r.rewardMoney} rep={r.rewardRep} visible={stage >= 1} />
              {r.bonuses.map((b, i) => (
                <RewardRow key={`${b.label}-${i}`} label={b.label} money={b.money} rep={b.rep} visible={stage >= 2 + i} />
              ))}
              <div className="h-[0.5rem]" />
              <RewardRow label="TOTAL" money={totalMoney} rep={totalRep} visible={stage >= 2 + r.bonuses.length} strong />
            </div>
            {stage >= 3 + r.bonuses.length ? (
              <div className="mt-[0.8rem] flex flex-col gap-[0.5rem]">
                {r.repLevelUp !== null ? (
                  <div className="ax-levelup ax-in-zoom" data-testid="results-levelup">
                    <ArrowBigUp className="h-[1.9rem] w-[1.9rem] shrink-0" strokeWidth={2.2} fill="currentColor" />
                    <div className="min-w-0">
                      <div className="ax-display text-[1.05rem]">NIVEAU REP {r.repLevelUp}</div>
                      <div className="truncate text-[0.9rem] font-bold opacity-80">{REP_TITLES[Math.min(REP_TITLES.length - 1, Math.max(0, r.repLevelUp - 1))]}</div>
                    </div>
                  </div>
                ) : null}
                {r.unlocked.length > 0 ? (
                  <div className="ax-in-up">
                    <div className="ax-label mb-[0.3rem] !text-neon-violet">Débloqué</div>
                    <div className="flex flex-wrap gap-[0.4rem]">
                      {r.unlocked.map((u) => (
                        <span key={u} className="ax-chip ax-tone-violet !text-[0.8rem] !normal-case !tracking-[0.03em]">
                          <LockOpen size="1em" strokeWidth={2.6} />
                          {u}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <div className="ax-in-up mt-[1.3rem] flex items-center justify-center gap-[1.2rem]" style={{ animationDelay: '0.5s' }}>
          <Btn tone="steel" size="lg" kbd="R" testId="results-restart" onClick={() => api.actions.restartEvent()}>
            <RotateCcw size="1.1em" strokeWidth={2.6} /> Recommencer
          </Btn>
          <Btn tone="green" size="lg" solid kbd="Entrée" testId="results-continue" onClick={() => api.actions.exitToFreeRoam()}>
            Continuer
          </Btn>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Busted
// -----------------------------------------------------------------------------

export function BustedScreen({ busted }: { busted: BustedInfo }) {
  const api = useApi();
  const paused = useUI((s) => s.paused);
  const stage = useStage(4, 260, 700);
  const heat = Math.max(0, Math.min(5, Math.round(busted.heat)));

  useKey((e) => {
    if (e.repeat) return;
    if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      api.actions.playUiSound('click');
      api.actions.exitToFreeRoam();
    }
  }, !paused);

  return (
    <div className="ax-overlay ax-busted ax-pe ax-in-fade" data-testid="busted-screen">
      <div className="ax-busted-lights" aria-hidden>
        <i />
        <i />
      </div>
      <div className="ax-busted-quake flex flex-col items-center">
        <div className="ax-stamp">
          <span className="ax-display">ARRÊTÉ</span>
        </div>
        <div className="ax-in-up mt-[0.4rem] text-[1rem] font-bold uppercase tracking-[0.3em] text-white/80" style={{ animationDelay: '0.55s' }}>
          Police de Port-Sélène — véhicule immobilisé
        </div>

        <div className="ax-panel ax-carbon ax-edge-top ax-cut ax-tone-red ax-in-up mt-[1.4rem] w-[40rem] max-w-[94vw] p-[1.3rem]" style={{ animationDelay: '0.7s' }}>
          <div className="grid grid-cols-2 gap-x-[1.6rem]">
            <div className="flex items-baseline justify-between border-b border-white/10 py-[0.55rem]">
              <span className="ax-label">Amende</span>
              {stage >= 1 ? <TickNumber value={busted.fine} prefix="−" suffix={' $'} className="ax-num ax-in-fade text-[1.6rem] italic text-neon-red" /> : <span />}
            </div>
            <div className="flex items-center justify-between border-b border-white/10 py-[0.55rem]">
              <span className="ax-label">Niveau de recherche</span>
              <span className="flex items-center gap-[0.1rem]">
                {[0, 1, 2, 3, 4].map((i) => (
                  <Flame
                    key={i}
                    className="h-[1.3rem] w-[1.3rem]"
                    strokeWidth={2.2}
                    fill={i < heat ? 'currentColor' : 'none'}
                    style={{ color: i < heat ? (i >= 3 ? '#ff3344' : '#ff7a1a') : 'rgba(255,255,255,0.22)' }}
                  />
                ))}
              </span>
            </div>
            <div className="flex items-baseline justify-between border-b border-white/10 py-[0.55rem]">
              <span className="ax-label">Prime perdue</span>
              {stage >= 2 ? <TickNumber value={busted.bounty} className="ax-num ax-in-fade text-[1.25rem] italic text-neon-amber" /> : <span />}
            </div>
            <div className="flex items-baseline justify-between border-b border-white/10 py-[0.55rem]">
              <span className="ax-label">Durée de la poursuite</span>
              <span className="ax-num text-[1.1rem] italic text-white">{fmtDuration(busted.durationS)}</span>
            </div>
          </div>

          <SectionTitle className="mt-[1rem]">Infractions relevées</SectionTitle>
          <div className="mt-[0.5rem] grid grid-cols-2 gap-x-[1.6rem] gap-y-[0.2rem]">
            {busted.infractions.length === 0 ? <div className="text-[0.95rem] font-semibold text-steel">Aucune infraction enregistrée.</div> : null}
            {busted.infractions.map((inf, i) => (
              <div key={inf.label} className={cx('flex items-center justify-between py-[0.25rem] text-[1rem] font-bold', stage >= 3 ? 'ax-in-left' : 'opacity-0')} style={{ animationDelay: `${i * 0.06}s` }}>
                <span className="text-chrome">{inf.label}</span>
                <span className="ax-num text-neon-red">×{inf.count}</span>
              </div>
            ))}
          </div>
          <div className="mt-[0.9rem] text-[0.88rem] font-semibold text-steel">
            L’amende de {fmtMoney(busted.fine)} est prélevée sur ton compte et la prime de la poursuite est perdue.
          </div>
        </div>

        <div className="ax-in-up mt-[1.3rem]" style={{ animationDelay: '1s' }}>
          <Btn tone="red" size="lg" solid kbd="Entrée" testId="busted-continue" onClick={() => api.actions.exitToFreeRoam()}>
            Continuer
          </Btn>
        </div>
      </div>
    </div>
  );
}
