/* =============================================================================
 * Marker sprites for canvas rendering (radar): the same lucide icons as the DOM
 * markers of the world map, rasterised once into small tinted discs.
 * ===========================================================================*/
import { useEffect, useRef } from 'react';
import type { MapMarker } from '../core/types';
import { Bomb, ChevronsUp, Flag, Gauge, RefreshCw, Tornado, Warehouse, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export type IconKey = 'sprint' | 'circuit' | 'drift' | 'drag' | 'speedtrap' | 'garage' | 'breaker' | 'ramp';

const ICONS: Record<IconKey, LucideIcon> = {
  sprint: Flag,
  circuit: RefreshCw,
  drift: Tornado,
  drag: Zap,
  speedtrap: Gauge,
  garage: Warehouse,
  breaker: Bomb,
  ramp: ChevronsUp,
};

const ICON_KEYS = Object.keys(ICONS) as IconKey[];

const SPRITE_PX = 56;
const iconImages = new Map<IconKey, HTMLImageElement>();
const spriteCache = new Map<string, HTMLCanvasElement>();

export function markerIconKey(m: MapMarker): IconKey {
  if (m.kind === 'event') return m.event ? m.event.mode : 'sprint';
  return m.kind;
}

/** Tinted disc sprite (SPRITE_PX square) or null while the icons are still decoding. */
export function getMarkerSprite(key: IconKey, color: string): HTMLCanvasElement | null {
  const id = `${key}|${color}`;
  const hit = spriteCache.get(id);
  if (hit) return hit;
  const img = iconImages.get(key);
  if (!img || !img.complete || img.naturalWidth === 0) return null;
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE_PX;
  const ctx = c.getContext('2d');
  if (!ctx) return null;
  const h = SPRITE_PX / 2;
  // tinted icon on a scratch canvas
  const tint = document.createElement('canvas');
  tint.width = tint.height = SPRITE_PX;
  const tctx = tint.getContext('2d');
  if (!tctx) return null;
  const icon = SPRITE_PX * 0.56;
  tctx.drawImage(img, h - icon / 2, h - icon / 2, icon, icon);
  tctx.globalCompositeOperation = 'source-in';
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, SPRITE_PX, SPRITE_PX);
  // disc
  ctx.beginPath();
  ctx.arc(h, h, h - 4, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(5,7,13,0.94)';
  ctx.fill();
  ctx.lineWidth = 3.5;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.drawImage(tint, 0, 0);
  spriteCache.set(id, c);
  return c;
}

/** Hidden component: mounts the icons once and turns them into images. Render it once near the root. */
export function SpriteForge() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const serializer = new XMLSerializer();
    for (const key of ICON_KEYS) {
      if (iconImages.has(key)) continue;
      const svg = host.querySelector<SVGSVGElement>(`[data-icon="${key}"] svg`);
      if (!svg) continue;
      const clone = svg.cloneNode(true) as SVGSVGElement;
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      clone.setAttribute('width', '64');
      clone.setAttribute('height', '64');
      const img = new Image();
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serializer.serializeToString(clone))}`;
      iconImages.set(key, img);
    }
  }, []);
  return (
    <div ref={ref} style={{ display: 'none' }} aria-hidden>
      {ICON_KEYS.map((key) => {
        const Icon = ICONS[key];
        return (
          <span key={key} data-icon={key}>
            <Icon color="#ffffff" size={64} strokeWidth={2.5} />
          </span>
        );
      })}
    </div>
  );
}
