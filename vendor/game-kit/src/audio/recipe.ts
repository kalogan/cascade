/**
 * AudioRecipe — a serializable, dependency-free description of a sound, plus the
 * PURE renderer that bakes it to a 16-bit PCM mono WAV.
 *
 * This is the game↔Crucible portability contract. The SAME recipe shape lives in
 * Crucible's `lib/pipeline/audio.ts`, so a game can:
 *   1. declare a recipe once,
 *   2. play it LIVE at runtime via `AudioManager.playRecipe` (Web-Audio), AND
 *   3. bake it to a WAV with `renderRecipeToWav` and POST it to Crucible's
 *      `/api/import` — one importer forever, no bespoke synth per game.
 *
 * NODE-SAFE / DOM-FREE: there is NO AudioContext here. We synthesize sample by
 * sample with the SAME math the runtime uses (naive oscillator waveforms + white
 * noise through a clamped gain product, with a short attack/release envelope so
 * events don't click) and write the RIFF/WAVE container by hand. Pure → testable.
 *
 * NOTE: this file mirrors Crucible's `lib/pipeline/audio.ts` renderer exactly.
 * Keep the two in lock-step (attack/release ramp, waveform math, WAV encoding) so
 * a recipe sounds the same whether it's played live or baked.
 */

// ── recipe shape (matches lib/pipeline/audio.ts exactly) ────────────────────────

/** Oscillator waveforms we can render (matches the Web-Audio OscillatorType subset). */
export type AudioWave = 'sine' | 'square' | 'sawtooth' | 'triangle';

/** One scheduled sound: a tone (oscillator) or a burst of white noise. */
export interface AudioEvent {
  type: 'tone' | 'noise';
  /** Tone frequency in Hz (ignored for noise). */
  freq?: number;
  /** When the event starts, in seconds from t=0. */
  startSec: number;
  /** How long the event lasts, in seconds. */
  durationSec: number;
  /** Per-event linear gain (0..1), layered on the master gain. */
  gain: number;
  /** Tone waveform. Defaults to 'sine'. Ignored for noise. */
  wave?: AudioWave;
}

/** A self-contained, serializable description of a sound. */
export interface AudioRecipe {
  /** Output sample rate in Hz (e.g. 44100). */
  sampleRate: number;
  /** Master linear gain (0..1) applied to the whole mix. Defaults to 1. */
  masterGain?: number;
  /** Scheduled events, mixed additively into one mono track. */
  events: AudioEvent[];
}

// ── pure synthesis (mirrors the AudioManager's per-event math) ──────────────────

/** Clamp into [0, 1]; NaN → 0 (same semantics as the runtime's clamp01). */
function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

const TWO_PI = Math.PI * 2;

/** One cycle of the named waveform at phase `t` (in turns). Band-limit-free
 *  (naive), matching a basic OscillatorType — fine for short UI/SFX cues. */
function oscillator(wave: AudioWave, t: number): number {
  const frac = t - Math.floor(t);
  switch (wave) {
    case 'square':
      return frac < 0.5 ? 1 : -1;
    case 'sawtooth':
      return 2 * frac - 1;
    case 'triangle':
      return 4 * Math.abs(frac - 0.5) - 1;
    case 'sine':
    default:
      return Math.sin(TWO_PI * frac);
  }
}

/**
 * The same short attack/release the AudioManager applies via linearRampToValueAtTime,
 * computed for a given offset into the event. Ramps 0→peak over `ramp` seconds at the
 * start and peak→0 over `ramp` seconds at the end (ramp is capped at half the duration
 * so very short events still get a symmetric fade). Returns a 0..1 envelope multiplier.
 */
function envelope(offsetSec: number, durationSec: number, peak: number): number {
  if (durationSec <= 0) return 0;
  const ramp = Math.min(0.01, durationSec / 2);
  if (ramp <= 0) return peak;
  if (offsetSec < ramp) return peak * (offsetSec / ramp);
  const release = durationSec - offsetSec;
  if (release < ramp) return peak * Math.max(0, release / ramp);
  return peak;
}

/**
 * PURE: render an AudioRecipe to mono Float32 samples in [-1, 1]. Events are summed
 * additively (then hard-clamped at write time). White-noise uses Math.random, exactly
 * like the runtime's noise buffer. Deterministic for tone-only recipes.
 */
export function renderRecipeSamples(recipe: AudioRecipe): Float32Array {
  const sampleRate = Math.max(1, Math.floor(recipe.sampleRate));
  const master = recipe.masterGain === undefined ? 1 : clamp01(recipe.masterGain);

  // Track length = the latest event end (rounded up to a whole sample). Empty → 0.
  let endSec = 0;
  for (const e of recipe.events) {
    endSec = Math.max(endSec, e.startSec + Math.max(0, e.durationSec));
  }
  const totalFrames = Math.max(0, Math.ceil(endSec * sampleRate));
  const out = new Float32Array(totalFrames);

  for (const e of recipe.events) {
    if (e.durationSec <= 0) continue;
    const peak = clamp01(e.gain) * master; // the AudioManager's master×event product
    if (peak <= 0) continue;
    const startFrame = Math.max(0, Math.floor(e.startSec * sampleRate));
    const frames = Math.floor(e.durationSec * sampleRate);
    const wave = e.wave ?? 'sine';
    const freq = e.freq ?? 440;

    for (let i = 0; i < frames; i++) {
      const frame = startFrame + i;
      if (frame >= totalFrames) break;
      const offsetSec = i / sampleRate;
      const env = envelope(offsetSec, e.durationSec, peak);
      const sample =
        e.type === 'noise' ? Math.random() * 2 - 1 : oscillator(wave, freq * offsetSec);
      out[frame] = (out[frame] ?? 0) + sample * env;
    }
  }

  // Guard against additive overlap clipping past [-1, 1].
  for (let i = 0; i < out.length; i++) {
    const v = out[i] ?? 0;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

// ── WAV container (16-bit PCM, mono) ────────────────────────────────────────────

/** Write an ASCII tag into a DataView at `offset`. */
function writeTag(view: DataView, offset: number, tag: string): void {
  for (let i = 0; i < tag.length; i++) view.setUint8(offset + i, tag.charCodeAt(i));
}

/**
 * PURE: encode mono Float32 samples ([-1,1]) as a 16-bit PCM WAV byte stream.
 * Standard 44-byte RIFF/WAVE header followed by little-endian int16 samples.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2; // 16-bit
  const numChannels = 1; // mono
  const dataBytes = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  // RIFF header
  writeTag(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true); // file size minus the first 8 bytes
  writeTag(view, 8, 'WAVE');
  // fmt chunk
  writeTag(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = 1 (PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true); // byte rate
  view.setUint16(32, numChannels * bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true); // bits per sample
  // data chunk
  writeTag(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i] ?? 0;
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    // Map [-1,1] → int16. Negative range is one larger, matching common encoders.
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Uint8Array(buffer);
}

/** PURE: render a recipe straight to WAV bytes (renderRecipeSamples → encodeWav).
 *  This is the shared BAKE path — a recipe → 16-bit PCM mono WAV. */
export function renderRecipeToWav(recipe: AudioRecipe): Uint8Array {
  return encodeWav(renderRecipeSamples(recipe), Math.max(1, Math.floor(recipe.sampleRate)));
}

// ── preset library ──────────────────────────────────────────────────────────────

/** Standard sample rate for the built-in presets. */
const SR = 44100;

/**
 * SFX_PRESETS — common game sounds as ready-to-use recipes. Good, reusable,
 * on-brand defaults: play any of them at runtime with `playRecipe`, or bake →
 * import to Crucible as a starting-point asset. Each is a small AudioRecipe, so
 * a game can spread one and tweak (`{ ...SFX_PRESETS.coin, masterGain: 0.5 }`).
 */
export const SFX_PRESETS = {
  /** A dull, punchy hit — low sine thump layered with a short noise transient. */
  impact: {
    sampleRate: SR,
    events: [
      { type: 'noise', startSec: 0, durationSec: 0.06, gain: 0.5 },
      { type: 'tone', wave: 'sine', freq: 120, startSec: 0, durationSec: 0.14, gain: 0.7 },
    ],
  },
  /** A soft, dry footstep — a very short low-passed-feeling noise tick. */
  footstep: {
    sampleRate: SR,
    events: [
      { type: 'noise', startSec: 0, durationSec: 0.05, gain: 0.35 },
      { type: 'tone', wave: 'sine', freq: 90, startSec: 0, durationSec: 0.05, gain: 0.25 },
    ],
  },
  /** A bright two-note rising pickup blip. */
  pickup: {
    sampleRate: SR,
    events: [
      { type: 'tone', wave: 'square', freq: 660, startSec: 0, durationSec: 0.06, gain: 0.4 },
      { type: 'tone', wave: 'square', freq: 990, startSec: 0.06, durationSec: 0.08, gain: 0.4 },
    ],
  },
  /** A classic arcade coin — quick low→high square chirp. */
  coin: {
    sampleRate: SR,
    events: [
      { type: 'tone', wave: 'square', freq: 988, startSec: 0, durationSec: 0.05, gain: 0.45 },
      { type: 'tone', wave: 'square', freq: 1319, startSec: 0.05, durationSec: 0.12, gain: 0.45 },
    ],
  },
  /** A crisp UI click — a single very short triangle blip. */
  'ui-click': {
    sampleRate: SR,
    events: [{ type: 'tone', wave: 'triangle', freq: 880, startSec: 0, durationSec: 0.03, gain: 0.35 }],
  },
  /** A friendly confirm — two ascending sine notes. */
  'ui-confirm': {
    sampleRate: SR,
    events: [
      { type: 'tone', wave: 'sine', freq: 587, startSec: 0, durationSec: 0.08, gain: 0.4 },
      { type: 'tone', wave: 'sine', freq: 880, startSec: 0.08, durationSec: 0.12, gain: 0.4 },
    ],
  },
  /** A back/cancel — two descending sine notes. */
  'ui-back': {
    sampleRate: SR,
    events: [
      { type: 'tone', wave: 'sine', freq: 587, startSec: 0, durationSec: 0.08, gain: 0.4 },
      { type: 'tone', wave: 'sine', freq: 392, startSec: 0.08, durationSec: 0.12, gain: 0.4 },
    ],
  },
  /**
   * A cold courtesy tick — a single very short high sine partial with almost no
   * body, so it never reads as a UI-toolkit click. Quieter and barer than
   * `ui-click`. Promoted from GYRE's shell menu SELECT tick (`playMenuTick`).
   */
  'menu-tick': {
    sampleRate: SR,
    events: [{ type: 'tone', wave: 'sine', freq: 1760, startSec: 0, durationSec: 0.05, gain: 0.18 }],
  },
  /**
   * A ceremonial DESCENDING confirm — a 3-note triangle motif (E6→C#6→A5, a
   * descending A-major triad) with more body than `ui-confirm`'s ascending sine
   * pair; reads as "commitment", not a courtesy blip. Promoted from GYRE's
   * NEW-DESCENT chime (`playStartChime`) — the recipe form folds its three
   * setTimeout-staggered notes into one declaratively-scheduled cue.
   */
  'menu-confirm': {
    sampleRate: SR,
    events: [
      { type: 'tone', wave: 'triangle', freq: 1319.5, startSec: 0, durationSec: 0.16, gain: 0.32 },
      { type: 'tone', wave: 'triangle', freq: 1108.7, startSec: 0.14, durationSec: 0.16, gain: 0.3 },
      { type: 'tone', wave: 'triangle', freq: 880, startSec: 0.28, durationSec: 0.26, gain: 0.34 },
    ],
  },
  /** A sharp combat hit — noise crack over a short sawtooth stab. */
  hit: {
    sampleRate: SR,
    events: [
      { type: 'noise', startSec: 0, durationSec: 0.04, gain: 0.5 },
      { type: 'tone', wave: 'sawtooth', freq: 220, startSec: 0, durationSec: 0.1, gain: 0.5 },
    ],
  },
  /** A negative buzz — a low, harsh sawtooth double-blip. */
  error: {
    sampleRate: SR,
    events: [
      { type: 'tone', wave: 'sawtooth', freq: 200, startSec: 0, durationSec: 0.12, gain: 0.4 },
      { type: 'tone', wave: 'sawtooth', freq: 150, startSec: 0.14, durationSec: 0.16, gain: 0.4 },
    ],
  },
  /** A triumphant level-up — a three-note ascending square arpeggio. */
  'level-up': {
    sampleRate: SR,
    events: [
      { type: 'tone', wave: 'square', freq: 523, startSec: 0, durationSec: 0.1, gain: 0.4 },
      { type: 'tone', wave: 'square', freq: 659, startSec: 0.1, durationSec: 0.1, gain: 0.4 },
      { type: 'tone', wave: 'square', freq: 784, startSec: 0.2, durationSec: 0.18, gain: 0.4 },
    ],
  },
  /** A swishy whoosh — a burst of noise that fades over ~0.3s. */
  whoosh: {
    sampleRate: SR,
    events: [
      { type: 'noise', startSec: 0, durationSec: 0.12, gain: 0.4 },
      { type: 'noise', startSec: 0.1, durationSec: 0.2, gain: 0.25 },
    ],
  },
} satisfies Record<string, AudioRecipe>;

/** The key of a built-in preset (e.g. 'coin', 'ui-click'). */
export type SfxPresetName = keyof typeof SFX_PRESETS;
