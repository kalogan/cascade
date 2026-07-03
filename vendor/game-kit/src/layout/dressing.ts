/**
 * Dressing — deterministic prop PLACEMENT over a `LayoutDescriptor`.
 *
 * THREE-FREE: this module must never import three so it unit-tests without it.
 *
 * The kit owns the pure placement ENGINE only: `DressingRule`s (grid /
 * wallLine / anchor / scatter) resolved against a layout's volumes into a
 * flat list of `PropPlacement`s (kind + position + yaw + which volume). The
 * GAME supplies the actual prop meshes/prefabs for each `kind` — this module
 * never touches geometry or rendering (see ./r3f.tsx for the layout
 * greybox renderer, which is a separate, later concern for dressing too).
 *
 * Deterministic: `dressLayout(d, rules, seed)` uses `createRng` (see
 * ../prng/index.ts) so the same descriptor + rules + seed always produces the
 * IDENTICAL placement list, in stable order (rules in authored order; within
 * a rule, row-major / wall-order / scatter-draw order).
 *
 * SAFETY: every placement is clamped inside its volume's rect (minus a
 * margin) and never lands inside a door-gap footprint, a stair footprint, or
 * a void-portal opening on that floor — the same exclusion geometry
 * `buildLayoutGeometry` uses for wall gaps and floor-slab holes (see
 * ../layout/index.ts), ported here rather than re-derived so both stay in
 * sync.
 */

import type { Floor, LayoutDescriptor, Rect, Volume, VolumeRef } from './index.js';
import { shapeRect } from './index.js';
import { createRng, hashStringToSeed, type Rng } from '../prng/index.js';

// ── Placement ────────────────────────────────────────────────────────────────

/** One placed prop: a kind (the game resolves this to a mesh/prefab), a world position, and a facing yaw (radians, 0 = +X, increasing toward +Z — same convention as `StairPortal.dir`). */
export interface PropPlacement {
  kind: string;
  pos: [number, number, number];
  yaw: number;
  volume: VolumeRef;
}

/** Which side of a volume's rect a wall/anchor rule refers to. */
export type WallSide = 'north' | 'south' | 'east' | 'west';

const ALL_SIDES: WallSide[] = ['north', 'south', 'east', 'west'];

// ── Rules ────────────────────────────────────────────────────────────────────

/** Matches a rule to volumes: by volume `kind` and/or an id pattern (substring or RegExp against the volume id). */
export interface DressingMatch {
  kind?: 'room' | 'hall';
  /** Volume-id filter: a substring match, or a RegExp tested against the id. */
  id?: string | RegExp;
}

interface RuleBase {
  match: DressingMatch;
}

/** Rows x cols of a prop kind filling the volume's rect, all facing one direction. */
export interface GridRule extends RuleBase {
  type: 'grid';
  propKind: string;
  rows: number;
  cols: number;
  /** Inset from the volume's rect edges (world units). */
  margin?: number;
  /** Facing yaw (radians) OR a named wall the grid faces (e.g. desks facing the board wall). */
  facing: number | WallSide;
  /** Deterministic small positional jitter (world units, +/- jitter/2) so grids aren't robotic. */
  jitter?: number;
}

/** Props along one or more walls, spacing-driven, respecting door gaps + stair/void footprints. */
export interface WallLineRule extends RuleBase {
  type: 'wallLine';
  propKind: string;
  walls: 'all' | WallSide[];
  /** Center-to-center spacing along the wall (world units). */
  spacing: number;
  /** Offset from the wall inward (world units) — how far the prop sits off the wall line. */
  offset?: number;
  /** Inset from the wall's corners before placing the first/last prop (world units). */
  margin?: number;
}

/** A single prop at a named position: the volume center, a wall's center, or an explicit offset. */
export interface AnchorRule extends RuleBase {
  type: 'anchor';
  propKind: string;
  at: { type: 'center' } | { type: 'wall'; side: WallSide } | { type: 'offset'; x: number; z: number };
  /** Mount flush to the wall (wall's yaw + inward offset near-zero) — for boards/windows. Ignored for 'center'/'offset'. */
  mount?: 'floor' | 'wall';
  /** Extra elevation above the floor (world units) — e.g. a wall-mounted board at chest height. */
  elevationOffset?: number;
  /** Explicit yaw override (radians). Defaults: wall-facing for `mount: 'wall'`/`at.type === 'wall'`, 0 otherwise. */
  yaw?: number;
}

/** N seeded scatter placements inside the rect with a minimum pairwise distance. */
export interface ScatterRule extends RuleBase {
  type: 'scatter';
  propKind: string;
  count: number;
  minDistance: number;
  margin?: number;
  /** Cap on placement attempts per prop before giving up (avoids infinite loops in a packed volume). Default 40. */
  maxAttempts?: number;
}

export type DressingRule = GridRule | WallLineRule | AnchorRule | ScatterRule;

// ── Exclusion geometry (ported from buildLayoutGeometry / layout core) ─────

interface DoorGap {
  at: [number, number];
  width: number;
}

/** Door portals touching (floor, volumeId) — same lookup `doorGapsFor` in ./index.ts does internally. */
function doorGapsFor(d: LayoutDescriptor, floor: number, volumeId: string): DoorGap[] {
  const gaps: DoorGap[] = [];
  for (const p of d.portals) {
    if (p.type !== 'door') continue;
    if ((p.a.floor === floor && p.a.volume === volumeId) || (p.b.floor === floor && p.b.volume === volumeId)) {
      gaps.push({ at: p.at, width: p.width });
    }
  }
  return gaps;
}

/** A door gap footprint as a small square (width x width, centered at `at`) — enough to keep a prop clear of the doorway on either side of the wall. */
function doorGapRect(gap: DoorGap): Rect {
  const half = gap.width / 2;
  return { type: 'rect', x: gap.at[0] - half, z: gap.at[1] - half, w: gap.width, d: gap.width };
}

/** Stair footprints (foot rect ∪ head rect, generously the run's bounding box) touching (floor, volumeId), as exclusion rects on that floor's plane. */
function stairFootprintsFor(d: LayoutDescriptor, floor: number, volumeId: string): Rect[] {
  const rects: Rect[] = [];
  for (const p of d.portals) {
    if (p.type !== 'stair') continue;
    const touchesFrom = p.from.floor === floor && p.from.volume === volumeId;
    const touchesTo = p.to.floor === floor && p.to.volume === volumeId;
    if (!touchesFrom && !touchesTo) continue;
    const fromFloor = d.floors[p.from.floor];
    const toFloor = d.floors[p.to.floor];
    if (!fromFloor || !toFloor) continue;
    const rise = Math.abs(toFloor.elevation - fromFloor.elevation);
    const run = rise; // matches stairHead's 1:1 rise/run convention in ./index.ts
    const [fx, fz] = p.foot;
    const hx = fx + Math.cos(p.dir) * run;
    const hz = fz + Math.sin(p.dir) * run;
    const half = p.width / 2;
    const minX = Math.min(fx, hx) - half;
    const maxX = Math.max(fx, hx) + half;
    const minZ = Math.min(fz, hz) - half;
    const maxZ = Math.max(fz, hz) + half;
    rects.push({ type: 'rect', x: minX, z: minZ, w: maxX - minX, d: maxZ - minZ });
  }
  return rects;
}

/** Void-portal openings that punch a hole in THIS (floor, volumeId)'s slab — nothing should float over the atrium hole. */
function voidOpeningsFor(d: LayoutDescriptor, floor: number, volumeId: string): Rect[] {
  const rects: Rect[] = [];
  for (const p of d.portals) {
    if (p.type !== 'void') continue;
    if (p.over.floor === floor && p.over.volume === volumeId) rects.push(p.opening);
  }
  return rects;
}

function rectContains(r: Rect, x: number, z: number, eps = 1e-6): boolean {
  return x >= r.x - eps && x <= r.x + r.w + eps && z >= r.z - eps && z <= r.z + r.d + eps;
}

/** Inset a rect by `margin` on all sides; collapses to a degenerate (zero-size, centered) rect rather than going negative. */
function insetRect(r: Rect, margin: number): Rect {
  const w = Math.max(0, r.w - margin * 2);
  const d = Math.max(0, r.d - margin * 2);
  const x = r.w - margin * 2 >= 0 ? r.x + margin : r.x + r.w / 2;
  const z = r.d - margin * 2 >= 0 ? r.z + margin : r.z + r.d / 2;
  return { type: 'rect', x, z, w, d };
}

/** All exclusion rects (door gaps + stair footprints + void openings) for one (floor, volume). */
function exclusionsFor(d: LayoutDescriptor, floor: number, volume: Volume): Rect[] {
  const gaps = doorGapsFor(d, floor, volume.id).map(doorGapRect);
  const stairs = stairFootprintsFor(d, floor, volume.id);
  const voids = voidOpeningsFor(d, floor, volume.id);
  return [...gaps, ...stairs, ...voids];
}

/** True if point (x, z) falls inside any exclusion rect. */
function isExcluded(x: number, z: number, exclusions: Rect[]): boolean {
  return exclusions.some((r) => rectContains(r, x, z, 0));
}

// ── Wall side geometry ───────────────────────────────────────────────────────

interface WallLine {
  side: WallSide;
  x0: number;
  z0: number;
  x1: number;
  z1: number;
  /** Outward normal (points away from the room interior). */
  nx: number;
  nz: number;
}

/** The 4 axis-aligned wall lines of a rect, with outward normals. North/south run along X (at min/max Z); east/west run along Z (at min/max X). */
function wallLines(r: Rect): Record<WallSide, WallLine> {
  return {
    north: { side: 'north', x0: r.x, z0: r.z, x1: r.x + r.w, z1: r.z, nx: 0, nz: -1 },
    south: { side: 'south', x0: r.x, z0: r.z + r.d, x1: r.x + r.w, z1: r.z + r.d, nx: 0, nz: 1 },
    west: { side: 'west', x0: r.x, z0: r.z, x1: r.x, z1: r.z + r.d, nx: -1, nz: 0 },
    east: { side: 'east', x0: r.x + r.w, z0: r.z, x1: r.x + r.w, z1: r.z + r.d, nx: 1, nz: 0 },
  };
}

/** Yaw (radians) facing INTO the room from a wall (i.e. opposite the outward normal) — 0 = +X, increasing toward +Z. */
function inwardYaw(line: WallLine): number {
  return Math.atan2(-line.nz, -line.nx);
}

function yawFor(facing: number | WallSide, r: Rect): number {
  if (typeof facing === 'number') return facing;
  return inwardYaw(wallLines(r)[facing]);
}

// ── Rule resolution: match rules to volumes ─────────────────────────────────

function matchesVolume(match: DressingMatch, volume: Volume): boolean {
  if (match.kind && volume.kind !== match.kind) return false;
  if (match.id !== undefined) {
    if (typeof match.id === 'string') {
      if (!volume.id.includes(match.id)) return false;
    } else if (!match.id.test(volume.id)) {
      return false;
    }
  }
  return true;
}

// ── Per-rule placement ───────────────────────────────────────────────────────

function placeGrid(rule: GridRule, ref: VolumeRef, r: Rect, elevation: number, exclusions: Rect[], rng: Rng): PropPlacement[] {
  const margin = rule.margin ?? 0.5;
  const inner = insetRect(r, margin);
  const out: PropPlacement[] = [];
  const rows = Math.max(1, Math.floor(rule.rows));
  const cols = Math.max(1, Math.floor(rule.cols));
  const yaw = yawFor(rule.facing, r);
  const jitter = rule.jitter ?? 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Cell-center placement: rows/cols slots evenly spaced across the inner rect.
      const fx = cols === 1 ? 0.5 : (col + 0.5) / cols;
      const fz = rows === 1 ? 0.5 : (row + 0.5) / rows;
      let x = inner.x + fx * inner.w;
      let z = inner.z + fz * inner.d;
      if (jitter > 0) {
        x += (rng.next() * 2 - 1) * (jitter / 2);
        z += (rng.next() * 2 - 1) * (jitter / 2);
      }
      // Clamp back inside the inner rect (jitter must not push a prop out of bounds or into a door gap).
      x = clamp(x, inner.x, inner.x + inner.w);
      z = clamp(z, inner.z, inner.z + inner.d);
      if (isExcluded(x, z, exclusions)) continue;
      out.push({ kind: rule.propKind, pos: [x, elevation, z], yaw, volume: ref });
    }
  }
  return out;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

function placeWallLine(rule: WallLineRule, ref: VolumeRef, r: Rect, elevation: number, exclusions: Rect[]): PropPlacement[] {
  const sides: WallSide[] = rule.walls === 'all' ? ALL_SIDES : rule.walls;
  const offset = rule.offset ?? 0.4;
  const margin = rule.margin ?? 0.3;
  const spacing = Math.max(0.01, rule.spacing);
  const lines = wallLines(r);
  const out: PropPlacement[] = [];

  for (const side of sides) {
    const line = lines[side];
    const len = Math.hypot(line.x1 - line.x0, line.z1 - line.z0);
    const usable = len - margin * 2;
    if (usable <= 0) continue;
    const ux = (line.x1 - line.x0) / len;
    const uz = (line.z1 - line.z0) / len;
    const count = Math.max(0, Math.floor(usable / spacing) + 1);
    const yaw = inwardYaw(line);

    for (let i = 0; i < count; i++) {
      // Centered run of `count` props spaced `spacing` apart along the usable span.
      const spanCenter = margin + usable / 2;
      const t = spanCenter + (i - (count - 1) / 2) * spacing;
      if (t < margin - 1e-6 || t > len - margin + 1e-6) continue;
      const wx = line.x0 + ux * t;
      const wz = line.z0 + uz * t;
      const x = wx + line.nx * -offset; // offset inward (opposite the outward normal)
      const z = wz + line.nz * -offset;
      if (isExcluded(x, z, exclusions) || isExcluded(wx, wz, exclusions)) continue;
      out.push({ kind: rule.propKind, pos: [x, elevation, z], yaw, volume: ref });
    }
  }
  return out;
}

function placeAnchor(rule: AnchorRule, ref: VolumeRef, r: Rect, elevation: number, exclusions: Rect[]): PropPlacement[] {
  let x: number;
  let z: number;
  let yaw = rule.yaw ?? 0;
  let elevationOut = elevation + (rule.elevationOffset ?? 0);

  if (rule.at.type === 'center') {
    x = r.x + r.w / 2;
    z = r.z + r.d / 2;
  } else if (rule.at.type === 'offset') {
    x = r.x + rule.at.x;
    z = r.z + rule.at.z;
  } else {
    const line = wallLines(r)[rule.at.side];
    const midX = (line.x0 + line.x1) / 2;
    const midZ = (line.z0 + line.z1) / 2;
    if (rule.mount === 'wall') {
      // Flush to the wall: sit right at the wall line (no inward offset), facing into the room.
      x = midX;
      z = midZ;
      yaw = rule.yaw ?? inwardYaw(line);
    } else {
      // Floor-mounted near the wall: pull slightly inward so it doesn't clip the wall.
      const inward = 0.4;
      x = midX + line.nx * -inward;
      z = midZ + line.nz * -inward;
      yaw = rule.yaw ?? inwardYaw(line);
    }
  }

  if (isExcluded(x, z, exclusions)) return [];
  return [{ kind: rule.propKind, pos: [x, elevationOut, z], yaw, volume: ref }];
}

function placeScatter(rule: ScatterRule, ref: VolumeRef, r: Rect, elevation: number, exclusions: Rect[], rng: Rng): PropPlacement[] {
  const margin = rule.margin ?? 0.3;
  const inner = insetRect(r, margin);
  const maxAttempts = rule.maxAttempts ?? 40;
  const minDist = Math.max(0, rule.minDistance);
  const placed: PropPlacement[] = [];

  if (inner.w <= 0 || inner.d <= 0) return placed;

  for (let i = 0; i < rule.count; i++) {
    let ok = false;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const x = inner.x + rng.next() * inner.w;
      const z = inner.z + rng.next() * inner.d;
      if (isExcluded(x, z, exclusions)) continue;
      const tooClose = placed.some((p) => Math.hypot(p.pos[0] - x, p.pos[2] - z) < minDist);
      if (tooClose) continue;
      const yaw = rng.next() * Math.PI * 2;
      placed.push({ kind: rule.propKind, pos: [x, elevation, z], yaw, volume: ref });
      ok = true;
      break;
    }
    if (!ok) break; // volume is saturated at this min-distance — stop rather than loop forever.
  }
  return placed;
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Resolve `rules` against every volume of `d` into a flat, deterministic list
 * of `PropPlacement`s. Same (`d`, `rules`, `seed`) → identical output, every
 * time (uses `createRng`; string seeds are hashed via `hashStringToSeed`).
 *
 * Rule application order: authored `rules` order, then floor order, then each
 * floor's `volumes` order (a rule only touches volumes it matches — see
 * `DressingMatch`). Each rule instance draws from a child RNG stream forked
 * per (rule index, floor, volume) so inserting/removing an unrelated rule or
 * volume doesn't reshuffle other volumes' placements.
 *
 * Placements are clamped inside their volume's rect (minus the rule's
 * margin) and never land inside a door-gap footprint, a stair footprint, or
 * a void-portal opening on that floor.
 */
export function dressLayout(d: LayoutDescriptor, rules: DressingRule[], seed: number | string): PropPlacement[] {
  const baseSeed = typeof seed === 'string' ? hashStringToSeed(seed) : seed >>> 0;
  const rootRng = createRng(baseSeed);
  const out: PropPlacement[] = [];

  rules.forEach((rule, ruleIndex) => {
    const ruleRng = rootRng.fork(ruleIndex + 1);
    d.floors.forEach((floorData: Floor, floorIndex: number) => {
      floorData.volumes.forEach((volume: Volume, volumeIndex: number) => {
        if (!matchesVolume(rule.match, volume)) return;
        const volRng = ruleRng.fork(floorIndex * 9973 + volumeIndex + 1);
        const ref: VolumeRef = { floor: floorIndex, volume: volume.id };
        const r = shapeRect(volume.shape);
        const exclusions = exclusionsFor(d, floorIndex, volume);
        const elevation = floorData.elevation;

        if (rule.type === 'grid') {
          out.push(...placeGrid(rule, ref, r, elevation, exclusions, volRng));
        } else if (rule.type === 'wallLine') {
          out.push(...placeWallLine(rule, ref, r, elevation, exclusions));
        } else if (rule.type === 'anchor') {
          out.push(...placeAnchor(rule, ref, r, elevation, exclusions));
        } else if (rule.type === 'scatter') {
          out.push(...placeScatter(rule, ref, r, elevation, exclusions, volRng));
        }
      });
    });
  });

  return out;
}

// ── Obstacles (solid-prop footprints for locomotion / camera probes) ────────

/** World-XZ footprint of one prop KIND at yaw 0: `w` along local X, `d` along local Z. */
export interface PropFootprint {
  w: number;
  d: number;
}

/**
 * One solid prop's floor + axis-aligned world footprint rect — the shape
 * `createLayoutLocomotion`'s `opts.obstacles` consumes (and a third-person
 * camera probe can consult the same list).
 */
export interface PropObstacle {
  floor: number;
  rect: Rect;
}

/**
 * Derive solid-obstacle rects from dressed placements: every placement whose
 * `kind` appears in `footprints` contributes the axis-aligned bounding rect
 * of its yaw-rotated footprint, on its volume's floor. Kinds absent from the
 * map are GHOST (pure decor — papers, mugs, wall art): the caller opts each
 * BIG kind in explicitly rather than the kit guessing from mesh data it
 * never sees. The AABB is exact for the yaw values wall/grid rules emit
 * (multiples of π/2) and conservatively larger for oblique yaws.
 */
export function propObstacles(
  placements: readonly PropPlacement[],
  footprints: Record<string, PropFootprint>,
): PropObstacle[] {
  const out: PropObstacle[] = [];
  for (const p of placements) {
    const fp = footprints[p.kind];
    if (!fp || fp.w <= 0 || fp.d <= 0) continue;
    const c = Math.abs(Math.cos(p.yaw));
    const s = Math.abs(Math.sin(p.yaw));
    const hw = (c * fp.w + s * fp.d) / 2;
    const hd = (s * fp.w + c * fp.d) / 2;
    out.push({
      floor: p.volume.floor,
      rect: { type: 'rect', x: p.pos[0] - hw, z: p.pos[2] - hd, w: hw * 2, d: hd * 2 },
    });
  }
  return out;
}
