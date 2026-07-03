import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';
// The r3f wrapper mirrors the pure createSceneMachine's transitions into React
// state. jsdom + @testing-library give us React without a WebGL context — this
// exercises the state-mirroring bridge, not three.
import { useSceneMachine } from './r3f.js';
import type { SceneStates } from './index.js';

describe('useSceneMachine', () => {
  it('starts in the initial state', () => {
    const config: SceneStates = { a: {}, b: {} };
    const { result } = renderHook(() => useSceneMachine(config, 'a'));
    const [current, machine] = result.current;
    expect(current).toBe('a');
    expect(machine.current).toBe('a');
  });

  it('mirrors an explicit transition into React state', () => {
    const config: SceneStates = { a: {}, b: {} };
    const { result } = renderHook(() => useSceneMachine(config, 'a'));

    act(() => {
      result.current[1].transition('b');
    });

    expect(result.current[0]).toBe('b');
    expect(result.current[1].current).toBe('b');
  });

  it('mirrors an auto-transition returned from update(dt) into React state', () => {
    // 'a' auto-advances to 'b' once its update() has accumulated >= 1s.
    let t = 0;
    const config: SceneStates = {
      a: {
        update(dt: number): string | void {
          t += dt;
          if (t >= 1) return 'b';
        },
      },
      b: {},
    };
    const { result } = renderHook(() => useSceneMachine(config, 'a'));

    act(() => {
      result.current[1].update(0.5); // not yet
    });
    expect(result.current[0]).toBe('a');

    act(() => {
      result.current[1].update(0.6); // crosses 1s → auto-transition to 'b'
    });
    expect(result.current[0]).toBe('b');
  });

  it('runs the state-table lifecycle hooks (enter on the target)', () => {
    const entered: string[] = [];
    const config: SceneStates = {
      a: { enter: () => entered.push('a') },
      b: { enter: () => entered.push('b') },
    };
    const { result } = renderHook(() => useSceneMachine(config, 'a'));
    // Initial enter ran at construction.
    expect(entered).toEqual(['a']);

    act(() => {
      result.current[1].transition('b');
    });
    expect(entered).toEqual(['a', 'b']);
  });

  it('builds the machine once — a re-render with a new config does not rebuild', () => {
    const first: SceneStates = { a: {}, b: {} };
    const { result, rerender } = renderHook(
      ({ cfg }: { cfg: SceneStates }) => useSceneMachine(cfg, 'a'),
      { initialProps: { cfg: first } },
    );
    const machineRef = result.current[1];

    // Move to 'b', then re-render with a different config object.
    act(() => {
      result.current[1].transition('b');
    });
    rerender({ cfg: { a: {}, b: {}, c: {} } });

    // Same machine instance, state preserved (not reset to initial).
    expect(result.current[1]).toBe(machineRef);
    expect(result.current[0]).toBe('b');
  });
});
