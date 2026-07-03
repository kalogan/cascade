/**
 * Persistent settings store — localStorage-backed with a schema version and
 * forward-merge migration.
 *
 * THREE-FREE: this module must never import three so it unit-tests without it.
 *
 * - Persisted values are merged OVER the defaults, so adding a new default in a
 *   newer build is picked up automatically for existing users.
 * - On a version bump, the optional `migrate` hook transforms the old persisted
 *   blob into a partial of the new shape; if it is absent (or throws), the store
 *   falls back to defaults.
 * - When localStorage is unavailable (node / SSR), an in-memory map is used so
 *   the API behaves identically without persistence.
 */

export interface SettingsStoreOptions<T extends object> {
  /** localStorage key the persisted blob lives under. */
  key: string;
  /** Default settings; the source of truth for the current schema shape. */
  defaults: T;
  /** Current schema version. A persisted blob with a different version triggers migrate. */
  version: number;
  /**
   * Optional migration from an older (or unknown) persisted blob.
   * Receives the raw persisted `data` and its `oldV` version (NaN if unknown),
   * and returns a partial that is merged over defaults. If omitted or it throws,
   * the store falls back to defaults.
   */
  migrate?(old: unknown, oldV: number): Partial<T>;
}

export interface SettingsStore<T extends object> {
  /** Current in-memory settings (a fresh shallow copy). */
  get(): T;
  /** Merge a patch into the current settings, persist, and notify subscribers. */
  set(patch: Partial<T>): void;
  /** Subscribe to changes; returns an unsubscribe function. */
  subscribe(fn: (s: T) => void): () => void;
  /** Re-read from storage into memory and return the result. */
  load(): T;
  /** Persist the current in-memory settings to storage. */
  save(): void;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** In-memory fallback when localStorage is absent (node / SSR). */
function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

function resolveStorage(): StorageLike {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (ls && typeof ls.getItem === 'function' && typeof ls.setItem === 'function') {
      // Probe write — some environments expose localStorage but throw on use.
      const probe = '__game_kit_probe__';
      ls.setItem(probe, '1');
      return ls;
    }
  } catch {
    // fall through to memory
  }
  return createMemoryStorage();
}

interface Persisted {
  version: number;
  data: unknown;
}

export function createSettingsStore<T extends object>(
  options: SettingsStoreOptions<T>,
): SettingsStore<T> {
  const { key, defaults, version, migrate } = options;
  const storage = resolveStorage();
  const subscribers = new Set<(s: T) => void>();

  let state: T = { ...defaults };

  function mergeOverDefaults(partial: Partial<T>): T {
    return { ...defaults, ...partial };
  }

  function readFromStorage(): T {
    const raw = storage.getItem(key);
    if (raw == null) return { ...defaults };

    let parsed: Persisted | undefined;
    try {
      parsed = JSON.parse(raw) as Persisted;
    } catch {
      return { ...defaults };
    }

    if (!parsed || typeof parsed !== 'object') return { ...defaults };

    const oldV = typeof parsed.version === 'number' ? parsed.version : NaN;

    // Matching version: forward-merge persisted data over defaults.
    if (oldV === version) {
      const data = (parsed.data ?? {}) as Partial<T>;
      return mergeOverDefaults(data);
    }

    // Version mismatch (older / unknown): try migrate, else fall back to defaults.
    if (migrate) {
      try {
        const migrated = migrate(parsed.data, oldV);
        return mergeOverDefaults(migrated ?? {});
      } catch {
        return { ...defaults };
      }
    }
    return { ...defaults };
  }

  function persist(): void {
    const payload: Persisted = { version, data: state };
    try {
      storage.setItem(key, JSON.stringify(payload));
    } catch {
      // Persisting is best-effort; ignore quota / serialization errors.
    }
  }

  function notify(): void {
    const snapshot = { ...state };
    for (const fn of subscribers) fn(snapshot);
  }

  // Initial load from storage.
  state = readFromStorage();

  return {
    get(): T {
      return { ...state };
    },

    set(patch: Partial<T>): void {
      state = { ...state, ...patch };
      persist();
      notify();
    },

    subscribe(fn: (s: T) => void): () => void {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },

    load(): T {
      state = readFromStorage();
      return { ...state };
    },

    save(): void {
      persist();
    },
  };
}
