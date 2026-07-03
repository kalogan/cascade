/**
 * Art-kit registry — the data-driven render seam `id → (rng) => Object3D`.
 *
 * Distilled from project-mmo's approved art-kit (packages/client/src/art/artKit.ts):
 * the renderer never hard-codes which mesh to build — it looks an asset up by id.
 * Each id maps to a deterministic generator `(rng) => Object3D`, so the same id +
 * seed always builds the same object. A bought asset pack would slot in as the
 * per-id fallback without any renderer change (source-agnostic seam).
 *
 * Where project-mmo froze one global `ART_KIT` record, this kit version is a small
 * FACTORY so each game owns its own registry and `register`s into it at startup.
 *
 * three-dependent (Object3D) but builds the seeded Rng via the kit's prng module.
 */

import * as THREE from 'three';
import { createRng, type Rng } from '../prng/index.js';

/** A deterministic generator: same Rng sequence → same Object3D. */
export type ArtGenerator = (rng: Rng) => THREE.Object3D;

export interface ArtKit {
  /** Register a generator under `id`. Throws if `id` is already taken. */
  register(id: string, gen: ArtGenerator): void;
  /** Whether an id has a registered generator. */
  has(id: string): boolean;
  /** All registered ids (insertion order). */
  ids(): string[];
  /**
   * Build a fresh Object3D for `id` seeded by `seed`. Builds a new
   * `createRng(seed)` and calls the generator. Returns null for an unknown id
   * (the renderer logs + skips — never throws on missing art).
   */
  generate(id: string, seed: number): THREE.Object3D | null;
}

/** Create an empty art-kit registry. */
export function createArtKit(): ArtKit {
  const gens = new Map<string, ArtGenerator>();

  const kit: ArtKit = {
    register(id: string, gen: ArtGenerator): void {
      if (gens.has(id)) {
        throw new Error(`artKit: id "${id}" is already registered`);
      }
      gens.set(id, gen);
    },

    has(id: string): boolean {
      return gens.has(id);
    },

    ids(): string[] {
      return [...gens.keys()];
    },

    generate(id: string, seed: number): THREE.Object3D | null {
      const gen = gens.get(id);
      if (gen === undefined) return null;
      const rng = createRng(seed >>> 0);
      return gen(rng);
    },
  };

  return kit;
}
