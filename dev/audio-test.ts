/* Audio smoke test: exercises the whole IGameAudio surface and measures levels
 * on the master bus. Result is published on window.__audioResult. */
import { GameAudio } from '../src/audio/engineSound';
import type { AudioFrame, MusicMood, UiSound } from '../src/core/types';

interface AudioTestResult {
  ok: boolean;
  engineRmsLow: number;
  engineRmsHigh: number;
  centroidLow: number;
  centroidHigh: number;
  peak: number;
  pausedRms: number;
  error?: string;
}

const log = document.getElementById('log') as HTMLPreElement;
const say = (s: string) => {
  log.textContent += s + '\n';
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function measure(analyser: AnalyserNode): { rms: number; peak: number; centroid: number } {
  const time = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(time);
  let sum = 0;
  let peak = 0;
  for (const v of time) {
    sum += v * v;
    peak = Math.max(peak, Math.abs(v));
  }
  const freq = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(freq);
  let num = 0;
  let den = 0;
  for (let i = 0; i < freq.length; i++) {
    const mag = Math.pow(10, freq[i] / 20);
    num += mag * i;
    den += mag;
  }
  const hzPerBin = analyser.context.sampleRate / analyser.fftSize;
  return { rms: Math.sqrt(sum / time.length), peak, centroid: den > 0 ? (num / den) * hzPerBin : 0 };
}

async function run(): Promise<AudioTestResult> {
  const audio = new GameAudio();
  await audio.resume();
  const analyser = audio.debugAnalyser;
  if (!analyser) throw new Error('AudioContext unavailable');
  audio.setMasterVolume(0.8);
  audio.setMusicVolume(0);
  audio.setEngineProfile(8, 'na', 6400);
  audio.setEngineActive(true);
  const frame: AudioFrame = {
    rpm: 1200, redlineRpm: 6400, throttle: 0.2, speed: 5, turbo: 0, nitroActive: false,
    wheelSlip: 0, surface: 'asphalt', grounded: true, inTunnel: false, engineBlown: false,
  };
  let peak = 0;
  const hold = async (ms: number) => {
    const end = performance.now() + ms;
    let last = { rms: 0, peak: 0, centroid: 0 };
    while (performance.now() < end) {
      audio.update(1 / 60, frame);
      await wait(16);
      last = measure(analyser);
      peak = Math.max(peak, last.peak);
    }
    return last;
  };
  const low = await hold(700);
  say(`idle   rms=${low.rms.toFixed(4)} centroid=${low.centroid.toFixed(0)} Hz`);
  frame.rpm = 6000;
  frame.throttle = 1;
  frame.speed = 60;
  frame.turbo = 0.9;
  const high = await hold(700);
  say(`6000   rms=${high.rms.toFixed(4)} centroid=${high.centroid.toFixed(0)} Hz`);

  // everything else: must not throw
  frame.nitroActive = true;
  frame.wheelSlip = 0.9;
  frame.inTunnel = true;
  audio.playNitro(true);
  await hold(300);
  for (const q of ['perfect', 'good', 'early', 'late', 'auto'] as const) audio.playShift(q);
  audio.playBlowOff();
  audio.playBackfire();
  audio.playImpact(12, true);
  audio.playImpact(3, false);
  audio.playLanding(6);
  audio.playCollapse();
  audio.playNitro(false);
  const ui: UiSound[] = [
    'hover', 'click', 'back', 'buy', 'error', 'countdown', 'go', 'checkpoint', 'lap', 'finish', 'win', 'lose',
    'nearMiss', 'perfectShift', 'badShift', 'driftBank', 'heatUp', 'spotted', 'busted', 'evaded', 'speedtrap', 'unlock', 'radio',
  ];
  for (const s of ui) {
    audio.playUi(s);
    await hold(40);
  }
  audio.setSirens([{ distance: 40, pan: -0.5, approach: 10 }, { distance: 120, pan: 0.6, approach: -5 }]);
  audio.setHelicopter(0.8);
  audio.setMusicVolume(0.6);
  const moods: MusicMood[] = ['menu', 'garage', 'cruise', 'race', 'pursuit', 'none'];
  for (const m of moods) {
    audio.setMusicMood(m);
    await hold(1300);
  }
  frame.engineBlown = true;
  await hold(200);
  say(`peak=${peak.toFixed(3)}`);

  audio.setPaused(true);
  await wait(900);
  const paused = measure(analyser);
  say(`paused rms=${paused.rms.toFixed(5)}`);
  audio.setPaused(false);
  audio.dispose();
  const ok = low.rms > 0.002 && high.rms > low.rms && high.centroid > low.centroid * 1.2 && peak < 1 && paused.rms < 0.002;
  return { ok, engineRmsLow: low.rms, engineRmsHigh: high.rms, centroidLow: low.centroid, centroidHigh: high.centroid, peak, pausedRms: paused.rms };
}

async function start(): Promise<void> {
  log.textContent = '';
  const w = window as unknown as { __audioResult?: AudioTestResult };
  try {
    w.__audioResult = await run();
  } catch (err) {
    w.__audioResult = {
      ok: false, engineRmsLow: 0, engineRmsHigh: 0, centroidLow: 0, centroidHigh: 0, peak: 0, pausedRms: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  say(JSON.stringify(w.__audioResult, null, 2));
}

document.getElementById('run')!.addEventListener('click', () => void start());
if (new URLSearchParams(location.search).has('auto')) void start();
