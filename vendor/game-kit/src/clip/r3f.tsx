/**
 * Clip player — react-three-fiber variant.
 *
 * A `useClipPlayer` hook wrapping the vanilla `createClipPlayer`. It builds the
 * player once the supplied root ref is populated (the AnimationMixer needs a
 * live Object3D), then steps it every frame from `useFrame`. Returns the player
 * (or null until the ref is set) so the caller can `player?.play('walk')`.
 *
 * Requires the react + @react-three/fiber peer deps (optional in package.json).
 */

import { useMemo, type RefObject } from 'react';
import { useFrame } from '@react-three/fiber';
import type * as THREE from 'three';
import type { AnimationClip } from 'three';
import { createClipPlayer, type ClipPlayer } from './index.js';

/**
 * Drive a crossfading clip player over the Object3D referenced by `rootRef`.
 *
 * The player is constructed once `rootRef.current` is non-null, keyed on the
 * resolved root + clip set, and stepped from the real per-frame `dt`. Returns
 * the {@link ClipPlayer}, or `null` while the ref is still empty.
 *
 * ```tsx
 * const root = useRef<THREE.Group>(null);
 * const player = useClipPlayer(root, clips);
 * useEffect(() => player?.play('idle'), [player]);
 * <group ref={root}>{/* rigged model *\/}</group>
 * ```
 */
export function useClipPlayer(
  rootRef: RefObject<THREE.Object3D | null>,
  clips: readonly AnimationClip[],
): ClipPlayer | null {
  const root = rootRef.current;
  const player = useMemo<ClipPlayer | null>(
    () => (root ? createClipPlayer(root, clips) : null),
    [root, clips],
  );

  useFrame((_, dt) => {
    player?.update(dt);
  });

  return player;
}
