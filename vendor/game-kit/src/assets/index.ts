/**
 * assets — a small async preloader for images / audio / data, with progress.
 *
 * The batching core (dedup, bounded concurrency, progress, error handling, the
 * result store) is engine-agnostic and DOM-free — it drives INJECTABLE per-kind
 * loaders, so it unit-tests fully headless. `defaultLoaders()` supplies the
 * browser implementations (Image decode, fetch), guarded so importing the module
 * never touches globals until a default loader is actually used.
 *
 * Typical use: build a loading screen off `onProgress`, then read decoded assets
 * from the returned store (e.g. `store.image('hero')` for a sprite atlas image).
 */

export type AssetKind = 'image' | 'audio' | 'json' | 'text' | 'binary';

export interface AssetSpec {
  id: string;
  url: string;
  kind: AssetKind;
}

export interface LoadProgress {
  /** Assets finished (success or, in failSoft mode, failed). */
  loaded: number;
  total: number;
  /** loaded / total, in [0, 1]. */
  ratio: number;
  /** The id that just completed. */
  lastId?: string;
}

export type AssetLoader = (url: string) => Promise<unknown>;

export interface LoadOptions {
  onProgress?: (p: LoadProgress) => void;
  /** Max concurrent loads. Default 6. */
  concurrency?: number;
  /** Keep going past a failed asset (record it in `store.errors`) instead of
   *  rejecting the whole batch. Default false (fail-fast). */
  failSoft?: boolean;
  /** Override / supply loaders per kind (inject fakes for tests). */
  loaders?: Partial<Record<AssetKind, AssetLoader>>;
}

export interface AssetError {
  id: string;
  url: string;
  error: unknown;
}

export interface AssetStore {
  get<T = unknown>(id: string): T | undefined;
  /** Convenience typed getter for image assets. */
  image(id: string): HTMLImageElement | undefined;
  has(id: string): boolean;
  readonly ids: string[];
  /** Assets that failed (only populated in failSoft mode). */
  readonly errors: AssetError[];
}

/** Browser loaders for each kind. Each throws a clear error in a headless env. */
export function defaultLoaders(): Record<AssetKind, AssetLoader> {
  const needFetch = (): typeof fetch => {
    if (typeof fetch !== 'function') throw new Error('assets: fetch is unavailable in this environment');
    return fetch;
  };
  return {
    image: (url) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        if (typeof Image !== 'function') {
          reject(new Error('assets: Image is unavailable in this environment'));
          return;
        }
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error(`assets: failed to load image ${url}`));
        img.src = url;
      }),
    audio: (url) => needFetch()(url).then((r) => r.arrayBuffer()), // caller decodes with its AudioContext
    json: (url) => needFetch()(url).then((r) => r.json()),
    text: (url) => needFetch()(url).then((r) => r.text()),
    binary: (url) => needFetch()(url).then((r) => r.arrayBuffer()),
  };
}

/**
 * Load a batch of assets with bounded concurrency + progress. Duplicate ids are
 * loaded once. Resolves with a store; in fail-fast mode (default) a single load
 * error rejects the batch (with the offending id), in failSoft mode failures are
 * collected in `store.errors` and the batch still resolves.
 */
export async function loadAssets(specs: AssetSpec[], opts: LoadOptions = {}): Promise<AssetStore> {
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 6));
  const failSoft = opts.failSoft ?? false;
  const loaders = { ...defaultLoaders(), ...(opts.loaders ?? {}) };

  // Dedup by id (first spec for an id wins).
  const seen = new Set<string>();
  const queue: AssetSpec[] = [];
  for (const s of specs) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      queue.push(s);
    }
  }

  const total = queue.length;
  const results = new Map<string, unknown>();
  const errors: AssetError[] = [];
  let loaded = 0;
  let next = 0;

  const report = (lastId: string): void => {
    loaded += 1;
    opts.onProgress?.({ loaded, total, ratio: total === 0 ? 1 : loaded / total, lastId });
  };

  async function worker(): Promise<void> {
    while (next < queue.length) {
      const spec = queue[next++]!;
      const loader = loaders[spec.kind];
      try {
        if (!loader) throw new Error(`assets: no loader for kind "${spec.kind}"`);
        results.set(spec.id, await loader(spec.url));
      } catch (error) {
        errors.push({ id: spec.id, url: spec.url, error });
        if (!failSoft) {
          throw error instanceof Error
            ? new Error(`assets: failed to load "${spec.id}" (${spec.url}): ${error.message}`)
            : error;
        }
      }
      report(spec.id);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total || 1) }, () => worker()));

  return {
    get<T = unknown>(id: string): T | undefined {
      return results.get(id) as T | undefined;
    },
    image(id: string): HTMLImageElement | undefined {
      return results.get(id) as HTMLImageElement | undefined;
    },
    has(id: string): boolean {
      return results.has(id);
    },
    get ids(): string[] {
      return [...results.keys()];
    },
    get errors(): AssetError[] {
      return errors.slice();
    },
  };
}
