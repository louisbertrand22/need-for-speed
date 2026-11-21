/* Keyboard (+ optional gamepad) input. Uses physical key codes so ZQSD (AZERTY)
 * and WASD (QWERTY) both work without configuration. */
import type { DriveInput } from '../core/types';

export type InputAction =
  | 'interact'
  | 'map'
  | 'pause'
  | 'camera'
  | 'mirror'
  | 'reset'
  | 'gearbox'
  | 'shiftUp'
  | 'shiftDown';

const DRIVE_KEYS = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
  'ShiftLeft',
  'ShiftRight',
  'KeyN',
  'KeyC',
  'KeyE',
  'KeyQ',
  'KeyV',
  'KeyM',
  'KeyT',
  'KeyR',
  'KeyG',
  'KeyP',
  'PageUp',
  'PageDown',
  'Tab',
]);

export class InputManager {
  private down = new Set<string>();
  private actions: InputAction[] = [];
  private enabled = true;
  private padPrev: boolean[] = [];

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.down.clear();
  }

  private isTyping(e: KeyboardEvent): boolean {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (DRIVE_KEYS.has(e.code)) e.preventDefault();
    if (e.code === 'Escape') {
      if (!e.repeat) this.actions.push('pause');
      return;
    }
    if (!this.enabled) return;
    if (e.repeat) return;
    this.down.add(e.code);
    switch (e.code) {
      case 'KeyE':
        this.actions.push('interact');
        this.actions.push('shiftUp');
        break;
      case 'PageUp':
        this.actions.push('shiftUp');
        break;
      case 'KeyQ':
      case 'PageDown':
        this.actions.push('shiftDown');
        break;
      case 'KeyM':
        this.actions.push('map');
        break;
      case 'KeyP':
        this.actions.push('pause');
        break;
      case 'KeyV':
        this.actions.push('camera');
        break;
      case 'KeyT':
        this.actions.push('mirror');
        break;
      case 'KeyR':
        this.actions.push('reset');
        break;
      case 'KeyG':
        this.actions.push('gearbox');
        break;
      default:
        break;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private onBlur = (): void => {
    this.down.clear();
  };

  /** Returns and clears the actions pressed since the last call. */
  consumeActions(): InputAction[] {
    this.pollGamepadButtons();
    if (this.actions.length === 0) return EMPTY;
    const out = this.actions;
    this.actions = [];
    return out;
  }

  get lookBack(): boolean {
    return this.down.has('KeyC') || this.padButton(11);
  }

  private pad(): Gamepad | null {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) if (p && p.connected && p.mapping === 'standard') return p;
    return null;
  }

  private padButton(index: number): boolean {
    const p = this.pad();
    return !!p && !!p.buttons[index] && p.buttons[index].pressed;
  }

  private pollGamepadButtons(): void {
    const p = this.pad();
    if (!p) return;
    const map: [number, InputAction][] = [
      [3, 'interact'], // Y / triangle
      [8, 'map'], // back / share
      [9, 'pause'], // start
      [12, 'camera'], // d-pad up
      [13, 'mirror'], // d-pad down
      [14, 'reset'], // d-pad left
      [5, 'shiftUp'], // RB
      [4, 'shiftDown'], // LB
    ];
    for (const [index, action] of map) {
      const pressed = !!p.buttons[index]?.pressed;
      if (pressed && !this.padPrev[index]) this.actions.push(action);
      this.padPrev[index] = pressed;
    }
  }

  /** Fill the continuous part of the drive input (shift edges are handled by the engine). */
  readDrive(out: DriveInput): void {
    const d = this.down;
    let throttle = d.has('KeyW') || d.has('ArrowUp') ? 1 : 0;
    let brake = d.has('KeyS') || d.has('ArrowDown') ? 1 : 0;
    let steer = 0;
    if (d.has('KeyA') || d.has('ArrowLeft')) steer -= 1;
    if (d.has('KeyD') || d.has('ArrowRight')) steer += 1;
    let handbrake = d.has('Space');
    let nitro = d.has('ShiftLeft') || d.has('ShiftRight') || d.has('KeyN');

    const p = this.pad();
    if (p) {
      const ax = p.axes[0] ?? 0;
      const dead = 0.12;
      if (Math.abs(ax) > dead) steer += (ax - Math.sign(ax) * dead) / (1 - dead);
      throttle = Math.max(throttle, p.buttons[7]?.value ?? 0);
      brake = Math.max(brake, p.buttons[6]?.value ?? 0);
      handbrake = handbrake || !!p.buttons[0]?.pressed; // A / cross
      nitro = nitro || !!p.buttons[2]?.pressed; // X / square
    }

    out.throttle = throttle;
    out.brake = brake;
    out.steer = steer < -1 ? -1 : steer > 1 ? 1 : steer;
    out.handbrake = handbrake;
    out.nitro = nitro;
  }
}

const EMPTY: InputAction[] = [];

export function makeDriveInput(): DriveInput {
  return { throttle: 0, brake: 0, steer: 0, handbrake: false, nitro: false, shiftUp: false, shiftDown: false };
}
