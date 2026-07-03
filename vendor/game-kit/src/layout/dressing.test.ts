import { describe, it, expect } from 'vitest';
import type { LayoutDescriptor } from './index.js';
import {
  dressLayout,
  propObstacles,
  type DressingRule,
  type GridRule,
  type WallLineRule,
  type AnchorRule,
  type ScatterRule,
  type PropPlacement,
} from './dressing.js';

// Pure placement-engine contract: rule -> PropPlacement resolution, door/stair/void
// exclusion, and determinism. No THREE — see module docs.

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A single 10x8 room, door mid-north-wall (at [5, 0]), no stairs/voids. */
function roomWithNorthDoor(): LayoutDescriptor {
  return {
    id: 'classroom',
    floors: [
      {
        elevation: 0,
        height: 3,
        volumes: [{ id: 'classroom-1', kind: 'room', shape: { type: 'rect', x: 0, z: 0, w: 10, d: 8 } }],
      },
    ],
    portals: [
      {
        type: 'door',
        a: { floor: 0, volume: 'classroom-1' },
        b: { floor: 0, volume: 'classroom-1' }, // self-ref is fine for gap geometry purposes here
        at: [5, 0],
        width: 1.2,
      },
    ],
    spawn: { floor: 0, pos: [5, 4] },
  };
}

/** A plain room with no portals — the simplest fixture for grid/scatter/anchor unit tests. */
function plainRoom(w = 10, dz = 8): LayoutDescriptor {
  return {
    id: 'plain',
    floors: [
      {
        elevation: 1.5,
        height: 3,
        volumes: [{ id: 'room-1', kind: 'room', shape: { type: 'rect', x: 0, z: 0, w, d: dz } }],
      },
    ],
    portals: [],
    spawn: { floor: 0, pos: [1, 1] },
  };
}

/**
 * The school-shaped two-floor integration fixture: ground floor has a
 * classroom (desk grid + board + teacher desk) and a corridor (lockers along
 * walls, door gaps, a stair up); floor 1 has a landing room the stair lands
 * in. Mirrors GYRE's prologue shape (see module report).
 */
function schoolFixture(): LayoutDescriptor {
  return {
    id: 'school',
    floors: [
      {
        elevation: 0,
        height: 3,
        volumes: [
          { id: 'classroom-1', kind: 'room', shape: { type: 'rect', x: 0, z: 0, w: 12, d: 9 } },
          { id: 'corridor-1', kind: 'hall', shape: { type: 'rect', x: 12, z: 0, w: 4, d: 9 } },
        ],
      },
      {
        elevation: 3,
        height: 3,
        volumes: [{ id: 'landing-1', kind: 'hall', shape: { type: 'rect', x: 12, z: 0, w: 4, d: 4 } }],
      },
    ],
    portals: [
      {
        type: 'door',
        a: { floor: 0, volume: 'classroom-1' },
        b: { floor: 0, volume: 'corridor-1' },
        at: [12, 4.5],
        width: 1.2,
      },
      {
        type: 'stair',
        from: { floor: 0, volume: 'corridor-1' },
        to: { floor: 1, volume: 'landing-1' },
        foot: [13, 7],
        dir: 0, // +X: rise 3 -> run 3 -> head [16, 7]... but landing is x:[12..16], z:[0..4] so clamp z instead
        width: 1.2,
      },
    ],
    spawn: { floor: 0, pos: [6, 4.5] },
    exits: [{ name: 'school-entry', floor: 0, at: [0, 4.5] }],
  };
}

const seed = 'gyre-school-prologue';

// ── grid ─────────────────────────────────────────────────────────────────────

describe('dressLayout — grid', () => {
  it('places rows x cols desks, all facing the given direction', () => {
    const d = plainRoom(10, 8);
    const rule: GridRule = {
      type: 'grid',
      match: { id: 'room-1' },
      propKind: 'desk',
      rows: 2,
      cols: 3,
      facing: Math.PI / 2, // facing +Z
      margin: 1,
    };
    const placements = dressLayout(d, [rule], 1);
    expect(placements).toHaveLength(6);
    for (const p of placements) {
      expect(p.kind).toBe('desk');
      expect(p.yaw).toBeCloseTo(Math.PI / 2);
      expect(p.volume).toEqual({ floor: 0, volume: 'room-1' });
      expect(p.pos[1]).toBeCloseTo(1.5); // sits on the floor's elevation
    }
  });

  it('faces a named wall (e.g. desks facing the board wall)', () => {
    const d = plainRoom(10, 8);
    const rule: GridRule = {
      type: 'grid',
      match: { id: 'room-1' },
      propKind: 'desk',
      rows: 1,
      cols: 1,
      facing: 'north',
    };
    const [p] = dressLayout(d, [rule], 1);
    // north wall's inward yaw points toward +Z.
    expect(p!.yaw).toBeCloseTo(Math.PI / 2);
  });

  it('keeps every placement within the margin-inset rect', () => {
    const d = plainRoom(10, 8);
    const margin = 1.5;
    const rule: GridRule = {
      type: 'grid',
      match: { id: 'room-1' },
      propKind: 'desk',
      rows: 3,
      cols: 4,
      facing: 0,
      margin,
      jitter: 0.4,
    };
    const placements = dressLayout(d, [rule], 42);
    for (const p of placements) {
      expect(p.pos[0]).toBeGreaterThanOrEqual(margin - 1e-6);
      expect(p.pos[0]).toBeLessThanOrEqual(10 - margin + 1e-6);
      expect(p.pos[2]).toBeGreaterThanOrEqual(margin - 1e-6);
      expect(p.pos[2]).toBeLessThanOrEqual(8 - margin + 1e-6);
    }
  });

  it('jitter perturbs positions deterministically but stays seed-stable', () => {
    const d = plainRoom(10, 8);
    const rule: GridRule = {
      type: 'grid',
      match: { id: 'room-1' },
      propKind: 'desk',
      rows: 2,
      cols: 2,
      facing: 0,
      jitter: 0.6,
    };
    const a = dressLayout(d, [rule], 7);
    const b = dressLayout(d, [rule], 7);
    expect(a).toEqual(b);
    // Not perfectly grid-aligned (jitter actually moved something) with high probability.
    const noJitterRule: GridRule = { ...rule, jitter: 0 };
    const straight = dressLayout(d, [noJitterRule], 7);
    const anyDifferent = a.some((p, i) => p.pos[0] !== straight[i]!.pos[0] || p.pos[2] !== straight[i]!.pos[2]);
    expect(anyDifferent).toBe(true);
  });

  it('only matches volumes satisfying DressingMatch (kind/id)', () => {
    const d = schoolFixture();
    const rule: GridRule = {
      type: 'grid',
      match: { kind: 'room' },
      propKind: 'desk',
      rows: 1,
      cols: 1,
      facing: 0,
    };
    const placements = dressLayout(d, [rule], 1);
    expect(placements.every((p) => p.volume.volume === 'classroom-1')).toBe(true);
  });
});

// ── wallLine ─────────────────────────────────────────────────────────────────

describe('dressLayout — wallLine', () => {
  it('places props along all four walls', () => {
    const d = plainRoom(10, 8);
    const rule: WallLineRule = {
      type: 'wallLine',
      match: { id: 'room-1' },
      propKind: 'locker',
      walls: 'all',
      spacing: 2,
      offset: 0.3,
      margin: 0.5,
    };
    const placements = dressLayout(d, [rule], 1);
    expect(placements.length).toBeGreaterThan(0);
    for (const p of placements) expect(p.kind).toBe('locker');
  });

  it('skips the door gap footprint on a wall with a door mid-wall', () => {
    const d = roomWithNorthDoor(); // door at [5, 0], width 1.2, on the north wall (z=0)
    const rule: WallLineRule = {
      type: 'wallLine',
      match: { id: 'classroom-1' },
      propKind: 'locker',
      walls: ['north'],
      spacing: 0.5, // dense spacing so we'd definitely hit the gap if unguarded
      offset: 0.3,
      margin: 0.2,
    };
    const placements = dressLayout(d, [rule], 1);
    expect(placements.length).toBeGreaterThan(0);
    const half = 1.2 / 2;
    for (const p of placements) {
      // No prop's X falls inside the door's gap span [5-0.6, 5+0.6].
      expect(p.pos[0] < 5 - half || p.pos[0] > 5 + half).toBe(true);
    }
  });

  it('respects offset (inward distance from the wall line)', () => {
    const d = plainRoom(10, 8);
    const rule: WallLineRule = {
      type: 'wallLine',
      match: { id: 'room-1' },
      propKind: 'locker',
      walls: ['west'],
      spacing: 2,
      offset: 0.5,
      margin: 0.5,
    };
    const placements = dressLayout(d, [rule], 1);
    expect(placements.length).toBeGreaterThan(0);
    for (const p of placements) {
      expect(p.pos[0]).toBeCloseTo(0.5); // west wall at x=0, offset inward +0.5
    }
  });
});

// ── anchor ───────────────────────────────────────────────────────────────────

describe('dressLayout — anchor', () => {
  it('places a single prop at the volume center', () => {
    const d = plainRoom(10, 8);
    const rule: AnchorRule = {
      type: 'anchor',
      match: { id: 'room-1' },
      propKind: 'teacher-desk',
      at: { type: 'center' },
    };
    const placements = dressLayout(d, [rule], 1);
    expect(placements).toHaveLength(1);
    expect(placements[0]!.pos[0]).toBeCloseTo(5);
    expect(placements[0]!.pos[2]).toBeCloseTo(4);
  });

  it('mounts a prop flush to a wall with the wall-facing yaw + elevation offset (e.g. a board)', () => {
    const d = plainRoom(10, 8);
    const rule: AnchorRule = {
      type: 'anchor',
      match: { id: 'room-1' },
      propKind: 'board',
      at: { type: 'wall', side: 'north' },
      mount: 'wall',
      elevationOffset: 1.4,
    };
    const [p] = dressLayout(d, [rule], 1);
    expect(p!.pos[0]).toBeCloseTo(5);
    expect(p!.pos[2]).toBeCloseTo(0); // flush to the north wall line (z=0)
    expect(p!.pos[1]).toBeCloseTo(1.5 + 1.4); // plainRoom's elevation is 1.5
    expect(p!.yaw).toBeCloseTo(Math.PI / 2); // facing into the room (+Z)
  });

  it('an explicit offset anchor is relative to the volume origin', () => {
    const d = plainRoom(10, 8);
    const rule: AnchorRule = {
      type: 'anchor',
      match: { id: 'room-1' },
      propKind: 'plant',
      at: { type: 'offset', x: 1, z: 1 },
    };
    const [p] = dressLayout(d, [rule], 1);
    expect(p!.pos[0]).toBeCloseTo(1);
    expect(p!.pos[2]).toBeCloseTo(1);
  });
});

// ── scatter ──────────────────────────────────────────────────────────────────

describe('dressLayout — scatter', () => {
  it('places up to `count` props, all within bounds and respecting min-distance', () => {
    const d = plainRoom(12, 10);
    const rule: ScatterRule = {
      type: 'scatter',
      match: { id: 'room-1' },
      propKind: 'bench',
      count: 8,
      minDistance: 1.5,
      margin: 0.5,
    };
    const placements = dressLayout(d, [rule], 99);
    expect(placements.length).toBeGreaterThan(0);
    expect(placements.length).toBeLessThanOrEqual(8);
    for (const p of placements) {
      expect(p.pos[0]).toBeGreaterThanOrEqual(0.5 - 1e-6);
      expect(p.pos[0]).toBeLessThanOrEqual(12 - 0.5 + 1e-6);
      expect(p.pos[2]).toBeGreaterThanOrEqual(0.5 - 1e-6);
      expect(p.pos[2]).toBeLessThanOrEqual(10 - 0.5 + 1e-6);
    }
    for (let i = 0; i < placements.length; i++) {
      for (let j = i + 1; j < placements.length; j++) {
        const dist = Math.hypot(placements[i]!.pos[0] - placements[j]!.pos[0], placements[i]!.pos[2] - placements[j]!.pos[2]);
        expect(dist).toBeGreaterThanOrEqual(1.5 - 1e-6);
      }
    }
  });

  it('gives up gracefully (fewer than count) when the volume is too small to fit them all', () => {
    const d = plainRoom(3, 3);
    const rule: ScatterRule = {
      type: 'scatter',
      match: { id: 'room-1' },
      propKind: 'bench',
      count: 50,
      minDistance: 2,
      margin: 0.2,
      maxAttempts: 20,
    };
    const placements = dressLayout(d, [rule], 5);
    expect(placements.length).toBeLessThan(50);
  });
});

// ── stair / void exclusion ───────────────────────────────────────────────────

describe('dressLayout — stair and void exclusion', () => {
  it('never places a grid prop inside a stair footprint', () => {
    const d = schoolFixture();
    const rule: GridRule = {
      type: 'grid',
      match: { id: 'corridor-1' },
      propKind: 'locker',
      rows: 4,
      cols: 2,
      facing: 0,
      margin: 0.1,
    };
    const placements = dressLayout(d, [rule], 1);
    // Stair foot [13,7] dir 0 rise 3 -> head [16,7], width 1.2 half=0.6 -> footprint x:[12.4,16.6] z:[6.4,7.6] (clipped by corridor 12..16)
    for (const p of placements) {
      const insideStairBox = p.pos[0] >= 12.4 && p.pos[0] <= 16.6 && p.pos[2] >= 6.4 && p.pos[2] <= 7.6;
      expect(insideStairBox).toBe(false);
    }
  });

  it('never places a scatter prop inside a void-portal opening', () => {
    const d: LayoutDescriptor = {
      id: 'atrium-scatter',
      floors: [
        {
          elevation: 0,
          height: 3,
          volumes: [{ id: 'below', kind: 'room', shape: { type: 'rect', x: 0, z: 0, w: 10, d: 10 } }],
        },
        {
          elevation: 3,
          height: 3,
          volumes: [{ id: 'gallery', kind: 'room', shape: { type: 'rect', x: 0, z: 0, w: 10, d: 10 } }],
        },
      ],
      portals: [
        {
          type: 'void',
          over: { floor: 1, volume: 'gallery' },
          opening: { type: 'rect', x: 3, z: 3, w: 4, d: 4 },
        },
      ],
      spawn: { floor: 0, pos: [1, 1] },
    };
    const rule: ScatterRule = {
      type: 'scatter',
      match: { id: 'gallery' },
      propKind: 'planter',
      count: 40,
      minDistance: 0.5,
      margin: 0.1,
      maxAttempts: 60,
    };
    const placements = dressLayout(d, [rule], 3);
    for (const p of placements) {
      const insideVoid = p.pos[0] >= 3 && p.pos[0] <= 7 && p.pos[2] >= 3 && p.pos[2] <= 7;
      expect(insideVoid).toBe(false);
    }
  });
});

// ── determinism ──────────────────────────────────────────────────────────────

describe('dressLayout — determinism', () => {
  it('two runs with the same inputs are deep-equal', () => {
    const d = schoolFixture();
    const rules: DressingRule[] = [
      { type: 'grid', match: { id: 'classroom-1' }, propKind: 'desk', rows: 3, cols: 4, facing: 'north', jitter: 0.3 },
      { type: 'wallLine', match: { id: 'corridor-1' }, propKind: 'locker', walls: 'all', spacing: 1.2 },
      { type: 'scatter', match: { id: 'corridor-1' }, propKind: 'debris', count: 5, minDistance: 0.5 },
    ];
    const a = dressLayout(d, rules, seed);
    const b = dressLayout(d, rules, seed);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('a string seed is stable across runs (hashStringToSeed)', () => {
    const d = plainRoom();
    const rule: ScatterRule = { type: 'scatter', match: { id: 'room-1' }, propKind: 'bench', count: 6, minDistance: 1 };
    const a = dressLayout(d, [rule], 'my-seed');
    const b = dressLayout(d, [rule], 'my-seed');
    expect(a).toEqual(b);
  });

  it('different seeds produce different scatter output', () => {
    const d = plainRoom(20, 20);
    const rule: ScatterRule = { type: 'scatter', match: { id: 'room-1' }, propKind: 'bench', count: 10, minDistance: 1 };
    const a = dressLayout(d, [rule], 1);
    const b = dressLayout(d, [rule], 2);
    expect(a).not.toEqual(b);
  });
});

// ── school-shaped integration fixture ───────────────────────────────────────

describe('dressLayout — school fixture integration', () => {
  it('dresses a classroom (desk grid + teacher desk + board) and a corridor (lockers) deterministically', () => {
    const d = schoolFixture();
    const rules: DressingRule[] = [
      { type: 'anchor', match: { id: 'classroom-1' }, propKind: 'board', at: { type: 'wall', side: 'north' }, mount: 'wall', elevationOffset: 1.4 },
      { type: 'anchor', match: { id: 'classroom-1' }, propKind: 'teacher-desk', at: { type: 'wall', side: 'north' } },
      { type: 'grid', match: { id: 'classroom-1' }, propKind: 'student-desk', rows: 3, cols: 4, facing: 'north', margin: 1.5, jitter: 0.15 },
      { type: 'wallLine', match: { id: 'corridor-1' }, propKind: 'locker', walls: ['east', 'west'], spacing: 1.2, offset: 0.35, margin: 0.4 },
      { type: 'scatter', match: { id: 'corridor-1' }, propKind: 'waiting-bench', count: 2, minDistance: 2 },
    ];

    const placements = dressLayout(d, rules, seed);
    const kinds = new Set(placements.map((p) => p.kind));
    expect(kinds).toEqual(new Set(['board', 'teacher-desk', 'student-desk', 'locker', 'waiting-bench']));

    // 12 desks requested; none should be excluded in this generous 12x9 room.
    expect(placements.filter((p) => p.kind === 'student-desk')).toHaveLength(12);

    // Lockers never land in the classroom<->corridor door gap at [12, 4.5] (width 1.2).
    const doorHalf = 0.6;
    for (const p of placements.filter((p) => p.kind === 'locker')) {
      const inGap = p.pos[2] > 4.5 - doorHalf && p.pos[2] < 4.5 + doorHalf && Math.abs(p.pos[0] - 12) < 0.5;
      expect(inGap).toBe(false);
    }

    // Determinism holds for the full multi-rule integration too.
    const again = dressLayout(d, rules, seed);
    expect(again).toEqual(placements);
  });
});

describe('propObstacles — solid footprints from placements', () => {
  const place = (kind: string, x: number, z: number, yaw: number, floor = 0): PropPlacement => ({
    kind,
    pos: [x, 0, z],
    yaw,
    volume: { floor, volume: 'classroom-1' },
  });

  it('emits an axis-aligned rect centered on the placement at yaw 0', () => {
    const obs = propObstacles([place('locker', 3, 4, 0)], { locker: { w: 1, d: 0.5 } });
    expect(obs).toHaveLength(1);
    expect(obs[0]!.floor).toBe(0);
    expect(obs[0]!.rect).toEqual({ type: 'rect', x: 2.5, z: 3.75, w: 1, d: 0.5 });
  });

  it('swaps w/d at yaw = π/2 (exact for right-angle yaws)', () => {
    const obs = propObstacles([place('locker', 3, 4, Math.PI / 2)], { locker: { w: 1, d: 0.5 } });
    const r = obs[0]!.rect;
    expect(r.w).toBeCloseTo(0.5, 6);
    expect(r.d).toBeCloseTo(1, 6);
    expect(r.x).toBeCloseTo(2.75, 6);
    expect(r.z).toBeCloseTo(3.5, 6);
  });

  it('kinds absent from the footprint map are ghost (pure decor)', () => {
    const obs = propObstacles(
      [place('locker', 3, 4, 0), place('paper', 5, 5, 0)],
      { locker: { w: 1, d: 0.5 } },
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]!.rect.x).toBeCloseTo(2.5, 6);
  });

  it('carries each placement volume floor through', () => {
    const obs = propObstacles([place('desk', 1, 1, 0, 1)], { desk: { w: 1.2, d: 0.7 } });
    expect(obs[0]!.floor).toBe(1);
  });

  it('degenerate footprints are skipped', () => {
    expect(propObstacles([place('dot', 1, 1, 0)], { dot: { w: 0, d: 1 } })).toHaveLength(0);
  });
});
