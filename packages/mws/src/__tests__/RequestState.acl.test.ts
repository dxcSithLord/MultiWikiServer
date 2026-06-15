/**
 * Access-model Batch 2 — least privilege for content.
 *
 * Verifies that getRecipeACL / getBagACL no longer special-case admins: the
 * read/write permission checks run the real ACL `findUnique` query for everyone,
 * including ADMIN-role users (previously admins short-circuited to a `SELECT 1`
 * that always passed). The non-write short-circuit (`SELECT 2` when needWrite is
 * false) is preserved.
 *
 * The methods are exercised against a tagged mock engine so we can assert WHICH
 * query each `$transaction` slot received, without standing up a real database.
 */
import { describe, it, expect } from "vitest";
import { StateObject } from "../RequestState";

// A query descriptor: the mock engine tags every query it builds so the test can
// tell an ACL findUnique apart from a bypass `$queryRaw`.
type Tagged = { kind: string; arg?: any; raw?: any };

function makeEngine() {
  const findUnique = (model: string) => (arg: any): Tagged => ({ kind: `${model}.findUnique`, arg });
  return {
    recipes: { findUnique: findUnique("recipes") },
    bags: { findUnique: findUnique("bags") },
    // tagged-template form: prisma.$queryRaw`SELECT 2`
    $queryRaw: (strings: TemplateStringsArray, ...values: any[]): Tagged =>
      ({ kind: "queryRaw", raw: strings.join("?") }),
    // return the slot array verbatim so canRead/canWrite are the descriptors above
    $transaction: async (arr: Tagged[]) => arr,
  };
}

function makeState(isAdmin: boolean) {
  const state = Object.create(StateObject.prototype) as any;
  state.engine = makeEngine();
  state.user = {
    isLoggedIn: true,
    isAdmin,
    user_id: "u1",
    roles: [{ role_id: "r-admin", role_name: "ADMIN" }],
  };
  // headers / pathPrefix are accessor properties on the StreamerState prototype;
  // shadow them with own data properties for the test instance.
  Object.defineProperty(state, "headers", { value: {}, configurable: true }); // no referer
  Object.defineProperty(state, "pathPrefix", { value: "", configurable: true });
  return state as InstanceType<typeof StateObject>;
}

describe("RequestState content ACL — admin least privilege (Batch 2)", () => {
  it("getRecipeACL runs the real ACL read query for an admin (no SELECT-1 bypass)", async () => {
    const state = makeState(true);
    const { canRead, canWrite } = await state.getRecipeACL("docs" as any, true) as any;
    expect(canRead.kind).toBe("recipes.findUnique");
    expect(canRead.arg.where.recipe_bags).toBeDefined();
    expect(canWrite.kind).toBe("recipes.findUnique");
    expect(canWrite.arg.where.recipe_bags.some.position).toBe(0);
  });

  it("getRecipeACL builds the identical query shape for admin and non-admin", async () => {
    const admin = await (makeState(true) as any).getRecipeACL("docs" as any, true);
    const user = await (makeState(false) as any).getRecipeACL("docs" as any, true);
    expect(admin.canRead).toEqual(user.canRead);
    expect(admin.canWrite).toEqual(user.canWrite);
  });

  it("getRecipeACL keeps the SELECT-2 short-circuit when needWrite is false", async () => {
    const { canWrite } = await (makeState(true) as any).getRecipeACL("docs" as any, false);
    expect(canWrite.kind).toBe("queryRaw");
  });

  it("getBagACL runs the real ACL read query for an admin (no SELECT-1 bypass)", async () => {
    const { canRead, canWrite } = await (makeState(true) as any).getBagACL("docs" as any, true);
    expect(canRead.kind).toBe("bags.findUnique");
    expect(canRead.arg.where.OR).toBeDefined();
    expect(canWrite.kind).toBe("bags.findUnique");
  });

  it("getBagACL keeps the SELECT-2 short-circuit when needWrite is false", async () => {
    const { canWrite } = await (makeState(true) as any).getBagACL("docs" as any, false);
    expect(canWrite.kind).toBe("queryRaw");
  });
});
