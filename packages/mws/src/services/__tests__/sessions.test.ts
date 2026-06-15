/**
 * Login rate-limiting (batch 2): SessionManager.checkLoginRateLimit.
 * Time is injected via the `now` argument so the tests are deterministic (no fake timers).
 * Each test uses a unique username to avoid sharing the static in-memory map.
 */
import { describe, it, expect, afterEach } from "vitest";
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

  it("stays bounded under a spray of distinct fresh usernames", () => {
    // All within one window, so the staleness check can't reclaim them — the hard cap must.
    const cap = SessionManager.LOGIN_MAX_TRACKED;
    for (let i = 0; i < cap + 1000; i++) {
      SessionManager.checkLoginRateLimit("spray-" + i, 1_000 + i);
    }
    expect(SessionManager.loginTrackedCount).toBeLessThanOrEqual(cap);
  });
});

describe("SessionManager.parseIncomingRequest — Tailscale SSO", () => {
  const ORIG = process.env.MWS_TAILSCALE_SSO;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.MWS_TAILSCALE_SSO;
    else process.env.MWS_TAILSCALE_SSO = ORIG;
  });

  const alice = {
    tailscale_login: "alice@example.com", user_id: "u1", username: "alice",
    nickname: null, disabled: false, roles: [{ role_id: "r1", role_name: "USER" }],
  };
  // No session cookie; optional Tailscale identity header.
  const mkStreamer = (header: string | null) =>
    ({ cookies: { getAll: () => [] }, headers: header ? { "tailscale-user-login": header } : {} }) as any;
  // engine: no session; users.findUnique matches only the given user's tailscale_login.
  const mkConfig = (user: any) => ({
    engine: {
      sessions: { findFirst: async () => null },
      users: { findUnique: async ({ where }: any) => (user && where.tailscale_login === user.tailscale_login) ? user : null },
    },
  }) as any;
  const resolve = (header: string | null, user: any) =>
    SessionManager.parseIncomingRequest(mkStreamer(header), mkConfig(user));

  it("ignores the header when SSO is disabled", async () => {
    delete process.env.MWS_TAILSCALE_SSO;
    expect((await resolve("alice@example.com", alice)).isLoggedIn).toBe(false);
  });

  it("authenticates a mapped user when SSO is enabled (stateless, roles as mapped)", async () => {
    process.env.MWS_TAILSCALE_SSO = "1";
    const u = await resolve("alice@example.com", alice);
    expect(u.isLoggedIn).toBe(true);
    expect(u.username).toBe("alice");
    expect(u.sessionId).toBeUndefined();
  });

  it("denies an unmapped identity (no auto-provision)", async () => {
    process.env.MWS_TAILSCALE_SSO = "1";
    expect((await resolve("bob@example.com", alice)).isLoggedIn).toBe(false);
  });

  it("denies a disabled mapped user", async () => {
    process.env.MWS_TAILSCALE_SSO = "1";
    expect((await resolve("alice@example.com", { ...alice, disabled: true })).isLoggedIn).toBe(false);
  });

  it("is anonymous when no identity header is present", async () => {
    process.env.MWS_TAILSCALE_SSO = "1";
    expect((await resolve(null, alice)).isLoggedIn).toBe(false);
  });
});
