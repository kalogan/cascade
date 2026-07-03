/**
 * FX particles — react-three-fiber variant.
 *
 * A declarative <Particles/> wrapping the vanilla `createParticles` system. The
 * particle THREE.Points object is mounted via <primitive/>, stepped every frame
 * from `useFrame`, and disposed on unmount. Emission is imperative (it's an
 * event, not state), so the component forwards a ref exposing `emit(...)`.
 *
 * Requires the react + @react-three/fiber peer deps (optional in package.json).
 */

import type { JSX } from 'react';
import { forwardRef, useImperativeHandle, useMemo, useEffect } from 'react';
import { useFrame } from '@react-three/fiber';
import {
  createParticles,
  type CreateParticlesOptions,
  type EmitOptions,
} from './index.js';

/** Imperative handle exposed by <Particles/> for emitting bursts. */
export interface ParticlesHandle {
  /** Activate up to `count` free particles at `origin`. Capped at capacity. */
  emit(
    origin: readonly [number, number, number],
    count: number,
    opts?: EmitOptions,
  ): void;
}

/** Props for {@link Particles} — the same options as the vanilla system. */
export type ParticlesProps = CreateParticlesOptions;

/**
 * Declarative particle system for r3f. Drop into a <Canvas/> scene and grab a
 * ref to call `emit(origin, count, opts)`:
 *
 * ```tsx
 * const fx = useRef<ParticlesHandle>(null);
 * <Particles ref={fx} max={500} color={0xffaa33} gravity={[0, -9.8, 0]} />
 * // later: fx.current?.emit([0, 1, 0], 32, { spread: 4, life: 0.8 });
 * ```
 *
 * The system updates from the real per-frame `dt` and disposes on unmount.
 */
export const Particles = forwardRef<ParticlesHandle, ParticlesProps>(
  function Particles(props, ref): JSX.Element {
    // Build the system once. Re-create only if the pool capacity changes
    // (other tunables are read at construction and not hot-swappable).
    const sys = useMemo(
      () => createParticles(props),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [props.max],
    );

    useImperativeHandle(ref, () => ({ emit: sys.emit }), [sys]);

    useFrame((_, dt) => {
      sys.update(dt);
    });

    useEffect(() => () => sys.dispose(), [sys]);

    return <primitive object={sys.object} />;
  },
);
