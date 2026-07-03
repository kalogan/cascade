/**
 * FX — vanilla-three particle/emitter system.
 *
 * A fixed-pool particle system backed by a single BufferGeometry. Feeds the
 * composable asset-system 'fx' channel. Designed for ZERO per-frame allocation
 * on the hot path: all particle state lives in pre-allocated typed arrays and
 * is mutated in place by `update`.
 *
 * Technique distilled from project-mmo's VFX code: a `THREE.Points` cloud with
 * a fixed `max` capacity, a free-list of dead slots, and per-particle
 * velocity/life kept in plain Float32Arrays alongside the geometry attributes.
 *
 * Determinism: given a fixed `dt`, `update` is fully deterministic. `emit`'s
 * spread uses an injected `rng` (matching the prng module's `() => number`
 * contract) so callers can make emission deterministic too; it falls back to
 * Math.random when none is supplied.
 */

import * as THREE from 'three';

/** Minimal RNG contract — a function returning a float in [0, 1). */
export type RandFn = () => number;

export interface CreateParticlesOptions {
  /** Fixed pool capacity. The system never allocates beyond this. */
  max: number;
  /** Point size in world units (PointsMaterial.size). Default 1. */
  size?: number;
  /** Base particle color (0xRRGGBB). Default 0xffffff. */
  color?: number;
  /** Constant acceleration applied every update, in units/s². Default [0,0,0]. */
  gravity?: readonly [number, number, number];
  /** Material blending mode. Default THREE.NormalBlending. */
  blending?: THREE.Blending;
  /**
   * Deterministic RNG for emission spread (float in [0,1)). Defaults to
   * Math.random. Inject a seeded generator for reproducible emission.
   */
  rng?: RandFn;
}

export interface EmitOptions {
  /** Base velocity in units/s applied to every emitted particle. */
  velocity?: readonly [number, number, number];
  /** Symmetric random velocity jitter (units/s) added per axis via rng. */
  spread?: number;
  /** Lifetime in seconds. Default 1. */
  life?: number;
}

export interface ParticleSystem {
  /** The renderable THREE.Points cloud. Add this to your scene. */
  readonly object: THREE.Points;
  /** Activate up to `count` free particles at `origin`. Capped at capacity. */
  emit(
    origin: readonly [number, number, number],
    count: number,
    opts?: EmitOptions,
  ): void;
  /** Integrate physics, age particles, and recycle the dead. */
  update(dt: number): void;
  /** Release GPU/material resources. */
  dispose(): void;
}

/**
 * Create a fixed-pool particle system.
 *
 * Backed by a BufferGeometry with `position` + `color` attributes plus an
 * `alpha` attribute (consumed by a small shader patch so particles can fade).
 * Velocity and remaining life live in side typed arrays. A free-list of dead
 * slot indices makes `emit` O(count) with no scanning and no allocation.
 */
export function createParticles(opts: CreateParticlesOptions): ParticleSystem {
  const max = Math.max(0, Math.floor(opts.max));
  const size = opts.size ?? 1;
  const baseColor = new THREE.Color(opts.color ?? 0xffffff);
  const gravity = opts.gravity ?? ([0, 0, 0] as const);
  const gx = gravity[0];
  const gy = gravity[1];
  const gz = gravity[2];
  const blending = opts.blending ?? THREE.NormalBlending;
  const rng: RandFn = opts.rng ?? Math.random;

  // ── Pre-allocated state (no per-frame allocation past this point) ──────────
  const positions = new Float32Array(max * 3);
  const colors = new Float32Array(max * 3);
  const alphas = new Float32Array(max); // current alpha, doubles as "active" flag (>0)
  const velocities = new Float32Array(max * 3);
  const life = new Float32Array(max); // remaining seconds
  const lifeInit = new Float32Array(max); // original lifetime, for fade ratio

  // Free-list (LIFO stack): indices of inactive slots; `freeCount` is the live length.
  // Seeded descending so the first emits allocate ascending slots (0,1,2,…) — intuitive
  // + lets a single-emit be inspected at index 0.
  const freeList = new Int32Array(max);
  for (let i = 0; i < max; i++) freeList[i] = max - 1 - i;
  let freeCount = max;

  const geometry = new THREE.BufferGeometry();
  const positionAttr = new THREE.BufferAttribute(positions, 3);
  const colorAttr = new THREE.BufferAttribute(colors, 3);
  const alphaAttr = new THREE.BufferAttribute(alphas, 1);
  positionAttr.setUsage(THREE.DynamicDrawUsage);
  colorAttr.setUsage(THREE.DynamicDrawUsage);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', positionAttr);
  geometry.setAttribute('color', colorAttr);
  geometry.setAttribute('alpha', alphaAttr);
  geometry.setDrawRange(0, max);

  const material = new THREE.PointsMaterial({
    size,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending,
  });

  // Patch the material so the per-particle `alpha` attribute modulates opacity.
  material.onBeforeCompile = (shader) => {
    shader.vertexShader =
      'attribute float alpha;\nvarying float vAlpha;\n' +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vAlpha = alpha;',
      );
    shader.fragmentShader =
      'varying float vAlpha;\n' +
      shader.fragmentShader.replace(
        '#include <premultiplied_alpha_fragment>',
        'gl_FragColor.a *= vAlpha;\n#include <premultiplied_alpha_fragment>',
      );
  };

  const object = new THREE.Points(geometry, material);
  object.frustumCulled = false;

  function emit(
    origin: readonly [number, number, number],
    count: number,
    emitOpts: EmitOptions = {},
  ): void {
    const want = Math.max(0, Math.floor(count));
    const n = Math.min(want, freeCount); // cap at remaining capacity
    const vel = emitOpts.velocity ?? ([0, 0, 0] as const);
    const spread = emitOpts.spread ?? 0;
    const lifeSpan = emitOpts.life ?? 1;
    const ox = origin[0];
    const oy = origin[1];
    const oz = origin[2];

    for (let k = 0; k < n; k++) {
      freeCount--;
      const idx = freeList[freeCount] as number; // freeCount < max, always valid
      const p = idx * 3;

      positions[p] = ox;
      positions[p + 1] = oy;
      positions[p + 2] = oz;

      // spread is symmetric: rng()*2-1 → [-1, 1)
      velocities[p] = vel[0] + (spread > 0 ? (rng() * 2 - 1) * spread : 0);
      velocities[p + 1] = vel[1] + (spread > 0 ? (rng() * 2 - 1) * spread : 0);
      velocities[p + 2] = vel[2] + (spread > 0 ? (rng() * 2 - 1) * spread : 0);

      colors[p] = baseColor.r;
      colors[p + 1] = baseColor.g;
      colors[p + 2] = baseColor.b;

      life[idx] = lifeSpan;
      lifeInit[idx] = lifeSpan;
      alphas[idx] = 1;
    }

    if (n > 0) {
      positionAttr.needsUpdate = true;
      colorAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
    }
  }

  function update(dt: number): void {
    let touched = false;
    for (let idx = 0; idx < max; idx++) {
      if ((alphas[idx] as number) <= 0) continue; // inactive slot
      touched = true;

      let remaining = (life[idx] as number) - dt;
      if (remaining <= 0) {
        // Recycle: mark dead and return the slot to the free-list.
        alphas[idx] = 0;
        life[idx] = 0;
        freeList[freeCount] = idx;
        freeCount++;
        continue;
      }
      life[idx] = remaining;

      const p = idx * 3;
      // Integrate velocity (with gravity acceleration).
      const vx = (velocities[p] as number) + gx * dt;
      const vy = (velocities[p + 1] as number) + gy * dt;
      const vz = (velocities[p + 2] as number) + gz * dt;
      velocities[p] = vx;
      velocities[p + 1] = vy;
      velocities[p + 2] = vz;

      positions[p] = (positions[p] as number) + vx * dt;
      positions[p + 1] = (positions[p + 1] as number) + vy * dt;
      positions[p + 2] = (positions[p + 2] as number) + vz * dt;

      // Fade alpha proportional to remaining life.
      const span = lifeInit[idx] as number;
      alphas[idx] = span > 0 ? remaining / span : 0;
    }

    if (touched) {
      positionAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
    }
  }

  function dispose(): void {
    geometry.dispose();
    material.dispose();
  }

  return { object, emit, update, dispose };
}
