import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/ratelimit.js';

describe('RateLimiter', () => {
  it('blocks after the limit and reports the wait, then recovers', () => {
    let t = 1_000_000;
    const rl = new RateLimiter(3, 60_000, () => t);
    for (let i = 0; i < 2; i++) rl.hit('k');
    expect(rl.blockedFor('k')).toBe(0);
    rl.hit('k');
    expect(rl.blockedFor('k')).toBe(60);
    t += 30_000;
    expect(rl.blockedFor('k')).toBe(30);
    t += 30_000; // window over
    expect(rl.blockedFor('k')).toBe(0);
    rl.hit('k');
    expect(rl.blockedFor('k')).toBe(0);
  });

  it('keeps keys independent and supports reset', () => {
    const rl = new RateLimiter(1, 60_000);
    rl.hit('a');
    expect(rl.blockedFor('a')).toBeGreaterThan(0);
    expect(rl.blockedFor('b')).toBe(0);
    rl.reset('a');
    expect(rl.blockedFor('a')).toBe(0);
  });

  it('does not count checks as hits', () => {
    const rl = new RateLimiter(1, 60_000);
    for (let i = 0; i < 10; i++) rl.blockedFor('a');
    expect(rl.blockedFor('a')).toBe(0);
  });
});
