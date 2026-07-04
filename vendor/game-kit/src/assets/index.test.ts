import { describe, it, expect, vi } from 'vitest';
import { loadAssets, type AssetSpec, type AssetLoader } from './index.js';

// A fake loader that resolves the URL string after an optional tick, so tests
// never touch the network / DOM.
const fake =
  (delay = 0): AssetLoader =>
  (url) =>
    new Promise((r) => setTimeout(() => r(`loaded:${url}`), delay));

const specs = (n: number): AssetSpec[] =>
  Array.from({ length: n }, (_, i) => ({ id: `a${i}`, url: `/x/${i}.png`, kind: 'image' as const }));

describe('loadAssets', () => {
  it('loads all specs and exposes them by id', async () => {
    const store = await loadAssets(specs(3), { loaders: { image: fake() } });
    expect(store.ids.sort()).toEqual(['a0', 'a1', 'a2']);
    expect(store.get('a1')).toBe('loaded:/x/1.png');
    expect(store.has('a2')).toBe(true);
    expect(store.has('nope')).toBe(false);
    expect(store.errors).toEqual([]);
  });

  it('reports monotonic progress ending at ratio 1', async () => {
    const seen: number[] = [];
    await loadAssets(specs(4), {
      loaders: { image: fake() },
      onProgress: (p) => seen.push(p.loaded),
    });
    expect(seen).toEqual([1, 2, 3, 4]);
  });

  it('dedups by id (a repeated id loads once)', async () => {
    const load = vi.fn(fake());
    const dup: AssetSpec[] = [
      { id: 'x', url: '/x.png', kind: 'image' },
      { id: 'x', url: '/x-again.png', kind: 'image' },
      { id: 'y', url: '/y.png', kind: 'image' },
    ];
    const store = await loadAssets(dup, { loaders: { image: load } });
    expect(load).toHaveBeenCalledTimes(2);
    expect(store.ids.sort()).toEqual(['x', 'y']);
  });

  it('respects the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const loader: AssetLoader = (url) =>
      new Promise((r) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight--;
          r(url);
        }, 5);
      });
    await loadAssets(specs(10), { loaders: { image: loader }, concurrency: 3 });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('fail-fast: a load error rejects the batch with the offending id', async () => {
    const loader: AssetLoader = (url) =>
      url.includes('2') ? Promise.reject(new Error('boom')) : Promise.resolve(url);
    await expect(loadAssets(specs(4), { loaders: { image: loader }, concurrency: 1 })).rejects.toThrow(/a2/);
  });

  it('failSoft: collects errors and still resolves with the good assets', async () => {
    const loader: AssetLoader = (url) =>
      url.includes('2') ? Promise.reject(new Error('boom')) : Promise.resolve(`ok:${url}`);
    const store = await loadAssets(specs(4), { loaders: { image: loader }, failSoft: true });
    expect(store.has('a2')).toBe(false);
    expect(store.errors).toHaveLength(1);
    expect(store.errors[0]!.id).toBe('a2');
    expect(store.ids.sort()).toEqual(['a0', 'a1', 'a3']);
  });

  it('handles an empty batch (ratio 1, no work)', async () => {
    let ratio = -1;
    const store = await loadAssets([], { onProgress: (p) => (ratio = p.ratio) });
    expect(store.ids).toEqual([]);
    expect(ratio).toBe(-1); // no progress events for zero assets
  });

  it('routes by kind to the matching loader', async () => {
    const store = await loadAssets(
      [
        { id: 'img', url: '/a.png', kind: 'image' },
        { id: 'data', url: '/b.json', kind: 'json' },
      ],
      { loaders: { image: () => Promise.resolve('IMG'), json: () => Promise.resolve({ ok: 1 }) } },
    );
    expect(store.get('img')).toBe('IMG');
    expect(store.get<{ ok: number }>('data')).toEqual({ ok: 1 });
  });
});
