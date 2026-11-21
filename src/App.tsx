import { useEffect, useRef, useState } from 'react';
import type { GameAPI } from './core/types';
import { GameEngine } from './game/GameEngine';
import { GameUI } from './components/GameUI';

/**
 * Root: a full-screen WebGL canvas driven by the GameEngine (its own
 * requestAnimationFrame loop, completely outside React) with the React HUD
 * layered on top through the GameAPI bridge.
 */
export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [api, setApi] = useState<GameAPI | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let engine: GameEngine | null = null;
    try {
      engine = new GameEngine(canvas);
      setApi(engine.api);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : String(err));
    }
    return () => {
      engine?.dispose();
      setApi(null);
    };
  }, []);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#05060d]">
      <canvas ref={canvasRef} className="absolute inset-0 block h-full w-full outline-none" tabIndex={-1} />
      {api && <GameUI api={api} />}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-8 text-center font-ui text-lg text-red-300">
          Impossible de démarrer le moteur 3D (WebGL 2 requis).
          <br />
          {error}
        </div>
      )}
    </div>
  );
}
