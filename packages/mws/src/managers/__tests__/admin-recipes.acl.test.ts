/**
 * Access-model Batch 3 — WIKI_ADMIN structural authorization.
 *
 * Covers `RecipeManager.assertCreateOrUpdate` (the create/update gate shared by
 * recipe_create_or_update / bag_create_or_update) and the `hasWikiAdmin` helper.
 * Least-privilege intent: creating a recipe/bag now requires site-admin or the
 * WIKI_ADMIN role (previously any logged-in user); editing requires admin,
 * WIKI_ADMIN, or ownership.
 */

import { describe, it, expect, vi } from "vitest";
import { RecipeManager } from "../admin-recipes";
import { hasWikiAdmin } from "../../services/roles";

const mgr = new RecipeManager();

const userWith = (opts: { isAdmin?: boolean; roleNames?: string[]; user_id?: string; isLoggedIn?: boolean }): any => ({
  isLoggedIn: opts.isLoggedIn ?? true,
  user_id: opts.user_id ?? "u1",
  isAdmin: opts.isAdmin ?? false,
  roles: (opts.roleNames ?? []).map((role_name, i) => ({ role_id: `r${i}`, role_name })),
});

const PLAIN = userWith({ roleNames: ["USER"] });
const WIKI = userWith({ roleNames: ["USER", "WIKI_ADMIN"] });
const ADMIN = userWith({ isAdmin: true, roleNames: ["ADMIN"] });

const call = (existing: any, isCreate: boolean, user: any, owner_id?: any) =>
  () => mgr.assertCreateOrUpdate({ existing, isCreate, owner_id, type: "recipe", user });

describe("Batch 3 — assertCreateOrUpdate (structural gate)", () => {
  it("rejects an unauthenticated user", () => {
    expect(call(null, true, userWith({ isLoggedIn: false }))).toThrow(/not authenticated/);
  });

  it("rejects a plain USER creating a recipe", () => {
    expect(call(null, true, PLAIN)).toThrow(/WIKI_ADMIN/);
  });

  it("allows a WIKI_ADMIN to create a recipe", () => {
    expect(call(null, true, WIKI)).not.toThrow();
  });

  it("allows a site-admin to create a recipe", () => {
    expect(call(null, true, ADMIN)).not.toThrow();
  });

  it("rejects a create-via-upsert (isCreate=false, no existing) for a plain USER", () => {
    // The upsert path passes create_only=false; `!existing` still gates it.
    expect(call(null, false, PLAIN)).toThrow(/WIKI_ADMIN/);
  });

  it("allows the owner to edit their existing recipe", () => {
    expect(call({ owner_id: "u1" }, false, PLAIN)).not.toThrow();
  });

  it("rejects a non-owner plain USER editing an existing recipe", () => {
    expect(call({ owner_id: "someone-else" }, false, PLAIN)).toThrow(/does not own/);
  });

  it("allows a WIKI_ADMIN to edit a recipe they do not own", () => {
    expect(call({ owner_id: "someone-else" }, false, WIKI)).not.toThrow();
  });

  it("keeps owner_id assignment site-admin-only (WIKI_ADMIN cannot)", () => {
    expect(call(null, true, WIKI, "someone-else")).toThrow(/owner_id is only valid for admins/);
    expect(call(null, true, ADMIN, "someone-else")).not.toThrow();
  });
});

describe("Batch 3 — hasWikiAdmin", () => {
  it("is true when the WIKI_ADMIN role is present", () => {
    expect(hasWikiAdmin(WIKI)).toBe(true);
  });
  it("is false for a plain USER", () => {
    expect(hasWikiAdmin(PLAIN)).toBe(false);
  });
  it("is false (not throwing) when roles is missing", () => {
    expect(hasWikiAdmin({} as any)).toBe(false);
  });
});

// Representative manager -> audit-sink data-flow test (Batch 4a). All 14 admin/structural
// emit points use the identical `recordAudit(state.engine, {...})` wiring; this exercises one
// end to end (recipe_delete) through the real admin() route, confirming the row is written via
// the ROOT engine (state.engine), not the request transaction client.
describe("Batch 4a — manager audit emit (recipe_delete)", () => {
  it("writes a recipe.delete audit row via state.engine", async () => {
    const auditCreate = vi.fn(async () => ({}));
    const txnPrisma = {
      recipes: {
        findUnique: async () => ({ recipe_id: "rec1", recipe_name: "docs", owner_id: null }),
        delete: async () => ({}),
      },
    };
    const state: any = {
      headers: { referer: "http://h/admin", host: "h", origin: "http://h" }, // CSRF passes
      pathPrefix: "",
      data: { recipe_name: "docs" },
      user: { isLoggedIn: true, user_id: "admin1", isAdmin: true, roles: [{ role_id: "r", role_name: "ADMIN" }] },
      engine: { auditLog: { create: auditCreate } },           // ROOT engine (audit sink)
      $transaction: async (cb: any) => cb(txnPrisma),           // request txn client (NOT the engine)
      sendEmpty: (s: number, h: any) => { throw { s, h }; },
    };

    await mgr.recipe_delete.inner(state);

    expect(auditCreate).toHaveBeenCalledTimes(1);
    const data = auditCreate.mock.calls[0][0].data;
    expect(data.action).toBe("recipe.delete");
    expect(data.outcome).toBe("success");
    expect(data.target_type).toBe("recipe");
    expect(data.target_name).toBe("docs");
  });
});
