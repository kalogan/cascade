/**
 * Named palette + material factories — the flat + emissive/bloom recipe.
 *
 * Distilled from project-mmo's approved art-kit (packages/client/src/art/palette.ts):
 * a generator names its colours once, then mints flat-shaded standard materials
 * from them. Emissive materials set `toneMapped: false` so they pop under a Bloom
 * pass instead of being crushed by tone mapping (RENDERING_STABILITY: glow via
 * bloom + emissive, never real per-object lights).
 *
 * Where project-mmo hard-codes one big `PAL` const + free `flatMat`/`emissiveMat`
 * functions, this kit version is a small FACTORY so each game declares its own
 * named palette and gets bound material helpers — no shared global.
 *
 * three-dependent: imports three.
 */

import * as THREE from 'three';

export interface FlatMatOpts {
  /** Surface roughness (default ~1 — matte, no specular highlight). */
  roughness?: number;
}

export interface Palette {
  /** Resolve a named colour to a fresh THREE.Color. Unknown name → throws. */
  color(name: string): THREE.Color;
  /** Whether a colour name is registered. */
  has(name: string): boolean;
  /**
   * Flat-shaded matte MeshStandardMaterial for the named colour.
   * `{ color, roughness ~1, metalness 0, flatShading true }`.
   */
  flatMat(name: string, opts?: FlatMatOpts): THREE.MeshStandardMaterial;
  /**
   * Emissive flat material that pops under Bloom: same as `flatMat` plus an
   * emissive tint (`emissiveName` if given, else `name`), an emissive intensity,
   * and `toneMapped: false` so tone mapping doesn't crush the glow.
   */
  emissiveMat(
    name: string,
    emissiveName?: string,
    intensity?: number,
  ): THREE.MeshStandardMaterial;
}

/**
 * Build a palette from a record of named colours. Values may be CSS strings
 * (`'#ff8c42'`, `'tomato'`) or hex numbers (`0xff8c42`) — anything a
 * THREE.Color accepts.
 *
 * Colours are stored as THREE.Color and `color(name)` returns a fresh CLONE each
 * call, so callers can mutate the result without corrupting the palette.
 */
export function createPalette(colors: Record<string, string | number>): Palette {
  const table = new Map<string, THREE.Color>();
  for (const [name, value] of Object.entries(colors)) {
    table.set(name, new THREE.Color(value as THREE.ColorRepresentation));
  }

  function resolve(name: string): THREE.Color {
    const c = table.get(name);
    if (c === undefined) {
      throw new Error(
        `palette: unknown color name "${name}" (known: ${[...table.keys()].join(', ') || '<none>'})`,
      );
    }
    return c;
  }

  const palette: Palette = {
    color(name: string): THREE.Color {
      return resolve(name).clone();
    },

    has(name: string): boolean {
      return table.has(name);
    },

    flatMat(name: string, opts: FlatMatOpts = {}): THREE.MeshStandardMaterial {
      return new THREE.MeshStandardMaterial({
        color: resolve(name).clone(),
        roughness: opts.roughness ?? 1.0,
        metalness: 0.0,
        flatShading: true,
      });
    },

    emissiveMat(
      name: string,
      emissiveName?: string,
      intensity = 1.0,
    ): THREE.MeshStandardMaterial {
      const emissive = resolve(emissiveName ?? name).clone();
      return new THREE.MeshStandardMaterial({
        color: resolve(name).clone(),
        roughness: 1.0,
        metalness: 0.0,
        flatShading: true,
        emissive,
        emissiveIntensity: intensity,
        toneMapped: false, // so it pops under a Bloom pass
      });
    },
  };

  return palette;
}
