/* =============================================================================
 * Shared UI plumbing: GameAPI context, ONE requestAnimationFrame loop for every
 * imperative HUD widget, low-rate telemetry polling, UI sounds, small helpers.
 * ===========================================================================*/
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { RefObject } from 'react';
import type { ActionResult, GameAPI, GameUiEvent, Telemetry, UIState, UiSound } from '../core/types';

// -----------------------------------------------------------------------------
// API context
// -----------------------------------------------------------------------------

export const ApiContext = createContext<GameAPI | null>(null);

export function useApi(): GameAPI {
  const api = useContext(ApiContext);
  if (!api) throw new Error('GameUI: ApiContext manquant');
  return api;
}

/**
 * Low-frequency UIState slice. The selector must return a primitive or an object that
 * already lives inside the snapshot (never build a new object in the selector).
 */
export function useUI<T>(selector: (s: UIState) => T): T {
  const api = useApi();
  const subscribe = useCallback((l: () => void) => api.subscribe(l), [api]);
  return useSyncExternalStore(subscribe, () => selector(api.getState()));
}

/** Transient engine events (pop-ups, flashes). */
export function useGameEvent(handler: (e: GameUiEvent) => void): void {
  const api = useApi();
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => api.onEvent((e) => ref.current(e)), [api]);
}

// -----------------------------------------------------------------------------
// Shared frame loop
// -----------------------------------------------------------------------------

export type FrameCallback = (dt: number, time: number) => void;

const frameCallbacks = new Set<FrameCallback>();
let rafId = 0;
let lastNow = 0;

function frameLoop(now: number): void {
  const dt = Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;
  const t = now / 1000;
  for (const cb of frameCallbacks) cb(dt, t);
  rafId = frameCallbacks.size > 0 ? requestAnimationFrame(frameLoop) : 0;
}

export function addFrameCallback(cb: FrameCallback): () => void {
  frameCallbacks.add(cb);
  if (!rafId) {
    lastNow = performance.now();
    rafId = requestAnimationFrame(frameLoop);
  }
  return () => {
    frameCallbacks.delete(cb);
  };
}

/** Runs `cb(dt, time)` every animation frame while mounted (single shared rAF). */
export function useFrame(cb: FrameCallback, active = true): void {
  const ref = useRef(cb);
  useEffect(() => {
    ref.current = cb;
  });
  useEffect(() => {
    if (!active) return;
    return addFrameCallback((dt, t) => ref.current(dt, t));
  }, [active]);
}

/**
 * Polls a telemetry-derived value at `hz` (default 10 Hz) and re-renders only when it
 * changes (Object.is). Use for medium-rate values: position, lap, status flags...
 */
export function usePoll<T>(read: (t: Telemetry) => T, hz = 10): T {
  const api = useApi();
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });
  const [value, setValue] = useState<T>(() => read(api.telemetry));
  const acc = useRef(0);
  useFrame((dt) => {
    acc.current += dt;
    if (acc.current < 1 / hz) return;
    acc.current = 0;
    const next = readRef.current(api.telemetry);
    setValue((prev) => (Object.is(prev, next) ? prev : next));
  });
  return value;
}

// -----------------------------------------------------------------------------
// Sounds / actions
// -----------------------------------------------------------------------------

export interface Sfx {
  play(sound: UiSound): void;
  hover(): void;
  click(): void;
  back(): void;
  /** plays 'buy' or 'error' depending on the result and returns it */
  result(r: ActionResult): ActionResult;
}

export function useSfx(): Sfx {
  const api = useApi();
  return useMemo<Sfx>(() => {
    const play = (s: UiSound) => api.actions.playUiSound(s);
    return {
      play,
      hover: () => play('hover'),
      click: () => play('click'),
      back: () => play('back'),
      result: (r) => {
        play(r.ok ? 'buy' : 'error');
        return r;
      },
    };
  }, [api]);
}

/** Window keydown listener bound while `active`. */
export function useKey(handler: (e: KeyboardEvent) => void, active = true): void {
  const ref = useRef(handler);
  useEffect(() => {
    ref.current = handler;
  });
  useEffect(() => {
    if (!active) return;
    const h = (e: KeyboardEvent) => ref.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [active]);
}

/** Inline error message that auto-clears (ActionResult failures). `nonce` restarts the shake animation. */
export function useFlashError(ms = 2600): { error: string | null; nonce: number; flash: (msg: string | undefined) => void; clear: () => void } {
  const [state, setState] = useState<{ error: string | null; nonce: number }>({ error: null, nonce: 0 });
  const timer = useRef(0);
  const clear = useCallback(() => {
    window.clearTimeout(timer.current);
    setState((s) => (s.error === null ? s : { error: null, nonce: s.nonce }));
  }, []);
  const flash = useCallback(
    (msg: string | undefined) => {
      window.clearTimeout(timer.current);
      setState((s) => ({ error: msg ?? 'Action impossible', nonce: s.nonce + 1 }));
      timer.current = window.setTimeout(() => setState((s) => ({ error: null, nonce: s.nonce })), ms);
    },
    [ms],
  );
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { error: state.error, nonce: state.nonce, flash, clear };
}

/**
 * Keeps removed list items around for `exitMs` so they can play an exit animation.
 * Returns the items in display order with a `leaving` flag.
 */
export function usePresenceList<T>(items: readonly T[], getKey: (item: T) => string | number, exitMs = 300): { item: T; leaving: boolean }[] {
  const [gone, setGone] = useState<{ item: T; at: number }[]>([]);
  const prev = useRef<readonly T[]>(items);
  useEffect(() => {
    const keys = new Set(items.map(getKey));
    const removed = prev.current.filter((p) => !keys.has(getKey(p)));
    prev.current = items;
    if (removed.length === 0) return;
    const now = performance.now();
    setGone((g) => [...g.filter((x) => !keys.has(getKey(x.item))), ...removed.map((item) => ({ item, at: now }))]);
    const id = window.setTimeout(() => {
      const limit = performance.now() - exitMs + 10;
      setGone((g) => g.filter((x) => x.at > limit));
    }, exitMs);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);
  const live = new Set(items.map(getKey));
  return [
    ...gone.filter((g) => !live.has(getKey(g.item))).map((g) => ({ item: g.item, leaving: true })),
    ...items.map((item) => ({ item, leaving: false })),
  ];
}

// -----------------------------------------------------------------------------
// Imperative DOM helpers (cached writes — no layout work when nothing changed)
// -----------------------------------------------------------------------------

interface Cached {
  __t?: string;
}

export function setText(el: (HTMLElement & Cached) | null, text: string): void {
  if (!el || el.__t === text) return;
  el.__t = text;
  el.textContent = text;
}

/** Sets the CSS variable --p (0..1), quantised to avoid useless style writes. */
export function setP(el: (HTMLElement & { __p?: number }) | null, p: number, steps = 400): void {
  if (!el) return;
  const q = Math.round((p < 0 ? 0 : p > 1 ? 1 : p) * steps) / steps;
  if (el.__p === q) return;
  el.__p = q;
  el.style.setProperty('--p', String(q));
}

export function setClass(el: (HTMLElement & { __c?: Record<string, boolean> }) | null, name: string, on: boolean): void {
  if (!el) return;
  const cache = el.__c ?? (el.__c = {});
  if (cache[name] === on) return;
  cache[name] = on;
  el.classList.toggle(name, on);
}

/** Restarts a CSS animation class on an element. */
export function retrigger(el: HTMLElement | null, cls: string): void {
  if (!el) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

/** Sizes a canvas backing store to its CSS box × devicePixelRatio (capped). Returns true when it changed. */
export function fitCanvas(canvas: HTMLCanvasElement, maxDpr = 2, scale = 1): boolean {
  const dpr = Math.min(maxDpr, window.devicePixelRatio || 1) * scale;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

/** Calls `onResize` when the element box changes (and once on mount). */
export function useResize(ref: RefObject<HTMLElement | null>, onResize: () => void): void {
  const cb = useRef(onResize);
  useEffect(() => {
    cb.current = onResize;
  });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    cb.current();
    const ro = new ResizeObserver(() => cb.current());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
}

// -----------------------------------------------------------------------------
// Formatting
// -----------------------------------------------------------------------------

const NBSP = ' ';

/** 12 450 (French grouping with a narrow no-break space). */
export function fmtInt(v: number): string {
  const n = Math.round(v);
  const s = Math.abs(n).toString();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += NBSP;
    out += s[i];
  }
  return n < 0 ? `-${out}` : out;
}

export function fmtMoney(v: number): string {
  return `${fmtInt(v)}${NBSP}$`;
}

/** 1:23.456 */
export function fmtTime(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '-:--.---';
  const total = Math.floor(ms);
  const m = Math.floor(total / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const mil = total % 1000;
  return `${m}:${s < 10 ? '0' : ''}${s}.${mil < 10 ? '00' : mil < 100 ? '0' : ''}${mil}`;
}

/** 1:23.4 (race clock — tenths only: readable at speed) */
export function fmtClock(ms: number): string {
  if (!isFinite(ms) || ms < 0) return '-:--.-';
  const total = Math.floor(ms / 100);
  const m = Math.floor(total / 600);
  const s = Math.floor((total % 600) / 10);
  return `${m}:${s < 10 ? '0' : ''}${s}.${total % 10}`;
}

/** +1.234 / -0.512 */
export function fmtDelta(ms: number): string {
  const a = Math.abs(ms) / 1000;
  return `${ms < 0 ? '-' : '+'}${a.toFixed(a >= 10 ? 2 : 3)}`;
}

export function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h} h ${m < 10 ? '0' : ''}${m}`;
  return `${m} min ${r < 10 ? '0' : ''}${r} s`;
}

export const KMH_TO_MPH = 0.621371;

export function ordinalFr(n: number): string {
  return n === 1 ? 'er' : 'e';
}
