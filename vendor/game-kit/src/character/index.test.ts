import { describe, it, expect } from 'vitest';
// Pure clip state machine — no three / DOM / WebGL. Just name resolution + the
// one-shot→return-to-idle policy over a set of clip names.
import { createClipMachine } from './index.js';

// The clip set the auto-rig actually emits (idle/cast/guard/strike/hit), used
// across most tests. Walk is future — a couple of tests add it.
const RIG_CLIPS = ['idle', 'cast', 'guard', 'strike', 'hit'];

describe('createClipMachine — construction + defaults', () => {
  it('starts on idle by default', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    expect(m.current.name).toBe('idle');
    expect(m.current.loop).toBe(true);
    expect(m.idle).toBe('idle');
  });

  it('honors an explicit initial clip', () => {
    const m = createClipMachine({ clips: RIG_CLIPS, initial: 'guard' });
    expect(m.current.name).toBe('guard');
  });

  it('exposes the real (unresolved) clip names', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    expect(m.clips).toEqual(RIG_CLIPS);
  });

  it('is inert but safe with NO clips (static model)', () => {
    const m = createClipMachine({ clips: [] });
    expect(m.current.name).toBeNull();
    expect(m.idle).toBeNull();
    expect(m.play('cast')).toBeNull();
    expect(m.tick(1)).toBe(false); // never changes anything
    expect(m.current.name).toBeNull();
  });
});

describe('clip-name resolution — case + rig suffix tolerance', () => {
  it('resolves case-insensitively', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    expect(m.resolve('CAST')).toBe('cast');
    expect(m.resolve('Guard')).toBe('guard');
  });

  it('tolerates surrounding whitespace', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    expect(m.resolve('  hit  ')).toBe('hit');
  });

  it("strips the rig's _humanoid suffix on the CLIP side", () => {
    // The auto-rig names a clip Cast_humanoid; a game still asks for "cast".
    const m = createClipMachine({ clips: ['Idle_humanoid', 'Cast_humanoid', 'Strike_humanoid'] });
    expect(m.resolve('cast')).toBe('Cast_humanoid');
    expect(m.resolve('idle')).toBe('Idle_humanoid');
    expect(m.idle).toBe('Idle_humanoid');
  });

  it('strips a _humanoid suffix on the REQUEST side too', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    expect(m.resolve('Cast_humanoid')).toBe('cast');
  });

  it('also tolerates an _armature suffix', () => {
    const m = createClipMachine({ clips: ['idle_armature', 'strike_armature'] });
    expect(m.resolve('strike')).toBe('strike_armature');
  });

  it('returns null for an unknown clip', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    expect(m.resolve('teleport')).toBeNull();
  });

  it('first-wins: an exact clip is not shadowed by a suffixed duplicate', () => {
    const m = createClipMachine({ clips: ['idle', 'idle_humanoid'] });
    expect(m.resolve('idle')).toBe('idle');
  });
});

describe('play — loop inference + explicit override', () => {
  it('play(unknown) is a no-op that keeps the current clip', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    expect(m.play('nope')).toBeNull();
    expect(m.current.name).toBe('idle');
  });

  it('resolves + switches to a requested clip, returning the real name', () => {
    const m = createClipMachine({ clips: ['Cast_humanoid', 'Idle_humanoid'] });
    expect(m.play('cast')).toBe('Cast_humanoid');
    expect(m.current.name).toBe('Cast_humanoid');
  });

  it('infers idle/walk as looping and cast/strike as one-shots', () => {
    const m = createClipMachine({ clips: [...RIG_CLIPS, 'walk'] });
    m.play('walk');
    expect(m.current.loop).toBe(true);
    m.play('cast');
    expect(m.current.loop).toBe(false);
  });

  it('lets an explicit loop override hold a one-shot clip as a loop', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    m.play('guard', { loop: true });
    expect(m.current.loop).toBe(true);
    // A held loop never counts down.
    expect(m.tick(100)).toBe(false);
    expect(m.current.name).toBe('guard');
  });

  it('carries the crossfade through (default + per-play override)', () => {
    const m = createClipMachine({ clips: RIG_CLIPS, fade: 0.3 });
    m.play('cast');
    expect(m.current.fade).toBeCloseTo(0.3, 10);
    m.play('strike', { fade: 0.05 });
    expect(m.current.fade).toBeCloseTo(0.05, 10);
  });
});

describe('one-shot → auto-return-to-idle', () => {
  it('returns to idle after the one-shot duration elapses', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    m.play('cast', { duration: 1.0 });
    expect(m.current.name).toBe('cast');

    // Partway through — still casting, no change.
    expect(m.tick(0.4)).toBe(false);
    expect(m.current.name).toBe('cast');

    // Crossing the duration boundary flips back to idle (a change).
    expect(m.tick(0.7)).toBe(true);
    expect(m.current.name).toBe('idle');
    expect(m.current.loop).toBe(true);
  });

  it('reports no further change once already returned to idle', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    m.play('strike', { duration: 0.5 });
    m.tick(0.5); // → idle
    expect(m.tick(1)).toBe(false);
    expect(m.current.name).toBe('idle');
  });

  it('uses a clip duration set via setDuration when play omits one', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    m.setDuration('cast', 0.8);
    m.play('cast');
    expect(m.tick(0.5)).toBe(false); // still within 0.8s
    expect(m.current.name).toBe('cast');
    expect(m.tick(0.4)).toBe(true); // past 0.8s → idle
    expect(m.current.name).toBe('idle');
  });

  it('holds a one-shot with no known duration until re-driven', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    m.play('hit'); // no duration, none set
    expect(m.tick(1000)).toBe(false);
    expect(m.current.name).toBe('hit');
  });

  it('a looping clip never auto-returns', () => {
    const m = createClipMachine({ clips: [...RIG_CLIPS, 'walk'] });
    m.play('walk');
    expect(m.tick(100)).toBe(false);
    expect(m.current.name).toBe('walk');
  });

  it('re-triggering a one-shot restarts its countdown', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    m.play('cast', { duration: 1.0 });
    m.tick(0.8); // 0.2 left
    m.play('cast', { duration: 1.0 }); // restart
    expect(m.tick(0.5)).toBe(false); // 0.5 < 1.0 → still casting
    expect(m.current.name).toBe('cast');
  });

  it('holds the last pose (no return) when there is no idle clip', () => {
    const m = createClipMachine({ clips: ['cast', 'strike'] });
    m.play('cast', { duration: 0.5 });
    expect(m.tick(0.6)).toBe(false); // no idle to return to
    expect(m.current.name).toBe('cast');
    // And it stops counting, so it never thrashes.
    expect(m.tick(10)).toBe(false);
  });

  it('resolves the return-to-idle target through the rig suffix', () => {
    const m = createClipMachine({ clips: ['Idle_humanoid', 'Cast_humanoid'] });
    m.play('cast', { duration: 0.3 });
    expect(m.tick(0.4)).toBe(true);
    expect(m.current.name).toBe('Idle_humanoid');
  });
});

describe('tick — dt handling', () => {
  it('ignores negative dt (no time travel)', () => {
    const m = createClipMachine({ clips: RIG_CLIPS });
    m.play('cast', { duration: 1.0 });
    m.tick(-5); // ignored
    expect(m.current.name).toBe('cast');
    expect(m.tick(1.0)).toBe(true);
    expect(m.current.name).toBe('idle');
  });

  it('is deterministic: identical dt sequences yield identical state', () => {
    const run = (): (string | null)[] => {
      const m = createClipMachine({ clips: RIG_CLIPS });
      const out: (string | null)[] = [];
      m.play('cast', { duration: 1.0 });
      for (const dt of [0.3, 0.3, 0.3, 0.3]) {
        m.tick(dt);
        out.push(m.current.name);
      }
      return out;
    };
    expect(run()).toEqual(run());
    // And the boundary lands where expected: idle only after cumulative ≥ 1.0.
    expect(run()).toEqual(['cast', 'cast', 'cast', 'idle']);
  });
});
