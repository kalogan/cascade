/**
 * Versioned + checksummed save store — for game saves / replays.
 *
 * THREE-FREE: this module must never import three so it unit-tests without it.
 *
 * Distinct from `settings`: this store does NOT forward-merge or migrate. A save
 * is an opaque snapshot of game state. On load it is rejected (→ null) if either
 * the version does not match (the save shape is from a different build) OR the
 * checksum does not match the persisted data (corrupt / tampered blob).
 *
 * Persisted JSON shape: `{ version, data, checksum }` where `checksum` is an
 * FNV-1a hash of the serialized `data`. When localStorage is unavailable
 * (node / SSR), an in-memory map is used so the API behaves identically without
 * persistence.
 */

export interface SaveStoreOptions {
  /** localStorage key the persisted blob lives under. */
  key: string;
  /** Current save-format version. A persisted blob with a different version → null. */
  version: number;
}

export interface SaveStore<T> {
  /** Serialize and persist `data` with the current version and a checksum. */
  save(data: T): void;
  /** Load the saved data, or null if absent / corrupt / version-mismatched. */
  load(): T | null;
  /** Remove any persisted save. */
  clear(): void;
  /** Whether a (syntactically present) save exists under the key. */
  exists(): boolean;
}

/**
 * FNV-1a 32-bit string hash, returned as an unsigned hex string.
 *
 * Pure and deterministic: the same input always yields the same hash, and a
 * single-character change yields a different hash with overwhelming likelihood.
 * Exported for direct testing and reuse.
 */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= FNV prime (0x01000193), done via Math.imul to stay in 32-bit.
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory fallback when localStorage is absent (node / SSR). */
function createMemoryStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function resolveStorage(): StorageLike {
  try {
    const ls = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (
      ls &&
      typeof ls.getItem === 'function' &&
      typeof ls.setItem === 'function' &&
      typeof ls.removeItem === 'function'
    ) {
      // Probe write — some environments expose localStorage but throw on use.
      const probe = '__game_kit_save_probe__';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    }
  } catch {
    // fall through to memory
  }
  return createMemoryStorage();
}

interface PersistedSave {
  version: number;
  data: unknown;
  checksum: string;
}

export function createSaveStore<T>(options: SaveStoreOptions): SaveStore<T> {
  const { key, version } = options;
  const storage = resolveStorage();

  return {
    save(data: T): void {
      const serialized = JSON.stringify(data);
      const payload: PersistedSave = {
        version,
        // Re-parse so the persisted `data` is a structured value, while the
        // checksum is taken over the exact string we hashed.
        data: serialized === undefined ? null : JSON.parse(serialized),
        checksum: fnv1a(serialized ?? 'undefined'),
      };
      try {
        storage.setItem(key, JSON.stringify(payload));
      } catch {
        // Persisting is best-effort; ignore quota / serialization errors.
      }
    },

    load(): T | null {
      const raw = storage.getItem(key);
      if (raw == null) return null;

      let parsed: PersistedSave;
      try {
        parsed = JSON.parse(raw) as PersistedSave;
      } catch {
        return null; // unparseable blob
      }

      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.version !== 'number' || typeof parsed.checksum !== 'string') {
        return null;
      }

      // Version gate: a save from a different build shape is rejected.
      if (parsed.version !== version) return null;

      // Checksum gate: recompute over the persisted data and compare.
      const serialized = JSON.stringify(parsed.data);
      const expected = fnv1a(serialized ?? 'undefined');
      if (expected !== parsed.checksum) return null; // corrupt / tampered

      return parsed.data as T;
    },

    clear(): void {
      try {
        storage.removeItem(key);
      } catch {
        // best-effort
      }
    },

    exists(): boolean {
      return storage.getItem(key) != null;
    },
  };
}
