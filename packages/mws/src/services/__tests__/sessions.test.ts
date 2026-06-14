/**
 * Login rate-limiting (batch 2): SessionManager.checkLoginRateLimit.
 * Time is injected via the `now` argument so the tests are deterministic (no fake timers).
 * Each test uses a unique username to avoid sharing the static in-memory map.
 */
import { describe, it, expect } from "vitest";
import { SessionManager } from "../sessions";

const MAX = SessionManager.LOGIN_MAX_ATTEMPTS;
const WINDOW = SessionManager.LOGIN_WINDOW_MS;
const LOCKOUT = SessionManager.LOGIN_LOCKOUT_MS;

describe("SessionManager.checkLoginRateLimit", () => {
  it("allows up to LOGIN_MAX_ATTEMPTS starts in the window, then locks out", () => {
    const u = "rl-user-burst";
    const t0 = 1_000_000;
    for (let i = 0; i < MAX; i++) {
      expect(() => SessionManager.checkLoginRateLimit(u, t0 + i)).not.toThrow();
    }
    // The attempt past the cap trips the lockout, and it stays locked.
    expect(() => SessionManager.checkLoginRateLimit(u, t0 + MAX)).toThrow(/Too many login attempts/);
    expect(() => SessionManager.checkLoginRateLimit(u, t0 + MAX + 5)).toThrow(/Too many login attempts/);
  });

  it("unlocks after the lockout period elapses", () => {
    const u = "rl-user-unlock";
    const t0 = 5_000_000;
    for (let i = 0; i <= MAX; i++) {
      try { SessionManager.checkLoginRateLimit(u, t0 + i); } catch { /* the (MAX+1)th locks */ }
    }
    expect(() => SessionManager.checkLoginRateLimit(u, t0 + 1000)).toThrow(/Too many login attempts/);
    // lockedUntil = (t0 + MAX) + LOCKOUT; just past it, attempts are allowed again.
    const after = t0 + MAX + LOCKOUT + 1;
    expect(() => SessionManager.checkLoginRateLimit(u, after)).not.toThrow();
  });

  it("does not lock out when attempts are spread beyond the window", () => {
    const u = "rl-user-spread";
    for (let i = 0; i < MAX + 5; i++) {
      const t = i * (WINDOW + 1000);
      expect(() => SessionManager.checkLoginRateLimit(u, t)).not.toThrow();
    }
  });
});
