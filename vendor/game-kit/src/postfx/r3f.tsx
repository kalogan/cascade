/**
 * Post-processing — react-three-fiber variant.
 *
 * A declarative <PostFx/> wrapping @react-three/postprocessing's
 * <EffectComposer> with a <Bloom> effect. Bloom defaults come from the shared
 * BLOOM_DEFAULTS in ./index.ts so vanilla + r3f never drift.
 *
 * Note: the vanilla pipeline uses three's UnrealBloomPass; here we use the
 * pmndrs postprocessing <Bloom> effect (the r3f-idiomatic equivalent). The
 * `intensity`/`radius`/`luminanceThreshold` props map onto the same
 * strength/radius/threshold defaults.
 *
 * Requires the react + @react-three/fiber + @react-three/postprocessing peer
 * deps (optional in package.json).
 */

import type { JSX } from 'react';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { BLOOM_DEFAULTS } from './index.js';

export interface PostFxProps {
  bloom?: {
    /** Bloom strength. Maps to the postprocessing Bloom `intensity`. */
    strength?: number;
    /** Bloom radius (0–1). */
    radius?: number;
    /** Luminance threshold above which pixels bloom. */
    threshold?: number;
  };
}

/**
 * Declarative post-processing for r3f. Drop into a <Canvas/> scene as the last
 * child. Bloom defaults match the vanilla `createPostFx`.
 */
export function PostFx(props: PostFxProps = {}): JSX.Element {
  const bloom = props.bloom ?? {};
  return (
    <EffectComposer>
      <Bloom
        intensity={bloom.strength ?? BLOOM_DEFAULTS.strength}
        radius={bloom.radius ?? BLOOM_DEFAULTS.radius}
        luminanceThreshold={bloom.threshold ?? BLOOM_DEFAULTS.threshold}
        mipmapBlur
      />
    </EffectComposer>
  );
}
