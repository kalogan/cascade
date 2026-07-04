/**
 * perf — device-tier detection + adaptive quality.
 *
 * THREE-FREE. `detectDeviceTier` reads `navigator`/`devicePixelRatio`/`matchMedia`
 * behind `typeof` guards so it is headless-safe (returns a sensible default when
 * those globals are absent — SSR, tests, workers). For determinism you can inject
 * the raw signals instead of touching globals at all.
 *
 * `createFrameMonitor` and `createAdaptiveQuality` are PURE: they are fed frame
 * times each tick and never read the wall clock or `Math.random()`. The same
 * sequence of `push`/`tick` calls always produces identical state — asserted in
 * the test suite.
 *
 * Division of labour: `perf` owns *when* to switch tiers (frame-time budget +
 * hysteresis); the game owns *what* each tier means (DPR cap, particle budget,
 * blend modes …). The game registers those knobs; this module just emits a tier.
 */

// ─────────────────────────────────────────────────────────────────────────
// Device tier
// ─────────────────────────────────────────────────────────────────────────

export type DeviceTier = 'low' | 'mid' | 'high';

/** Ladder low → high; index in here defines "step up / step down". */
export const TIER_ORDER: readonly DeviceTier[] = ['low', 'mid', 'high'];

export function isDeviceTier(v: unknown): v is DeviceTier {
  return v === 'low' || v === 'mid' || v === 'high';
}

/**
 * Raw device signals the heuristic scores. Every field is optional; inject them
 * for deterministic tests, or leave the object off entirely to read the globals.
 */
export interface DeviceSignals {
  /** navigator.hardwareConcurrency (logical cores). */
  cores?: number;
  /** navigator.deviceMemory (GiB, coarse + capped by the platform). */
  memoryGiB?: number;
  /** devicePixelRatio. */
  dpr?: number;
  /** matchMedia('(pointer: coarse)') — touch-primary. */
  coarsePointer?: boolean;
  /** UA looks like a phone/tablet. */
  mobile?: boolean;
}

export interface DetectTierOpts {
  /** Hard override (e.g. persisted in settings). Wins over everything. */
  override?: DeviceTier | null;
  /** URL query string to scan for `?tier=low|mid|high` (e.g. `location.search`). */
  search?: string;
  /** Pre-collected signals; when present the globals are NOT read. */
  signals?: DeviceSignals;
}

/** Read device signals from browser globals, guarded for headless environments. */
export function readDeviceSignals(): DeviceSignals {
  const nav: any = typeof navigator !== 'undefined' ? navigator : undefined;
  const dpr = typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : undefined;
  const coarse =
    typeof matchMedia !== 'undefined'
      ? !!matchMedia('(pointer: coarse)').matches
      : undefined;
  const ua: string = nav?.userAgent ?? '';
  return {
    cores: typeof nav?.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : undefined,
    memoryGiB: typeof nav?.deviceMemory === 'number' ? nav.deviceMemory : undefined,
    dpr,
    coarsePointer: coarse,
    mobile: ua ? /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(ua) : undefined,
  };
}

/**
 * Pick a starting tier. Precedence: explicit `override` → `?tier=` URL param →
 * a heuristic score over the signals. Unknown/absent signals are treated as
 * "capable" so a stripped environment (headless test, SSR) is never crippled;
 * the adaptive loop corrects a wrong guess at runtime anyway.
 */
export function detectDeviceTier(opts: DetectTierOpts = {}): DeviceTier {
  if (isDeviceTier(opts.override)) return opts.override;

  const search = opts.search ?? (typeof location !== 'undefined' ? location.search : '');
  const m = /[?&]tier=(low|mid|high)\b/.exec(search ?? '');
  if (m) return m[1] as DeviceTier;

  const s = opts.signals ?? readDeviceSignals();
  const cores = s.cores ?? 4;
  const mem = s.memoryGiB ?? 4;
  const dpr = s.dpr ?? 1;

  // Additive score: strong CPU/RAM push up; a dense mobile panel pushes down
  // (more pixels to fill on a thermally-limited part).
  let score = 0;
  score += cores >= 8 ? 2 : cores >= 4 ? 1 : 0;
  score += mem >= 8 ? 2 : mem >= 4 ? 1 : 0;
  if (s.mobile) score -= 1;
  if (s.mobile && dpr >= 3) score -= 1;

  return score >= 3 ? 'high' : score >= 1 ? 'mid' : 'low';
}

// ─────────────────────────────────────────────────────────────────────────
// Frame monitor — rolling window of frame times (pure; fed dt each tick)
// ─────────────────────────────────────────────────────────────────────────

export interface FrameMonitor {
  /** Record one frame's duration in milliseconds. */
  push(dtMs: number): void;
  /** Mean frame time (ms) over the window; 0 when empty. */
  avg(): number;
  /** 95th-percentile frame time (ms) over the window; 0 when empty. */
  p95(): number;
  /** Smoothed frames-per-second derived from the mean; 0 when empty. */
  fps(): number;
  /** Count of frames in the window slower than the drop threshold. */
  dropped(): number;
  /** Number of samples currently held (≤ window). */
  count(): number;
  /** Forget all samples. */
  reset(): void;
}

export interface FrameMonitorOpts {
  /** Samples retained (rolling). Default 120 (~2s at 60fps). */
  window?: number;
  /** Frames slower than this (ms) count as "dropped". Default 33.34 (<30fps). */
  dropThresholdMs?: number;
}

/**
 * Fixed-size ring buffer of frame times. `push` never allocates; `p95` allocates
 * a scratch copy only when queried (sort-based percentile), never per frame.
 */
export function createFrameMonitor(opts: FrameMonitorOpts = {}): FrameMonitor {
  const window = Math.max(1, Math.floor(opts.window ?? 120));
  const dropMs = opts.dropThresholdMs ?? 1000 / 30;
  const buf = new Float64Array(window);
  let head = 0; // next write index
  let n = 0; // filled count

  return {
    push(dtMs: number) {
      if (!(dtMs >= 0)) return; // ignore NaN / negative
      buf[head] = dtMs;
      head = (head + 1) % window;
      if (n < window) n++;
    },
    avg() {
      if (n === 0) return 0;
      let sum = 0;
      for (let i = 0; i < n; i++) sum += buf[i]!;
      return sum / n;
    },
    p95() {
      if (n === 0) return 0;
      const scratch = Array.prototype.slice.call(buf, 0, n) as number[];
      scratch.sort((a, b) => a - b);
      const idx = Math.min(n - 1, Math.ceil(0.95 * n) - 1);
      return scratch[Math.max(0, idx)]!;
    },
    fps() {
      const a = this.avg();
      return a > 0 ? 1000 / a : 0;
    },
    dropped() {
      let d = 0;
      for (let i = 0; i < n; i++) if (buf[i]! > dropMs) d++;
      return d;
    },
    count() {
      return n;
    },
    reset() {
      head = 0;
      n = 0;
      buf.fill(0);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Adaptive quality — steps the tier with hysteresis so it never oscillates
// ─────────────────────────────────────────────────────────────────────────

export interface AdaptiveQualityOpts {
  /** Starting tier (typically from `detectDeviceTier`). */
  start: DeviceTier;
  /** Source of the smoothed p95 frame time (ms) — usually a `FrameMonitor`. */
  monitor: Pick<FrameMonitor, 'p95'>;
  /** Allowed ladder (subset/order of TIER_ORDER). Default all three. */
  tiers?: readonly DeviceTier[];
  /** Frame-time budget (ms) we try to hold. Default 1000/60 ≈ 16.67. */
  budgetMs?: number;
  /** Consecutive over-budget ticks before stepping DOWN. Default 3 (react fast). */
  downgradeAfter?: number;
  /** Consecutive comfortable ticks before stepping UP. Default 12 (creep up slowly). */
  upgradeAfter?: number;
  /**
   * Upgrade only when p95 sits under `headroom * budgetMs`. The band between
   * that and the budget is the hysteresis dead-zone where nothing moves.
   * Default 0.7.
   */
  headroom?: number;
}

export interface AdaptiveQuality {
  /** Current tier. */
  tier(): DeviceTier;
  /**
   * Evaluate one decision step against the monitor's p95 and return the
   * (possibly updated) tier. Call periodically (e.g. once per N frames), not
   * necessarily every frame.
   */
  tick(): DeviceTier;
  /** Reset counters; optionally jump to a tier. */
  reset(tier?: DeviceTier): void;
}

/**
 * Hysteretic tier controller. Downgrades quickly when p95 blows the budget for
 * `downgradeAfter` consecutive checks; upgrades only after `upgradeAfter`
 * checks sitting comfortably under `headroom * budget`. Frame times in the
 * dead-band between `headroom*budget` and `budget` reset both counters, so a
 * signal hovering near the budget holds steady instead of flapping. This is the
 * same debounced-threshold shape that killed GYRE's stair-bounce oscillation.
 */
export function createAdaptiveQuality(opts: AdaptiveQualityOpts): AdaptiveQuality {
  const ladder = (opts.tiers ?? TIER_ORDER).slice();
  const budgetMs = opts.budgetMs ?? 1000 / 60;
  const downgradeAfter = Math.max(1, opts.downgradeAfter ?? 3);
  const upgradeAfter = Math.max(1, opts.upgradeAfter ?? 12);
  const headroom = opts.headroom ?? 0.7;
  const comfortMs = budgetMs * headroom;

  const clampIdx = (i: number) => Math.max(0, Math.min(ladder.length - 1, i));
  let idx = clampIdx(ladder.indexOf(isDeviceTier(opts.start) ? opts.start : ladder[ladder.length - 1]!));
  if (idx < 0) idx = ladder.length - 1;
  let overRun = 0;
  let underRun = 0;

  return {
    tier() {
      return ladder[idx]!;
    },
    tick() {
      const p = opts.monitor.p95();
      if (p > budgetMs) {
        overRun++;
        underRun = 0;
        if (overRun >= downgradeAfter && idx > 0) {
          idx--;
          overRun = 0;
        }
      } else if (p > 0 && p < comfortMs) {
        underRun++;
        overRun = 0;
        if (underRun >= upgradeAfter && idx < ladder.length - 1) {
          idx++;
          underRun = 0;
        }
      } else {
        // dead-band (comfortMs..budgetMs) or no data — hold, decay both runs.
        overRun = 0;
        underRun = 0;
      }
      return ladder[idx]!;
    },
    reset(tier?: DeviceTier) {
      overRun = 0;
      underRun = 0;
      if (tier && ladder.includes(tier)) idx = clampIdx(ladder.indexOf(tier));
    },
  };
}
