/* Pursuit HUD (bottom-centre): heat, bounty, bust ⇄ evade tug-of-war, cooldown bar. */
import { useRef } from 'react';
import { EyeOff, Flame, Helicopter, Siren } from 'lucide-react';
import { fmtInt, setP, setText, useApi, useFrame, usePoll } from './hooks';
import { cx } from './kit';

export function PursuitHUD() {
  const api = useApi();
  const status = usePoll((t) => t.pursuit.status, 10);
  const heat = usePoll((t) => Math.max(0, Math.min(5, Math.round(t.pursuit.heat))), 10);
  const units = usePoll((t) => t.pursuit.units, 5);
  const heli = usePoll((t) => t.pursuit.heli, 5);
  const inSight = usePoll((t) => t.pursuit.inSight, 10);

  const bountyRef = useRef<HTMLSpanElement>(null);
  const nextRef = useRef<HTMLSpanElement>(null);
  const bustRef = useRef<HTMLDivElement>(null);
  const evadeRef = useRef<HTMLDivElement>(null);
  const coolRef = useRef<HTMLDivElement>(null);
  const timeRef = useRef<HTMLSpanElement>(null);

  useFrame(() => {
    const p = api.telemetry.pursuit;
    if (p.status === 'idle') return;
    setText(bountyRef.current, fmtInt(p.bounty));
    setP(nextRef.current, p.heatProgress, 50);
    setP(bustRef.current, p.bust, 300);
    setP(evadeRef.current, p.evade, 300);
    setP(coolRef.current, p.cooldown, 300);
    const s = Math.floor(p.durationS);
    setText(timeRef.current, `${Math.floor(s / 60)}:${s % 60 < 10 ? '0' : ''}${s % 60}`);
  });

  if (status === 'idle') return null;
  const cooldown = status === 'cooldown';

  return (
    <div className={cx('ax-pursuit ax-in-up', cooldown && 'is-cool')}>
      {/* top row: heat / units / bounty */}
      <div className="flex items-end justify-between gap-[0.8rem] px-[0.4rem]">
        <div className="flex items-center gap-[0.5rem]">
          <span className="ax-label !text-white/80">Recherché</span>
          <div className="flex items-center gap-[0.12rem]">
            {[0, 1, 2, 3, 4].map((i) => {
              const full = i < heat;
              const next = i === heat;
              return (
                <span key={i} className={cx('ax-heat', full && 'is-full')}>
                  <Flame className="ax-heat-bg" strokeWidth={2.2} />
                  {full ? <Flame key={`f${heat}`} className={cx('ax-heat-fg', i === heat - 1 && 'ax-pop')} strokeWidth={2.2} fill="currentColor" /> : null}
                  {next ? (
                    <span ref={nextRef} className="ax-heat-next">
                      <Flame className="ax-heat-fg" strokeWidth={2.2} fill="currentColor" />
                    </span>
                  ) : null}
                </span>
              );
            })}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-[0.7rem] text-[0.85rem] font-bold">
          {heli ? (
            <span className="ax-blink-slow flex items-center text-neon-amber" title="Hélicoptère">
              <Helicopter className="h-[1.25rem] w-[1.25rem]" strokeWidth={2.3} />
            </span>
          ) : null}
          <span className="flex items-center gap-[0.3rem] text-white">
            <Siren className={cx('h-[1.1rem] w-[1.1rem]', inSight ? 'text-neon-red' : 'text-neon-blue')} strokeWidth={2.3} />
            <span className="ax-num text-[0.95rem]">{units}</span>
          </span>
          <span className="ax-num text-[0.8rem] text-steel">
            <span ref={timeRef}>0:00</span>
          </span>
        </div>

        <div className="flex shrink-0 items-baseline gap-[0.45rem] whitespace-nowrap">
          <span className="ax-label !text-white/80">Prime</span>
          <span className="ax-display ax-glow ax-tone-amber text-[1.5rem] text-neon-amber">
            <span ref={bountyRef}>0</span>
          </span>
        </div>
      </div>

      {/* tug of war / cooldown */}
      {cooldown ? (
        <div className="mt-[0.45rem]">
          <div className="ax-cool-track">
            <div ref={coolRef} className="ax-cool-fill" />
            <div className="ax-cool-label">
              <EyeOff className="h-[1rem] w-[1rem]" strokeWidth={2.6} />
              PLANQUE-TOI
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-[0.45rem] flex items-center gap-[0.6rem]">
          <span className="ax-tug-lbl text-neon-red">Interpellation</span>
          <div className="ax-tug">
            <div ref={bustRef} className="ax-tug-half is-bust">
              <i />
            </div>
            <div className={cx('ax-tug-mid', inSight && 'is-sight')} />
            <div ref={evadeRef} className="ax-tug-half is-evade">
              <i />
            </div>
          </div>
          <span className="ax-tug-lbl text-neon-green">Évasion</span>
        </div>
      )}
    </div>
  );
}
