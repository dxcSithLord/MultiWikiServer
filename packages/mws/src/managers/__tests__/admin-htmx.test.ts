/**
 * Test harness for HTMX Admin functionality
 *
 * Tests:
 * - Admin role authorization
 * - CSRF referer validation
 * - Event emissions
 * - Template rendering
 * - Profile route redirect
 * - Session handling
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
const mock = vi.fn;
import { ServerRequest, ServerRoute } from "@tiddlywiki/server";
import { serverEvents } from "@tiddlywiki/events";
import { HtmxAdminManager } from "../admin-htmx";

// Under vitest (running unbundled) dist_resolve anchors to packages/server/src, so the
// templates/styles dir mis-resolves to ".../packages/server/packages/mws/...". Redirect
// those reads to the real source path so the route handlers read the actual templates.
vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const fix = (p: any) =>
    typeof p === "string" ? p.replace("/packages/server/packages/mws/", "/packages/mws/") : p;
  return { ...actual, readFile: (p: any, ...rest: any[]) => actual.readFile(fix(p), ...rest) };
});

// Mock state helper
function createMockState(overrides: Partial<ServerRequest> = {}): ServerRequest {
  const defaultState: Partial<ServerRequest> = {
    pathPrefix: "",
    headers: {
      referer: "http://localhost:8080/admin-htmx",
      origin: "http://localhost:8080",
    },
    user: {
      user_id: "test-user-123",
      username: "testuser",
      isAdmin: true,
      roles: ["admin"],
    },
    okUser: function() {
      if (!this.user) throw new Error("Not authenticated");
      return this.user;
    },
    sendBuffer: mock((status: number, headers: Record<string, string>, body: Buffer) => {
      return { status, headers, body: body.toString() };
    }),
    sendEmpty: mock((status: number, headers: Record<string, string> = {}) => {
      throw { status, headers };
    }),
  };

  return { ...defaultState, ...overrides } as unknown as ServerRequest;
}

describe("HtmxAdminManager", () => {
  let mockRoot: ServerRoute;
  let capturedRoutes: Array<{
    config: { path: RegExp; method: string[] };
    handler: (state: ServerRequest) => Promise<any>;
  }>;
  let eventListeners: Map<string, Array<(...args: any[]) => void>>;

  beforeEach(() => {
    capturedRoutes = [];
    eventListeners = new Map();

    // Mock ServerRoute
    mockRoot = {
      defineRoute: mock((config, handler) => {
        capturedRoutes.push({ config, handler });
      }),
    } as unknown as ServerRoute;

    // Mock serverEvents
    const originalEmitAsync = serverEvents.emitAsync;
    serverEvents.emitAsync = mock(async (event: string, ...args: any[]) => {
      const listeners = eventListeners.get(event) || [];
      for (const listener of listeners) {
        await listener(...args);
      }
    }) as any;
  });

  afterEach(() => {
    capturedRoutes = [];
    eventListeners.clear();
  });

  describe("Route Registration", () => {
    it("should register profile route", () => {
      HtmxAdminManager.defineRoutes(mockRoot);

      expect(capturedRoutes.length).toBeGreaterThanOrEqual(2);

      const profileRoute = capturedRoutes.find(r =>
        r.config.path.toString().includes("profile")
      );

      expect(profileRoute).toBeDefined();
      expect(profileRoute?.config.method).toContain("GET");
    });

    it("should register main admin-htmx route", () => {
      HtmxAdminManager.defineRoutes(mockRoot);

      const mainRoute = capturedRoutes.find(r =>
        r.config.path.test("/admin-htmx") &&
        !r.config.path.toString().includes("profile")
      );

      expect(mainRoute).toBeDefined();
      expect(mainRoute?.config.method).toContain("GET");
    });
  });

  describe("Profile Route", () => {
    it("should redirect authenticated admin to their profile", async () => {
      HtmxAdminManager.defineRoutes(mockRoot);

      const profileRoute = capturedRoutes.find(r =>
        r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        user: {
          user_id: "user-123",
          username: "testuser",
          isAdmin: true,
          roles: ["admin"],
        },
      });

      const result = await profileRoute!.handler(state);

      expect(result.status).toBe(302);
      // Profile now redirects to the Users page, which opens the edit modal via ?editUser=.
      expect(result.headers.location).toContain("/admin-htmx/users?editUser=");
      expect(result.headers.location).toContain("user-123");
    });

    it("should return 403 for non-admin users", async () => {
      HtmxAdminManager.defineRoutes(mockRoot);

      const profileRoute = capturedRoutes.find(r =>
        r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        user: {
          user_id: "user-123",
          username: "normaluser",
          isAdmin: false,
          roles: [],
        },
      });

      const result = await profileRoute!.handler(state);

      expect(result.status).toBe(403);
      expect(result.body).toContain("403 Forbidden");
      expect(result.body).toContain("Admin access required");
    });

    it("should emit forbidden event for non-admin access", async () => {
      const forbiddenEvents: any[] = [];
      eventListeners.set("admin.htmx.page.forbidden", [
        (state, username) => {
          forbiddenEvents.push({ state, username });
        },
      ]);

      HtmxAdminManager.defineRoutes(mockRoot);

      const profileRoute = capturedRoutes.find(r =>
        r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        user: {
          user_id: "user-123",
          username: "normaluser",
          isAdmin: false,
          roles: [],
        },
      });

      await profileRoute!.handler(state);

      expect(forbiddenEvents.length).toBe(1);
      expect(forbiddenEvents[0].username).toBe("normaluser");
    });
  });

  describe("Main Admin HTMX Route", () => {
    it("should serve template to authenticated admin", async () => {
      HtmxAdminManager.defineRoutes(mockRoot);

      const mainRoute = capturedRoutes.find(r =>
        r.config.path.test("/admin-htmx") &&
        !r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        pathPrefix: "",
        user: {
          user_id: "admin-123",
          username: "adminuser",
          isAdmin: true,
          roles: ["admin"],
        },
      });

      const result = await mainRoute!.handler(state);

      expect(result.status).toBe(200);
      expect(result.headers["content-type"]).toContain("text/html");
      expect(result.body).toContain("<!DOCTYPE html>");
    });

    it("should land a non-admin on their wiki instead of 403", async () => {
      HtmxAdminManager.defineRoutes(mockRoot);

      const mainRoute = capturedRoutes.find(r =>
        r.config.path.test("/admin-htmx") &&
        !r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        user: {
          user_id: "user-123",
          username: "normaluser",
          isAdmin: false,
          roles: [{ role_id: "r1", role_name: "USER" }],
        },
        getBagWhereACL: () => [],
        engine: { recipes: { findFirst: async () => ({ recipe_name: "moving-house" }) } },
      } as any);

      const result = await mainRoute!.handler(state);

      expect(result.status).toBe(302);
      expect(result.headers.location).toContain("/wiki/moving-house");
    });

    it("should emit page accessed event for admin", async () => {
      const accessEvents: any[] = [];
      eventListeners.set("admin.htmx.page.accessed", [
        (state, isAdmin) => {
          accessEvents.push({ state, isAdmin });
        },
      ]);

      HtmxAdminManager.defineRoutes(mockRoot);

      const mainRoute = capturedRoutes.find(r =>
        r.config.path.test("/admin-htmx") &&
        !r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        user: {
          user_id: "admin-123",
          username: "adminuser",
          isAdmin: true,
          roles: ["admin"],
        },
      });

      await mainRoute!.handler(state);

      expect(accessEvents.length).toBe(1);
      expect(accessEvents[0].isAdmin).toBe(true);
    });

    it("should replace template variables", async () => {
      HtmxAdminManager.defineRoutes(mockRoot);

      const mainRoute = capturedRoutes.find(r =>
        r.config.path.test("/admin-htmx") &&
        !r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        pathPrefix: "/wiki",
        user: {
          user_id: "admin-123",
          username: "adminuser",
          isAdmin: true,
          roles: ["admin"],
        },
      });

      const result = await mainRoute!.handler(state);

      expect(result.body).toContain("/wiki");
      expect(result.body).toContain("adminuser");
      // (user_id is only rendered on the Users page, not the recipes frame.)
    });

    it("should escape HTML in template variables", async () => {
      HtmxAdminManager.defineRoutes(mockRoot);

      const mainRoute = capturedRoutes.find(r =>
        r.config.path.test("/admin-htmx") &&
        !r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        user: {
          user_id: "user-123",
          username: "<script>alert('xss')</script>",
          isAdmin: true,
          roles: ["admin"],
        },
      });

      const result = await mainRoute!.handler(state);

      expect(result.body).not.toContain("<script>alert('xss')</script>");
      expect(result.body).toContain("&lt;script&gt;");
    });
  });

  describe("Security", () => {
    it("should require authentication", async () => {
      HtmxAdminManager.defineRoutes(mockRoot);

      const mainRoute = capturedRoutes.find(r =>
        r.config.path.test("/admin-htmx") &&
        !r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        user: undefined,
        okUser: function() {
          throw new Error("Not authenticated");
        },
      });

      // Unauthenticated access is not an error — the route redirects (302) to /login.
      const result = await mainRoute!.handler(state);
      expect(result.status).toBe(302);
      expect(result.headers.location).toContain("/login");
    });

    it("should enforce admin role on profile route", async () => {
      HtmxAdminManager.defineRoutes(mockRoot);

      const profileRoute = capturedRoutes.find(r =>
        r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        user: {
          user_id: "user-123",
          username: "normaluser",
          isAdmin: false,
          roles: [],
        },
      });

      const result = await profileRoute!.handler(state);

      expect(result.status).toBe(403);
    });

    it("should redirect a non-admin to their first accessible wiki", async () => {
      HtmxAdminManager.defineRoutes(mockRoot);

      const mainRoute = capturedRoutes.find(r =>
        r.config.path.test("/admin-htmx") &&
        !r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        user: {
          user_id: "user-123",
          username: "normaluser",
          isAdmin: false,
          roles: [{ role_id: "r1", role_name: "USER" }],
        },
        getBagWhereACL: () => [],
        engine: { recipes: { findFirst: async () => ({ recipe_name: "family wiki" }) } },
      } as any);

      const result = await mainRoute!.handler(state);

      expect(result.status).toBe(302);
      expect(result.headers.location).toContain("/wiki/family%20wiki");
    });

    it("should show a friendly no-wiki page (200) when a non-admin has no access", async () => {
      HtmxAdminManager.defineRoutes(mockRoot);

      const mainRoute = capturedRoutes.find(r =>
        r.config.path.test("/admin-htmx") &&
        !r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        user: {
          user_id: "user-123",
          username: "normaluser",
          isAdmin: false,
          roles: [],
        },
        getBagWhereACL: () => [],
        engine: { recipes: { findFirst: async () => null } },
      } as any);

      const result = await mainRoute!.handler(state);

      expect(result.status).toBe(200);
      expect(result.body).toContain("No wikis assigned");
    });
  });

  describe("Event System Integration", () => {
    it("should emit admin.htmx.page.accessed with correct parameters", async () => {
      const events: Array<{ state: ServerRequest; isAdmin: boolean }> = [];

      eventListeners.set("admin.htmx.page.accessed", [
        (state, isAdmin) => {
          events.push({ state, isAdmin });
        },
      ]);

      HtmxAdminManager.defineRoutes(mockRoot);

      const mainRoute = capturedRoutes.find(r =>
        r.config.path.test("/admin-htmx") &&
        !r.config.path.toString().includes("profile")
      );

      const state = createMockState();
      await mainRoute!.handler(state);

      expect(events.length).toBe(1);
      expect(events[0].isAdmin).toBe(true);
      expect(events[0].state).toBeDefined();
    });

    it("should emit admin.htmx.page.forbidden with correct parameters", async () => {
      const events: Array<{ state: ServerRequest; username: string }> = [];

      eventListeners.set("admin.htmx.page.forbidden", [
        (state, username) => {
          events.push({ state, username });
        },
      ]);

      HtmxAdminManager.defineRoutes(mockRoot);

      // The main /admin-htmx route now lands non-admins on a wiki; the admin-only
      // pages (e.g. profile) still emit "forbidden" for a non-admin.
      const profileRoute = capturedRoutes.find(r =>
        r.config.path.toString().includes("profile")
      );

      const state = createMockState({
        user: {
          user_id: "user-123",
          username: "normaluser",
          isAdmin: false,
          roles: [],
        },
      });

      await profileRoute!.handler(state);

      expect(events.length).toBe(1);
      expect(events[0].username).toBe("normaluser");
      expect(events[0].state).toBeDefined();
    });
  });
});
