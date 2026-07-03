/**
 * AudioManager — a lean, reusable Web-Audio runtime.
 *
 * DOM/AudioContext-OPTIONAL: importing this module must never throw without a DOM
 * (node / SSR). The AudioContext is created LAZILY on `resume()` (the first user
 * gesture, required by browser autoplay policy). In an environment with no
 * AudioContext (node / SSR / tests), every method is a safe no-op so call sites
 * never need to guard.
 *
 * Bus graph (mirrors the proven project-mmo engine, kept lean + standalone):
 *   tone/noise source → per-channel GainNode → master GainNode → destination.
 * Each channel's audible gain is the clamped product of its level and the master
 * level (see the pure `effectiveGain` helper, which is unit-tested without any
 * AudioContext).
 *
 * No new deps: pure Web Audio API. The only per-play allocation is the oscillator
 * / buffer-source node Web-Audio requires (one-shot by design — they're GC'd once
 * stopped, so we pool nothing).
 */

import type { AudioRecipe, AudioWave } from './recipe.js';

// Re-export the portable recipe contract + pure bake path + preset library so the
// whole audio surface (recipe type, renderer, playRecipe, presets) lands from one
// module. All of `recipe.ts` is DOM-free/pure, so this stays client-safe.
export type { AudioRecipe, AudioEvent, AudioWave, SfxPresetName } from './recipe.js';
export {
  renderRecipeSamples,
  encodeWav,
  renderRecipeToWav,
  SFX_PRESETS,
} from './recipe.js';

export type Channel = string;

export interface PlayRecipeOpts {
  /** Channel to route the whole recipe through. Defaults to 'sfx'. */
  channel?: Channel;
  /** Extra per-play linear gain layered on top of the recipe + channel (0..1). Defaults to 1. */
  gain?: number;
}

export interface PlayToneOpts {
  /** Oscillator waveform. Defaults to 'sine'. */
  type?: OscillatorType;
  /** Channel to route through. Defaults to 'sfx'. */
  channel?: Channel;
  /** Per-event linear gain layered on top of the channel volume (0..1). Defaults to 1. */
  gain?: number;
}

export interface PlayNoiseOpts {
  /** Channel to route through. Defaults to 'sfx'. */
  channel?: Channel;
  /** Per-event linear gain layered on top of the channel volume (0..1). Defaults to 1. */
  gain?: number;
}

export interface PlaySampleOpts {
  /** Channel to route through. Defaults to 'sfx'. */
  channel?: Channel;
  /** Per-play linear gain layered on top of the channel volume (0..1). Defaults to 1. */
  gain?: number;
  /**
   * Playback rate. 1 = original pitch/speed; <1 pitches DOWN + slows (heavier);
   * >1 pitches UP + speeds. Defaults to 1. (GYRE played a footstep at 0.72 for a
   * duller, weightier impact.)
   */
  rate?: number;
}

export interface AudioManager {
  /** Unlock/create the AudioContext (call on the first user gesture). Idempotent. */
  resume(): Promise<void>;
  /** Set a channel's volume, clamped to 0..1. Unknown channels are ignored. */
  setVolume(channel: Channel, level: number): void;
  /** Read a channel's volume (0..1). Returns 0 for unknown channels. */
  getVolume(channel: Channel): number;
  /** Play a short tone (oscillator) for `durationSec`. No-op until resumed. */
  playTone(freq: number, durationSec: number, opts?: PlayToneOpts): void;
  /** Play a burst of white noise for `durationSec`. No-op until resumed. */
  playNoise(durationSec: number, opts?: PlayNoiseOpts): void;
  /**
   * Synthesize an AudioRecipe LIVE via Web-Audio: one OscillatorNode per tone
   * event (its wave/freq) and a noise buffer-source per noise event, each through
   * a per-event GainNode doing the same attack/release envelope, scheduled at the
   * event's startSec and routed through the channel→master graph. This is the
   * runtime twin of `renderRecipeToWav` (the bake path) — same recipe, same math.
   * No-op until resumed (like the rest of the manager).
   */
  playRecipe(recipe: AudioRecipe, opts?: PlayRecipeOpts): void;
  /**
   * The live AudioContext, or null before `resume()` / in a no-AudioContext env.
   * Exposed so callers can decode/create buffers on the SAME context the manager
   * mixes through (GYRE had to stand up a SECOND AudioContext just to play one WAV
   * — {@link loadSample} / {@link playSample} remove that need).
   */
  getContext(): AudioContext | null;
  /**
   * Fetch + decode an audio file into an AudioBuffer, CACHED by URL (repeat calls
   * return the same buffer). Requires a context — call `resume()` first (on a user
   * gesture). Rejects if there's no AudioContext or the fetch/decode fails; the
   * caller decides how to degrade (e.g. fall back to a synth tick).
   */
  loadSample(url: string): Promise<AudioBuffer>;
  /**
   * Play a decoded AudioBuffer once through the channel→master graph, with an
   * optional per-play gain + playback rate. No-op until resumed / without a
   * context. Get a buffer from {@link loadSample}.
   */
  playSample(buffer: AudioBuffer, opts?: PlaySampleOpts): void;
  /** Close the AudioContext and release nodes. Safe to call repeatedly. */
  dispose(): void;
}

export interface AudioManagerOptions {
  /** Channel names (each a GainNode → master). Defaults to ['master','music','sfx']. */
  channels?: Channel[];
}

/** Channels every manager has, even if the caller passes a custom list. */
const DEFAULT_CHANNELS: Channel[] = ['master', 'music', 'sfx'];

/** Default channel a tone/noise routes through when none is given. */
const DEFAULT_CHANNEL: Channel = 'sfx';

/** Clamp a number into [0, 1]. NaN → 0; ±Infinity clamp to the nearest bound (1 / 0). */
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * PURE: the audible gain a channel produces — the clamped product of the master
 * level, the channel level, and an optional per-event gain (each clamped to 0..1,
 * so the result is always in 0..1). No AudioContext needed → unit-testable.
 */
export function effectiveGain(master: number, channel: number, gain?: number): number {
  const g = gain === undefined ? 1 : clamp01(gain);
  return clamp01(clamp01(master) * clamp01(channel) * g);
}

/** Resolve the AudioContext constructor, or null in a no-AudioContext env. */
function resolveAudioContextCtor(): typeof AudioContext | null {
  const g = globalThis as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/**
 * Create an AudioManager. Channels default to ['master','music','sfx']; the
 * 'master' channel is ALWAYS present (it backs the master GainNode) even if the
 * caller omits it. All channels start at volume 1.
 */
export function createAudioManager(opts: AudioManagerOptions = {}): AudioManager {
  // De-dupe the channel list and guarantee 'master' is present.
  const requested = opts.channels && opts.channels.length > 0 ? opts.channels : DEFAULT_CHANNELS;
  const channelNames = Array.from(new Set<Channel>(['master', ...requested]));

  // Volumes live independently of the AudioContext so getVolume/setVolume work
  // before resume() and in no-AudioContext envs. All channels start at 1.
  const volumes = new Map<Channel, number>();
  for (const name of channelNames) volumes.set(name, 1);

  let ctx: AudioContext | null = null;
  let masterGain: GainNode | null = null;
  /** Per-channel GainNodes (excluding 'master', which is `masterGain`). */
  const channelGains = new Map<Channel, GainNode>();
  /** Decoded sample buffers, cached by URL (+ the in-flight decode promise). */
  const sampleCache = new Map<string, Promise<AudioBuffer>>();
  let disposed = false;

  function masterLevel(): number {
    return volumes.get('master') ?? 1;
  }

  /** Build the bus graph once a context exists: channel gains → master → destination. */
  function buildGraph(c: AudioContext): void {
    masterGain = c.createGain();
    masterGain.gain.value = clamp01(masterLevel());
    masterGain.connect(c.destination);
    for (const name of channelNames) {
      if (name === 'master') continue;
      const g = c.createGain();
      g.gain.value = clamp01(volumes.get(name) ?? 1);
      g.connect(masterGain);
      channelGains.set(name, g);
    }
  }

  /** The GainNode a channel routes through (master falls back to the master gain). */
  function gainFor(channel: Channel): GainNode | null {
    if (channel === 'master') return masterGain;
    return channelGains.get(channel) ?? null;
  }

  return {
    async resume(): Promise<void> {
      if (disposed) return;
      if (!ctx) {
        const Ctor = resolveAudioContextCtor();
        if (!Ctor) return; // no-AudioContext env → safe no-op
        ctx = new Ctor();
        buildGraph(ctx);
      }
      if (ctx.state === 'suspended') {
        try {
          await ctx.resume();
        } catch {
          /* resume can reject if not from a gesture; caller retries on next gesture */
        }
      }
    },

    setVolume(channel: Channel, level: number): void {
      if (!volumes.has(channel)) return; // unknown channel → ignore
      const clamped = clamp01(level);
      volumes.set(channel, clamped);
      if (channel === 'master') {
        if (masterGain && ctx) masterGain.gain.setTargetAtTime(clamped, ctx.currentTime, 0.02);
      } else {
        const g = channelGains.get(channel);
        if (g && ctx) g.gain.setTargetAtTime(clamped, ctx.currentTime, 0.02);
      }
    },

    getVolume(channel: Channel): number {
      return volumes.get(channel) ?? 0;
    },

    playTone(freq: number, durationSec: number, toneOpts: PlayToneOpts = {}): void {
      if (disposed || !ctx || durationSec <= 0) return;
      const bus = gainFor(toneOpts.channel ?? DEFAULT_CHANNEL);
      if (!bus) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      osc.type = toneOpts.type ?? 'sine';
      osc.frequency.value = freq;
      const env = ctx.createGain();
      // Short attack/release envelope so tones don't click on start/stop.
      const peak = clamp01(toneOpts.gain ?? 1);
      env.gain.setValueAtTime(0, now);
      env.gain.linearRampToValueAtTime(peak, now + Math.min(0.01, durationSec / 2));
      env.gain.setValueAtTime(peak, now + Math.max(0, durationSec - 0.01));
      env.gain.linearRampToValueAtTime(0, now + durationSec);
      osc.connect(env).connect(bus);
      osc.start(now);
      osc.stop(now + durationSec);
      osc.onended = () => {
        try {
          osc.disconnect();
          env.disconnect();
        } catch {
          /* already gone */
        }
      };
    },

    playNoise(durationSec: number, noiseOpts: PlayNoiseOpts = {}): void {
      if (disposed || !ctx || durationSec <= 0) return;
      const bus = gainFor(noiseOpts.channel ?? DEFAULT_CHANNEL);
      if (!bus) return;
      const now = ctx.currentTime;
      const frames = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      const env = ctx.createGain();
      env.gain.value = clamp01(noiseOpts.gain ?? 1);
      src.connect(env).connect(bus);
      src.start(now);
      src.stop(now + durationSec);
      src.onended = () => {
        try {
          src.disconnect();
          env.disconnect();
        } catch {
          /* already gone */
        }
      };
    },

    playRecipe(recipe: AudioRecipe, recipeOpts: PlayRecipeOpts = {}): void {
      if (disposed || !ctx || recipe.events.length === 0) return;
      const bus = gainFor(recipeOpts.channel ?? DEFAULT_CHANNEL);
      if (!bus) return;
      const now = ctx.currentTime;
      // The recipe's own masterGain × an optional per-play gain, layered on each
      // event — mirrors renderRecipeSamples' master×event product exactly.
      const recipeMaster = recipe.masterGain === undefined ? 1 : clamp01(recipe.masterGain);
      const playGain = clamp01(recipeOpts.gain ?? 1);
      const mix = clamp01(recipeMaster * playGain);
      if (mix <= 0) return;

      for (const e of recipe.events) {
        if (e.durationSec <= 0) continue;
        const peak = clamp01(clamp01(e.gain) * mix);
        if (peak <= 0) continue;
        const startAt = now + Math.max(0, e.startSec);
        const dur = e.durationSec;
        // Same attack/release the pure renderer's envelope() applies.
        const ramp = Math.min(0.01, dur / 2);
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, startAt);
        env.gain.linearRampToValueAtTime(peak, startAt + ramp);
        env.gain.setValueAtTime(peak, startAt + Math.max(ramp, dur - ramp));
        env.gain.linearRampToValueAtTime(0, startAt + dur);
        env.connect(bus);

        if (e.type === 'noise') {
          const frames = Math.max(1, Math.floor(ctx.sampleRate * dur));
          const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
          const data = buffer.getChannelData(0);
          for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(env);
          src.start(startAt);
          src.stop(startAt + dur);
          src.onended = () => {
            try {
              src.disconnect();
              env.disconnect();
            } catch {
              /* already gone */
            }
          };
        } else {
          const osc = ctx.createOscillator();
          osc.type = (e.wave ?? 'sine') as AudioWave;
          osc.frequency.value = e.freq ?? 440;
          osc.connect(env);
          osc.start(startAt);
          osc.stop(startAt + dur);
          osc.onended = () => {
            try {
              osc.disconnect();
              env.disconnect();
            } catch {
              /* already gone */
            }
          };
        }
      }
    },

    getContext(): AudioContext | null {
      return disposed ? null : ctx;
    },

    loadSample(url: string): Promise<AudioBuffer> {
      if (disposed) return Promise.reject(new Error('AudioManager disposed'));
      const cached = sampleCache.get(url);
      if (cached) return cached;
      if (!ctx) {
        return Promise.reject(
          new Error('AudioManager.loadSample: no AudioContext — call resume() first (on a user gesture)'),
        );
      }
      const c = ctx;
      const promise = (async (): Promise<AudioBuffer> => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`loadSample fetch ${res.status} for ${url}`);
        const bytes = await res.arrayBuffer();
        // decodeAudioData is promise-based in modern browsers; the buffer is
        // reusable across many playSample calls.
        return c.decodeAudioData(bytes);
      })();
      // Cache the PROMISE so concurrent callers share one fetch/decode; evict on
      // failure so a transient error can be retried.
      promise.catch(() => {
        if (sampleCache.get(url) === promise) sampleCache.delete(url);
      });
      sampleCache.set(url, promise);
      return promise;
    },

    playSample(buffer: AudioBuffer, sampleOpts: PlaySampleOpts = {}): void {
      if (disposed || !ctx) return;
      const bus = gainFor(sampleOpts.channel ?? DEFAULT_CHANNEL);
      if (!bus) return;
      const now = ctx.currentTime;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      if (sampleOpts.rate !== undefined && sampleOpts.rate > 0) {
        src.playbackRate.value = sampleOpts.rate;
      }
      // Route through a per-play GainNode only when attenuating; at full gain go
      // straight to the channel bus (the channel/master gains still apply).
      const gain = clamp01(sampleOpts.gain ?? 1);
      let env: GainNode | null = null;
      if (gain < 1) {
        env = ctx.createGain();
        env.gain.value = gain;
        src.connect(env).connect(bus);
      } else {
        src.connect(bus);
      }
      src.onended = () => {
        try {
          src.disconnect();
          env?.disconnect();
        } catch {
          /* already gone */
        }
      };
      src.start(now);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      sampleCache.clear();
      channelGains.clear();
      masterGain = null;
      const c = ctx;
      ctx = null;
      if (c) {
        try {
          void c.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}
