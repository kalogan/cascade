import { describe, it, expect } from 'vitest';
import {
  validateLayout,
  buildLayoutGeometry,
  layoutBounds,
  layoutArea,
  decomposeRect,
  createLayoutLocomotion,
  type LayoutDescriptor,
  type Rect,
} from './index.js';

// Pure, THREE-free contract for the layout core — validation error classes,
// slab rect-decomposition, wall door-gaps, stair runs, and bounds clamping.

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Simple single-floor, single-room layout — the smallest valid descriptor. */
function oneRoom(): LayoutDescriptor {
  return {
    id: 'one-room',
    floors: [
      {
        elevation: 0,
        height: 3,
        volumes: [{ id: 'hall', kind: 'room', shape: { type: 'rect', x: 0, z: 0, w: 10, d: 10 } }],
      },
    ],
    portals: [],
    spawn: { floor: 0, pos: [5, 5] },
  };
}

/** Two floors, one stair, one atrium void — the "deceive-me-daddy" integration fixture. */
function twoFloorAtrium(): LayoutDescriptor {
  return {
    id: 'atrium',
    floors: [
      {
        elevation: 0,
        height: 3,
        volumes: [
          { id: 'lobby', kind: 'room', shape: { type: 'rect', x: 0, z: 0, w: 10, d: 10 } },
          { id: 'stairhall', kind: 'hall', shape: { type: 'rect', x: 10, z: 0, w: 4, d: 4 } },
        ],
      },
      {
        elevation: 3,
        height: 3,
        volumes: [
          { id: 'gallery', kind: 'room', shape: { type: 'rect', x: 0, z: 0, w: 10, d: 10 } },
          { id: 'landing', kind: 'hall', shape: { type: 'rect', x: 10, z: 0, w: 4, d: 4 } },
        ],
      },
    ],
    portals: [
      { type: 'door', a: { floor: 0, volume: 'lobby' }, b: { floor: 0, volume: 'stairhall' }, at: [10, 2], width: 1.2 },
      {
        type: 'stair',
        from: { floor: 0, volume: 'stairhall' },
        to: { floor: 1, volume: 'landing' },
        foot: [11, 1],
        dir: 0, // +X: lands at [11 + 3, 1] = [14, 1] — inside landing [10..14]x[0..4]
        width: 1.2,
      },
      {
        type: 'void',
        over: { floor: 1, volume: 'gallery' },
        opening: { type: 'rect', x: 2, z: 2, w: 3, d: 3 },
      },
    ],
    spawn: { floor: 0, pos: [5, 5] },
    exits: [{ name: 'main-entry', floor: 0, at: [0, 5] }],
  };
}

/**
 * GYRE school prologue's west stairwell + surrounding rooms, extracted
 * verbatim (same rects/portals/elevations) from
 * `gyre/src/school/school-layout.ts` (`SCHOOL_LAYOUT`) — the regression
 * fixture for the stair-ascent bug filed from the Director's live playtest
 * (see `createLayoutLocomotion — real consumer regression` below). Trimmed to
 * the volumes/portals that matter for the west stair (corridor + stairwell on
 * both floors) but at the SAME coordinates as the full school, since the bug
 * only reproduced with the full room set present (a minimal 2-room-per-floor
 * fixture did not reproduce it — see module docs on the fix for why).
 */
function schoolWestStair(): LayoutDescriptor {
  const FLOOR_HEIGHT = 3.6;
  return {
    id: 'school-prologue-west-stair',
    floors: [
      {
        elevation: 0,
        height: FLOOR_HEIGHT,
        volumes: [
          { id: 'entrance-hall', kind: 'room', shape: { type: 'rect', x: -5, z: -4, w: 10, d: 8 } },
          { id: 'corridor-0', kind: 'hall', shape: { type: 'rect', x: -16, z: 4, w: 32, d: 3 } },
          { id: 'classroom-0a', kind: 'room', shape: { type: 'rect', x: -15, z: 7, w: 7, d: 9 } },
          { id: 'stairwell-w', kind: 'room', shape: { type: 'rect', x: -24, z: 3, w: 8, d: 7 } },
        ],
      },
      {
        elevation: FLOOR_HEIGHT,
        height: FLOOR_HEIGHT,
        volumes: [
          { id: 'corridor-1', kind: 'hall', shape: { type: 'rect', x: -16, z: 4, w: 32, d: 3 } },
          { id: 'classroom-1a', kind: 'room', shape: { type: 'rect', x: -15, z: 7, w: 7, d: 9 } },
          { id: 'stairwell-w-1', kind: 'room', shape: { type: 'rect', x: -24, z: 3, w: 8, d: 7 } },
        ],
      },
    ],
    portals: [
      { type: 'door', a: { floor: 0, volume: 'entrance-hall' }, b: { floor: 0, volume: 'corridor-0' }, at: [0, 4], width: 3 },
      { type: 'door', a: { floor: 0, volume: 'corridor-0' }, b: { floor: 0, volume: 'classroom-0a' }, at: [-11.5, 7], width: 1.4 },
      { type: 'door', a: { floor: 0, volume: 'corridor-0' }, b: { floor: 0, volume: 'stairwell-w' }, at: [-16, 5.5], width: 2.5 },
      { type: 'door', a: { floor: 1, volume: 'corridor-1' }, b: { floor: 1, volume: 'classroom-1a' }, at: [-11.5, 7], width: 1.4 },
      { type: 'door', a: { floor: 1, volume: 'corridor-1' }, b: { floor: 1, volume: 'stairwell-w-1' }, at: [-16, 6], width: 2.5 },
      // West stairwell: runs toward -X (dir = PI), a straight 1:1 rise/run
      // flight the full FLOOR_HEIGHT — same authoring as SCHOOL_LAYOUT.
      {
        type: 'stair',
        from: { floor: 0, volume: 'stairwell-w' },
        to: { floor: 1, volume: 'stairwell-w-1' },
        foot: [-16.5, 5],
        dir: Math.PI,
        width: 2,
      },
    ],
    spawn: { floor: 0, pos: [-20, 5] },
  };
}

/**
 * `schoolWestStair` extended with the GYRE school's real gap: an ATRIUM over
 * the entrance hall. Mirrors `gyre/src/school/school-layout.ts`'s floor-1
 * `atrium-1` volume (same rect as `entrance-hall` below it, `x:-5, z:-4,
 * w:10, d:8`) connected to `corridor-1` via the same door as `entrance-hall`
 * -> `corridor-0`. UNLIKE the real school (whose void opening fully covers
 * `atrium-1`, leaving no walkable slab on that floor at all), this fixture's
 * opening is INSET within `atrium-1` so a walkable ring remains — the more
 * general case, and the one this slice's "walk around the void" tests need.
 */
function schoolWithAtrium(): LayoutDescriptor {
  const d = schoolWestStair();
  d.floors[1]!.volumes.push({ id: 'atrium-1', kind: 'room', shape: { type: 'rect', x: -5, z: -4, w: 10, d: 8 } });
  d.portals.push(
    { type: 'door', a: { floor: 1, volume: 'atrium-1' }, b: { floor: 1, volume: 'corridor-1' }, at: [0, 4], width: 3 },
    {
      type: 'void',
      over: { floor: 1, volume: 'atrium-1' },
      // Inset within atrium-1's [-5..5]x[-4..4] -> a 2-unit walkable ring all around.
      opening: { type: 'rect', x: -3, z: -2, w: 6, d: 4 },
    },
  );
  return d;
}

// ── validateLayout ───────────────────────────────────────────────────────────

describe('validateLayout — happy paths', () => {
  it('accepts the minimal one-room layout', () => {
    expect(validateLayout(oneRoom())).toEqual({ ok: true });
  });

  it('accepts the two-floor stair + atrium fixture', () => {
    expect(validateLayout(twoFloorAtrium())).toEqual({ ok: true });
  });
});

describe('validateLayout — error classes', () => {
  it('flags a duplicate volume id on the same floor', () => {
    const d = oneRoom();
    d.floors[0]!.volumes.push({ id: 'hall', kind: 'room', shape: { type: 'rect', x: 20, z: 0, w: 2, d: 2 } });
    const r = validateLayout(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('duplicate volume id'))).toBe(true);
  });

  it('flags a door referencing a missing volume', () => {
    const d = oneRoom();
    d.portals.push({
      type: 'door',
      a: { floor: 0, volume: 'hall' },
      b: { floor: 0, volume: 'nonexistent' },
      at: [5, 0],
      width: 1,
    });
    const r = validateLayout(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('not found'))).toBe(true);
  });

  it('flags a door "at" point outside one of its volumes', () => {
    const d = oneRoom();
    d.floors[0]!.volumes.push({ id: 'annex', kind: 'room', shape: { type: 'rect', x: 20, z: 0, w: 5, d: 5 } });
    d.portals.push({
      type: 'door',
      a: { floor: 0, volume: 'hall' },
      b: { floor: 0, volume: 'annex' },
      at: [5, 5], // inside hall, nowhere near annex
      width: 1,
    });
    const r = validateLayout(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('outside volume floor 0/annex'))).toBe(true);
  });

  it('flags a stair spanning non-adjacent floors', () => {
    const d = twoFloorAtrium();
    d.floors.push({
      elevation: 6,
      height: 3,
      volumes: [{ id: 'roof', kind: 'room', shape: { type: 'rect', x: 0, z: 0, w: 10, d: 10 } }],
    });
    d.portals.push({
      type: 'stair',
      from: { floor: 0, volume: 'lobby' },
      to: { floor: 2, volume: 'roof' },
      foot: [5, 5],
      dir: 0,
      width: 1,
    });
    const r = validateLayout(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('adjacent'))).toBe(true);
  });

  it('flags a stair whose foot is outside its "from" volume', () => {
    const d = twoFloorAtrium();
    d.portals.push({
      type: 'stair',
      from: { floor: 0, volume: 'lobby' },
      to: { floor: 1, volume: 'landing' },
      foot: [-5, -5], // outside lobby
      dir: 0,
      width: 1,
    });
    const r = validateLayout(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('foot') && e.includes('outside'))).toBe(true);
  });

  it('flags a stair whose derived head lands outside its "to" volume', () => {
    const d = twoFloorAtrium();
    d.portals.push({
      type: 'stair',
      from: { floor: 0, volume: 'stairhall' },
      to: { floor: 1, volume: 'landing' },
      foot: [11, 1],
      dir: Math.PI, // -X direction — head lands far outside landing
      width: 1,
    });
    const r = validateLayout(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('derived head'))).toBe(true);
  });

  it('flags a void opening extending outside its "over" volume', () => {
    const d = twoFloorAtrium();
    d.portals.push({
      type: 'void',
      over: { floor: 1, volume: 'gallery' },
      opening: { type: 'rect', x: 8, z: 8, w: 5, d: 5 }, // extends past gallery's [0..10]x[0..10]
    });
    const r = validateLayout(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('opening extends outside'))).toBe(true);
  });

  it('flags a spawn point outside every volume on its floor', () => {
    const d = oneRoom();
    d.spawn = { floor: 0, pos: [500, 500] };
    const r = validateLayout(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('spawn'))).toBe(true);
  });

  it('flags a spawn floor out of range', () => {
    const d = oneRoom();
    d.spawn = { floor: 9, pos: [0, 0] };
    const r = validateLayout(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.includes('floor 9 out of range'))).toBe(true);
  });

  it('collects multiple independent errors in one pass', () => {
    const d = oneRoom();
    d.spawn = { floor: 0, pos: [500, 500] };
    d.portals.push({
      type: 'door',
      a: { floor: 0, volume: 'hall' },
      b: { floor: 0, volume: 'missing' },
      at: [5, 5],
      width: 1,
    });
    const r = validateLayout(d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });
});

// ── decomposeRect (slab rect-decomposition) ────────────────────────────────

describe('decomposeRect', () => {
  it('returns the base rect unchanged when there are no holes', () => {
    const base: Rect = { type: 'rect', x: 0, z: 0, w: 10, d: 10 };
    expect(decomposeRect(base, [])).toEqual([base]);
  });

  it('conserves area when punching a hole fully inside the base', () => {
    const base: Rect = { type: 'rect', x: 0, z: 0, w: 10, d: 10 };
    const hole: Rect = { type: 'rect', x: 2, z: 2, w: 3, d: 3 };
    const pieces = decomposeRect(base, [hole]);
    const total = pieces.reduce((sum, r) => sum + r.w * r.d, 0);
    expect(total).toBeCloseTo(100 - 9, 6);
  });

  it('produces non-overlapping pieces that never intersect the hole', () => {
    const base: Rect = { type: 'rect', x: 0, z: 0, w: 10, d: 10 };
    const hole: Rect = { type: 'rect', x: 2, z: 2, w: 3, d: 3 };
    const pieces = decomposeRect(base, [hole]);
    for (const p of pieces) {
      const overlapsHole = p.x < hole.x + hole.w && p.x + p.w > hole.x && p.z < hole.z + hole.d && p.z + p.d > hole.z;
      expect(overlapsHole).toBe(false);
    }
  });

  it('conserves area with multiple non-overlapping holes', () => {
    const base: Rect = { type: 'rect', x: 0, z: 0, w: 20, d: 20 };
    const holes: Rect[] = [
      { type: 'rect', x: 1, z: 1, w: 2, d: 2 },
      { type: 'rect', x: 10, z: 10, w: 4, d: 4 },
    ];
    const pieces = decomposeRect(base, holes);
    const total = pieces.reduce((sum, r) => sum + r.w * r.d, 0);
    expect(total).toBeCloseTo(400 - 4 - 16, 6);
  });

  it('clips a hole that extends outside the base before subtracting', () => {
    const base: Rect = { type: 'rect', x: 0, z: 0, w: 10, d: 10 };
    const hole: Rect = { type: 'rect', x: 8, z: 8, w: 10, d: 10 }; // extends to [18,18], clipped to [8..10]x[8..10]
    const pieces = decomposeRect(base, [hole]);
    const total = pieces.reduce((sum, r) => sum + r.w * r.d, 0);
    expect(total).toBeCloseTo(100 - 4, 6); // clipped hole is 2x2 = 4
  });

  it('a hole covering the entire base leaves no pieces', () => {
    const base: Rect = { type: 'rect', x: 0, z: 0, w: 5, d: 5 };
    const hole: Rect = { type: 'rect', x: 0, z: 0, w: 5, d: 5 };
    expect(decomposeRect(base, [hole])).toEqual([]);
  });
});

// ── buildLayoutGeometry ──────────────────────────────────────────────────────

describe('buildLayoutGeometry — floor slabs', () => {
  it('emits a single unbroken slab for a room with no void above nothing', () => {
    const geo = buildLayoutGeometry(oneRoom());
    expect(geo.floors).toHaveLength(1);
    expect(geo.floors[0]!.rect).toEqual({ type: 'rect', x: 0, z: 0, w: 10, d: 10 });
  });

  it('punches a hole in the slab of the volume ABOVE a void portal', () => {
    const geo = buildLayoutGeometry(twoFloorAtrium());
    // Floor 1's "gallery" slab is hole-punched; floor 0 is untouched.
    const floor0Gallery = geo.floors.filter((s) => s.floor === 0);
    const floor1Gallery = geo.floors.filter((s) => s.floor === 1);
    const floor0Area = floor0Gallery.reduce((sum, s) => sum + s.rect.w * s.rect.d, 0);
    const floor1Area = floor1Gallery.reduce((sum, s) => sum + s.rect.w * s.rect.d, 0);
    // floor 0: lobby (100) + stairhall (16) = 116, no holes.
    expect(floor0Area).toBeCloseTo(116, 6);
    // floor 1: gallery (100 - 3*3=9 hole) + landing (16) = 107.
    expect(floor1Area).toBeCloseTo(107, 6);
  });
});

describe('buildLayoutGeometry — wall door gaps', () => {
  it('a room with no doors has an unbroken perimeter (4 wall segments)', () => {
    const geo = buildLayoutGeometry(oneRoom());
    expect(geo.walls).toHaveLength(4);
  });

  it('cuts a gap exactly where a door portal sits on a volume side', () => {
    const d = twoFloorAtrium();
    const geo = buildLayoutGeometry(d);
    const lobbyWalls = geo.walls.filter((w) => w.floor === 0 && w.volume === 'lobby');
    // The east side (x=10) of lobby [0..10]x[0..10] has a door at [10, 2] width 1.2,
    // so that side splits into two segments instead of one straight run.
    const eastSideSegs = lobbyWalls.filter((w) => w.x0 === 10 && w.x1 === 10);
    expect(eastSideSegs.length).toBe(2);
    // Gap is centered at z=2 with width 1.2 -> [1.4, 2.6] is missing from the side.
    const covered = eastSideSegs
      .map((w) => [Math.min(w.z0, w.z1), Math.max(w.z0, w.z1)] as const)
      .sort((a, b) => a[0] - b[0]);
    expect(covered[0]![0]).toBeCloseTo(0, 6);
    expect(covered[0]![1]).toBeCloseTo(1.4, 6);
    expect(covered[1]![0]).toBeCloseTo(2.6, 6);
    expect(covered[1]![1]).toBeCloseTo(10, 6);
  });

  it('the matching gap is also cut on the OTHER side of the door (stairhall)', () => {
    const geo = buildLayoutGeometry(twoFloorAtrium());
    const stairhallWalls = geo.walls.filter((w) => w.floor === 0 && w.volume === 'stairhall');
    // stairhall is [10..14]x[0..4]; its west side (x=10) has the same door gap.
    const westSideSegs = stairhallWalls.filter((w) => w.x0 === 10 && w.x1 === 10);
    expect(westSideSegs.length).toBe(2);
  });
});

describe('buildLayoutGeometry — stair runs', () => {
  it('spans exactly the elevation delta between the connected floors', () => {
    const geo = buildLayoutGeometry(twoFloorAtrium());
    expect(geo.stairs).toHaveLength(1);
    const run = geo.stairs[0]!;
    expect(run.toElevation - run.fromElevation).toBeCloseTo(3, 6);
    expect(run.steps * run.stepRise).toBeCloseTo(3, 6);
  });

  it('produces at least one step even for a tiny elevation delta', () => {
    const d = oneRoom();
    d.floors.push({
      elevation: 0.05,
      height: 3,
      volumes: [{ id: 'mezz', kind: 'room', shape: { type: 'rect', x: 0, z: 0, w: 10, d: 10 } }],
    });
    d.portals.push({
      type: 'stair',
      from: { floor: 0, volume: 'hall' },
      to: { floor: 1, volume: 'mezz' },
      foot: [1, 1],
      dir: 0,
      width: 1,
    });
    const geo = buildLayoutGeometry(d);
    expect(geo.stairs).toHaveLength(1);
    expect(geo.stairs[0]!.steps).toBeGreaterThanOrEqual(1);
  });
});

describe('buildLayoutGeometry — determinism', () => {
  it('the same descriptor builds deep-equal geometry every time', () => {
    const d = twoFloorAtrium();
    const a = buildLayoutGeometry(d);
    const b = buildLayoutGeometry(d);
    expect(a).toEqual(b);
  });

  it('a fresh equivalent descriptor object also builds deep-equal geometry', () => {
    const a = buildLayoutGeometry(twoFloorAtrium());
    const b = buildLayoutGeometry(twoFloorAtrium());
    expect(a).toEqual(b);
  });
});

// ── layoutBounds ─────────────────────────────────────────────────────────────

describe('layoutBounds', () => {
  it('leaves a point already inside a volume unchanged', () => {
    const bounds = layoutBounds(oneRoom(), 0);
    expect(bounds(5, 5)).toEqual([5, 5]);
  });

  it('clamps a point outside every volume back to the nearest wall', () => {
    const bounds = layoutBounds(oneRoom(), 0);
    const [x, z] = bounds(15, 5);
    expect(x).toBeCloseTo(10, 6);
    expect(z).toBeCloseTo(5, 6);
  });

  it('blocks straight through a solid wall (no door) back to the boundary', () => {
    const bounds = layoutBounds(oneRoom(), 0);
    const [x, z] = bounds(-3, -3);
    expect(x).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it('lets a point cross a doorway between two adjoining volumes', () => {
    const bounds = layoutBounds(twoFloorAtrium(), 0);
    // The door sits at [10, 2] connecting lobby [0..10]x[0..10] and stairhall [10..14]x[0..4].
    // A point exactly at the door threshold is inside BOTH rects -> unclamped.
    expect(bounds(10, 2)).toEqual([10, 2]);
    // Points just inside each side of the doorway are also free (both inside their own rect).
    expect(bounds(9.9, 2)).toEqual([9.9, 2]);
    expect(bounds(10.1, 2)).toEqual([10.1, 2]);
  });

  it('returns the input unchanged when the floor has no volumes', () => {
    const d = oneRoom();
    d.floors.push({ elevation: 3, height: 3, volumes: [] });
    const bounds = layoutBounds(d, 1);
    expect(bounds(42, -17)).toEqual([42, -17]);
  });
});

// ── layoutArea (the "area" seam) ─────────────────────────────────────────────

describe('layoutArea', () => {
  it('exposes spawn + exits + a loose outer AABB across every floor', () => {
    const area = layoutArea(twoFloorAtrium());
    expect(area.spawn.pos).toEqual([5, 5]);
    expect(area.exits).toEqual([{ name: 'main-entry', floor: 0, at: [0, 5] }]);
    // Union of lobby/stairhall/gallery/landing rects: x in [0,14], z in [0,10].
    expect(area.bounds).toEqual({ minX: 0, maxX: 14, minZ: 0, maxZ: 10 });
  });

  it('degenerates to a zero-sized bounds when there are no volumes anywhere', () => {
    const d: LayoutDescriptor = {
      id: 'empty',
      floors: [{ elevation: 0, height: 3, volumes: [] }],
      portals: [],
      spawn: { floor: 0, pos: [0, 0] },
    };
    const area = layoutArea(d);
    expect(area.bounds).toEqual({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 });
  });

  it('defaults exits to an empty array when omitted', () => {
    const area = layoutArea(oneRoom());
    expect(area.exits).toEqual([]);
  });
});

// ── Integration: the two-floor stair + atrium fixture end-to-end ───────────

describe('integration — two-floor stair + atrium ("deceive-me-daddy")', () => {
  it('validates', () => {
    expect(validateLayout(twoFloorAtrium())).toEqual({ ok: true });
  });

  it('builds slabs, walls, and a stair run together', () => {
    const geo = buildLayoutGeometry(twoFloorAtrium());
    expect(geo.floors.length).toBeGreaterThan(0);
    expect(geo.walls.length).toBeGreaterThan(0);
    expect(geo.stairs).toHaveLength(1);
  });
});

// ── createLayoutLocomotion ───────────────────────────────────────────────────
//
// Stair fixture recap (twoFloorAtrium): foot [11, 1], dir 0 (+X), width 1.2 ->
// halfWidth 0.6, rise = toElevation(3) - fromElevation(0) = 3, run = 3 (1:1
// convention) -> head [14, 1]. Footprint: x in [11, 14], z in [0.4, 1.6].
// stairhall (floor 0) is [10..14]x[0..4]; landing (floor 1) is [10..14]x[0..4].

describe('createLayoutLocomotion — floor + volume basics', () => {
  it('starts on the spawn floor by default and reports the spawn volume', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium());
    expect(loco.floorIndex()).toBe(0);
    const [x, z] = loco.constrain(5, 5); // inside lobby
    expect([x, z]).toEqual([5, 5]);
    expect(loco.volumeAt()).toEqual({ floor: 0, volume: 'lobby' });
  });

  it('honors an explicit startFloor override', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 });
    expect(loco.floorIndex()).toBe(1);
  });

  it('elevation off-stair equals the current floor elevation', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium());
    loco.constrain(5, 5); // lobby, floor 0 (elevation 0)
    expect(loco.elevation()).toBeCloseTo(0, 6);
  });

  it('elevation reflects floor 1 once standing there', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 });
    loco.constrain(5, 5); // gallery, floor 1 (elevation 3)
    expect(loco.elevation()).toBeCloseTo(3, 6);
  });

  it('door/wall clamping still holds mid-locomotion (blocked by a solid wall)', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium());
    const [x, z] = loco.constrain(-5, -5); // outside lobby, no door there
    expect(x).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it('still allows free pass-through at a door gap', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium());
    expect(loco.constrain(10, 2)).toEqual([10, 2]); // lobby/stairhall doorway
  });
});

describe('createLayoutLocomotion — stair traversal (ascending)', () => {
  it('interpolates elevation monotonically while climbing, and transitions floor at the head', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium());
    // Walk from the stairhall into the stair foot, then up the run to the head.
    loco.constrain(11, 1); // t=0 (foot) — still floor 0
    expect(loco.floorIndex()).toBe(0);
    expect(loco.elevation()).toBeCloseTo(0, 6);

    const elevations: number[] = [loco.elevation()];
    for (const t of [0.5, 1, 1.5, 2, 2.5]) {
      loco.constrain(11 + t, 1);
      elevations.push(loco.elevation());
      expect(loco.floorIndex()).toBe(0); // strictly between the ends: unchanged
    }
    // Monotonically non-decreasing while ascending.
    for (let i = 1; i < elevations.length; i++) {
      expect(elevations[i]!).toBeGreaterThanOrEqual(elevations[i - 1]! - 1e-9);
    }

    // Reach the head (t = run = 3) -> transitions to floor 1.
    loco.constrain(14, 1);
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3, 6);
  });

  it('elevation at the run midpoint is the midpoint of the two floor elevations', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium());
    loco.constrain(11, 1);
    loco.constrain(11 + 1.5, 1); // t = 1.5, halfway of run=3
    expect(loco.elevation()).toBeCloseTo(1.5, 6);
  });

  it('landing on floor 1 reports the landing volume', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium());
    loco.constrain(11, 1);
    loco.constrain(14, 1);
    expect(loco.volumeAt()).toEqual({ floor: 1, volume: 'landing' });
  });
});

describe('createLayoutLocomotion — stair traversal (descending, reverses)', () => {
  it('walking a fully-climbed stair back down reverses floor + elevation', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 });
    loco.constrain(14, 1); // head, t = run — floor 1
    expect(loco.floorIndex()).toBe(1);

    for (const t of [2.5, 2, 1.5, 1, 0.5]) {
      loco.constrain(11 + t, 1);
      expect(loco.floorIndex()).toBe(1); // strictly between: unchanged until the foot
    }

    loco.constrain(11, 1); // foot, t = 0 -> transitions down to floor 0
    expect(loco.floorIndex()).toBe(0);
    expect(loco.elevation()).toBeCloseTo(0, 6);
  });

  it('elevation decreases monotonically while descending', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 });
    loco.constrain(14, 1);
    const elevations: number[] = [loco.elevation()];
    for (const t of [2, 1, 0]) {
      loco.constrain(11 + t, 1);
      elevations.push(loco.elevation());
    }
    for (let i = 1; i < elevations.length; i++) {
      expect(elevations[i]!).toBeLessThanOrEqual(elevations[i - 1]! + 1e-9);
    }
  });
});

describe('createLayoutLocomotion — no flip-flop at the boundary', () => {
  it('stepping just short of the head does not transition, exactly at/past it does', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium());
    loco.constrain(11, 1);
    loco.constrain(11 + 2.999, 1); // t = 2.999, just short of run=3
    expect(loco.floorIndex()).toBe(0);
    loco.constrain(14, 1); // t = 3, exactly the head
    expect(loco.floorIndex()).toBe(1);
  });

  it('re-entering the stair from the head side without reaching the foot stays on floor 1', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 });
    loco.constrain(14, 1); // floor 1
    loco.constrain(11 + 2, 1); // step back onto the run, not at the foot
    expect(loco.floorIndex()).toBe(1);
    loco.constrain(11 + 2.9, 1); // step forward again, still not at the head
    expect(loco.floorIndex()).toBe(1);
  });
});

describe('createLayoutLocomotion — determinism', () => {
  it('the same sequence of moves produces the same sequence of states', () => {
    const walk = (loco: ReturnType<typeof createLayoutLocomotion>) => {
      const states: Array<{ pos: [number, number]; floor: number; elevation: number; volume: unknown }> = [];
      const moves: Array<[number, number]> = [
        [5, 5],
        [9, 2],
        [10, 2],
        [11, 1],
        [12, 1],
        [13, 1],
        [14, 1],
        [5, 5],
        [12, 1],
        [11, 1],
      ];
      for (const [x, z] of moves) {
        const pos = loco.constrain(x, z);
        states.push({ pos, floor: loco.floorIndex(), elevation: loco.elevation(), volume: loco.volumeAt() });
      }
      return states;
    };

    const a = walk(createLayoutLocomotion(twoFloorAtrium()));
    const b = walk(createLayoutLocomotion(twoFloorAtrium()));
    expect(a).toEqual(b);
  });
});

// ── Real-consumer regression: GYRE school prologue's west stairwell ────────
//
// BUG (filed from a live playtest): standing in `stairwell-w` on floor 0 and
// walking at the stairs did not climb — elevation never rose past the point
// where the walker's step size first overshot the stair's far end.
//
// ROOT CAUSE (kit bug, not school data): `onStairFootprint` gated the along-
// run coordinate `t` to `[0, run]` (plus a tiny epsilon). A per-frame step
// large enough to land PAST `run` in a single `constrain()` call (routine —
// nothing requires a fixed step size to divide `run` evenly, and the west
// stair's `run` is 3.6, not a "nice" number relative to any particular step)
// missed the gate entirely, so `constrain()` fell through to the plain
// per-floor rect clamp on the CURRENT (still pre-transition) floor. That
// clamp snapped the walker back into `stairwell-w`'s room rect at elevation
// 0 — undoing the climb — and the walker was stuck oscillating at the near
// end forever, since it could never land EXACTLY on `t === run` to trigger
// the transition. The kit's own fixture tests (`twoFloorAtrium`, above) never
// caught this because every hand-authored test step happens to land exactly
// on `t = run` (e.g. `constrain(14, 1)` at `run = 3`) — an edge the fixture
// didn't cover, per the bug report's suspect (1).
//
// Suspects (2) reversed from/to authoring and (3) a `dir` convention mismatch
// were both ruled out: `schoolWestStair` below validates cleanly, and the
// transition rule (`buildStairSpan`) already normalizes `from`/`to` into
// `lowFloor`/`highFloor` by comparing elevations (not by authored order), so
// approaching from either floor works regardless of which one is `from`.
//
// FIX: `onStairFootprint` now only gates the LATERAL (perpendicular) distance
// from the stair's centerline — not the along-run coordinate. `constrain()`
// already clamps `t` into `[0, run]` before deriving position/elevation/floor
// (`clampedT`), so widening the gate is safe: an overshooting step still
// glues to the correct end and fires the floor transition, instead of
// silently missing the stair and re-clamping to the room.
describe('createLayoutLocomotion — real consumer regression (GYRE school west stair)', () => {
  it('the extracted school west-stair fixture validates', () => {
    expect(validateLayout(schoolWestStair())).toEqual({ ok: true });
  });

  it('walking from the corridor door, across the stairwell room, and up the run climbs to floor 1 with monotonically rising elevation', () => {
    const loco = createLayoutLocomotion(schoolWestStair());

    // Approach from the corridor, through the door at [-16, 5.5], across the
    // stairwell room floor toward the stair foot [-16.5, 5].
    const approach: Array<[number, number]> = [
      [-15.9, 5.5],
      [-16.0, 5.5],
      [-16.3, 5.4],
      [-16.5, 5.2],
      [-16.5, 5.0], // at the stair foot (t=0)
    ];
    for (const [x, z] of approach) loco.constrain(x, z);
    expect(loco.floorIndex()).toBe(0);
    expect(loco.elevation()).toBeCloseTo(0, 6);

    // Walk up the run in fixed 0.7-unit steps — deliberately NOT a divisor of
    // run=3.6, so the final step overshoots the head [-20.1, 5] by 0.1 units
    // in a single constrain() call, reproducing the exact overshoot that
    // triggered the bug (t goes from 3.5 straight to 4.2, skipping t=3.6).
    const elevations: number[] = [loco.elevation()];
    const STEP = 0.7;
    let x = -16.5;
    for (let i = 0; i < 6; i++) {
      x -= STEP;
      loco.constrain(x, 5);
      elevations.push(loco.elevation());
    }

    // Elevation must rise monotonically throughout (never snap back to 0).
    for (let i = 1; i < elevations.length; i++) {
      expect(elevations[i]!).toBeGreaterThanOrEqual(elevations[i - 1]! - 1e-9);
    }
    // The overshooting final step must land the walker on floor 1, at the
    // top elevation — not stuck back at 0 on floor 0.
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3.6, 6);
    expect(loco.volumeAt()).toEqual({ floor: 1, volume: 'stairwell-w-1' });
  });

  it('reproduces the bug directly: a single overshooting step from mid-run must not fall back to elevation 0', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    loco.constrain(-16.5, 5); // foot, t=0
    loco.constrain(-20, 5); // t=3.5, still short of run=3.6 — floor 0
    expect(loco.floorIndex()).toBe(0);
    expect(loco.elevation()).toBeCloseTo(3.5, 6);

    // One more step overshoots past the head (t=3.7 > run=3.6) in a single
    // constrain() call — this is exactly what a real per-frame walk speed
    // produces, and exactly what the fixture's own tests never exercised.
    loco.constrain(-20.2, 5);
    expect(loco.floorIndex()).toBe(1); // must transition, not fall back to floor 0
    expect(loco.elevation()).toBeCloseTo(3.6, 6); // must clamp to the head's elevation, not snap to 0
  });

  it('approaching the SAME stair from the upper floor (reversed dir/from-to authoring check) transitions correctly on descent', () => {
    // buildStairSpan normalizes from/to into low/high by comparing elevations
    // (not authored order), so descending from floor 1 must work identically
    // to ascending from floor 0 — rules out suspect (2) (a from/to-reversal
    // bug) for this portal's authoring.
    const loco = createLayoutLocomotion(schoolWestStair(), { startFloor: 1 });
    loco.constrain(-20.1, 5); // head, t=run=3.6 — floor 1
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3.6, 6);

    loco.constrain(-18, 5); // t=1.5, mid-run — floor unchanged (no flip-flop)
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(1.5, 6);

    // Elevation decreases monotonically while descending.
    const elevations: number[] = [loco.elevation()];
    for (const x of [-17.5, -17, -16.7]) {
      loco.constrain(x, 5);
      elevations.push(loco.elevation());
    }
    for (let i = 1; i < elevations.length; i++) {
      expect(elevations[i]!).toBeLessThanOrEqual(elevations[i - 1]! + 1e-9);
    }
  });

  it('descending overshoot past the foot in a single step transitions to floor 0 (not stuck at floor 1)', () => {
    const loco = createLayoutLocomotion(schoolWestStair(), { startFloor: 1 });
    loco.constrain(-20.1, 5); // head, t=run — floor 1
    loco.constrain(-16.7, 5); // t=0.2, close to the foot — still floor 1
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(0.2, 6);

    // Overshoot PAST the foot (t goes negative) in a single constrain() call —
    // the descending mirror of the ascent-overshoot bug.
    loco.constrain(-16.2, 5); // t = -(-16.2 - -16.5) = -0.3
    expect(loco.floorIndex()).toBe(0); // must transition down, not stay stuck on floor 1
    expect(loco.elevation()).toBeCloseTo(0, 6); // must clamp to the foot's elevation, not the old 0.2
  });
});

// ── Real-consumer regression #2: bounce-back at the stair head ─────────────
//
// A live playtest AFTER the overshoot fix above caught a follow-on bug: the
// walker DID climb (elevation rose, floor transitioned to 1 at the head),
// but continuing to walk on floor 1 — away from the stairs, toward an
// unrelated door — bounced the floor straight back to 0.
//
// ROOT CAUSE: the overshoot fix (making `onStairFootprint` admit ANY
// along-run `t`, unbounded) was too broad. The west stair's infinite
// centerline (through `foot=[-16.5,5]`, `dir=PI`) passes laterally close to
// OTHER points in the school that have nothing to do with the stair — e.g.
// the door from `stairwell-w-1` into `corridor-1` at `[-16, 6]` projects to
// `t=-0.5, perp=1.0` on that same line, i.e. within the stair's width band
// but on the FOOT side (`t<0`) while the walker was actually approaching
// from deep in the HEAD side. Once the walker reached the head and moved on
// into the room, a later step toward that door was wrongly re-admitted as
// "on the stair" (unbounded lateral gate, no `t` bound at all) with a
// negative `t`, which re-triggered the `t <= 0` transition rule and flipped
// the floor back down.
//
// FIX: `onStairFootprint` reverted to its original strict bounds (`t` in
// `[0, run]`). The overshoot case is instead handled by a narrow, STATEFUL
// "one-shot bridge" (`isSameEndOvershoot` + `activeStairSpan` in
// `createLayoutLocomotion`): a step is admitted as overshoot ONLY if (a) the
// walker was on the STRICT bounded footprint on the immediately preceding
// call, (b) this step's raw `t` continues in the SAME direction that
// trajectory was already heading, and (c) admitting it immediately consumes
// the bridge (does not re-latch from the out-of-range `t`) — so a walker who
// has moved on past the head can never be re-captured by an unrelated point
// elsewhere on the stair's infinite centerline.
describe('createLayoutLocomotion — real consumer regression #2 (bounce-back at the stair head)', () => {
  it('continuing to walk on floor 1 after climbing, toward an unrelated door, does not bounce back to floor 0', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    const climb: Array<[number, number]> = [
      [-16.5, 5], // foot
      [-18, 5],
      [-20, 5],
      [-20.1, 5], // head — transitions to floor 1
    ];
    for (const [x, z] of climb) loco.constrain(x, z);
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3.6, 6);

    // Continue walking on floor 1, away from the stairs, deeper into
    // stairwell-w-1 and then toward the door into corridor-1 at [-16, 6] —
    // a point that projects onto the SAME stair's infinite centerline with
    // t < 0 (the foot side) but perp within the stair's width band. This
    // must NOT be mistaken for re-descending the stair.
    const onward: Array<[number, number]> = [
      [-20.1, 5.5],
      [-21, 5],
      [-22, 5],
      [-22, 6],
      [-16, 6], // at the door into corridor-1
    ];
    for (const [x, z] of onward) {
      loco.constrain(x, z);
      expect(loco.floorIndex()).toBe(1); // must never bounce back to floor 0
      expect(loco.elevation()).toBeCloseTo(3.6, 6);
    }
    expect(loco.volumeAt()).toEqual({ floor: 1, volume: 'corridor-1' });
  });

  it('overshoot admission is a one-shot bridge: it does not re-latch and keep tracking the stair indefinitely', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    loco.constrain(-16.5, 5); // foot, strict
    loco.constrain(-20, 5); // t=3.5, strict — activeStairSpan latches here
    loco.constrain(-20.2, 5); // t=3.7, overshoot admission — floor 1, bridge consumed

    // A second big step, still laterally within the stair's width band but
    // now on the FOOT side (t goes negative) — if the bridge had wrongly
    // re-latched on the overshoot call, this would be admitted as "same
    // direction continuation" and flip back to floor 0. It must not.
    loco.constrain(-16.2, 5); // t ≈ -0.3
    expect(loco.floorIndex()).toBe(1);
  });

  it('a genuine re-descent still works after walking back to the head through the strict footprint', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    loco.constrain(-16.5, 5);
    loco.constrain(-20.1, 5); // head, floor 1
    // Walk back down through the strict bounded footprint (re-entering it
    // properly, not via the overshoot bridge).
    loco.constrain(-19, 5); // t=2.6, strict
    loco.constrain(-17, 5); // t=0.6, strict
    loco.constrain(-16.5, 5); // t=0, foot — transitions back to floor 0
    expect(loco.floorIndex()).toBe(0);
    expect(loco.elevation()).toBeCloseTo(0, 6);
  });
});

// ── Real-consumer regression #3: lingering at the head keeps the latch hot ──
//
// Found while building the void-exclusion slice's school-atrium integration
// test, and guaranteed to bite the real player: GYRE's corridor-1 runs
// alongside both stairwells, so post-climb walks near a stair's centerline
// are constant, not exotic.
//
// BUG: the one-shot overshoot bridge's latch re-armed on EVERY strict
// on-footprint call — including repeated calls sitting AT the head
// (`t = run`), where the floor transition had already fired. A walker who
// finished climbing and lingered at/near the head therefore kept a hot
// latch, and a later step along floor 1 — laterally within the stair's
// width band but far on the FOOT side (e.g. walking corridor-1 east past
// the stair's centerline at `z ≈ 5.5`, `perp = 0.5 < halfWidth = 1`) —
// passed `isSameEndOvershoot`'s `t < lastT` check trivially (from
// `lastT = run`, EVERY foot-side `t` is `< lastT`; the check cannot infer
// heading from one endpoint sample) and was admitted as "overshooting past
// the foot," re-firing the `t <= 0` transition and bouncing the floor back
// to 0.
//
// FIX (interior-only arming): the latch only arms when the strict
// on-footprint `t` is strictly MID-RUN (`eps < t < run - eps`) — i.e.
// exactly when the transition rule did NOT fire on that call. An armed
// latch now always means "traversal in progress," so the bridge can only
// ever complete a climb/descent, never re-capture a walker whose traversal
// already finished. INVARIANT: once a transition fires (exact landing or
// overshoot admission), the latch is null, and only a genuine strict
// re-entry into the mid-run footprint can re-arm it.
describe('createLayoutLocomotion — real consumer regression #3 (lingering at the head keeps the latch hot)', () => {
  it('climb -> linger at the head -> walk floor-1 corridor east past the stair centerline: floor stays 1', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    // Climb to the head (transition to floor 1).
    for (const [x, z] of [
      [-16.5, 5],
      [-18, 5],
      [-20, 5],
      [-20.1, 5],
    ] as const) {
      loco.constrain(x, z);
    }
    expect(loco.floorIndex()).toBe(1);

    // LINGER at/near the head: still strict on-footprint (t = run = 3.6,
    // perp = 0.5 <= halfWidth = 1). Under the old "any strict call" arming
    // rule this kept re-arming the latch with lastT = run.
    loco.constrain(-20.1, 5.5);
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3.6, 6);

    // Now walk east along the corridor at z = 5.5 — the exact walk-path the
    // void slice's integration test originally had to route around. Every
    // point stays laterally within the stair's width band (perp = 0.5) but
    // far on the FOOT side (t << 0). With a hot latch this was admitted as
    // a foot overshoot and bounced the floor to 0; it must stay 1.
    for (const [x, z] of [
      [-10, 5.5],
      [0, 5.5],
      [10, 5.5],
    ] as const) {
      loco.constrain(x, z);
      expect(loco.floorIndex()).toBe(1); // never bounces back down
      expect(loco.elevation()).toBeCloseTo(3.6, 6);
    }
    expect(loco.volumeAt()).toEqual({ floor: 1, volume: 'corridor-1' });
  });

  it('REPEATED lingering calls at the head never re-arm the latch', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    loco.constrain(-16.5, 5);
    loco.constrain(-20.1, 5); // head, floor 1
    // Several consecutive strict at-the-head calls (a player idling against
    // the landing wall) — none of them may arm the latch.
    loco.constrain(-20.1, 5.2);
    loco.constrain(-20.1, 5.5);
    loco.constrain(-20.1, 5.4);
    expect(loco.floorIndex()).toBe(1);

    // Single large step to the foot side of the centerline, within the band.
    loco.constrain(-10, 5.5); // t = -6.5, perp = 0.5
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3.6, 6);
  });

  it('descending mirror: lingering at the FOOT after a descent cannot be captured toward the head side', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    // Climb, then genuinely re-descend to the foot (floor 0).
    loco.constrain(-16.5, 5);
    loco.constrain(-20.1, 5); // head, floor 1
    loco.constrain(-18, 5); // t=1.5, strict mid-run
    loco.constrain(-16.5, 5); // foot — transitions back to floor 0
    expect(loco.floorIndex()).toBe(0);

    // Linger at the foot (strict, t = 0 — latch must not arm), then step to
    // a point deep on the HEAD side of the centerline, within the width
    // band (walking floor 0 underneath the stair's head region). Under the
    // old rule the hot latch admitted this as a head overshoot (t > lastT
    // trivially from lastT = 0) and wrongly hoisted the walker to floor 1.
    loco.constrain(-16.5, 5.5); // t=0, perp=0.5 — strict at the foot end
    expect(loco.floorIndex()).toBe(0);
    loco.constrain(-20.5, 5.5); // t=4.0 > run, perp=0.5
    expect(loco.floorIndex()).toBe(0); // must stay on floor 0
    expect(loco.elevation()).toBeCloseTo(0, 6);
  });

  it('the legitimate overshoot bridge still works: it arms from a mid-run call, not an at-end one', () => {
    // Byte-for-byte the shape of regression #1's overshoot case — the
    // interior-only arming must NOT have broken it: the arming call there is
    // mid-run (t=3.5), not at an end.
    const loco = createLayoutLocomotion(schoolWestStair());
    loco.constrain(-16.5, 5); // foot, t=0 — does NOT arm (at an end)
    loco.constrain(-20, 5); // t=3.5, strict mid-run — arms the latch
    loco.constrain(-20.2, 5); // t=3.7, overshoot admission — completes the climb
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3.6, 6);
  });
});

// ── Real-consumer regression #4: the stair band was enterable from the side ──
//
// Caught by the Director's phone playtest ("did we actually fix the stairs?"
// — no). The band admitted ANY point on its 2D footprint, from any direction,
// and snapped every admitted point to the centerline. Three cliffs, all
// reproduced by a frame-stepped sim before fixing:
//   (B) drifting sideways mid-climb fell off the open side: elevation
//       1.80 -> 0.00 in one frame;
//   (C) a floor-1 walker cutting laterally across the slab opening was
//       captured mid-run and teleported DOWN it (3.60 -> 1.50) with a 1m
//       yank to the centerline (z 5.99 -> 5.00);
//   (E) a floor-0 walker cutting across the band was teleported ON TOP of
//       the staircase mass (0.00 -> 2.50).
// New model: end-only entry, rails mid-run (lateral offset preserved,
// clamped), solid band sides from the outside on both floors.
describe('createLayoutLocomotion — real consumer regression #4 (side entry/exit on the stair band)', () => {
  it('B: rails — drifting sideways mid-climb clamps to the band edge, elevation holds', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    loco.constrain(-16.5, 5); // board at the foot
    loco.constrain(-18.3, 5); // t = 1.8, mid-run
    expect(loco.elevation()).toBeCloseTo(1.8, 6);

    // Press hard sideways (north): the old footprint check rejected the
    // point and fell through to the floor clamp — an instant 1.8m drop.
    // Now the rail holds: clamped to the band edge (z = 6), same t, same
    // elevation, still floor 0 mid-climb.
    const [cx, cz] = loco.constrain(-18.3, 8.5);
    expect(cx).toBeCloseTo(-18.3, 6);
    expect(cz).toBeCloseTo(6, 6);
    expect(loco.elevation()).toBeCloseTo(1.8, 6);
    expect(loco.floorIndex()).toBe(0);
  });

  it('no centerline yank: a walker boarding off-center keeps their lateral offset up the whole run', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    const [, bz] = loco.constrain(-16.5, 5.5); // board at the foot, half a meter off-center
    expect(bz).toBeCloseTo(5.5, 6);
    const [, cz] = loco.constrain(-18, 5.5); // climb — z must NOT snap to the centerline (5)
    expect(cz).toBeCloseTo(5.5, 6);
    expect(loco.elevation()).toBeCloseTo(1.5, 6);
  });

  it('C: the slab opening is solid from the side on floor 1 — no mid-run capture, no teleport down', () => {
    const loco = createLayoutLocomotion(schoolWestStair(), { startFloor: 1 });
    loco.constrain(-18, 8.5); // on the floor-1 landing, north of the band
    // Walk south toward the opening: must be held at the implicit rail
    // (band edge + margin), staying on floor 1 at 3.6 — never captured onto
    // the stair surface below.
    const [, cz] = loco.constrain(-18, 5.5);
    expect(cz).toBeGreaterThanOrEqual(6.0);
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3.6, 6);
  });

  it('C-door: entering floor 1 through the west door gap that overlaps the band slides along the rail, not down the stairwell', () => {
    const loco = createLayoutLocomotion(schoolWestStair(), { startFloor: 1 });
    loco.constrain(-16.2, 5.5); // just inside the door, beyond the stair foot (t < 0)
    expect(loco.floorIndex()).toBe(1);
    // Continue west: t crosses into the band's mid-run range on the high
    // floor -> solid; the walker slides to the north side of the opening.
    const [, cz] = loco.constrain(-16.8, 5.5);
    expect(cz).toBeGreaterThanOrEqual(6.0);
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3.6, 6);
  });

  it('E: the staircase mass is solid from the side on floor 0 — no teleport on top', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    loco.constrain(-19, 8.5); // floor 0, north aisle of the stairwell room
    // Cut south across the band mid-run: held at the band edge, elevation 0.
    const [, cz] = loco.constrain(-19, 4.2);
    expect(cz).toBeGreaterThanOrEqual(6.0);
    expect(loco.floorIndex()).toBe(0);
    expect(loco.elevation()).toBeCloseTo(0, 6);
  });

  it('end zones stay permeable: a sideways step within the foot zone releases the boarding onto the floor', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    loco.constrain(-16.5, 5); // board at the foot (t = 0)
    // One step up, then sideways beyond the band while still in the entry
    // zone (t = 0.1 <= 0.6): the surface is within a step of the floor —
    // free exit, no rail.
    const [, cz] = loco.constrain(-16.6, 6.4);
    expect(cz).toBeCloseTo(6.4, 6);
    expect(loco.floorIndex()).toBe(0);
    expect(loco.elevation()).toBeCloseTo(0, 6);
  });

  it('end zones stay permeable at the head: stepping off sideways onto the floor-1 landing releases', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    for (const [x, z] of [
      [-16.5, 5],
      [-18, 5],
      [-20, 5],
      [-20.1, 5],
    ] as const) {
      loco.constrain(x, z);
    }
    expect(loco.floorIndex()).toBe(1); // at the head
    const [, cz] = loco.constrain(-20.1, 6.6); // sideways off the top step
    expect(cz).toBeCloseTo(6.6, 6);
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3.6, 6);
  });

  it('frame-stepped integration: climbing then pressing diagonally off-side never drops elevation', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    loco.constrain(-16.5, 5);
    const STEP = 2.6 / 60; // GYRE's walk speed at 60fps
    // Climb halfway up the run in per-frame steps.
    let prev = loco.elevation();
    for (let x = -16.5; x >= -18.3; x -= STEP) {
      loco.constrain(x, 5);
      expect(loco.elevation()).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = loco.elevation();
    }
    // Now press diagonally up-and-sideways: elevation may only keep rising
    // (rails hold the walker on the run) — the old model dropped it to 0
    // the frame the footprint check failed.
    let z = 5;
    for (let x = -18.3; x >= -20.0; x -= STEP) {
      z += STEP; // drifting north the whole way
      loco.constrain(x, z);
      expect(loco.elevation()).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = loco.elevation();
    }
    expect(loco.floorIndex()).toBe(0); // still mid-run (t < 3.5), floor unchanged
    expect(loco.elevation()).toBeGreaterThan(3.0);
  });
});

describe('createLayoutLocomotion — opts.obstacles (solid prop footprints)', () => {
  // A locker bank against the school stairwell room's north wall: rect
  // x in [-19, -17], z in [9, 9.6] on floor 0.
  const lockers = { floor: 0, rect: { type: 'rect', x: -19, z: 9, w: 2, d: 0.6 } as const };

  it('a walker cannot enter a solid footprint — pushed back the way they came', () => {
    const loco = createLayoutLocomotion(schoolWestStair(), { obstacles: [lockers] });
    loco.constrain(-18, 8.5); // just south of the locker bank
    const [, cz] = loco.constrain(-18, 9.3); // step into it
    expect(cz).toBeLessThanOrEqual(9); // held at the south face
    expect(loco.floorIndex()).toBe(0);
  });

  it('the same footprint on floor 0 does not block a floor-1 walker', () => {
    const loco = createLayoutLocomotion(schoolWestStair(), { startFloor: 1, obstacles: [lockers] });
    loco.constrain(-18, 8.5);
    const [, cz] = loco.constrain(-18, 9.3);
    expect(cz).toBeCloseTo(9.3, 6); // free — the lockers are a floor below
  });

  it('absent opts.obstacles is byte-identical to today: nothing blocks', () => {
    const loco = createLayoutLocomotion(schoolWestStair());
    loco.constrain(-18, 8.5);
    const [, cz] = loco.constrain(-18, 9.3);
    expect(cz).toBeCloseTo(9.3, 6);
  });
});

// ── createLayoutLocomotion — opts.isDoorOpen (door blocking) ───────────────
//
// twoFloorAtrium's floor-0 door: portals[0], connecting lobby [0..10]x[0..10]
// and stairhall [10..14]x[0..4], at [10, 2], width 1.2 -> gap rect
// x in [9.4, 10.6], z in [1.4, 2.6].

describe('createLayoutLocomotion — opts.isDoorOpen absent (default)', () => {
  it('is byte-identical to today\'s behavior: every door stays passable', () => {
    const withoutOpts = createLayoutLocomotion(twoFloorAtrium());
    const withOptsButNoCallback = createLayoutLocomotion(twoFloorAtrium(), {});
    expect(withoutOpts.constrain(10, 2)).toEqual([10, 2]);
    expect(withOptsButNoCallback.constrain(10, 2)).toEqual([10, 2]);
  });
});

describe('createLayoutLocomotion — opts.isDoorOpen (door blocking)', () => {
  it('a CLOSED door blocks crossing from the lobby side', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { isDoorOpen: () => false });
    // Approach the door head-on, aligned with its z-center, from inside
    // lobby, so the push-out below is purely along X (not a diagonal from
    // spawn) — isolates the "blocked at the threshold" behavior cleanly.
    loco.constrain(9.9, 2);
    // Now attempt to walk to the door's center: the gap footprint is now
    // solid, so the walker is pushed back out of it (biased toward
    // lastX/lastZ, i.e. back toward lobby) rather than passing through.
    const [x, z] = loco.constrain(10, 2);
    expect([x, z]).not.toEqual([10, 2]);
    // Pushed back to the gap rect's near (lobby-side) edge: x = 9.4.
    expect(x).toBeCloseTo(9.4, 6);
    expect(z).toBeCloseTo(2, 6);
  });

  it('a CLOSED door blocks crossing from the stairhall side too', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 0, isDoorOpen: () => false });
    // Start the walker on the stairhall side of the door.
    loco.constrain(11, 2);
    const [x, z] = loco.constrain(10, 2);
    expect([x, z]).not.toEqual([10, 2]);
    // Pushed back to the gap rect's near (stairhall-side) edge: x = 10.6.
    expect(x).toBeCloseTo(10.6, 6);
    expect(z).toBeCloseTo(2, 6);
  });

  it('an OPEN door (isDoorOpen returns true) passes through exactly like the default', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { isDoorOpen: () => true });
    expect(loco.constrain(10, 2)).toEqual([10, 2]);
  });

  it('flipping the door open mid-walk immediately allows passage on the next constrain() call', () => {
    let open = false;
    const loco = createLayoutLocomotion(twoFloorAtrium(), { isDoorOpen: () => open });

    const [bx] = loco.constrain(10, 2);
    expect(bx).toBeCloseTo(9.4, 6); // blocked while closed

    open = true; // flip the door open at runtime
    expect(loco.constrain(10, 2)).toEqual([10, 2]); // passes through immediately
  });

  it('flipping the door closed mid-walk blocks the very next crossing attempt', () => {
    let open = true;
    const loco = createLayoutLocomotion(twoFloorAtrium(), { isDoorOpen: () => open });

    expect(loco.constrain(10, 2)).toEqual([10, 2]); // passes while open

    open = false;
    const [x] = loco.constrain(10.5, 2); // still inside the gap rect, now solid
    expect(x).not.toBeCloseTo(10.5, 6);
  });

  it('a specific closed door only blocks ITS OWN gap — other movement is unaffected', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { isDoorOpen: () => false });
    // Plain interior movement, nowhere near the door.
    expect(loco.constrain(5, 5)).toEqual([5, 5]);
    // Clamped-to-wall movement (no door there) behaves exactly as without opts.
    const [x, z] = loco.constrain(-3, -3);
    expect(x).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(0, 6);
  });

  it('isDoorOpen receives the portal and its stable index into d.portals', () => {
    const d = twoFloorAtrium();
    const calls: Array<{ portal: unknown; index: number }> = [];
    const loco = createLayoutLocomotion(d, {
      isDoorOpen: (portal, index) => {
        calls.push({ portal, index });
        return true;
      },
    });
    loco.constrain(10, 2);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]!.index).toBe(0); // the door is d.portals[0]
    expect(calls[0]!.portal).toBe(d.portals[0]);
  });

  it('a closed door does not block stair traversal on an unrelated span', () => {
    // The stair (portals[1]) is untouched by a closed door elsewhere; climbing
    // it works exactly as in the non-door-blocking tests above.
    const loco = createLayoutLocomotion(twoFloorAtrium(), { isDoorOpen: () => false });
    loco.constrain(11, 1); // stair foot, t=0
    loco.constrain(14, 1); // stair head, t=run=3
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3, 6);
  });

  it('per-door control: closing one door leaves a second door on the same floor passable', () => {
    const d = twoFloorAtrium();
    // Add a second door, elsewhere on floor 0, between lobby and a new annex.
    d.floors[0]!.volumes.push({ id: 'annex', kind: 'room', shape: { type: 'rect', x: -4, z: 0, w: 4, d: 4 } });
    d.portals.push({ type: 'door', a: { floor: 0, volume: 'lobby' }, b: { floor: 0, volume: 'annex' }, at: [0, 2], width: 1.2 });

    const loco = createLayoutLocomotion(d, {
      // Close only the FIRST door (index 0, lobby/stairhall); leave the
      // second (index 2, lobby/annex) open.
      isDoorOpen: (_portal, index) => index !== 0,
    });

    const [bx] = loco.constrain(10, 2);
    expect(bx).toBeCloseTo(9.4, 6); // first door: blocked

    expect(loco.constrain(0, 2)).toEqual([0, 2]); // second door: passable
  });
});

// ── createLayoutLocomotion — void openings are unwalkable ──────────────────
//
// Gap found in the real consumer (GYRE's school): a floor-1 volume whose slab
// is cut by a VoidPortal (the atrium over the entrance hall) still treated
// its WHOLE rect as walkable in constrain() — a walker could stroll out over
// the hole and float above the atrium below. `layoutBounds`/`bounds()` alone
// can't catch this: v1 bounds clamping uses the volume's RECT HULL (the void
// opening is still "inside" that rect), so a point inside the hole reads as
// "already inside a volume" and is passed through unclamped. The fix mirrors
// `blockClosedDoors`: a final pass after the room/stair clamp treats each
// void opening that cuts the CURRENT floor's slab as a solid exclusion rect,
// pushing the walker back out (biased toward the previous position, via the
// same `pushOutOfRect` `blockClosedDoors` uses) — the implicit atrium railing.
//
// twoFloorAtrium's void: over floor 1's "gallery" [0..10]x[0..10], opening
// [2..5]x[2..5] (a 3x3 hole with a walkable ring around it, well inside the
// room). voidMargin defaults to 0 (flush edge).

describe('createLayoutLocomotion — void openings are unwalkable (default, no margin)', () => {
  it('a point deep inside the void opening is pushed back out toward the approach side (from -X)', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 });
    loco.constrain(1, 3.5); // just west of the opening, still in gallery, floor 1
    const [x, z] = loco.constrain(3.5, 3.5); // inside the opening [2..5]x[2..5]
    expect(x).toBeCloseTo(2, 6); // clamped to the opening's west edge
    expect(z).toBeCloseTo(3.5, 6);
  });

  it("approaching from +X clamps at the opening's east edge", () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 });
    loco.constrain(6, 3.5); // east of the opening
    const [x, z] = loco.constrain(3.5, 3.5);
    expect(x).toBeCloseTo(5, 6); // east edge
    expect(z).toBeCloseTo(3.5, 6);
  });

  it("approaching from -Z (north) clamps at the opening's north edge", () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 });
    loco.constrain(3.5, 1); // north of the opening
    const [x, z] = loco.constrain(3.5, 3.5);
    expect(x).toBeCloseTo(3.5, 6);
    expect(z).toBeCloseTo(2, 6); // north edge
  });

  it("approaching from +Z (south) clamps at the opening's south edge", () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 });
    loco.constrain(3.5, 6); // south of the opening
    const [x, z] = loco.constrain(3.5, 3.5);
    expect(x).toBeCloseTo(3.5, 6);
    expect(z).toBeCloseTo(5, 6); // south edge
  });

  it('walking AROUND the void on the remaining slab ring works freely', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 });
    // A ring path that skirts the [2..5]x[2..5] hole but stays on solid slab,
    // never entering the opening — every point should pass through unclamped.
    const ring: Array<[number, number]> = [
      [1, 1],
      [6, 1],
      [8, 3.5],
      [6, 7],
      [1, 7],
      [1, 3.5],
    ];
    for (const [x, z] of ring) {
      expect(loco.constrain(x, z)).toEqual([x, z]);
    }
  });

  it('a walker on the floor BELOW the void is unaffected (can stand under the atrium hole)', () => {
    // Floor 0's "lobby" occupies the SAME [0..10]x[0..10] footprint as floor
    // 1's "gallery" (whose slab is cut). A point matching the hole's XZ, but
    // on floor 0, must be untouched — it's solid ground looking UP through
    // the opening, not standing on the cut slab.
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 0 });
    expect(loco.constrain(3.5, 3.5)).toEqual([3.5, 3.5]);
  });

  it('a point exactly on the opening boundary is treated as inside (clamped, not passed through)', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 });
    loco.constrain(1, 3.5);
    const [x] = loco.constrain(2, 3.5); // exactly the west edge of the opening
    expect(x).toBeCloseTo(2, 6);
  });

  it('determinism: the same sequence of moves near a void produces the same sequence of states', () => {
    const walk = (loco: ReturnType<typeof createLayoutLocomotion>) => {
      const states: Array<[number, number]> = [];
      const moves: Array<[number, number]> = [
        [1, 3.5],
        [3.5, 3.5],
        [3.5, 1],
        [3.5, 3.5],
        [6, 3.5],
        [3.5, 3.5],
      ];
      for (const [x, z] of moves) states.push(loco.constrain(x, z));
      return states;
    };
    const a = walk(createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 }));
    const b = walk(createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 }));
    expect(a).toEqual(b);
  });
});

describe('createLayoutLocomotion — opts.voidMargin', () => {
  it('defaults to a flush edge (margin 0) — clamps exactly at the authored opening', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1 });
    loco.constrain(1, 3.5);
    const [x] = loco.constrain(3.5, 3.5);
    expect(x).toBeCloseTo(2, 6);
  });

  it('a positive margin keeps the walker back from the edge by that much', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1, voidMargin: 0.5 });
    loco.constrain(1, 3.5);
    const [x, z] = loco.constrain(3.5, 3.5); // still targets the same point
    expect(x).toBeCloseTo(2.5, 6); // opening's west edge (2) + margin (0.5)
    expect(z).toBeCloseTo(3.5, 6);
  });

  it('a negative margin is clamped to 0 rather than growing the hole', () => {
    const loco = createLayoutLocomotion(twoFloorAtrium(), { startFloor: 1, voidMargin: -1 });
    loco.constrain(1, 3.5);
    const [x] = loco.constrain(3.5, 3.5);
    expect(x).toBeCloseTo(2, 6); // same as margin 0, not shrunk further
  });
});

describe('createLayoutLocomotion — void exclusion composes with stairs (no fighting the overshoot latch)', () => {
  it('climbing the west stair to floor 1 and walking to the atrium ring, then into the hole, still clamps correctly', () => {
    const loco = createLayoutLocomotion(schoolWithAtrium());
    // Climb the west stair fully (mirrors the existing stair-regression tests).
    for (const [x, z] of [
      [-16.5, 5],
      [-18, 5],
      [-20, 5],
      [-20.1, 5],
    ] as const) {
      loco.constrain(x, z);
    }
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3.6, 6);

    // Walk from the stairwell, through corridor-1, into atrium-1, and up to
    // the void opening's edge — the stair's one-shot overshoot latch (armed
    // during the climb) must not interfere with this unrelated walk. First
    // clear the stair's lateral width band entirely (mirrors "real consumer
    // regression #2"'s own approach via a deep-room waypoint) before heading
    // east toward the atrium, so this test isolates VOID exclusion rather
    // than re-exercising the stair bounce-back edge case.
    const toAtrium: Array<[number, number]> = [
      [-20.1, 6.5], // deep in stairwell-w-1, clear of the stair's width band
      [-10, 6.5],
      [0, 6.5],
      [0, 4], // corridor-1 / atrium-1 doorway
      [0, 3], // inside atrium-1, south of the [-3..3]x[-2..2] void opening
    ];
    for (const [x, z] of toAtrium) {
      loco.constrain(x, z);
      expect(loco.floorIndex()).toBe(1); // never bounces back to floor 0
    }
    expect(loco.volumeAt()).toEqual({ floor: 1, volume: 'atrium-1' });

    // Now walk into the void opening — must clamp at its edge, not float over
    // it, and the stair-transition state must stay inert (still floor 1).
    // Approaching from [0,3] (south of the opening's [-3..3]x[-2..2] south
    // edge at z=2) toward the opening's center: pushOutOfRect biases toward
    // the approach side, clamping to the south edge (z=2).
    const [x, z] = loco.constrain(0, 0);
    expect(z).toBeCloseTo(2, 6);
    expect(x).toBeCloseTo(0, 6);
    expect(loco.floorIndex()).toBe(1);
  });

  it('a stair landing near solid floor-1 volumes (not the void) is unaffected by the void exclusion', () => {
    // Sanity: stairwell-w-1 and corridor-1 have no void over them — normal
    // stair transition + room clamping there is byte-identical to the
    // existing schoolWestStair regression tests, unaffected by adding the
    // unrelated atrium/void elsewhere in the same descriptor.
    const loco = createLayoutLocomotion(schoolWithAtrium());
    loco.constrain(-16.5, 5); // foot, t=0
    loco.constrain(-20, 5); // t=3.5, strict mid-run — arms the overshoot bridge
    loco.constrain(-20.2, 5); // t=3.7, overshoot past the head — transitions to floor 1
    expect(loco.floorIndex()).toBe(1);
    expect(loco.elevation()).toBeCloseTo(3.6, 6);
  });
});

describe('integration — void openings unwalkable in the school-shaped atrium fixture', () => {
  it('validates', () => {
    expect(validateLayout(schoolWithAtrium())).toEqual({ ok: true });
  });

  it('a walker on the atrium floor (1) cannot cross into the void opening', () => {
    const loco = createLayoutLocomotion(schoolWithAtrium(), { startFloor: 1 });
    loco.constrain(0, -3.5); // inside atrium-1, north of the opening [-3..3]x[-2..2]
    const [x, z] = loco.constrain(0, 0); // straight south into the opening's center
    expect(z).toBeCloseTo(-2, 6); // clamped to the opening's north edge
    expect(x).toBeCloseTo(0, 6);
  });

  it('a walker on the entrance hall floor (0), directly below the atrium void, is unaffected', () => {
    const loco = createLayoutLocomotion(schoolWithAtrium(), { startFloor: 0 });
    // entrance-hall shares the exact footprint of atrium-1/the void opening.
    expect(loco.constrain(0, 0)).toEqual([0, 0]);
  });

  it("walking the atrium's ring (around the void, never into it) stays free", () => {
    const loco = createLayoutLocomotion(schoolWithAtrium(), { startFloor: 1 });
    const ring: Array<[number, number]> = [
      [-4, -3],
      [4, -3],
      [4, 3],
      [-4, 3],
      [-4, -3],
    ];
    for (const [x, z] of ring) {
      expect(loco.constrain(x, z)).toEqual([x, z]);
    }
  });
});
