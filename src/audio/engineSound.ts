/* =============================================================================
 * APEX NOCTURNE — procedural audio (Web Audio API, no audio files)
 * -----------------------------------------------------------------------------
 * Engine synthesiser driven by RPM / throttle (firing-order harmonics per
 * cylinder count, intake noise, rev-limiter stutter), turbo whistle and blow-off
 * valve, nitro, tyre squeal, wind, tunnel reverb, police sirens, helicopter,
 * impacts, UI sounds and a small generative synthwave sequencer.
 *
 * The AudioContext is created lazily by resume() (user gesture). Every method
 * is a safe no-op before that or when Web Audio is unavailable.
 * ===========================================================================*/
import { clamp, clamp01, lerp } from '../core/math';
import type { Aspiration, AudioFrame, IGameAudio, MusicMood, ShiftQuality, SirenSource, UiSound } from '../core/types';

interface EngineProfile {
  cylinders: number;
  aspiration: Aspiration;
  redline: number;
  /** gains of the half-order, fundamental, 2nd and 3rd firing harmonics */
  sub: number;
  fund: number;
  second: number;
  third: number;
  /** low-pass brightness multiplier */
  bright: number;
}

function profileFor(cylinders: number, aspiration: Aspiration, redline: number): EngineProfile {
  if (cylinders >= 12) return { cylinders, aspiration, redline, sub: 0.08, fund: 0.5, second: 0.55, third: 0.4, bright: 1.5 };
  if (cylinders >= 8) return { cylinders, aspiration, redline, sub: 0.75, fund: 0.7, second: 0.3, third: 0.12, bright: 0.85 };
  if (cylinders >= 6) return { cylinders, aspiration, redline, sub: 0.25, fund: 0.7, second: 0.4, third: 0.22, bright: 1.1 };
  return { cylinders, aspiration, redline, sub: 0.35, fund: 0.85, second: 0.5, third: 0.3, bright: 1.0 };
}

interface SirenVoice {
  osc: OscillatorNode;
  lfo: OscillatorNode;
  lfoGain: GainNode;
  gain: GainNode;
  pan: StereoPannerNode;
}

interface MoodPattern {
  bpm: number;
  /** root notes (MIDI) of the 4-bar progression */
  roots: number[];
  /** chord intervals */
  chord: number[];
  kick: string;
  snare: string;
  hat: string;
  /** bass rhythm, 16 steps: 1 = note */
  bass: string;
  /** arpeggio pattern over chord tones (index or -1), 16 steps */
  arp: number[];
  pad: number;
  drive: number;
}

const X = (s: string) => s.replace(/\s/g, '');

const MOODS: Record<Exclude<MusicMood, 'none'>, MoodPattern> = {
  menu: {
    bpm: 84,
    roots: [41, 45, 38, 43],
    chord: [0, 7, 12, 16],
    kick: X('1000 0000 0000 0000'),
    snare: X('0000 0000 0000 0000'),
    hat: X('0000 0010 0000 0010'),
    bass: X('1000 0000 0010 0000'),
    arp: [0, -1, 2, -1, 3, -1, 2, -1, 1, -1, 2, -1, 3, -1, -1, -1],
    pad: 0.9,
    drive: 0.3,
  },
  garage: {
    bpm: 96,
    roots: [38, 43, 36, 45],
    chord: [0, 3, 7, 10],
    kick: X('1000 0000 1000 0000'),
    snare: X('0000 1000 0000 1000'),
    hat: X('0010 0010 0010 0010'),
    bass: X('1000 0010 0000 1000'),
    arp: [0, -1, 1, -1, 2, -1, 3, -1, 2, -1, 1, -1, 2, -1, 3, -1],
    pad: 0.7,
    drive: 0.45,
  },
  cruise: {
    bpm: 112,
    roots: [45, 41, 36, 43],
    chord: [0, 3, 7, 12],
    kick: X('1000 0000 1000 0000'),
    snare: X('0000 1000 0000 1000'),
    hat: X('0010 1010 0010 1011'),
    bass: X('1010 0010 1010 0110'),
    arp: [0, 2, 3, 2, 1, 2, 3, 2, 0, 2, 3, 2, 1, 3, 2, 1],
    pad: 0.5,
    drive: 0.6,
  },
  race: {
    bpm: 134,
    roots: [45, 45, 41, 43],
    chord: [0, 3, 7, 12],
    kick: X('1000 1000 1000 1000'),
    snare: X('0000 1000 0000 1001'),
    hat: X('0010 0010 0010 0111'),
    bass: X('1011 1011 1011 1011'),
    arp: [0, 3, 2, 3, 1, 3, 2, 3, 0, 3, 2, 3, 1, 3, 2, 1],
    pad: 0.3,
    drive: 0.9,
  },
  pursuit: {
    bpm: 148,
    roots: [40, 40, 43, 39],
    chord: [0, 3, 6, 12],
    kick: X('1000 1010 1000 1010'),
    snare: X('0000 1000 0100 1000'),
    hat: X('1111 1111 1111 1111'),
    bass: X('1110 1110 1110 1011'),
    arp: [0, 1, 2, 1, 3, 1, 2, 1, 0, 1, 2, 1, 3, 2, 1, 2],
    pad: 0.25,
    drive: 1.0,
  },
};

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class GameAudio implements IGameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private engineBus!: GainNode;
  private fxBus!: GainNode;
  private musicBus!: GainNode;
  private moodGain!: GainNode;
  private reverbSend!: GainNode;
  private noiseBuffer!: AudioBuffer;
  /** Master-bus analyser, exposed for automated checks. */
  debugAnalyser: AnalyserNode | null = null;

  private masterVolume = 0.8;
  private musicVolume = 0.5;
  private paused = false;
  private engineActive = false;
  private profile: EngineProfile = profileFor(4, 'turbo', 7600);

  // engine voice
  private oscSub!: OscillatorNode;
  private oscFund!: OscillatorNode;
  private oscSecond!: OscillatorNode;
  private oscThird!: OscillatorNode;
  private gSub!: GainNode;
  private gFund!: GainNode;
  private gSecond!: GainNode;
  private gThird!: GainNode;
  private engineFilter!: BiquadFilterNode;
  private engineGain!: GainNode;
  private stutterDepth!: GainNode;
  private intakeFilter!: BiquadFilterNode;
  private intakeGain!: GainNode;
  // continuous layers
  private turboOsc!: OscillatorNode;
  private turboGain!: GainNode;
  private nitroGain!: GainNode;
  private squealFilter!: BiquadFilterNode;
  private squealGain!: GainNode;
  private gravelGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private heliGain!: GainNode;
  private heliWhine!: GainNode;
  private sirens: SirenVoice[] = [];
  private jitter = 0;

  // music
  private mood: MusicMood = 'none';
  private pendingMood: MusicMood | null = null;
  private moodSwitchAt = 0;
  private nextStepTime = 0;
  private step = 0;
  private timer: number | null = null;

  // ---------------------------------------------------------------- lifecycle

  async resume(): Promise<void> {
    try {
      if (!this.ctx) {
        const Ctor: typeof AudioContext | undefined =
          window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return;
        this.ctx = new Ctor({ latencyHint: 'interactive' });
        this.build(this.ctx);
      }
      if (this.ctx.state === 'suspended' && !this.paused) await this.ctx.resume();
    } catch (err) {
      console.warn('[audio] unavailable', err);
      this.ctx = null;
    }
  }

  private build(ctx: AudioContext): void {
    // --- output chain
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -9;
    limiter.knee.value = 8;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.2;
    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;
    this.debugAnalyser = ctx.createAnalyser();
    this.debugAnalyser.fftSize = 2048;
    limiter.connect(this.master).connect(this.debugAnalyser).connect(ctx.destination);

    this.engineBus = ctx.createGain();
    this.engineBus.gain.value = 0;
    this.fxBus = ctx.createGain();
    this.fxBus.gain.value = 0.9;
    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.musicVolume * 0.5;
    this.moodGain = ctx.createGain();
    this.moodGain.gain.value = 0;
    this.moodGain.connect(this.musicBus).connect(limiter);
    this.engineBus.connect(limiter);
    this.fxBus.connect(limiter);

    // --- shared noise
    const len = ctx.sampleRate * 2;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // --- tunnel reverb (generated impulse response)
    const irLen = Math.floor(ctx.sampleRate * 1.7);
    const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < irLen; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / irLen, 2.6);
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = ir;
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0;
    this.engineBus.connect(this.reverbSend).connect(convolver).connect(limiter);

    // --- engine: four harmonically related oscillators → waveshaper → low-pass
    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      const x = (i / 511.5 - 1) * 2.2;
      curve[i] = Math.tanh(x);
    }
    shaper.curve = curve;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.Q.value = 1.2;
    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0.2;
    const mk = (type: OscillatorType): [OscillatorNode, GainNode] => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = 40;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g).connect(shaper);
      o.start();
      return [o, g];
    };
    [this.oscSub, this.gSub] = mk('square');
    [this.oscFund, this.gFund] = mk('sawtooth');
    [this.oscSecond, this.gSecond] = mk('sawtooth');
    [this.oscThird, this.gThird] = mk('triangle');
    // rev-limiter stutter: a square LFO chops the engine gain when `stutterDepth` > 0
    const stutter = ctx.createOscillator();
    stutter.type = 'square';
    stutter.frequency.value = 24;
    this.stutterDepth = ctx.createGain();
    this.stutterDepth.gain.value = 0;
    stutter.connect(this.stutterDepth).connect(this.engineGain.gain);
    stutter.start();
    shaper.connect(this.engineFilter).connect(this.engineGain).connect(this.engineBus);

    // intake / exhaust noise
    this.intakeFilter = ctx.createBiquadFilter();
    this.intakeFilter.type = 'bandpass';
    this.intakeFilter.Q.value = 0.8;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.loopNoise(0.0).connect(this.intakeFilter).connect(this.intakeGain).connect(this.engineBus);

    // turbo whistle
    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc.frequency.value = 2000;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turboOsc.connect(this.turboGain).connect(this.engineBus);
    this.turboOsc.start();

    // nitro hiss + roar
    const nitroHp = ctx.createBiquadFilter();
    nitroHp.type = 'highpass';
    nitroHp.frequency.value = 1800;
    this.nitroGain = ctx.createGain();
    this.nitroGain.gain.value = 0;
    this.loopNoise(0.3).connect(nitroHp).connect(this.nitroGain).connect(this.engineBus);

    // tyres
    this.squealFilter = ctx.createBiquadFilter();
    this.squealFilter.type = 'bandpass';
    this.squealFilter.frequency.value = 1150;
    this.squealFilter.Q.value = 7;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.loopNoise(0.6).connect(this.squealFilter).connect(this.squealGain).connect(this.engineBus);
    const gravelLp = ctx.createBiquadFilter();
    gravelLp.type = 'lowpass';
    gravelLp.frequency.value = 420;
    this.gravelGain = ctx.createGain();
    this.gravelGain.gain.value = 0;
    this.loopNoise(0.9).connect(gravelLp).connect(this.gravelGain).connect(this.engineBus);

    // wind / road
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 300;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.loopNoise(1.2).connect(this.windFilter).connect(this.windGain).connect(this.engineBus);

    // helicopter: chopped low noise + turbine whine
    const heliLp = ctx.createBiquadFilter();
    heliLp.type = 'lowpass';
    heliLp.frequency.value = 190;
    const chop = ctx.createGain();
    chop.gain.value = 0.5;
    const blade = ctx.createOscillator();
    blade.type = 'sawtooth';
    blade.frequency.value = 19;
    const bladeDepth = ctx.createGain();
    bladeDepth.gain.value = 0.5;
    blade.connect(bladeDepth).connect(chop.gain);
    blade.start();
    this.heliGain = ctx.createGain();
    this.heliGain.gain.value = 0;
    this.loopNoise(1.5).connect(heliLp).connect(chop).connect(this.heliGain).connect(this.fxBus);
    const whine = ctx.createOscillator();
    whine.type = 'sawtooth';
    whine.frequency.value = 610;
    const whineLp = ctx.createBiquadFilter();
    whineLp.type = 'lowpass';
    whineLp.frequency.value = 1400;
    this.heliWhine = ctx.createGain();
    this.heliWhine.gain.value = 0;
    whine.connect(whineLp).connect(this.heliWhine).connect(this.fxBus);
    whine.start();

    // sirens: three voices, alternating wail / yelp
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = 980 + i * 40;
      const lfo = ctx.createOscillator();
      lfo.type = i === 1 ? 'sawtooth' : 'sine';
      lfo.frequency.value = i === 1 ? 3.6 : 0.42 + i * 0.05;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 330;
      lfo.connect(lfoGain).connect(osc.frequency);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2400;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      const pan = ctx.createStereoPanner();
      osc.connect(lp).connect(gain).connect(pan).connect(this.fxBus);
      osc.start();
      lfo.start();
      this.sirens.push({ osc, lfo, lfoGain, gain, pan });
    }

    this.applyProfile();
    this.nextStepTime = ctx.currentTime + 0.1;
    this.timer = window.setInterval(this.schedule, 30);
  }

  private loopNoise(offset: number): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.start(0, offset);
    return src;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(paused ? 0 : this.masterVolume, t, 0.05);
    if (!paused && ctx.state === 'suspended') void ctx.resume();
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp01(v);
    if (this.ctx && !this.paused) this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.05);
  }

  setMusicVolume(v: number): void {
    this.musicVolume = clamp01(v);
    if (this.ctx) this.musicBus.gain.setTargetAtTime(this.musicVolume * 0.5, this.ctx.currentTime, 0.1);
  }

  setEngineProfile(cylinders: number, aspiration: Aspiration, redlineRpm: number): void {
    this.profile = profileFor(cylinders, aspiration, redlineRpm);
    this.applyProfile();
  }

  private applyProfile(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const p = this.profile;
    const t = ctx.currentTime;
    this.gSub.gain.setTargetAtTime(p.sub, t, 0.05);
    this.gFund.gain.setTargetAtTime(p.fund, t, 0.05);
    this.gSecond.gain.setTargetAtTime(p.second, t, 0.05);
    this.gThird.gain.setTargetAtTime(p.third, t, 0.05);
  }

  setEngineActive(active: boolean): void {
    this.engineActive = active;
    if (this.ctx) this.engineBus.gain.setTargetAtTime(active ? 1 : 0, this.ctx.currentTime, 0.12);
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number, f: AudioFrame): void {
    const ctx = this.ctx;
    if (!ctx || this.paused) return;
    const t = ctx.currentTime;
    const p = this.profile;
    const k = 0.035; // smoothing time constant

    // --- engine pitch: firing frequency with a little organic jitter
    this.jitter = lerp(this.jitter, (Math.random() - 0.5) * 2, clamp01(dt * 18));
    const rpm = clamp(f.rpm, 500, p.redline * 1.15);
    const firing = (rpm / 60) * (p.cylinders / 2) * (1 + this.jitter * 0.006);
    // keep the fundamental in a pleasant register for high cylinder counts
    const base = p.cylinders >= 8 ? firing / 2 : firing;
    this.oscSub.frequency.setTargetAtTime(base / 2, t, k);
    this.oscFund.frequency.setTargetAtTime(base, t, k);
    this.oscSecond.frequency.setTargetAtTime(base * 2.003, t, k);
    this.oscThird.frequency.setTargetAtTime(base * 3, t, k);

    const rev = clamp01((rpm - 700) / (p.redline - 700));
    const load = f.engineBlown ? 0.15 : 0.35 + f.throttle * 0.65;
    this.engineFilter.frequency.setTargetAtTime((320 + rev * 2600 + f.throttle * 2200) * p.bright, t, k);
    const blownGate = f.engineBlown ? (Math.sin(t * 31) > 0.3 ? 0.6 : 0.05) : 1;
    this.engineGain.gain.setTargetAtTime((0.1 + rev * 0.12) * load * blownGate, t, k);
    const onLimiter = !f.engineBlown && f.rpm > p.redline * 1.005 && f.throttle > 0.5;
    this.stutterDepth.gain.setTargetAtTime(onLimiter ? 0.09 : 0, t, 0.01);
    this.intakeFilter.frequency.setTargetAtTime(500 + rev * 2400, t, k);
    this.intakeGain.gain.setTargetAtTime(f.throttle * (0.02 + rev * 0.07), t, k);

    // --- turbo
    this.turboOsc.frequency.setTargetAtTime(1800 + f.turbo * 5200, t, 0.06);
    this.turboGain.gain.setTargetAtTime(f.turbo * f.turbo * 0.02, t, 0.06);

    // --- nitro
    this.nitroGain.gain.setTargetAtTime(f.nitroActive ? 0.11 : 0, t, 0.05);

    // --- tyres, wind
    const hard = f.surface === 'asphalt' || f.surface === 'concrete';
    const slip = f.grounded ? f.wheelSlip : 0;
    this.squealFilter.frequency.setTargetAtTime(900 + slip * 500 + Math.min(f.speed, 60) * 6, t, 0.05);
    this.squealGain.gain.setTargetAtTime(hard ? Math.pow(clamp01((slip - 0.15) / 0.85), 1.4) * 0.3 : 0, t, 0.05);
    const loose = f.grounded && !hard ? clamp01(f.speed / 30) : 0;
    this.gravelGain.gain.setTargetAtTime(loose * 0.3 + (hard ? 0 : slip * 0.15), t, 0.06);
    const sp = clamp01(f.speed / 95);
    this.windFilter.frequency.setTargetAtTime(260 + sp * 1900, t, 0.1);
    this.windGain.gain.setTargetAtTime(sp * sp * 0.16 * (f.grounded ? 1 : 1.3), t, 0.1);

    // --- tunnel reverb
    this.reverbSend.gain.setTargetAtTime(f.inTunnel ? 0.55 : 0, t, 0.25);
  }

  setSirens(sources: SirenSource[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    for (let i = 0; i < this.sirens.length; i++) {
      const v = this.sirens[i];
      const s = sources[i];
      if (!s || this.paused) {
        v.gain.gain.setTargetAtTime(0, t, 0.15);
        continue;
      }
      const near = clamp01(1 - s.distance / 360);
      v.gain.gain.setTargetAtTime(near * near * 0.085, t, 0.12);
      v.pan.pan.setTargetAtTime(clamp(s.pan, -1, 1) * 0.85, t, 0.1);
      v.osc.detune.setTargetAtTime(clamp(s.approach, -60, 60) * 5, t, 0.2); // light doppler
    }
  }

  setHelicopter(level: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const l = clamp01(level);
    this.heliGain.gain.setTargetAtTime(l * 0.55, ctx.currentTime, 0.3);
    this.heliWhine.gain.setTargetAtTime(l * 0.012, ctx.currentTime, 0.3);
  }

  // ---------------------------------------------------------------- one-shot helpers

  private tone(
    freq0: number,
    freq1: number,
    duration: number,
    gain: number,
    type: OscillatorType = 'sine',
    delay = 0,
    dest: AudioNode = this.fxBus,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, freq0), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, freq1), t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + Math.min(0.012, duration * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + duration + 0.03);
  }

  private burst(
    duration: number,
    type: BiquadFilterType,
    f0: number,
    f1: number,
    gain: number,
    delay = 0,
    q = 0.9,
    dest: AudioNode = this.fxBus,
  ): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(Math.max(30, f0), t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t + duration);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + Math.min(0.01, duration * 0.15));
    g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.loop = true;
    src.connect(filter).connect(g).connect(dest);
    src.start(t, Math.random() * 1.5);
    src.stop(t + duration + 0.03);
  }

  // ---------------------------------------------------------------- one-shots

  playShift(quality: ShiftQuality): void {
    if (!this.ctx || this.paused) return;
    this.burst(0.07, 'lowpass', 900, 300, 0.22);
    this.tone(140, 60, 0.09, 0.22, 'triangle');
    if (quality === 'perfect') {
      this.tone(1500, 2300, 0.09, 0.07, 'sine', 0.01);
    } else if (quality === 'early' || quality === 'late') {
      this.burst(0.16, 'bandpass', 2600, 1400, 0.16, 0, 3);
    }
  }

  playBlowOff(): void {
    if (!this.ctx || this.paused) return;
    // "pssh" with a fluttering tail
    this.burst(0.34, 'bandpass', 4200, 1100, 0.2, 0, 1.6, this.engineBus);
    for (let i = 0; i < 4; i++) this.burst(0.05, 'bandpass', 1900 - i * 220, 1300 - i * 150, 0.12 - i * 0.02, 0.2 + i * 0.045, 3, this.engineBus);
  }

  playBackfire(): void {
    if (!this.ctx || this.paused) return;
    this.burst(0.06, 'lowpass', 2600, 500, 0.5, 0, 0.7, this.engineBus);
    this.tone(160, 55, 0.08, 0.3, 'square', 0, this.engineBus);
    this.burst(0.04, 'lowpass', 2200, 700, 0.3, 0.07 + Math.random() * 0.03, 0.7, this.engineBus);
    if (Math.random() < 0.6) this.burst(0.035, 'lowpass', 2000, 800, 0.2, 0.14 + Math.random() * 0.04, 0.7, this.engineBus);
  }

  playNitro(start: boolean): void {
    if (!this.ctx || this.paused) return;
    if (start) {
      this.burst(0.5, 'highpass', 900, 3200, 0.28);
      this.tone(70, 190, 0.45, 0.22, 'sawtooth');
    } else {
      this.burst(0.3, 'highpass', 3000, 1200, 0.12);
    }
  }

  playImpact(intensity: number, metal = true): void {
    if (!this.ctx || this.paused) return;
    const a = clamp(intensity / 18, 0.05, 1);
    this.burst(0.12 + a * 0.2, 'lowpass', 1400 + a * 1200, 180, 0.25 + a * 0.6);
    this.tone(120, 42, 0.14 + a * 0.12, 0.3 * a + 0.1, 'sine');
    if (metal) {
      const base = 420 + Math.random() * 260;
      this.tone(base, base * 0.97, 0.22, 0.05 + a * 0.08, 'triangle');
      this.tone(base * 1.59, base * 1.55, 0.16, 0.03 + a * 0.06, 'square', 0.005);
      this.tone(base * 2.37, base * 2.3, 0.12, 0.02 + a * 0.04, 'triangle', 0.01);
      if (a > 0.5) this.burst(0.35, 'highpass', 5000, 2500, 0.12 * a, 0.04, 1); // glass / debris
    }
  }

  playLanding(intensity: number): void {
    if (!this.ctx || this.paused) return;
    const a = clamp(intensity / 9, 0.15, 1);
    this.tone(95, 38, 0.22, 0.5 * a, 'sine');
    this.burst(0.16, 'lowpass', 700, 150, 0.4 * a);
  }

  playCollapse(): void {
    if (!this.ctx || this.paused) return;
    this.burst(2.4, 'lowpass', 420, 70, 0.8);
    this.tone(60, 28, 1.6, 0.5, 'sine');
    for (let i = 0; i < 7; i++) {
      const d = 0.15 + Math.random() * 1.7;
      this.burst(0.18 + Math.random() * 0.2, 'bandpass', 500 + Math.random() * 2500, 200, 0.3, d, 1.2);
      this.tone(300 + Math.random() * 500, 120, 0.2, 0.08, 'triangle', d);
    }
  }

  playUi(sound: UiSound): void {
    if (!this.ctx || this.paused) return;
    const n = (m: number) => midiHz(m);
    switch (sound) {
      case 'hover':
        this.tone(1900, 2100, 0.03, 0.025, 'sine');
        break;
      case 'click':
        this.tone(900, 1400, 0.06, 0.09, 'triangle');
        this.burst(0.02, 'highpass', 4000, 4000, 0.05);
        break;
      case 'back':
        this.tone(1100, 600, 0.08, 0.09, 'triangle');
        break;
      case 'buy':
        [76, 80, 83, 88].forEach((m, i) => this.tone(n(m), n(m), 0.14, 0.09, 'triangle', i * 0.055));
        this.burst(0.08, 'highpass', 6000, 6000, 0.06, 0.22);
        break;
      case 'error':
        this.tone(160, 150, 0.16, 0.16, 'sawtooth');
        this.tone(120, 110, 0.2, 0.14, 'square', 0.1);
        break;
      case 'countdown':
        this.tone(440, 440, 0.16, 0.2, 'square');
        break;
      case 'go':
        this.tone(880, 880, 0.5, 0.2, 'square');
        this.tone(1320, 1320, 0.45, 0.08, 'sine');
        break;
      case 'checkpoint':
        this.tone(n(81), n(81), 0.09, 0.1, 'triangle');
        this.tone(n(88), n(88), 0.16, 0.1, 'triangle', 0.08);
        break;
      case 'lap':
        [76, 83, 88].forEach((m, i) => this.tone(n(m), n(m), 0.14, 0.1, 'square', i * 0.07));
        break;
      case 'finish':
        [72, 76, 79, 84, 88].forEach((m, i) => this.tone(n(m), n(m), 0.22, 0.1, 'triangle', i * 0.08));
        break;
      case 'win':
        [72, 76, 79, 84].forEach((m, i) => this.tone(n(m), n(m), 0.3, 0.11, 'sawtooth', i * 0.12));
        [84, 88, 91].forEach((m) => this.tone(n(m), n(m), 0.9, 0.06, 'triangle', 0.5));
        break;
      case 'lose':
        [67, 63, 60, 55].forEach((m, i) => this.tone(n(m), n(m) * 0.98, 0.32, 0.1, 'sawtooth', i * 0.16));
        break;
      case 'nearMiss':
        this.burst(0.22, 'bandpass', 800, 3600, 0.16, 0, 2);
        this.tone(n(93), n(93), 0.08, 0.05, 'sine', 0.05);
        break;
      case 'perfectShift':
        this.tone(n(88), n(88), 0.07, 0.08, 'sine');
        this.tone(n(95), n(95), 0.14, 0.08, 'sine', 0.06);
        break;
      case 'badShift':
        this.tone(220, 180, 0.12, 0.1, 'sawtooth');
        break;
      case 'driftBank':
        [79, 84, 91].forEach((m, i) => this.tone(n(m), n(m), 0.1, 0.08, 'triangle', i * 0.045));
        break;
      case 'heatUp':
        for (let i = 0; i < 3; i++) this.tone(740, 990, 0.14, 0.14, 'sawtooth', i * 0.17);
        break;
      case 'spotted':
        this.tone(1200, 1200, 0.07, 0.12, 'square');
        this.tone(1200, 1200, 0.07, 0.12, 'square', 0.12);
        break;
      case 'busted':
        [64, 60, 57, 52, 45].forEach((m, i) => this.tone(n(m), n(m) * 0.97, 0.3, 0.13, 'square', i * 0.15));
        break;
      case 'evaded':
        [69, 72, 76, 81, 84].forEach((m, i) => this.tone(n(m), n(m), 0.2, 0.1, 'triangle', i * 0.09));
        break;
      case 'speedtrap':
        this.burst(0.05, 'highpass', 5000, 5000, 0.2);
        this.tone(1700, 2300, 0.12, 0.1, 'sine', 0.03);
        break;
      case 'unlock':
        [72, 79, 84, 91, 96].forEach((m, i) => this.tone(n(m), n(m), 0.25, 0.07, 'sine', i * 0.07));
        break;
      case 'radio':
        this.burst(0.18, 'bandpass', 1800, 1800, 0.14, 0, 4);
        this.tone(1000, 1000, 0.05, 0.07, 'square', 0.2);
        break;
      default:
        break;
    }
  }

  // ---------------------------------------------------------------- music

  setMusicMood(mood: MusicMood): void {
    if (mood === this.mood && this.pendingMood === null) return;
    if (mood === (this.pendingMood ?? this.mood)) return;
    this.pendingMood = mood;
    const ctx = this.ctx;
    if (!ctx) {
      this.mood = mood;
      this.pendingMood = null;
      return;
    }
    // fade out, switch pattern on the next scheduled step after the fade, fade back in
    this.moodGain.gain.cancelScheduledValues(ctx.currentTime);
    this.moodGain.gain.setTargetAtTime(0, ctx.currentTime, 0.25);
    this.moodSwitchAt = ctx.currentTime + 0.8;
  }

  private schedule = (): void => {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    if (this.pendingMood !== null && now >= this.moodSwitchAt) {
      this.mood = this.pendingMood;
      this.pendingMood = null;
      this.step = 0;
      this.nextStepTime = now + 0.05;
      this.moodGain.gain.cancelScheduledValues(now);
      this.moodGain.gain.setTargetAtTime(this.mood === 'none' ? 0 : 1, now, 0.4);
    } else if (this.pendingMood === null && this.mood !== 'none' && this.moodGain.gain.value < 0.01) {
      // first start (mood chosen before the context existed)
      this.moodGain.gain.setTargetAtTime(1, now, 0.4);
    }
    if (this.mood === 'none' || this.paused) {
      this.nextStepTime = Math.max(this.nextStepTime, now + 0.05);
      return;
    }
    const pattern = MOODS[this.mood];
    const stepDur = 60 / pattern.bpm / 4;
    if (this.nextStepTime < now - 0.25) this.nextStepTime = now + 0.02; // tab was throttled: resync
    while (this.nextStepTime < now + 0.14) {
      this.playStep(pattern, this.step, this.nextStepTime - now, stepDur);
      this.nextStepTime += stepDur;
      this.step = (this.step + 1) % 64;
    }
  };

  private playStep(p: MoodPattern, step: number, delay: number, stepDur: number): void {
    const bar = Math.floor(step / 16) % p.roots.length;
    const i = step % 16;
    const root = p.roots[bar];
    const out = this.moodGain;
    const d = Math.max(0, delay);

    if (p.kick[i] === '1') {
      this.tone(150, 42, 0.16, 0.9, 'sine', d, out);
      this.burst(0.02, 'lowpass', 2500, 800, 0.25, d, 0.7, out);
    }
    if (p.snare[i] === '1') {
      this.burst(0.14, 'bandpass', 1900, 1500, 0.4, d, 0.8, out);
      this.tone(210, 150, 0.08, 0.2, 'triangle', d, out);
    }
    if (p.hat[i] === '1') this.burst(0.035, 'highpass', 8000, 8000, 0.13, d, 0.7, out);
    if (p.bass[i] === '1') {
      const f = midiHz(root - 12 + (i % 8 === 6 ? 12 : 0));
      this.tone(f, f, stepDur * 1.7, 0.34, 'sawtooth', d, this.bassFilter(out));
    }
    const a = p.arp[i];
    if (a >= 0) {
      const f = midiHz(root + 24 + p.chord[a % p.chord.length]);
      this.tone(f, f, stepDur * 1.4, 0.07 + p.drive * 0.04, 'square', d, out);
    }
    if (i === 0 && p.pad > 0) {
      const barDur = stepDur * 16;
      for (const iv of p.chord) {
        const f = midiHz(root + 12 + iv);
        this.pad(f, barDur, 0.05 * p.pad, d, out);
      }
    }
  }

  private bassFilterNode: BiquadFilterNode | null = null;

  private bassFilter(out: AudioNode): AudioNode {
    const ctx = this.ctx!;
    if (!this.bassFilterNode) {
      this.bassFilterNode = ctx.createBiquadFilter();
      this.bassFilterNode.type = 'lowpass';
      this.bassFilterNode.frequency.value = 520;
      this.bassFilterNode.Q.value = 4;
      this.bassFilterNode.connect(out);
    }
    return this.bassFilterNode;
  }

  private pad(freq: number, duration: number, gain: number, delay: number, dest: AudioNode): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + delay;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(gain, t + duration * 0.3);
    g.gain.linearRampToValueAtTime(0.0001, t + duration * 1.05);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    for (const detune of [-7, 7]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(lp);
      o.start(t);
      o.stop(t + duration * 1.1);
    }
    lp.connect(g).connect(dest);
  }

  /** true once the engine loops are audible (used by automated checks). */
  get isEngineActive(): boolean {
    return this.engineActive;
  }
}

export function createGameAudio(): IGameAudio {
  return new GameAudio();
}
