/* =============================================================================
 * Procedural textures shared by every vehicle / effect model (module-level
 * singletons, created on first use, never disposed: they are tiny).
 * ===========================================================================*/
import * as THREE from 'three';
import { mulberry32 } from '../../core/math';

export interface AtlasRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const ATLAS_SIZE = 1024;

/** Pixel rectangles [x, y, w, h] of the parts atlas. */
const ATLAS_LAYOUT = {
  white: [0, 0, 32, 32],
  headProjector: [64, 0, 256, 128],
  headLed: [328, 0, 256, 128],
  tailBars: [592, 0, 208, 128],
  tailDots: [808, 0, 208, 128],
  grilleHex: [0, 136, 512, 128],
  grilleSlats: [520, 136, 248, 128],
  louvres: [776, 136, 240, 128],
  plateA: [0, 272, 248, 64],
  plateB: [256, 272, 248, 64],
  plateC: [512, 272, 248, 64],
  platePolice: [768, 272, 248, 64],
  police: [0, 344, 512, 128],
  pspd: [520, 344, 256, 128],
  unit: [784, 344, 232, 128],
  taxi: [0, 480, 256, 96],
  busSign: [264, 480, 504, 96],
  checker: [776, 480, 240, 96],
  truckA: [0, 584, 512, 256],
  truckB: [520, 584, 496, 256],
  gauges: [0, 848, 256, 128],
  crest: [264, 848, 128, 128],
  banner: [400, 848, 512, 96],
  carbon: [920, 848, 96, 96],
} as const;

export type AtlasRegion = keyof typeof ATLAS_LAYOUT;

/** UV rectangle of an atlas region (v1 = top edge). `inset` in pixels avoids bleeding. */
export function atlasRect(name: AtlasRegion, inset = 1.5): AtlasRect {
  const [x, y, w, h] = ATLAS_LAYOUT[name];
  return {
    u0: (x + inset) / ATLAS_SIZE,
    u1: (x + w - inset) / ATLAS_SIZE,
    v1: 1 - (y + inset) / ATLAS_SIZE,
    v0: 1 - (y + h - inset) / ATLAS_SIZE,
  };
}

const FONT_DISPLAY = "'Orbitron', 'Rajdhani', 'Arial Black', 'Helvetica Neue', Arial, sans-serif";
const FONT_PLAIN = "'Rajdhani', 'Arial Narrow', Arial, sans-serif";

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  return { canvas, ctx };
}

function fitText(ctx: CanvasRenderingContext2D, text: string, weight: string, family: string, maxW: number, maxH: number): void {
  let size = maxH;
  ctx.font = `${weight} ${size}px ${family}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) size = Math.floor((size * maxW) / w);
  ctx.font = `${weight} ${size}px ${family}`;
}

function drawPlate(ctx: CanvasRenderingContext2D, r: readonly number[], text: string, bg: string, fg: string, band: string): void {
  const [x, y, w, h] = r;
  ctx.fillStyle = '#101114';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = bg;
  ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
  ctx.fillStyle = band;
  ctx.fillRect(x + 4, y + 4, 22, h - 8);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, text, '700', FONT_PLAIN, w - 48, h - 16);
  ctx.fillText(text, x + 26 + (w - 30) / 2, y + h / 2 + 2);
}

function drawAtlas(ctx: CanvasRenderingContext2D): void {
  const L = ATLAS_LAYOUT;
  ctx.clearRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);
  // opaque dark default so that stray UVs never hit transparent texels
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, ATLAS_SIZE, ATLAS_SIZE);

  ctx.fillStyle = '#fff';
  ctx.fillRect(L.white[0], L.white[1], L.white[2] + 8, L.white[3] + 8);

  // --- headlamp: twin projectors + DRL blade ------------------------------------------------
  {
    const [x, y, w, h] = L.headProjector;
    const g = ctx.createLinearGradient(x, y, x, y + h);
    g.addColorStop(0, '#1b1d22');
    g.addColorStop(1, '#08090b');
    ctx.fillStyle = g;
    ctx.fillRect(x, y, w, h);
    for (const cx of [x + w * 0.3, x + w * 0.68]) {
      const cy = y + h * 0.46;
      const rad = h * 0.3;
      const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
      rg.addColorStop(0, '#ffffff');
      rg.addColorStop(0.45, '#f4f8ff');
      rg.addColorStop(0.7, '#8a93a6');
      rg.addColorStop(0.86, '#30343c');
      rg.addColorStop(1, '#0c0d10');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#9aa2b2';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(cx, cy, rad * 1.12, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = '#eaf2ff';
    ctx.fillRect(x + 10, y + h - 20, w - 20, 9);
  }
  // --- headlamp: LED matrix strip -------------------------------------------------------------
  {
    const [x, y, w, h] = L.headLed;
    ctx.fillStyle = '#0a0b0d';
    ctx.fillRect(x, y, w, h);
    const n = 6;
    for (let i = 0; i < n; i++) {
      const bx = x + 12 + (i * (w - 24)) / n;
      const bw = (w - 24) / n - 8;
      const g = ctx.createLinearGradient(bx, y, bx, y + h);
      g.addColorStop(0, '#30343c');
      g.addColorStop(0.3, '#ffffff');
      g.addColorStop(0.7, '#ffffff');
      g.addColorStop(1, '#30343c');
      ctx.fillStyle = g;
      ctx.fillRect(bx, y + h * 0.2, bw, h * 0.6);
    }
    ctx.fillStyle = '#dfeaff';
    ctx.fillRect(x + 6, y + 6, w - 12, 7);
  }
  // --- tail lamp: horizontal light bars ---------------------------------------------------------
  {
    const [x, y, w, h] = L.tailBars;
    ctx.fillStyle = '#3a0a0a';
    ctx.fillRect(x, y, w, h);
    for (let i = 0; i < 4; i++) {
      const by = y + 10 + i * ((h - 20) / 4);
      const g = ctx.createLinearGradient(x, by, x, by + 20);
      g.addColorStop(0, '#701010');
      g.addColorStop(0.5, '#ffffff');
      g.addColorStop(1, '#701010');
      ctx.fillStyle = g;
      ctx.fillRect(x + 8, by, w - 16, 20);
    }
  }
  // --- tail lamp: LED dots ------------------------------------------------------------------------
  {
    const [x, y, w, h] = L.tailDots;
    ctx.fillStyle = '#4a0c0c';
    ctx.fillRect(x, y, w, h);
    for (let j = 0; j < 6; j++)
      for (let i = 0; i < 10; i++) {
        const cx = x + 14 + (i * (w - 28)) / 9;
        const cy = y + 14 + (j * (h - 28)) / 5;
        const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, 9);
        rg.addColorStop(0, '#ffffff');
        rg.addColorStop(0.5, '#ffd0d0');
        rg.addColorStop(1, 'rgba(120,20,20,0)');
        ctx.fillStyle = rg;
        ctx.fillRect(cx - 9, cy - 9, 18, 18);
      }
  }
  // --- grille: honeycomb ---------------------------------------------------------------------------
  {
    const [x, y, w, h] = L.grilleHex;
    ctx.fillStyle = '#060607';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#3a3d44';
    ctx.lineWidth = 2.2;
    const s = 11;
    const dx = s * Math.sqrt(3);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    for (let row = -1; row * s * 1.5 < h + s; row++) {
      for (let col = -1; col * dx < w + dx; col++) {
        const cx = x + col * dx + (row % 2 ? dx / 2 : 0);
        const cy = y + row * s * 1.5;
        ctx.beginPath();
        for (let k = 0; k < 6; k++) {
          const a = (Math.PI / 3) * k + Math.PI / 6;
          const px = cx + s * Math.cos(a);
          const py = cy + s * Math.sin(a);
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  // --- grille: horizontal slats ----------------------------------------------------------------------
  {
    const [x, y, w, h] = L.grilleSlats;
    ctx.fillStyle = '#050506';
    ctx.fillRect(x, y, w, h);
    for (let i = 0; i < 6; i++) {
      const by = y + 6 + i * ((h - 8) / 6);
      const g = ctx.createLinearGradient(x, by, x, by + 10);
      g.addColorStop(0, '#5a5e66');
      g.addColorStop(1, '#16171a');
      ctx.fillStyle = g;
      ctx.fillRect(x, by, w, 9);
    }
  }
  // --- engine louvres -------------------------------------------------------------------------------
  {
    const [x, y, w, h] = L.louvres;
    ctx.fillStyle = '#040405';
    ctx.fillRect(x, y, w, h);
    for (let i = 0; i < 7; i++) {
      const by = y + 4 + i * ((h - 6) / 7);
      const g = ctx.createLinearGradient(x, by, x, by + 14);
      g.addColorStop(0, '#000000');
      g.addColorStop(0.6, '#2c2e33');
      g.addColorStop(1, '#4a4d55');
      ctx.fillStyle = g;
      ctx.fillRect(x, by, w, 13);
    }
  }
  // --- number plates -----------------------------------------------------------------------------------
  drawPlate(ctx, L.plateA, 'APX·187·PS', '#f1f1ea', '#15161a', '#1d3fa8');
  drawPlate(ctx, L.plateB, 'NCT·042·PS', '#f1f1ea', '#15161a', '#1d3fa8');
  drawPlate(ctx, L.plateC, 'SLN·913·PS', '#f6d93b', '#15161a', '#15161a');
  drawPlate(ctx, L.platePolice, 'PSPD·0271', '#f1f1ea', '#0f2a80', '#0f2a80');

  // --- police livery texts (transparent background, alpha tested) ------------------------------------------
  const clearRegion = (r: readonly number[]): void => ctx.clearRect(r[0], r[1], r[2], r[3]);
  {
    const [x, y, w, h] = L.police;
    clearRegion(L.police);
    ctx.fillStyle = '#0c1433';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, 'POLICE', '900', FONT_DISPLAY, w - 24, h - 24);
    ctx.fillText('POLICE', x + w / 2, y + h / 2 + 4);
  }
  {
    const [x, y, w, h] = L.pspd;
    clearRegion(L.pspd);
    ctx.fillStyle = '#f2f4f8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, 'PSPD', '900', FONT_DISPLAY, w - 20, h - 36);
    ctx.fillText('PSPD', x + w / 2, y + h / 2 + 4);
  }
  {
    const [x, y, w, h] = L.unit;
    clearRegion(L.unit);
    ctx.fillStyle = '#f2f4f8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, '271', '900', FONT_DISPLAY, w - 20, h - 30);
    ctx.fillText('271', x + w / 2, y + h / 2 + 4);
  }
  // --- taxi roof sign (emissive) -----------------------------------------------------------------------------
  {
    const [x, y, w, h] = L.taxi;
    ctx.fillStyle = '#ffd83a';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, 'TAXI', '900', FONT_DISPLAY, w - 30, h - 24);
    ctx.fillText('TAXI', x + w / 2, y + h / 2 + 3);
  }
  // --- bus destination sign (emissive amber dot-matrix look) ------------------------------------------------------
  {
    const [x, y, w, h] = L.busSign;
    ctx.fillStyle = '#050505';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#ffb11e';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, '42  PORT-SÉLÈNE CENTRE', '700', FONT_PLAIN, w - 30, h - 30);
    ctx.fillText('42  PORT-SÉLÈNE CENTRE', x + w / 2, y + h / 2 + 3);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let i = 0; i < w; i += 4) ctx.fillRect(x + i, y, 1, h);
    for (let j = 0; j < h; j += 4) ctx.fillRect(x, y + j, w, 1);
  }
  // --- taxi checker band -----------------------------------------------------------------------------------------
  {
    const [x, y, w, h] = L.checker;
    const n = 10;
    const cw = w / n;
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < n; i++) {
        ctx.fillStyle = (i + j) % 2 ? '#111' : '#ffd83a';
        ctx.fillRect(x + i * cw, y + (j * h) / 4, cw + 0.5, h / 4 + 0.5);
      }
  }
  // --- truck box liveries --------------------------------------------------------------------------------------------
  {
    const [x, y, w, h] = L.truckA;
    ctx.fillStyle = '#d9dde3';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#12306e';
    ctx.fillRect(x, y + h * 0.68, w, h * 0.1);
    ctx.fillStyle = '#e0412b';
    ctx.fillRect(x, y + h * 0.8, w, h * 0.05);
    ctx.fillStyle = '#12306e';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    fitText(ctx, 'SÉLÈNE FRET', '900', FONT_DISPLAY, w - 60, h * 0.34);
    ctx.fillText('SÉLÈNE FRET', x + 30, y + h * 0.33);
    ctx.font = `600 22px ${FONT_PLAIN}`;
    ctx.fillText('TRANSPORT EXPRESS  ·  PORT-SÉLÈNE', x + 32, y + h * 0.55);
  }
  {
    const [x, y, w, h] = L.truckB;
    ctx.fillStyle = '#1c1f26';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#ff7a1a';
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x + w * 0.45, y + h);
    ctx.lineTo(x + w * 0.62, y + h * 0.62);
    ctx.lineTo(x, y + h * 0.62);
    ctx.fill();
    ctx.fillStyle = '#f2f2f2';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, 'NOVA CARGO', '900', FONT_DISPLAY, w - 60, h * 0.3);
    ctx.fillText('NOVA CARGO', x + w / 2, y + h * 0.32);
  }
  // --- dashboard gauges (emissive) ---------------------------------------------------------------------------------------
  {
    const [x, y, w, h] = L.gauges;
    ctx.fillStyle = '#030303';
    ctx.fillRect(x, y, w, h);
    for (const cx of [x + w * 0.28, x + w * 0.72]) {
      const cy = y + h * 0.52;
      ctx.strokeStyle = '#3fd2ff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(cx, cy, h * 0.36, Math.PI * 0.8, Math.PI * 2.2);
      ctx.stroke();
      ctx.strokeStyle = '#ff5a2a';
      ctx.beginPath();
      ctx.arc(cx, cy, h * 0.36, Math.PI * 1.9, Math.PI * 2.2);
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + h * 0.26, cy - h * 0.16);
      ctx.stroke();
    }
  }
  // --- police crest --------------------------------------------------------------------------------------------------------
  {
    const [x, y, w, h] = L.crest;
    clearRegion(L.crest);
    const cx = x + w / 2;
    const cy = y + h / 2;
    ctx.fillStyle = '#d7a928';
    ctx.beginPath();
    for (let k = 0; k < 14; k++) {
      const a = (Math.PI * 2 * k) / 14 - Math.PI / 2;
      const rr = k % 2 === 0 ? w * 0.47 : w * 0.3;
      const px = cx + rr * Math.cos(a);
      const py = cy + rr * Math.sin(a);
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#0c1a4d';
    ctx.beginPath();
    ctx.arc(cx, cy, w * 0.24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#f2f4f8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 22px ${FONT_DISPLAY}`;
    ctx.fillText('PS', cx, cy + 2);
  }
  // --- windscreen banner ------------------------------------------------------------------------------------------------------
  {
    const [x, y, w, h] = L.banner;
    clearRegion(L.banner);
    ctx.fillStyle = '#f4f6fa';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitText(ctx, 'APEX NOCTURNE', '900', FONT_DISPLAY, w - 20, h - 30);
    ctx.fillText('APEX NOCTURNE', x + w / 2, y + h / 2 + 3);
  }
  // --- carbon weave ------------------------------------------------------------------------------------------------------------
  {
    const [x, y, w, h] = L.carbon;
    ctx.fillStyle = '#0c0d0f';
    ctx.fillRect(x, y, w, h);
    const s = 8;
    for (let j = 0; j < h / s; j++)
      for (let i = 0; i < w / s; i++) {
        const even = (i + j) % 2 === 0;
        const g = even
          ? ctx.createLinearGradient(x + i * s, 0, x + i * s + s, 0)
          : ctx.createLinearGradient(0, y + j * s, 0, y + j * s + s);
        g.addColorStop(0, '#16181c');
        g.addColorStop(0.5, '#33363d');
        g.addColorStop(1, '#16181c');
        ctx.fillStyle = g;
        ctx.fillRect(x + i * s, y + j * s, s, s);
      }
  }
}

let atlasTexture: THREE.CanvasTexture | null = null;

/** Shared texture atlas of the "parts" material (lamps, grilles, plates, liveries). */
export function getPartsAtlas(): THREE.CanvasTexture {
  if (atlasTexture) return atlasTexture;
  const { canvas, ctx } = makeCanvas(ATLAS_SIZE, ATLAS_SIZE);
  drawAtlas(ctx);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.needsUpdate = true;
  atlasTexture = tex;
  // web fonts may finish loading after the first draw: refresh once when they are ready
  if (typeof document !== 'undefined' && document.fonts && document.fonts.status !== 'loaded') {
    void document.fonts.ready.then(() => {
      drawAtlas(ctx);
      tex.needsUpdate = true;
    });
  }
  return tex;
}

let flakeTexture: THREE.DataTexture | null = null;

/** Tiling random normal map: metallic flake sparkle. */
export function getFlakeNormalMap(): THREE.DataTexture {
  if (flakeTexture) return flakeTexture;
  const size = 256;
  const data = new Uint8Array(size * size * 4);
  const rng = mulberry32(90210);
  for (let i = 0; i < size * size; i++) {
    // sparse strong flakes over a fine grain
    const strong = rng() < 0.18 ? 1 : 0.32;
    const a = rng() * Math.PI * 2;
    const m = rng() * strong;
    const nx = Math.cos(a) * m;
    const ny = Math.sin(a) * m;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
    data[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
    data[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    data[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  flakeTexture = tex;
  return tex;
}

let glowTexture: THREE.CanvasTexture | null = null;

/** Soft round glow (white → transparent) for sprites and light pools. */
export function getGlowTexture(): THREE.CanvasTexture {
  if (glowTexture) return glowTexture;
  const { canvas, ctx } = makeCanvas(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.12, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.3, 'rgba(255,255,255,0.36)');
  g.addColorStop(0.6, 'rgba(255,255,255,0.09)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  glowTexture = tex;
  return tex;
}

let blobTexture: THREE.CanvasTexture | null = null;

/** Rounded-rectangle soft shadow (alpha only). */
export function getBlobShadowTexture(): THREE.CanvasTexture {
  if (blobTexture) return blobTexture;
  const size = 128;
  const { canvas, ctx } = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = Math.abs((x + 0.5) / size - 0.5) * 2;
      const v = Math.abs((y + 0.5) / size - 0.5) * 2;
      // superellipse distance: 0 centre → 1 edge
      const d = Math.pow(Math.pow(u, 3.2) + Math.pow(v, 3.2), 1 / 3.2);
      const t = Math.min(1, Math.max(0, (1 - d) / 0.42));
      const a = t * t * (3 - 2 * t);
      const i = (y * size + x) * 4;
      img.data[i] = 0;
      img.data[i + 1] = 0;
      img.data[i + 2] = 0;
      img.data[i + 3] = Math.round(a * 235);
    }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  blobTexture = tex;
  return tex;
}

let neonPoolTexture: THREE.CanvasTexture | null = null;

/** Under-glow light pool: bright rounded frame fading outward and (less) inward. */
export function getNeonPoolTexture(): THREE.CanvasTexture {
  if (neonPoolTexture) return neonPoolTexture;
  const size = 128;
  const { canvas, ctx } = makeCanvas(size, size);
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = Math.abs((x + 0.5) / size - 0.5) * 2;
      const v = Math.abs((y + 0.5) / size - 0.5) * 2;
      const d = Math.pow(Math.pow(u, 4) + Math.pow(v, 4), 0.25);
      // peak around d = 0.55 (the sills), smooth falloff to 1
      const inner = Math.min(1, d / 0.55);
      const outer = Math.min(1, Math.max(0, (1 - d) / 0.45));
      const a = (0.45 + 0.55 * inner * inner) * outer * outer * (3 - 2 * outer);
      const i = (y * size + x) * 4;
      img.data[i] = 255;
      img.data[i + 1] = 255;
      img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * 255);
    }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  neonPoolTexture = tex;
  return tex;
}

let crackTexture: THREE.CanvasTexture | null = null;

/** Tiling cracked-glass pattern (white lines on black). */
export function getCrackTexture(): THREE.CanvasTexture {
  if (crackTexture) return crackTexture;
  const size = 512;
  const { canvas, ctx } = makeCanvas(size, size);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const rng = mulberry32(4711);
  ctx.lineCap = 'round';
  const impacts: [number, number][] = [
    [150, 190],
    [390, 330],
    [300, 90],
  ];
  for (const [ix, iy] of impacts) {
    const rays = 11 + Math.floor(rng() * 6);
    const ends: [number, number][][] = [];
    for (let r = 0; r < rays; r++) {
      let a = (r / rays) * Math.PI * 2 + rng() * 0.4;
      let px = ix;
      let py = iy;
      const pts: [number, number][] = [[px, py]];
      const segs = 5 + Math.floor(rng() * 5);
      ctx.strokeStyle = `rgba(255,255,255,${0.55 + rng() * 0.45})`;
      ctx.lineWidth = 1.1 + rng() * 1.3;
      ctx.beginPath();
      ctx.moveTo(px, py);
      for (let s = 0; s < segs; s++) {
        a += (rng() - 0.5) * 0.5;
        const len = 14 + rng() * 34;
        px += Math.cos(a) * len;
        py += Math.sin(a) * len;
        ctx.lineTo(px, py);
        pts.push([px, py]);
      }
      ctx.stroke();
      ends.push(pts);
    }
    // concentric fragments
    ctx.lineWidth = 1;
    for (let ring = 1; ring < 4; ring++) {
      ctx.strokeStyle = `rgba(255,255,255,${0.5 - ring * 0.08})`;
      ctx.beginPath();
      for (let r = 0; r <= rays; r++) {
        const pts = ends[r % rays];
        const p = pts[Math.min(pts.length - 1, ring)];
        if (r === 0) ctx.moveTo(p[0], p[1]);
        else if (rng() < 0.8) ctx.lineTo(p[0], p[1]);
        else ctx.moveTo(p[0], p[1]);
      }
      ctx.stroke();
    }
    const g = ctx.createRadialGradient(ix, iy, 0, ix, iy, 26);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(ix - 26, iy - 26, 52, 52);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  crackTexture = tex;
  return tex;
}

/** Generic canvas → texture helper for one-off textures (signs, banners...). The caller owns the result. */
export function canvasTexture(
  width: number,
  height: number,
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  opts: { srgb?: boolean; repeat?: boolean } = {},
): THREE.CanvasTexture {
  const { canvas, ctx } = makeCanvas(width, height);
  draw(ctx, width, height);
  const tex = new THREE.CanvasTexture(canvas);
  if (opts.srgb !== false) tex.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

export const FONTS = { display: FONT_DISPLAY, plain: FONT_PLAIN } as const;
