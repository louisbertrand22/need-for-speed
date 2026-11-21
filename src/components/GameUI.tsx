/* =============================================================================
 * APEX NOCTURNE — UI root. Mount once above the game canvas:
 *
 *     <canvas … />            // engine (full screen, behind)
 *     <GameUI api={api} />    // fixed full-viewport overlay, pointer-events: none
 *
 * Only real panels / buttons re-enable pointer events (class `ax-pe`, `.ax-btn`…),
 * so camera-orbit drags in the garage and every driving input reach the engine.
 * ===========================================================================*/
import type { GameAPI } from '../core/types';
import { GarageModal } from './GarageModal';
import type { GarageTab } from './GarageModal';
import { ApiContext, useUI } from './hooks';
import { PauseMenu } from './PauseMenu';
import { RaceHUD } from './RaceHUD';
import { BustedScreen, ResultsScreen } from './Results';
import { SpriteForge } from './sprites';
import { TitleScreen } from './TitleScreen';
import { WorldMapOverlay } from './WorldMapOverlay';

function Screens({ initialGarageTab }: { initialGarageTab?: GarageTab }) {
  const screen = useUI((s) => s.screen);
  const paused = useUI((s) => s.paused);
  const mapOpen = useUI((s) => s.mapOpen);
  const results = useUI((s) => s.results);
  const busted = useUI((s) => s.busted);

  const driving = screen === 'freeroam' || screen === 'countdown' || screen === 'race';
  const inGame = screen !== 'title';

  return (
    <>
      {screen === 'title' ? <TitleScreen /> : null}
      {driving && !paused && !mapOpen ? <RaceHUD /> : null}
      {screen === 'garage' ? <GarageModal initialTab={initialGarageTab} /> : null}
      {screen === 'results' && results ? <ResultsScreen results={results} /> : null}
      {screen === 'busted' && busted ? <BustedScreen busted={busted} /> : null}
      {inGame && mapOpen ? <WorldMapOverlay /> : null}
      {inGame && paused && !mapOpen ? <PauseMenu /> : null}
    </>
  );
}

export interface GameUIProps {
  api: GameAPI;
  /** dev / deep-link helper: tab shown when the garage opens (default 'cars') */
  initialGarageTab?: GarageTab;
}

export function GameUI({ api, initialGarageTab }: GameUIProps) {
  return (
    <ApiContext.Provider value={api}>
      <div className="ax-root" data-testid="game-ui">
        <SpriteForge />
        <Screens initialGarageTab={initialGarageTab} />
      </div>
    </ApiContext.Provider>
  );
}

export default GameUI;
