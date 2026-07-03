/**
 * Layout — authored multi-floor interior levels (stairs, open atriums).
 *
 * THREE-FREE: this module must never import three so it unit-tests without it
 * (see ./r3f.tsx for the thin greybox renderer that turns this into meshes).
 *
 * Spatial model: VOLUMES + PORTALS. A `LayoutDescriptor` is a JSON-serializable
 * list of floors, each holding a set of `Volume`s (rooms/halls as rects or
 * polys), plus a flat list of `Portal`s connecting them — doors (same floor),
 * stairs (adjacent floors), and voids (an atrium: a floor-above opening that
 * lets a lower volume see up through it). This is DATA-FIRST: a future
 * Crucible 2D-canvas editor authors this exact JSON; the kit only reads it.
 *
 * `validateLayout(d)` checks referential + geometric integrity (dangling refs,
 * portals that don't touch their volumes, spawn outside every volume, etc.).
 * `buildLayoutGeometry(d)` turns a valid descriptor into transform-ready
 * primitive arrays (floor slabs, wall segments, stair runs) — deterministic,
 * no THREE, ready for a renderer (r3f or otherwise) to instantiate meshes
 * from. `layoutBounds(d, floor)` derives a `BoundsConstraint`-compatible
 * clamp function (see ../camera/index.ts) so a GYRE-style player can walk a
 * floor and be kept inside its volumes, with pass-through at door gaps.
 *
 * `createLayoutLocomotion(d, opts)` extends `layoutBounds` across MULTIPLE
 * floors: a stateful walker whose `constrain(x, z)` is `layoutBounds`-
 * compatible but stair-aware (crossing a stair's far end transitions the
 * walker's current floor), plus `elevation()` (interpolated on stairs),
 * `floorIndex()`, and `volumeAt()` — the load-bearing piece for a player who
 * WALKS a multi-floor level (stairs, upper floors) rather than being
 * teleported between single-floor `layoutBounds` clamps.
 *
 * KIT OWNS GEOMETRY + COLLISION ONLY. Explicitly NOT built here (ROADMAP):
 *   - Navgrid derivation (a walkable graph baked from the volumes/portals for
 *     pathfinding NPCs) — layered on top of ../nav/index.ts later.
 *   - Spawn/door RUNTIME (trigger volumes, open/close state, locked doors) —
 *     a game-side concern; this module only describes door geometry + gaps.
 *   - Room-enter events (the game reacting to the player crossing a portal).
 *   - The Crucible 2D-canvas editor that authors/edits this JSON visually.
 *
 * POLY v1 NOTE: `Poly` shapes are accepted by the descriptor for future
 * authoring flexibility, but v1 geometry/bounds/validation treat a Poly as
 * its AXIS-ALIGNED BOUNDING RECT (the "rect hull"). Convexity is not
 * required. This keeps the rect-decomposition + bounds-clamp math simple and
 * correct for the common case (rectangular rooms); true poly clipping is a
 * later upgrade if/when the editor needs non-rectangular rooms.
 */

import type { PropObstacle } from './dressing.js';

// ── Descriptor (pure data, JSON-serializable) ───────────────────────────────

/** An axis-aligned rectangle footprint on the XZ plane. */
export interface Rect {
  type: 'rect';
  x: number;
  z: number;
  w: number;
  d: number;
}

/** A polygon footprint on the XZ plane. Treated as its rect hull in v1 (see module docs). */
export interface Poly {
  type: 'poly';
  points: Array<[number, number]>;
}

/** A volume's footprint — either an authored rect or a poly (rect-hulled in v1). */
export type Shape = Rect | Poly;

/** A room or hall — one enclosed footprint on a floor. */
export interface Volume {
  id: string;
  kind: 'room' | 'hall';
  shape: Shape;
}

/** One storey: a floor slab at `elevation` (world Y) with `height` ceiling clearance. */
export interface Floor {
  /** Floor slab Y (world units). */
  elevation: number;
  /** Ceiling clearance above `elevation` (world units). */
  height: number;
  volumes: Volume[];
}

/** Reference to a volume on a specific floor. */
export interface VolumeRef {
  floor: number;
  volume: string;
}

/** A door connecting two volumes on the SAME floor. */
export interface DoorPortal {
  type: 'door';
  a: VolumeRef;
  b: VolumeRef;
  at: [number, number];
  width: number;
}

/**
 * A stair connecting two volumes on ADJACENT floors. The run is a straight
 * flight from `foot` (in `from`'s floor plane) rising in direction `dir`
 * (radians, 0 = +X, increasing toward +Z) until it spans the elevation delta
 * between `from` and `to`; the head lands inside `to`.
 */
export interface StairPortal {
  type: 'stair';
  from: VolumeRef;
  to: VolumeRef;
  foot: [number, number];
  /** Run direction in radians (0 = +X axis, increasing toward +Z). */
  dir: number;
  width: number;
}

/**
 * An ATRIUM: cuts an opening in the floor slab of the volume ABOVE (`over`),
 * so the volume below is open to it. Stack `void` portals across floors for a
 * multi-floor atrium.
 */
export interface VoidPortal {
  type: 'void';
  over: VolumeRef;
  opening: Rect;
}

export type Portal = DoorPortal | StairPortal | VoidPortal;

/** The "area" seam — a named point a player can be sent to (see module docs). */
export interface NamedExit {
  name: string;
  floor: number;
  at: [number, number];
}

/** A full authored level: floors of volumes, connecting portals, a spawn, and named exits. */
export interface LayoutDescriptor {
  id: string;
  floors: Floor[];
  portals: Portal[];
  spawn: { floor: number; pos: [number, number] };
  exits?: NamedExit[];
}

// ── Shared "area" seam (world + layout both satisfy this later) ────────────

/**
 * The minimal contract BOTH `layout` (this module) and the future `world`
 * open-world module can satisfy: a spawn point, named exits, and outer
 * bounds. A game that doesn't care whether it's standing in an authored
 * interior or an open zone can code against this interface alone.
 */
export interface Area {
  spawn: { pos: [number, number] };
  exits: NamedExit[];
  /** Outer bounds of the area on the XZ plane (a loose AABB, not per-room). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

// ── Rect helpers ─────────────────────────────────────────────────────────────

/** Rect hull of a `Shape` — a `Rect` as-is, a `Poly` as its axis-aligned bounding rect. */
export function shapeRect(shape: Shape): Rect {
  if (shape.type === 'rect') return shape;
  const xs = shape.points.map((p) => p[0]);
  const zs = shape.points.map((p) => p[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minZ = Math.min(...zs);
  const maxZ = Math.max(...zs);
  return { type: 'rect', x: minX, z: minZ, w: maxX - minX, d: maxZ - minZ };
}

function rectContains(r: Rect, x: number, z: number, eps = 1e-6): boolean {
  return x >= r.x - eps && x <= r.x + r.w + eps && z >= r.z - eps && z <= r.z + r.d + eps;
}

function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.z < b.z + b.d && a.z + a.d > b.z;
}

/** Intersection of two rects, or null if they don't overlap (touching is not overlap). */
function rectIntersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const z0 = Math.max(a.z, b.z);
  const z1 = Math.min(a.z + a.d, b.z + b.d);
  if (x1 <= x0 || z1 <= z0) return null;
  return { type: 'rect', x: x0, z: z0, w: x1 - x0, d: z1 - z0 };
}

function rectArea(r: Rect): number {
  return Math.max(0, r.w) * Math.max(0, r.d);
}

// ── Lookups ──────────────────────────────────────────────────────────────────

function findVolume(d: LayoutDescriptor, ref: VolumeRef): Volume | undefined {
  return d.floors[ref.floor]?.volumes.find((v) => v.id === ref.volume);
}

function refLabel(ref: VolumeRef): string {
  return `floor ${ref.floor}/${ref.volume}`;
}

// ── Validation ───────────────────────────────────────────────────────────────

export type ValidationResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Validate a `LayoutDescriptor`'s referential + geometric integrity:
 *   - every volume id is unique within its floor; every floor index used by a
 *     portal/spawn/exit is in range
 *   - portal refs resolve to real volumes
 *   - door `at` lies on/inside BOTH connected volumes' rect hulls
 *   - stair `from`/`to` floors are adjacent (|Δfloor| === 1); `foot` lies
 *     inside `from`; the derived head (see {@link stairHead}) lies inside `to`
 *   - void `opening` lies inside its `over` volume's rect hull
 *   - spawn floor is in range and `pos` lies inside some volume on that floor
 * Returns `{ ok: true }` or `{ ok: false, errors }` with one message per
 * violation (does not stop at the first error — collects all of them).
 */
export function validateLayout(d: LayoutDescriptor): ValidationResult {
  const errors: string[] = [];

  // Duplicate volume ids (within a floor).
  d.floors.forEach((floor, fi) => {
    const seen = new Set<string>();
    for (const v of floor.volumes) {
      if (seen.has(v.id)) errors.push(`duplicate volume id "${v.id}" on floor ${fi}`);
      seen.add(v.id);
    }
  });

  // Duplicate top-level layout id is out of scope (single descriptor), but
  // duplicate portal identity isn't tracked (portals are unnamed) — skip.

  const checkRef = (ref: VolumeRef, where: string): Volume | undefined => {
    if (ref.floor < 0 || ref.floor >= d.floors.length) {
      errors.push(`${where}: floor ${ref.floor} out of range`);
      return undefined;
    }
    const vol = findVolume(d, ref);
    if (!vol) errors.push(`${where}: volume "${ref.volume}" not found on floor ${ref.floor}`);
    return vol;
  };

  d.portals.forEach((portal, pi) => {
    const where = `portal[${pi}] (${portal.type})`;
    if (portal.type === 'door') {
      const va = checkRef(portal.a, `${where}.a`);
      const vb = checkRef(portal.b, `${where}.b`);
      const [x, z] = portal.at;
      if (va && !rectContains(shapeRect(va.shape), x, z)) {
        errors.push(`${where}: at [${x}, ${z}] is outside volume ${refLabel(portal.a)}`);
      }
      if (vb && !rectContains(shapeRect(vb.shape), x, z)) {
        errors.push(`${where}: at [${x}, ${z}] is outside volume ${refLabel(portal.b)}`);
      }
    } else if (portal.type === 'stair') {
      const vFrom = checkRef(portal.from, `${where}.from`);
      const vTo = checkRef(portal.to, `${where}.to`);
      if (Math.abs(portal.from.floor - portal.to.floor) !== 1) {
        errors.push(`${where}: from/to floors must be adjacent (got ${portal.from.floor} -> ${portal.to.floor})`);
      }
      const [fx, fz] = portal.foot;
      if (vFrom && !rectContains(shapeRect(vFrom.shape), fx, fz)) {
        errors.push(`${where}: foot [${fx}, ${fz}] is outside volume ${refLabel(portal.from)}`);
      }
      if (vTo) {
        const [hx, hz] = stairHead(d, portal) ?? [NaN, NaN];
        if (!rectContains(shapeRect(vTo.shape), hx, hz)) {
          errors.push(`${where}: derived head [${hx.toFixed(2)}, ${hz.toFixed(2)}] is outside volume ${refLabel(portal.to)}`);
        }
      }
    } else {
      const vOver = checkRef(portal.over, `${where}.over`);
      if (vOver) {
        const overRect = shapeRect(vOver.shape);
        const corners: Array<[number, number]> = [
          [portal.opening.x, portal.opening.z],
          [portal.opening.x + portal.opening.w, portal.opening.z + portal.opening.d],
        ];
        for (const [x, z] of corners) {
          if (!rectContains(overRect, x, z)) {
            errors.push(`${where}: opening extends outside volume ${refLabel(portal.over)}`);
            break;
          }
        }
      }
    }
  });

  // Spawn.
  if (d.spawn.floor < 0 || d.spawn.floor >= d.floors.length) {
    errors.push(`spawn: floor ${d.spawn.floor} out of range`);
  } else {
    const [sx, sz] = d.spawn.pos;
    const inside = d.floors[d.spawn.floor]!.volumes.some((v) => rectContains(shapeRect(v.shape), sx, sz));
    if (!inside) errors.push(`spawn: pos [${sx}, ${sz}] is outside every volume on floor ${d.spawn.floor}`);
  }

  // Named exits.
  (d.exits ?? []).forEach((exit, ei) => {
    if (exit.floor < 0 || exit.floor >= d.floors.length) {
      errors.push(`exit[${ei}] "${exit.name}": floor ${exit.floor} out of range`);
    }
  });

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * The stair's landing point in `to`'s floor plane: `foot` translated by the
 * horizontal run implied by `dir` and the elevation delta (run length = |Δy|,
 * i.e. a 45°-equivalent flight — see module JSDoc on `buildStairRun` for the
 * actual step geometry). Null if either floor index is out of range.
 */
function stairHead(d: LayoutDescriptor, portal: StairPortal): [number, number] | null {
  const fromFloor = d.floors[portal.from.floor];
  const toFloor = d.floors[portal.to.floor];
  if (!fromFloor || !toFloor) return null;
  const rise = Math.abs(toFloor.elevation - fromFloor.elevation);
  const run = rise; // 1:1 horizontal run per vertical rise (documented in buildStairRun).
  const [fx, fz] = portal.foot;
  return [fx + Math.cos(portal.dir) * run, fz + Math.sin(portal.dir) * run];
}

// ── Geometry primitives ──────────────────────────────────────────────────────

/** A floor slab piece — one rect of a (possibly hole-punched) floor, at world Y `elevation`. */
export interface Slab {
  floor: number;
  elevation: number;
  rect: Rect;
}

/** A wall segment: a straight run along one side of a volume, floor-to-ceiling, with door gaps already cut out. */
export interface WallSeg {
  floor: number;
  volume: string;
  /** Segment endpoints on the XZ plane. */
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Wall base Y (== floor elevation) and height (== floor ceiling clearance). */
  elevation: number;
  height: number;
}

/** A stair run: N steps rising from `fromElevation` to `toElevation` along `dir`. */
export interface StairRun {
  fromFloor: number;
  toFloor: number;
  foot: [number, number];
  dir: number;
  width: number;
  fromElevation: number;
  toElevation: number;
  /** Step count (derived from the elevation delta; see {@link buildLayoutGeometry}). */
  steps: number;
  /** Per-step rise (world units). */
  stepRise: number;
  /** Per-step run (horizontal, world units). */
  stepRun: number;
}

export interface LayoutGeometry {
  floors: Slab[];
  walls: WallSeg[];
  stairs: StairRun[];
}

const STEP_RISE = 0.2; // world units per step (a comfortable ~20cm rise at 1 unit = 1 metre).

/**
 * Rect-decomposition: `base` minus a set of hole `rects`, emitted as a
 * deterministic list of non-overlapping rects covering exactly `base` area
 * minus the (base-clipped) holes. Uses a simple horizontal-strip sweep over
 * hole Z boundaries — good enough for the axis-aligned rects this module
 * deals in (v1 treats polys as their rect hull, so this is the ONLY
 * decomposition shape needed). Holes outside `base` are ignored; holes are
 * clipped to `base` first so overlapping/out-of-bounds openings don't produce
 * negative-area slivers.
 */
export function decomposeRect(base: Rect, holes: Rect[]): Rect[] {
  const clipped = holes
    .map((h) => rectIntersect(base, h))
    .filter((h): h is Rect => h !== null && rectArea(h) > 1e-9);

  if (clipped.length === 0) return [{ ...base }];

  // Z boundaries: base top/bottom + every hole's top/bottom, sorted + deduped.
  const zsSet = new Set<number>([base.z, base.z + base.d]);
  for (const h of clipped) {
    zsSet.add(h.z);
    zsSet.add(h.z + h.d);
  }
  const zs = [...zsSet].sort((a, b) => a - b);

  const out: Rect[] = [];
  for (let i = 0; i < zs.length - 1; i++) {
    const z0 = zs[i]!;
    const z1 = zs[i + 1]!;
    const zMid = (z0 + z1) / 2;
    if (z1 - z0 <= 1e-9) continue;

    // Holes covering this strip, sorted by X.
    const stripHoles = clipped
      .filter((h) => h.z <= zMid && h.z + h.d >= zMid)
      .sort((a, b) => a.x - b.x);

    let cursor = base.x;
    for (const h of stripHoles) {
      if (h.x > cursor + 1e-9) {
        out.push({ type: 'rect', x: cursor, z: z0, w: h.x - cursor, d: z1 - z0 });
      }
      cursor = Math.max(cursor, h.x + h.w);
    }
    const rightEdge = base.x + base.w;
    if (rightEdge > cursor + 1e-9) {
      out.push({ type: 'rect', x: cursor, z: z0, w: rightEdge - cursor, d: z1 - z0 });
    }
  }
  return out;
}

/** Door portals touching (floor, volume), each carrying its gap half-width + position. */
function doorGapsFor(d: LayoutDescriptor, floor: number, volumeId: string): Array<{ at: [number, number]; width: number }> {
  const gaps: Array<{ at: [number, number]; width: number }> = [];
  for (const p of d.portals) {
    if (p.type !== 'door') continue;
    if ((p.a.floor === floor && p.a.volume === volumeId) || (p.b.floor === floor && p.b.volume === volumeId)) {
      gaps.push({ at: p.at, width: p.width });
    }
  }
  return gaps;
}

/**
 * A door portal's gap footprint as a small square (`width x width`, centered
 * at `at`) — the SAME rect convention `./dressing.ts`'s `doorGapRect` and the
 * wall-building `splitSideAtGaps` use for a door's clear zone. Used by
 * `createLayoutLocomotion`'s `isDoorOpen` support to make a CLOSED door's gap
 * solid (see module docs on `createLayoutLocomotion`).
 */
function doorGapRect(portal: DoorPortal): Rect {
  const half = portal.width / 2;
  return { type: 'rect', x: portal.at[0] - half, z: portal.at[1] - half, w: portal.width, d: portal.width };
}

/**
 * Split ONE side (`x0,z0` -> `x1,z1`) of a volume's perimeter into wall
 * segments, cutting a gap of `width` centered at each door's `at` point that
 * projects onto this side (within half-width of the side's line and between
 * its endpoints). Deterministic: gaps are applied in ascending order along
 * the side's parametric length.
 */
function splitSideAtGaps(
  x0: number,
  z0: number,
  x1: number,
  z1: number,
  gaps: Array<{ at: [number, number]; width: number }>,
): Array<[number, number, number, number]> {
  const len = Math.hypot(x1 - x0, z1 - z0);
  if (len <= 1e-9) return [];
  const ux = (x1 - x0) / len;
  const uz = (z1 - z0) / len;

  // Project each gap onto this side; keep only those whose center lies within
  // [0, len] along the side and within a small perpendicular tolerance of it.
  type Cut = { t0: number; t1: number };
  const cuts: Cut[] = [];
  for (const g of gaps) {
    const dx = g.at[0] - x0;
    const dz = g.at[1] - z0;
    const t = dx * ux + dz * uz; // parametric position along the side
    const perp = Math.abs(dx * -uz + dz * ux); // perpendicular distance from the side's line
    if (perp > 0.05) continue; // not on this side
    const half = g.width / 2;
    const t0 = Math.max(0, t - half);
    const t1 = Math.min(len, t + half);
    if (t1 > t0) cuts.push({ t0, t1 });
  }
  cuts.sort((a, b) => a.t0 - b.t0);

  const segs: Array<[number, number, number, number]> = [];
  let cursor = 0;
  for (const c of cuts) {
    if (c.t0 > cursor + 1e-9) {
      segs.push([x0 + ux * cursor, z0 + uz * cursor, x0 + ux * c.t0, z0 + uz * c.t0]);
    }
    cursor = Math.max(cursor, c.t1);
  }
  if (len > cursor + 1e-9) {
    segs.push([x0 + ux * cursor, z0 + uz * cursor, x0 + ux * len, z0 + uz * len]);
  }
  return segs;
}

/** Wall segments tracing a volume's rect perimeter (4 sides), with door gaps cut. */
function buildVolumeWalls(d: LayoutDescriptor, floor: number, floorData: Floor, volume: Volume): WallSeg[] {
  const r = shapeRect(volume.shape);
  const gaps = doorGapsFor(d, floor, volume.id);
  const corners: Array<[number, number]> = [
    [r.x, r.z],
    [r.x + r.w, r.z],
    [r.x + r.w, r.z + r.d],
    [r.x, r.z + r.d],
  ];
  const walls: WallSeg[] = [];
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = corners[i]!;
    const [x1, z1] = corners[(i + 1) % 4]!;
    const segs = splitSideAtGaps(x0, z0, x1, z1, gaps);
    for (const [sx0, sz0, sx1, sz1] of segs) {
      walls.push({
        floor,
        volume: volume.id,
        x0: sx0,
        z0: sz0,
        x1: sx1,
        z1: sz1,
        elevation: floorData.elevation,
        height: floorData.height,
      });
    }
  }
  return walls;
}

/**
 * Build the floor slabs for one floor: each volume's rect hull, minus any
 * void openings whose `over` ref points at THIS (floor, volume) — i.e. this
 * floor's slab has a hole punched where a lower floor's atrium looks up
 * through it.
 */
function buildFloorSlabs(d: LayoutDescriptor, floor: number, floorData: Floor): Slab[] {
  const slabs: Slab[] = [];
  for (const volume of floorData.volumes) {
    const r = shapeRect(volume.shape);
    const holes = d.portals
      .filter((p): p is VoidPortal => p.type === 'void' && p.over.floor === floor && p.over.volume === volume.id)
      .map((p) => p.opening);
    const pieces = decomposeRect(r, holes);
    for (const piece of pieces) {
      slabs.push({ floor, elevation: floorData.elevation, rect: piece });
    }
  }
  return slabs;
}

/**
 * Build a stair run's step count from the elevation delta at a fixed
 * per-step rise ({@link STEP_RISE}, ~0.2 world units). `stepRun` matches the
 * 1:1 horizontal-run-per-rise convention {@link stairHead} uses to derive the
 * landing point, spread evenly over the step count (so the flight's total
 * horizontal run always equals the vertical rise, same as `stairHead`).
 */
function buildStairRun(d: LayoutDescriptor, portal: StairPortal): StairRun | null {
  const fromFloor = d.floors[portal.from.floor];
  const toFloor = d.floors[portal.to.floor];
  if (!fromFloor || !toFloor) return null;
  const fromElevation = fromFloor.elevation;
  const toElevation = toFloor.elevation;
  const rise = Math.abs(toElevation - fromElevation);
  const steps = Math.max(1, Math.round(rise / STEP_RISE));
  return {
    fromFloor: portal.from.floor,
    toFloor: portal.to.floor,
    foot: portal.foot,
    dir: portal.dir,
    width: portal.width,
    fromElevation,
    toElevation,
    steps,
    stepRise: rise / steps,
    stepRun: rise / steps, // 1:1 total run == rise, spread evenly (matches stairHead).
  };
}

/**
 * Build the deterministic geometry primitives for a valid `LayoutDescriptor`:
 * floor slabs (rect-decomposed around void openings), wall segments (with
 * door gaps cut), and stair runs. Pure + THREE-free — a renderer (see
 * ./r3f.tsx) turns these into meshes. Does NOT validate; call
 * {@link validateLayout} first if the descriptor's provenance is untrusted.
 */
export function buildLayoutGeometry(d: LayoutDescriptor): LayoutGeometry {
  const floors: Slab[] = [];
  const walls: WallSeg[] = [];
  const stairs: StairRun[] = [];

  d.floors.forEach((floorData, fi) => {
    floors.push(...buildFloorSlabs(d, fi, floorData));
    for (const volume of floorData.volumes) {
      walls.push(...buildVolumeWalls(d, fi, floorData, volume));
    }
  });

  for (const portal of d.portals) {
    if (portal.type !== 'stair') continue;
    const run = buildStairRun(d, portal);
    if (run) stairs.push(run);
  }

  return { floors, walls, stairs };
}

// ── Bounds (BoundsConstraint-compatible clamp) ──────────────────────────────

/** A `(x, z) => [x, z]` clamp, matching `BoundsConstraint` in ../camera/index.ts. */
export type LayoutBoundsFn = (x: number, z: number) => [number, number];

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function clampToRect(x: number, z: number, r: Rect): { x: number; z: number; dist: number } {
  const cx = clamp(x, r.x, r.x + r.w);
  const cz = clamp(z, r.z, r.z + r.d);
  return { x: cx, z: cz, dist: Math.hypot(x - cx, z - cz) };
}

/**
 * Push `(x, z)` — currently inside solid rect `r` — back OUT of it, biased
 * toward where the walker came from (`from`). For each axis on which `from`
 * already lay outside `r`, the pushed point is clamped to that same axis's
 * near boundary (the wall the walker would have hit first); if `from` was
 * inside `r` on both axes (degenerate — e.g. spawning inside a closed door),
 * falls back to clamping to the nearest edge overall, same spirit as {@link
 * clampToRect}.
 */
function pushOutOfRect(x: number, z: number, r: Rect, from: { x: number; z: number }): [number, number] {
  const fromOutsideX = from.x < r.x || from.x > r.x + r.w;
  const fromOutsideZ = from.z < r.z || from.z > r.z + r.d;

  if (fromOutsideX || fromOutsideZ) {
    let cx = x;
    let cz = z;
    if (fromOutsideX) cx = from.x < r.x ? r.x : r.x + r.w;
    if (fromOutsideZ) cz = from.z < r.z ? r.z : r.z + r.d;
    return [cx, cz];
  }

  // Degenerate: `from` was already inside r on both axes — clamp to the
  // single nearest edge (distance-minimal push-out).
  const distLeft = x - r.x;
  const distRight = r.x + r.w - x;
  const distTop = z - r.z;
  const distBottom = r.z + r.d - z;
  const min = Math.min(distLeft, distRight, distTop, distBottom);
  if (min === distLeft) return [r.x, z];
  if (min === distRight) return [r.x + r.w, z];
  if (min === distTop) return [x, r.z];
  return [x, r.z + r.d];
}

/**
 * Inset a void opening rect by `margin` on all sides (used by {@link
 * createLayoutLocomotion}'s `opts.voidMargin`) — degenerates to a zero-size
 * rect centered in the opening rather than going negative, same spirit as
 * `./dressing.ts`'s `insetRect`. `margin` is assumed already clamped to >= 0
 * by the caller.
 */
function insetRectClampedToOpening(r: Rect, margin: number): Rect {
  const w = Math.max(0, r.w - margin * 2);
  const d = Math.max(0, r.d - margin * 2);
  const x = r.w - margin * 2 >= 0 ? r.x + margin : r.x + r.w / 2;
  const z = r.d - margin * 2 >= 0 ? r.z + margin : r.z + r.d / 2;
  return { type: 'rect', x, z, w, d };
}

/**
 * Derive a `BoundsConstraint`-compatible clamp for one floor of a layout: the
 * point is kept inside the UNION of that floor's volume rects (rect hulls in
 * v1), allowing free pass-through across door gaps (a point already near a
 * door's opening is not pushed back just for straddling two rects). If the
 * point starts inside any volume, it's left alone (mid-room movement is
 * always free); otherwise it's clamped to the closest volume's rect — which
 * also naturally lets a player walk straight through a door gap between two
 * adjacent rects, since both rects individually admit the doorway's width.
 */
export function layoutBounds(d: LayoutDescriptor, floor: number): LayoutBoundsFn {
  const floorData = d.floors[floor];
  const rects = (floorData?.volumes ?? []).map((v) => shapeRect(v.shape));

  return (x: number, z: number): [number, number] => {
    if (rects.length === 0) return [x, z];

    // Already inside some volume — free movement (this is what makes crossing
    // a door gap work: at the gap, x/z lies inside BOTH adjoining rects since
    // door `at` is required (by validateLayout) to be inside both).
    for (const r of rects) {
      if (rectContains(r, x, z, 0)) return [x, z];
    }

    // Outside every volume — clamp to the nearest rect's boundary.
    let best = clampToRect(x, z, rects[0]!);
    for (let i = 1; i < rects.length; i++) {
      const cand = clampToRect(x, z, rects[i]!);
      if (cand.dist < best.dist) best = cand;
    }
    return [best.x, best.z];
  };
}

// ── Locomotion (floor-aware walking: elevation, stair transitions) ─────────

/**
 * One stair portal's run geometry in a form the locomotion walker can project
 * a point onto: `foot` + unit direction `(ux, uz)`, `run` (== `stepRun` total,
 * matching {@link stairHead}'s 1:1 rise/run convention), and `width`. `lowFloor`
 * is whichever of `from`/`to` has the smaller elevation (the stair always
 * "rises" from `lowFloor` to `highFloor` regardless of portal authoring order).
 */
interface StairSpan {
  lowFloor: number;
  highFloor: number;
  lowElevation: number;
  highElevation: number;
  /** True if `from` is the low floor (so `foot` sits at the low end); false if `to` is. */
  footAtLow: boolean;
  foot: [number, number];
  ux: number;
  uz: number;
  run: number;
  halfWidth: number;
}

function buildStairSpan(d: LayoutDescriptor, portal: StairPortal): StairSpan | null {
  const fromFloor = d.floors[portal.from.floor];
  const toFloor = d.floors[portal.to.floor];
  if (!fromFloor || !toFloor) return null;
  const rise = Math.abs(toFloor.elevation - fromFloor.elevation);
  const footAtLow = fromFloor.elevation <= toFloor.elevation;
  const lowFloor = footAtLow ? portal.from.floor : portal.to.floor;
  const highFloor = footAtLow ? portal.to.floor : portal.from.floor;
  const lowElevation = footAtLow ? fromFloor.elevation : toFloor.elevation;
  const highElevation = footAtLow ? toFloor.elevation : fromFloor.elevation;
  return {
    lowFloor,
    highFloor,
    lowElevation,
    highElevation,
    footAtLow,
    foot: portal.foot,
    ux: Math.cos(portal.dir),
    uz: Math.sin(portal.dir),
    run: rise,
    halfWidth: portal.width / 2,
  };
}

/**
 * Project `(x, z)` onto a stair span's centerline: `t` is the along-run
 * distance from `foot` (0 at the foot, `run` at the head), `sperp` is the
 * SIGNED perpendicular offset from the centerline (positive toward the
 * `(-uz, ux)` normal). Signed so the walker's lateral position on the stair
 * can be preserved and clamped, not collapsed to the centerline.
 */
function projectOntoSpan(span: StairSpan, x: number, z: number): { t: number; sperp: number } {
  const dx = x - span.foot[0];
  const dz = z - span.foot[1];
  const t = dx * span.ux + dz * span.uz;
  const sperp = dx * -span.uz + dz * span.ux;
  return { t, sperp };
}

/** Reconstruct the world point at along-run `t` + signed lateral `sperp` on a span. */
function spanPoint(span: StairSpan, t: number, sperp: number): [number, number] {
  return [span.foot[0] + span.ux * t + -span.uz * sperp, span.foot[1] + span.uz * t + span.ux * sperp];
}

const STAIR_EPS = 1e-6;

/**
 * How far (world units) from a stair's low/high END the band is boardable —
 * and, symmetrically, how far from the end a boarded walker may step off
 * SIDEWAYS freely (the region where the stair surface is within a step of
 * the adjacent floor, so there is no cliff). Everywhere else along the run
 * the band's sides are WALLS — see the "rails + end-only entry" note on
 * {@link createLayoutLocomotion}.
 */
const STAIR_ENTRY_ZONE = 0.6;
/** How far outside the band's half-width a side push-out lands the walker. */
const STAIR_SIDE_MARGIN = 0.05;

/** Ground elevation at along-run progress `t` (clamped to the span), interpolated low→high. */
function elevationAtT(span: StairSpan, t: number): number {
  const clamped = clamp(t, 0, span.run);
  const frac = span.run > STAIR_EPS ? clamped / span.run : 0;
  return span.lowElevation + frac * (span.highElevation - span.lowElevation);
}

/** Which named volume (if any) on `floor` contains `(x, z)`, by rect-hull containment. */
function volumeAtPoint(d: LayoutDescriptor, floor: number, x: number, z: number): string | null {
  const floorData = d.floors[floor];
  if (!floorData) return null;
  for (const v of floorData.volumes) {
    if (rectContains(shapeRect(v.shape), x, z)) return v.id;
  }
  return null;
}

/** A stateful, floor-aware walker over a `LayoutDescriptor`. See {@link createLayoutLocomotion}. */
export interface LayoutLocomotion {
  /**
   * Constrain a proposed `(x, z)` move: 2D-clamps into the CURRENT floor's
   * volumes (door pass-through, same as {@link layoutBounds}), extended with
   * stair awareness — a stair is BOARDED at its ends only (low floor at the
   * foot, high floor at the head, each within {@link STAIR_ENTRY_ZONE});
   * while boarded, movement along the run is free (not clamped to either
   * floor's rect), the sides are rails (lateral position preserved, clamped
   * to the band), and reaching/crossing the far end transitions the walker's
   * current floor. Mid-run, the band is SOLID from the outside: the
   * staircase mass blocks the low floor, and the slab opening's implicit
   * rail blocks the high floor. Also excludes any void-portal opening that
   * cuts the CURRENT floor's slab — a walker on that floor is clamped at the
   * opening's edge (the implicit atrium railing; see `opts.voidMargin`)
   * rather than being allowed to walk out over the hole; a walker on the
   * floor BELOW the opening is unaffected. Mutates internal state (current
   * floor + boarding); returns the corrected `[x, z]`.
   */
  constrain(x: number, z: number): [number, number];
  /**
   * Ground Y at the walker's last `constrain`ed position: the current floor's
   * elevation normally, or a linear interpolation between the two floors'
   * elevations by progress along the run while on a stair.
   */
  elevation(): number;
  /** The floor index the walker currently occupies (transitions on full stair traversal). */
  floorIndex(): number;
  /** The named volume the walker's last position lies in, or null between/outside volumes. */
  volumeAt(): { floor: number; volume: string } | null;
}

/**
 * Create a stateful walker over `d`: 2D bounds clamping (like {@link
 * layoutBounds}) EXTENDED with stair traversal — walking onto a stair's
 * footprint lets the walker move along its run past either floor's rect
 * boundary; crossing the stair's far end (the same 1:1 rise/run convention
 * {@link buildStairRun}/`stairHead` use) transitions the walker's current
 * floor. `elevation()` interpolates linearly along the run while on a stair.
 *
 * TRANSITION RULE (no hysteresis needed — the rule is naturally stable): the
 * walker's current floor is whichever of the stair's two floors its along-run
 * progress `t` has most recently reached — `t <= 0` -> low floor, `t >= run`
 * -> high floor, and anywhere strictly between the two ends leaves the
 * CURRENT floor unchanged (so lingering mid-stair never flip-flops; only
 * fully reaching one end or the other can change floors). Walking back down
 * reverses the same way once `t` returns to 0.
 *
 * RAILS + END-ONLY ENTRY (real consumer regression #4 — the phone playtest
 * that finally made stairs feel like stairs): the stair band used to be
 * enterable and exitable ANYWHERE along its length, in any direction, and
 * every admitted point was snapped to the centerline. Three cliffs fell out
 * of that omnidirectional footprint, all caught on-device in the school:
 * drifting sideways mid-climb dumped the walker off the open side of the
 * flight (elevation 1.8 -> 0 in one frame); a high-floor walker cutting
 * laterally across the slab opening was captured mid-run and teleported
 * DOWN it (3.6 -> 1.5, plus a 1m yank to the centerline); and a low-floor
 * walker cutting across the band was teleported ON TOP of the staircase
 * mass (0 -> 2.5). The model is now the real-building one:
 *   - A stair is BOARDED only through an end zone ({@link STAIR_ENTRY_ZONE}):
 *     the foot from the low floor, the head from the high floor.
 *   - While boarded (tracked by the internal `boarded` state), the sides are
 *     RAILS: the lateral offset is preserved (never centerline-snapped) and
 *     clamped to the band; only within an end zone — where the stair surface
 *     is within a step of the adjacent floor, so there is no cliff — may the
 *     walker step off sideways.
 *   - NOT boarded, the mid-run band is SOLID from the side on BOTH floors
 *     (low: the staircase mass; high: the opening's implicit rail — the
 *     stair-shaped sibling of the void clamp), pushing the walker out the
 *     way they came.
 *   - Walking off an END transitions the floor and releases the boarding —
 *     including a per-frame step that lands PAST the end in a single call
 *     (nothing requires step size to divide `run` evenly; this subsumes the
 *     old one-shot "overshoot bridge"). The one asymmetry that keeps old
 *     regression #3 dead: a walker parked AT one end whose next point
 *     projects beyond the OPPOSITE end did not traverse anything — that
 *     step releases the boarding on the CURRENT floor, without a
 *     transition (you cannot cross a whole flight in a step you didn't
 *     climb).
 * End-only entry is also what structurally retires regressions #2/#3 (the
 * unrelated-door false captures along the stair's infinite centerline):
 * points far outside both end zones can never board, no matter what lateral
 * band they graze.
 *
 * Deterministic + no wall-clock: state (current floor + boarding) changes
 * ONLY inside `constrain()`, driven purely by the `(x, z)` passed in.
 */
export function createLayoutLocomotion(
  d: LayoutDescriptor,
  opts?: {
    startFloor?: number;
    /**
     * Runtime door-open state: called with each `DoorPortal` and its index
     * into `d.portals` (stable identity for the caller to key state by).
     * Absent (the default) means every door is always passable — BYTE-
     * IDENTICAL to this option not existing at all (today's behavior).
     * When provided and it returns `false` for a door, that door's gap
     * footprint (the same `width x width` square centered at `at` that
     * `./dressing.ts` and the wall-building gap-cutting use — see {@link
     * doorGapRect}) becomes SOLID: `constrain()` clamps the walker OUT of it
     * instead of allowing pass-through. Checked fresh on every `constrain()`
     * call (no caching), so flipping the getter's result open/opens/closes
     * the door immediately on the walker's next move — no separate "door
     * state changed" notification needed.
     */
    isDoorOpen?: (portal: DoorPortal, index: number) => boolean;
    /**
     * Extra inset (world units) applied to each void-portal opening before
     * it's treated as solid for locomotion (see {@link voidExclusionsFor}).
     * Default 0 — the walker clamps flush at the opening's authored edge
     * (the implicit railing sits exactly on the hole). A positive margin
     * keeps the walker back from the edge by that much; negative margins are
     * clamped to 0 (never grows the hole).
     */
    voidMargin?: number;
    /**
     * Solid prop footprints (from `./dressing.js`'s {@link propObstacles} —
     * lockers, desks, anything BIG): each rect is solid for a walker on its
     * floor, pushed out of exactly like a closed door's gap, composing with
     * walls/doors/voids. Static for the walker's lifetime (precomputed per
     * floor) — rebuild the walker if the dressing changes. Never applies
     * while riding a stair (dressing never places props on stair
     * footprints, so there is nothing to hit mid-flight).
     */
    obstacles?: readonly PropObstacle[];
  },
): LayoutLocomotion {
  let currentFloor = opts?.startFloor ?? d.spawn.floor;
  const isDoorOpen = opts?.isDoorOpen;
  const voidMargin = Math.max(0, opts?.voidMargin ?? 0);

  const stairSpans: StairSpan[] = [];
  for (const portal of d.portals) {
    if (portal.type !== 'stair') continue;
    const span = buildStairSpan(d, portal);
    if (span) stairSpans.push(span);
  }

  // Door portals, each with its stable `d.portals` index (passed to
  // `isDoorOpen`) and its gap rect (see {@link doorGapRect}) — precomputed
  // once since the geometry is static; only openness is checked per-call.
  const doorPortals: Array<{ portal: DoorPortal; index: number; rect: Rect }> = [];
  d.portals.forEach((portal, index) => {
    if (portal.type !== 'door') return;
    doorPortals.push({ portal, index, rect: doorGapRect(portal) });
  });

  // Void-portal openings, grouped by the floor whose slab they cut (the
  // `over` volume's floor — see module docs on `VoidPortal`). A walker on
  // that SAME floor must be excluded from the opening (it's a hole in the
  // slab they're standing on); a walker on the floor BELOW is unaffected —
  // they're standing on solid ground looking UP through the atrium, not on
  // the cut slab (mirrors `dressing.ts`'s `voidOpeningsFor`, which excludes
  // props from the same (floor, volume) only).
  const voidRectsByFloor = new Map<number, Rect[]>();
  for (const portal of d.portals) {
    if (portal.type !== 'void') continue;
    const floor = portal.over.floor;
    const rect = voidMargin > 0 ? insetRectClampedToOpening(portal.opening, voidMargin) : portal.opening;
    const list = voidRectsByFloor.get(floor);
    if (list) list.push(rect);
    else voidRectsByFloor.set(floor, [rect]);
  }

  // Solid prop footprints, grouped by floor (see `opts.obstacles`).
  const obstacleRectsByFloor = new Map<number, Rect[]>();
  for (const ob of opts?.obstacles ?? []) {
    if (ob.rect.w <= 0 || ob.rect.d <= 0) continue;
    const list = obstacleRectsByFloor.get(ob.floor);
    if (list) list.push(ob.rect);
    else obstacleRectsByFloor.set(ob.floor, [ob.rect]);
  }

  let lastX = d.spawn.pos[0];
  let lastZ = d.spawn.pos[1];
  let lastElevation = d.floors[currentFloor]?.elevation ?? 0;
  // Which stair span (index into `stairSpans`) the walker is currently
  // RIDING, and its clamped along-run progress `t` as of the last
  // `constrain()` call — `null` when on plain floor. Boarding happens ONLY
  // through an end zone (see the "rails + end-only entry" note on
  // {@link createLayoutLocomotion}); it's released by walking off an end or
  // by a sideways step within an end zone. The stored `t` is what lets the
  // off-the-end rule tell a genuine traversal (mid-run -> beyond an end,
  // including a single-call overshoot) from a parked-at-one-end walker
  // whose next point projects beyond the OPPOSITE end (a jump that climbed
  // nothing and must not transition — the ghost of regression #3).
  let boarded: { index: number; t: number } | null = null;

  /**
   * If `isDoorOpen` is provided and `(x, z)` lands inside a CLOSED door's
   * gap footprint on `floor`, push it back out (biased toward `lastX/lastZ`
   * — see {@link pushOutOfRect}) so the door is solid. Otherwise returns
   * `(x, z)` unchanged. Applied as a final pass after the stair/room clamp
   * above has already produced a candidate point, so closed-door blocking
   * composes with (rather than replaces) the existing pass-through-at-open-
   * doors and stair-traversal logic — including doors that sit on a
   * stairwell room's perimeter.
   */
  function blockClosedDoors(x: number, z: number, floor: number): [number, number] {
    if (!isDoorOpen) return [x, z];
    let cx = x;
    let cz = z;
    for (const { portal, index, rect } of doorPortals) {
      if (portal.a.floor !== floor && portal.b.floor !== floor) continue;
      if (isDoorOpen(portal, index)) continue;
      if (!rectContains(rect, cx, cz, 0)) continue;
      [cx, cz] = pushOutOfRect(cx, cz, rect, { x: lastX, z: lastZ });
    }
    return [cx, cz];
  }

  /**
   * If `(x, z)` lands inside a void-portal opening that cuts `floor`'s slab
   * (the opening's `over.floor`), push it back out (biased toward
   * `lastX/lastZ` — see {@link pushOutOfRect}) so the hole is solid — the
   * implicit railing at the atrium edge. A floor BELOW the opening (looking
   * UP through it) is unaffected: `voidRectsByFloor` is keyed by the CUT
   * floor only, same as `dressing.ts`'s `voidOpeningsFor`. Applied as a
   * final pass alongside {@link blockClosedDoors}, after the stair/room
   * clamp has already produced a candidate point.
   */
  function blockVoidOpenings(x: number, z: number, floor: number): [number, number] {
    const rects = voidRectsByFloor.get(floor);
    if (!rects) return [x, z];
    let cx = x;
    let cz = z;
    for (const rect of rects) {
      if (rect.w <= 0 || rect.d <= 0) continue; // degenerate (fully margined-away) — nothing to exclude
      if (!rectContains(rect, cx, cz, 0)) continue;
      [cx, cz] = pushOutOfRect(cx, cz, rect, { x: lastX, z: lastZ });
    }
    return [cx, cz];
  }

  /**
   * If `(x, z)` lands inside a solid prop's footprint on `floor` (see
   * `opts.obstacles`), push it back out (biased toward `lastX/lastZ`) —
   * lockers and desks are furniture, not fog. Same final-pass composition
   * as {@link blockClosedDoors} / {@link blockVoidOpenings}.
   */
  function blockObstacles(x: number, z: number, floor: number): [number, number] {
    const rects = obstacleRectsByFloor.get(floor);
    if (!rects) return [x, z];
    let cx = x;
    let cz = z;
    for (const rect of rects) {
      if (!rectContains(rect, cx, cz, 0)) continue;
      [cx, cz] = pushOutOfRect(cx, cz, rect, { x: lastX, z: lastZ });
    }
    return [cx, cz];
  }

  /**
   * Place the walker ON `span` at clamped `(t, sperp)`: fires the end
   * transitions, composes the closed-door pass, records position/elevation,
   * and keeps the boarding latched. Shared by the boarded-continuation path
   * and end-zone boarding — the ONLY two ways onto a stair.
   */
  function rideSpan(span: StairSpan, index: number, t: number, sperp: number): [number, number] {
    const ct = clamp(t, 0, span.run);
    const cs = clamp(sperp, -span.halfWidth, span.halfWidth);
    // Transition rule: reaching either end moves the walker onto that end's
    // floor; strictly between the ends, the CURRENT floor is kept (no
    // flip-flopping while mid-flight).
    if (t <= STAIR_EPS) {
      currentFloor = span.lowFloor;
    } else if (t >= span.run - STAIR_EPS) {
      currentFloor = span.highFloor;
    }
    let [cx, cz] = spanPoint(span, ct, cs);
    [cx, cz] = blockClosedDoors(cx, cz, currentFloor);
    lastX = cx;
    lastZ = cz;
    lastElevation = elevationAtT(span, ct);
    boarded = { index, t: ct };
    return [cx, cz];
  }

  return {
    constrain(x: number, z: number): [number, number] {
      // ── Boarded continuation: the walker is riding a stair. ──────────────
      if (boarded !== null) {
        const span = stairSpans[boarded.index]!;
        const lastT = boarded.t;
        const { t, sperp } = projectOntoSpan(span, x, z);

        if (t < -STAIR_EPS) {
          // Walked off past the FOOT. A genuine descent (anything short of
          // being parked at the head) transitions to the low floor — a
          // single-call overshoot included. From parked AT the head, a point
          // beyond the foot climbed nothing (regression #3's ghost): release
          // on the current floor, no transition.
          if (lastT < span.run - STAIR_EPS) currentFloor = span.lowFloor;
          boarded = null; // fall through to the room clamp below
        } else if (t > span.run + STAIR_EPS) {
          // Mirror: walked off past the HEAD; parked-at-the-foot jumps don't count.
          if (lastT > STAIR_EPS) currentFloor = span.highFloor;
          boarded = null; // fall through
        } else {
          // Still within the run. Within an END ZONE the stair surface is a
          // step or less from the adjacent floor — a sideways exit there is
          // harmless, so beyond-the-band lateral movement releases the
          // boarding. Mid-run, the sides are RAILS: lateral offset preserved
          // but clamped to the band (this is what removed the "fell off the
          // open side of the flight" cliff).
          const inEndZone =
            (currentFloor === span.lowFloor && t <= STAIR_ENTRY_ZONE) ||
            (currentFloor === span.highFloor && t >= span.run - STAIR_ENTRY_ZONE);
          if (inEndZone && Math.abs(sperp) > span.halfWidth + STAIR_EPS) {
            boarded = null; // step off sideways at the end — fall through
          } else {
            return rideSpan(span, boarded.index, t, sperp);
          }
        }
      }

      // ── Plain-floor movement: end-zone boarding + solid mid-run bands. ───
      // Stairs touching the CURRENT floor can (a) board the walker through
      // the appropriate end zone, or (b) block them: mid-run the band is
      // solid from the side on BOTH floors (low: the staircase mass; high:
      // the slab opening's implicit rail). See the "rails + end-only entry"
      // note on createLayoutLocomotion.
      let tx = x;
      let tz = z;
      for (let index = 0; index < stairSpans.length; index++) {
        const span = stairSpans[index]!;
        if (span.lowFloor !== currentFloor && span.highFloor !== currentFloor) continue;
        const { t, sperp } = projectOntoSpan(span, tx, tz);
        const perp = Math.abs(sperp);
        const lowSide = currentFloor === span.lowFloor;

        const inEntryZone = lowSide
          ? t >= -STAIR_EPS && t <= STAIR_ENTRY_ZONE
          : t >= span.run - STAIR_ENTRY_ZONE && t <= span.run + STAIR_EPS;
        if (inEntryZone && perp <= span.halfWidth + STAIR_EPS) {
          return rideSpan(span, index, t, sperp);
        }

        // Solid mid-run band (everything boardable-from-this-floor is NOT):
        // push out laterally, biased to the side the walker came from.
        const inSolidRange = lowSide
          ? t > STAIR_ENTRY_ZONE && t <= span.run + STAIR_EPS
          : t >= -STAIR_EPS && t < span.run - STAIR_ENTRY_ZONE;
        if (inSolidRange && perp < span.halfWidth + STAIR_SIDE_MARGIN) {
          const lastSperp = projectOntoSpan(span, lastX, lastZ).sperp;
          const side =
            Math.abs(lastSperp) > STAIR_EPS ? Math.sign(lastSperp) : sperp >= 0 ? 1 : -1;
          [tx, tz] = spanPoint(span, t, side * (span.halfWidth + STAIR_SIDE_MARGIN));
        }
      }

      // Fall back to the plain per-floor rect clamp (identical behavior to
      // layoutBounds), composed with door/void solidity.
      boarded = null;
      const bounds = layoutBounds(d, currentFloor);
      let [cx, cz] = bounds(tx, tz);
      [cx, cz] = blockClosedDoors(cx, cz, currentFloor);
      [cx, cz] = blockVoidOpenings(cx, cz, currentFloor);
      [cx, cz] = blockObstacles(cx, cz, currentFloor);
      lastX = cx;
      lastZ = cz;
      lastElevation = d.floors[currentFloor]?.elevation ?? 0;
      return [cx, cz];
    },

    elevation(): number {
      return lastElevation;
    },

    floorIndex(): number {
      return currentFloor;
    },

    volumeAt(): { floor: number; volume: string } | null {
      const volume = volumeAtPoint(d, currentFloor, lastX, lastZ);
      return volume ? { floor: currentFloor, volume } : null;
    },
  };
}

/**
 * Derive the {@link Area} seam for a layout: spawn + named exits + a loose
 * outer AABB across every floor's volumes (union, not per-floor — the
 * caller picks which floor's `layoutBounds` to enforce at runtime).
 */
export function layoutArea(d: LayoutDescriptor): Area {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const floorData of d.floors) {
    for (const v of floorData.volumes) {
      const r = shapeRect(v.shape);
      minX = Math.min(minX, r.x);
      maxX = Math.max(maxX, r.x + r.w);
      minZ = Math.min(minZ, r.z);
      maxZ = Math.max(maxZ, r.z + r.d);
    }
  }
  if (!isFinite(minX)) {
    minX = maxX = minZ = maxZ = 0;
  }
  return {
    spawn: { pos: d.spawn.pos },
    exits: d.exits ?? [],
    bounds: { minX, maxX, minZ, maxZ },
  };
}

// ── Dressing (deterministic prop placement — see ./dressing.ts) ────────────
export * from './dressing.js';
