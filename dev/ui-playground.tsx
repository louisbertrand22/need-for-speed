/* =============================================================================
 * UI playground: the whole interface against a mock GameAPI (dev/ui-mock-api.ts).
 * URL: /dev/ui-playground.html?screen=title|freeroam|race|countdown|garage|results|busted
 *        &mode=sprint|circuit|drift|drag|speedtrap &pursuit=1 &map=1 &paused=1
 *        &tab=cars|perf|style &loading=1
 * Engine-owned keys are emulated here: M (map), Esc / P (pause), E (prompt).
 * `window.__mock` exposes the mock (calls log, state) for automated checks.
 * ===========================================================================*/
import { createRoot } from 'react-dom/client';
import '../src/index.css';
import { MIRROR_RECT } from '../src/core/types';
import type { EventMode, GameScreen } from '../src/core/types';
import { GameUI } from '../src/components/GameUI';
import type { GarageTab } from '../src/components/GarageModal';
import { createMockApi } from './ui-mock-api';

const q = new URLSearchParams(window.location.search);
const api = createMockApi({
  screen: (q.get('screen') ?? 'freeroam') as GameScreen,
  mode: (q.get('mode') ?? 'circuit') as EventMode,
  pursuit: q.get('pursuit') === '1',
  map: q.get('map') === '1',
  paused: q.get('paused') === '1',
  loading: q.get('loading') === '1',
});
(window as unknown as { __mock: typeof api }).__mock = api;

let last = performance.now();
const loop = (now: number) => {
  api.step(Math.min(0.1, (now - last) / 1000));
  last = now;
  requestAnimationFrame(loop);
};
requestAnimationFrame(loop);

window.addEventListener('keydown', (e) => {
  const s = api.getState();
  if (s.screen === 'title' || s.screen === 'garage' || e.repeat) return;
  if (e.code === 'KeyM') api.actions.setMapOpen(!s.mapOpen);
  else if (e.code === 'Escape' && s.mapOpen) api.actions.setMapOpen(false);
  else if (e.code === 'Escape' || e.code === 'KeyP') api.actions.setPaused(!s.paused);
  else if (e.code === 'KeyE' && s.prompt) api.actions.enterGarage();
});

/** Stand-in for the 3D scene: night sky, skyline, wet road, and the mirror image rectangle. */
function Backdrop() {
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'linear-gradient(180deg,#0b1030 0%,#231040 38%,#3a1436 52%,#0a0b14 53%,#05060d 100%)' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: '30%', height: '23%', background: 'repeating-linear-gradient(90deg,#070912 0 3.2%,transparent 3.2% 3.7%,#0b0e1c 3.7% 8%,transparent 8% 8.4%,#080a14 8.4% 11%)', opacity: 0.92 }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: '36%', height: '16%', background: 'repeating-linear-gradient(90deg,transparent 0 1.1%,rgba(255,190,90,.5) 1.1% 1.3%,transparent 1.3% 2.9%,rgba(34,227,255,.45) 2.9% 3.05%)', maskImage: 'repeating-linear-gradient(180deg,#000 0 3px,transparent 3px 9px)' }} />
      <div style={{ position: 'absolute', left: '50%', top: '53%', width: '140%', height: '47%', transform: 'translateX(-50%) perspective(600px) rotateX(58deg)', transformOrigin: 'top', background: 'repeating-linear-gradient(90deg,transparent 0 49.6%,rgba(255,200,80,.7) 49.6% 50.4%,transparent 50.4%),linear-gradient(180deg,#15182a,#0a0b14)' }} />
      <div
        style={{
          position: 'absolute',
          left: '50%',
          top: MIRROR_RECT.top,
          width: `min(${MIRROR_RECT.maxWidth}px, ${MIRROR_RECT.widthFrac * 100}vw)`,
          aspectRatio: String(MIRROR_RECT.aspect),
          transform: 'translateX(-50%)',
          background: 'linear-gradient(180deg,#1a1f44,#40204a 55%,#11131f 56%)',
        }}
      />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <>
    <Backdrop />
    <GameUI api={api} initialGarageTab={(q.get('tab') ?? 'cars') as GarageTab} />
  </>,
);
