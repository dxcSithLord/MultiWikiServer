/**
 * Access-model Batch 4 (audit) — the audit sink.
 *
 * Covers `recordAudit` (the single writer) and `actorLabel`. The sink must map
 * fields correctly, never throw (a failed write must not break the request), and
 * the label must fall back to "anon" and stay bounded.
 */

import { describe, it, expect, vi } from "vitest";
import { recordAudit, actorLabel } from "../audit";

function mockEngine() {
  const create = vi.fn(async (args: any) => args);
  return { engine: { auditLog: { create } } as any, create };
}

describe("Batch 4 — recordAudit", () => {
  it("writes one row, mapping fields and defaulting optionals to null", async () => {
    const { engine, create } = mockEngine();
    await recordAudit(engine, {
      action: "user.create", outcome: "success",
      actor_user_id: "u1", actor_label: "admin",
      target_type: "user", target_id: "u2", target_name: "bob",
      detail: { roles: 1 },
    });
    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      action: "user.create", outcome: "success",
      actor_user_id: "u1", actor_label: "admin",
      target_type: "user", target_id: "u2", target_name: "bob",
      detail: { roles: 1 },
    });
    // unset optionals normalise to null (not undefined)
    expect(data.source).toBeNull();
  });

  it("never throws when the write fails (swallows the error)", async () => {
    const engine = { auditLog: { create: vi.fn(async () => { throw new Error("db down"); }) } } as any;
    await expect(
      recordAudit(engine, { action: "login.failure", outcome: "denied", actor_label: "x" })
    ).resolves.toBeUndefined();
  });

  it("redacts sensitive keys from detail before persisting", async () => {
    const { engine, create } = mockEngine();
    await recordAudit(engine, {
      action: "user.update", outcome: "success", actor_label: "admin",
      detail: {
        password: "hunter2", session_key: "abc", token: "t", signature: "sig",
        Authorization: "Bearer x", cookie: "c", registrationRecord: "r",
        roles: 2, reason: "ok",
      },
    });
    const detail = create.mock.calls[0][0].data.detail;
    // sensitive values masked...
    for (const k of ["password", "session_key", "token", "signature", "Authorization", "cookie", "registrationRecord"])
      expect(detail[k]).toBe("[redacted]");
    // ...non-sensitive values preserved
    expect(detail.roles).toBe(2);
    expect(detail.reason).toBe("ok");
  });

  it("clips an over-long actor_label", async () => {
    const { engine, create } = mockEngine();
    const long = "a".repeat(500);
    await recordAudit(engine, { action: "login.failure", outcome: "denied", actor_label: long });
    expect(create.mock.calls[0][0].data.actor_label.length).toBe(200);
  });
});

describe("Batch 4 — actorLabel", () => {
  it("is 'anon' for a logged-out or missing user", () => {
    expect(actorLabel(null)).toBe("anon");
    expect(actorLabel({ isLoggedIn: false } as any)).toBe("anon");
  });
  it("uses the username when logged in", () => {
    expect(actorLabel({ isLoggedIn: true, username: "alice", user_id: "u1" } as any)).toBe("alice");
  });
});
