/**
 * Procgen world (descriptor-driven) — the kit module the biome editor tunes.
 *
 * `buildWorld(descriptor)` turns a serializable `WorldDescriptor` (terrain noise knobs +
 * palette + prop fields + environment) into a THREE.Group: a vertex-coloured, flat-shaded
 * fBm terrain plus scattered low-poly props. Deterministic — the same descriptor always
 * builds the same world (seeded via the kit's hashing noise + `prng`), so a saved/exported
 * descriptor round-trips exactly.
 *
 * three-dependent. The editor renders this live and exports the descriptor as JSON; a game
 * loads the same descriptor through the same `buildWorld`.
 */

import * as THREE from 'three';
import { createRng } from '../prng/index.js';

// ── Descriptor ────────────────────────────────────────────────────────────

export interface WorldTerrain {
  /** Seed for the terrain noise + prop scatter. */
  seed: number;
  /** World units across the (square) zone. */
  zoneSize: number;
  /** Grid resolution (segments per side); higher = finer mesh. */
  meshSegments: number;
  /** Peak terrain height in world units. */
  maxHeight: number;
  /** fBm amplitude persistence per octave (0..1) — higher is rougher. */
  roughness: number;
  /** Base noise frequency (noise scale). */
  frequency: number;
  /** fBm octave count. */
  octaves: number;
  /** Per-vertex jitter for a hand-carved facet look. */
  facetNoise: number;
}

export interface WorldPalette {
  low: string;
  mid: string;
  high: string;
  rock: string;
  slope: string;
  peak: string;
}

export interface WorldPropField {
  /** Prop kind: 'conifer-tree' | 'crystal' | 'snow-drift' | 'rock' | (else a marker box). */
  id: string;
  /** How many to scatter. */
  density: number;
}

export interface WorldEnvironment {
  skyColor: string;
  horizonColor: string;
  fogColor: string;
  /** Linear fog density-ish factor (0 disables). */
  fogDensity: number;
  ambientTint: string;
}

/** A manually-placed object (the editor's "Place" tab). */
export type PlacementKind = 'prop' | 'landmark' | 'spawn';
export interface WorldPlacement {
  kind: PlacementKind;
  /** Prop/landmark id (ignored for `spawn`). */
  id: string;
  /** World XZ; Y is sampled from the terrain at build time. */
  x: number;
  z: number;
}

export interface WorldDescriptor {
  terrain: WorldTerrain;
  palette: WorldPalette;
  props: WorldPropField[];
  environment: WorldEnvironment;
  /** Hand-placed objects on top of the scattered prop fields. */
  placements?: WorldPlacement[];
  /** A path/trail as world XZ points (rendered as a line along the terrain). */
  trail?: Array<[number, number]>;
}

/** A sensible starting descriptor (a snowy hub, à la the editor's default). */
export const DEFAULT_WORLD: WorldDescriptor = {
  terrain: {
    seed: 1,
    zoneSize: 80,
    meshSegments: 40,
    maxHeight: 6,
    roughness: 0.5,
    frequency: 0.06,
    octaves: 4,
    facetNoise: 0.12,
  },
  palette: {
    low: '#3f7d34',
    mid: '#6f9c52',
    high: '#cfd8dc',
    rock: '#8a8d91',
    slope: '#a7b0b5',
    peak: '#ffffff',
  },
  props: [
    { id: 'conifer-tree', density: 22 },
    { id: 'crystal', density: 8 },
    { id: 'snow-drift', density: 64 },
  ],
  environment: {
    skyColor: '#2a3a5a',
    horizonColor: '#b9a6a0',
    fogColor: '#cdd6e0',
    fogDensity: 0.012,
    ambientTint: '#ffffff',
  },
};

// ── Deterministic fBm value noise ───────────────────────────────────────────

function hash2(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2654435761)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const v00 = hash2(ix, iy, seed);
  const v10 = hash2(ix + 1, iy, seed);
  const v01 = hash2(ix, iy + 1, seed);
  const v11 = hash2(ix + 1, iy + 1, seed);
  const sx = smooth(fx);
  const sy = smooth(fy);
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

/** fBm in [0, 1]. */
function fbm(x: number, y: number, t: WorldTerrain): number {
  let amp = 1;
  let freq = t.frequency;
  let sum = 0;
  let norm = 0;
  const octaves = Math.max(1, Math.floor(t.octaves));
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise(x * freq, y * freq, t.seed + o * 101) * amp;
    norm += amp;
    amp *= t.roughness;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Sample terrain height at world (x, z). Pure — props use it to sit on the surface. */
export function sampleHeight(terrain: WorldTerrain, x: number, z: number): number {
  return fbm(x, z, terrain) * terrain.maxHeight;
}

// ── Terrain geometry + colouring ────────────────────────────────────────────

function buildTerrain(d: WorldDescriptor): THREE.Mesh {
  const t = d.terrain;
  const seg = Math.max(1, Math.floor(t.meshSegments));
  const geo = new THREE.PlaneGeometry(t.zoneSize, t.zoneSize, seg, seg);
  geo.rotateX(-Math.PI / 2); // into the XZ plane, Y up

  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const jitterRng = createRng((t.seed ^ 0x9e3779b9) >>> 0);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const jitter = (jitterRng.next() * 2 - 1) * t.facetNoise;
    pos.setY(i, sampleHeight(t, x, z) + jitter);
  }

  const flat = geo.toNonIndexed();
  flat.computeVertexNormals();
  paintTerrain(flat, d);
  geo.dispose();

  const mesh = new THREE.Mesh(
    flat,
    new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 1, metalness: 0 }),
  );
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

/** Per-vertex colour by height band + slope (steep → rock, peaks → peak colour). */
function paintTerrain(geo: THREE.BufferGeometry, d: WorldDescriptor): void {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const nrm = geo.getAttribute('normal') as THREE.BufferAttribute;
  const p = d.palette;
  const low = new THREE.Color(p.low);
  const mid = new THREE.Color(p.mid);
  const high = new THREE.Color(p.high);
  const rock = new THREE.Color(p.rock);
  const slope = new THREE.Color(p.slope);
  const peak = new THREE.Color(p.peak);

  const maxH = Math.max(0.0001, d.terrain.maxHeight);
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const hr = Math.min(1, Math.max(0, pos.getY(i) / maxH));
    if (hr > 0.85) c.copy(peak);
    else if (hr < 0.33) c.copy(low);
    else if (hr < 0.66) c.copy(mid);
    else c.copy(high);

    // Steep faces read as rock/slope regardless of height.
    const ny = nrm.getY(i);
    if (ny < 0.6) c.copy(rock);
    else if (ny < 0.8) c.lerp(slope, 0.5);

    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// ── Props ───────────────────────────────────────────────────────────────────

function makeProp(id: string, rng: ReturnType<typeof createRng>): THREE.Object3D {
  if (id === 'conifer-tree') {
    const tree = new THREE.Group();
    const h = 1.2 + rng.next() * 1.6;
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.12, 0.16, h, 5),
      new THREE.MeshStandardMaterial({ color: 0x6b4a2f, flatShading: true, roughness: 1 }),
    );
    trunk.position.y = h / 2;
    const foliage = new THREE.Mesh(
      new THREE.ConeGeometry(0.7 + rng.next() * 0.4, 1.6, 6),
      new THREE.MeshStandardMaterial({ color: 0x2f6d34, flatShading: true, roughness: 1 }),
    );
    foliage.position.y = h + 0.4;
    tree.add(trunk, foliage);
    tree.traverse((o) => (o.castShadow = true));
    return tree;
  }
  if (id === 'crystal') {
    const m = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.4 + rng.next() * 0.4, 0),
      new THREE.MeshStandardMaterial({ color: 0x7fd3ff, emissive: 0x2a6fa0, flatShading: true, toneMapped: false }),
    );
    m.position.y = 0.4;
    m.castShadow = true;
    return m;
  }
  if (id === 'snow-drift') {
    const m = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.3 + rng.next() * 0.5, 0),
      new THREE.MeshStandardMaterial({ color: 0xeef3f7, flatShading: true, roughness: 1 }),
    );
    m.scale.y = 0.4;
    m.position.y = 0.1;
    return m;
  }
  if (id === 'rock') {
    const m = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.3 + rng.next() * 0.6, 0),
      new THREE.MeshStandardMaterial({ color: 0x8a8d91, flatShading: true, roughness: 1 }),
    );
    m.position.y = 0.2;
    m.castShadow = true;
    return m;
  }
  // Unknown id → a small marker box so it's visible + diagnosable.
  return new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 0.4, 0.4),
    new THREE.MeshStandardMaterial({ color: 0xff00ff, flatShading: true }),
  );
}

/** A simple low-poly building for a `landmark` placement. */
function makeLandmark(_id: string): THREE.Object3D {
  const house = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(2.4, 1.6, 3.2),
    new THREE.MeshStandardMaterial({ color: 0x6b5640, flatShading: true, roughness: 1 }),
  );
  body.position.y = 0.8;
  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(2.4, 1.2, 4),
    new THREE.MeshStandardMaterial({ color: 0x4a3526, flatShading: true, roughness: 1 }),
  );
  roof.position.y = 2.2;
  roof.rotation.y = Math.PI / 4;
  house.add(body, roof);
  house.traverse((o) => (o.castShadow = true));
  return house;
}

/** A glowing ring marking a `spawn` placement. */
function makeSpawnMarker(): THREE.Object3D {
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.8, 0.08, 8, 24),
    new THREE.MeshStandardMaterial({ color: 0x7fffd4, emissive: 0x2fa074, toneMapped: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  return ring;
}

/** Hand-placed objects (placements) at explicit positions, snapped to the terrain. */
function buildPlacements(d: WorldDescriptor): THREE.Group {
  const group = new THREE.Group();
  group.name = 'placements';
  const placements = d.placements ?? [];
  placements.forEach((pl, i) => {
    const rng = createRng((d.terrain.seed + i * 131 + 1) >>> 0);
    let obj: THREE.Object3D;
    if (pl.kind === 'spawn') obj = makeSpawnMarker();
    else if (pl.kind === 'landmark') obj = makeLandmark(pl.id);
    else obj = makeProp(pl.id, rng);
    obj.position.set(pl.x, sampleHeight(d.terrain, pl.x, pl.z) + obj.position.y, pl.z);
    group.add(obj);
  });
  return group;
}

/** A trail/path line that follows the terrain surface. Null when fewer than 2 points. */
function buildTrail(d: WorldDescriptor): THREE.Object3D | null {
  const points = d.trail ?? [];
  if (points.length < 2) return null;
  const pts = points.map(
    ([x, z]) => new THREE.Vector3(x, sampleHeight(d.terrain, x, z) + 0.15, z),
  );
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffcf66 }));
  line.name = 'trail';
  return line;
}

function scatterProps(d: WorldDescriptor): THREE.Group {
  const group = new THREE.Group();
  group.name = 'props';
  const half = d.terrain.zoneSize / 2;

  d.props.forEach((field, fi) => {
    const count = Math.max(0, Math.floor(field.density));
    const rng = createRng((d.terrain.seed + fi * 7919) >>> 0);
    for (let i = 0; i < count; i++) {
      const x = (rng.next() * 2 - 1) * half;
      const z = (rng.next() * 2 - 1) * half;
      const obj = makeProp(field.id, rng);
      obj.position.set(x, sampleHeight(d.terrain, x, z) + obj.position.y, z);
      obj.rotation.y = rng.next() * Math.PI * 2;
      group.add(obj);
    }
  });
  return group;
}

/**
 * Build the world Group (terrain + props) from a descriptor. Deterministic. Apply the
 * environment (sky/fog) yourself from `descriptor.environment` — kept out of the Group so
 * the editor owns the scene background/fog.
 */
export function buildWorld(descriptor: WorldDescriptor): THREE.Group {
  const world = new THREE.Group();
  world.name = 'world';
  world.add(buildTerrain(descriptor));
  world.add(scatterProps(descriptor));
  world.add(buildPlacements(descriptor));
  const trail = buildTrail(descriptor);
  if (trail) world.add(trail);
  return world;
}
