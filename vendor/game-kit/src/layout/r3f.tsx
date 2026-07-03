/**
 * Layout — react-three-fiber greybox shell.
 *
 * `<LayoutGreybox descriptor floor?/>` renders `buildLayoutGeometry(descriptor)`
 * as flat-shaded boxes: floor slabs, walls, and stair runs (each step a box).
 * Nothing else — no lights, no materials beyond flat colour, no interaction.
 * The GAME skins/lights this (swap in real materials, add props, etc.); this
 * component exists purely so a level author can SEE the layout while building
 * it, and so a game has a zero-effort placeholder render before real art
 * lands. Pass `floor` to render only one storey (handy for an editor that
 * shows one floor at a time); omit it to render every floor.
 *
 * Requires the react + @react-three/fiber peer deps (optional in package.json).
 */

import type { JSX } from 'react';
import { buildLayoutGeometry, type LayoutDescriptor, type Slab, type StairRun } from './index.js';

/** Kit-palette-friendly greybox colours. Override any subset via `colors`. */
export interface LayoutGreyboxColors {
  floor?: string;
  wall?: string;
  stair?: string;
}

const DEFAULT_COLORS: Required<LayoutGreyboxColors> = {
  floor: '#8a8d91',
  wall: '#cfd8dc',
  stair: '#a7b0b5',
};

/** Wall thickness + stair box depth, in world units — greybox-only, not part of the descriptor. */
const WALL_THICKNESS = 0.15;
const SLAB_THICKNESS = 0.1;

export interface LayoutGreyboxProps {
  descriptor: LayoutDescriptor;
  /** Render only this floor index. Omit to render every floor. */
  floor?: number;
  colors?: LayoutGreyboxColors;
  castShadow?: boolean;
  receiveShadow?: boolean;
}

function SlabMesh({ slab, color, castShadow, receiveShadow }: { slab: Slab; color: string; castShadow: boolean; receiveShadow: boolean }): JSX.Element {
  const cx = slab.rect.x + slab.rect.w / 2;
  const cz = slab.rect.z + slab.rect.d / 2;
  return (
    <mesh
      position={[cx, slab.elevation - SLAB_THICKNESS / 2, cz]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    >
      <boxGeometry args={[slab.rect.w, SLAB_THICKNESS, slab.rect.d]} />
      <meshStandardMaterial color={color} flatShading roughness={1} />
    </mesh>
  );
}

function WallMesh({
  wall,
  color,
  castShadow,
  receiveShadow,
}: {
  wall: { x0: number; z0: number; x1: number; z1: number; elevation: number; height: number };
  color: string;
  castShadow: boolean;
  receiveShadow: boolean;
}): JSX.Element {
  const cx = (wall.x0 + wall.x1) / 2;
  const cz = (wall.z0 + wall.z1) / 2;
  const len = Math.hypot(wall.x1 - wall.x0, wall.z1 - wall.z0);
  const angle = Math.atan2(wall.z1 - wall.z0, wall.x1 - wall.x0);
  return (
    <mesh
      position={[cx, wall.elevation + wall.height / 2, cz]}
      rotation={[0, -angle, 0]}
      castShadow={castShadow}
      receiveShadow={receiveShadow}
    >
      <boxGeometry args={[len, wall.height, WALL_THICKNESS]} />
      <meshStandardMaterial color={color} flatShading roughness={1} />
    </mesh>
  );
}

function StairMesh({ run, color, castShadow, receiveShadow }: { run: StairRun; color: string; castShadow: boolean; receiveShadow: boolean }): JSX.Element {
  const ux = Math.cos(run.dir);
  const uz = Math.sin(run.dir);
  const sign = run.toElevation >= run.fromElevation ? 1 : -1;
  const steps = [];
  for (let i = 0; i < run.steps; i++) {
    const along = run.stepRun * (i + 0.5);
    const rise = run.fromElevation + sign * run.stepRise * (i + 0.5);
    const cx = run.foot[0] + ux * along;
    const cz = run.foot[1] + uz * along;
    steps.push(
      <mesh key={i} position={[cx, rise, cz]} castShadow={castShadow} receiveShadow={receiveShadow}>
        <boxGeometry args={[run.width, run.stepRise, run.stepRun]} />
        <meshStandardMaterial color={color} flatShading roughness={1} />
      </mesh>,
    );
  }
  return <>{steps}</>;
}

/**
 * Flat-shaded greybox render of a `LayoutDescriptor`: floor slabs (with void
 * openings already cut by `buildLayoutGeometry`'s rect-decomposition), walls
 * (with door gaps already cut), and stair runs (one box per step). Drop
 * inside a `<Canvas>`; add your own lights.
 */
export function LayoutGreybox({
  descriptor,
  floor,
  colors,
  castShadow = true,
  receiveShadow = true,
}: LayoutGreyboxProps): JSX.Element {
  const c = { ...DEFAULT_COLORS, ...colors };
  const geo = buildLayoutGeometry(descriptor);

  const slabs = floor === undefined ? geo.floors : geo.floors.filter((s) => s.floor === floor);
  const walls = floor === undefined ? geo.walls : geo.walls.filter((w) => w.floor === floor);
  const stairs =
    floor === undefined ? geo.stairs : geo.stairs.filter((s) => s.fromFloor === floor || s.toFloor === floor);

  return (
    <group name="layout-greybox">
      {slabs.map((slab, i) => (
        <SlabMesh key={i} slab={slab} color={c.floor} castShadow={castShadow} receiveShadow={receiveShadow} />
      ))}
      {walls.map((wall, i) => (
        <WallMesh key={i} wall={wall} color={c.wall} castShadow={castShadow} receiveShadow={receiveShadow} />
      ))}
      {stairs.map((run, i) => (
        <StairMesh key={i} run={run} color={c.stair} castShadow={castShadow} receiveShadow={receiveShadow} />
      ))}
    </group>
  );
}
