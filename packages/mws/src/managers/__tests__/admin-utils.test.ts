/**
 * Test harness for admin-utils CSRF protection
 *
 * Tests:
 * - Referer header validation
 * - CSRF protection for admin endpoints
 * - Allowed paths
 * - Blocked paths
 */

import { describe, it, expect, mock } from "bun:test";
import { admin } from "../admin-utils";

// Mock dependencies
const mockPrisma = {
  $transaction: mock(async (callback: any) => {
    return await callback(mockPrisma);
  }),
} as any;

describe("Admin Utils - CSRF Protection", () => {
  describe("Referer Header Validation", () => {
    it("should allow requests from /admin path", async () => {
      const route = admin(
        (z) => z.object({ test: z.string() }),
        async (state, prisma) => ({ success: true })
      );

      const mockState: any = {
        headers: {
          referer: "http://localhost:8080/admin",
          origin: "http://localhost:8080",
        },
        pathPrefix: "",
        $transaction: mockPrisma.$transaction,
        sendEmpty: mock((status: number, headers: Record<string, string>) => {
          throw { status, headers };
        }),
      };

      const result = await route.inner(mockState);
      expect(result).toEqual({ success: true });
      expect(mockState.asserted).toBe(true);
    });

    it("should allow requests from /admin/ subpaths", async () => {
      const route = admin(
        (z) => z.object({ test: z.string() }),
        async (state, prisma) => ({ success: true })
      );

      const mockState: any = {
        headers: {
          referer: "http://localhost:8080/admin/users",
          origin: "http://localhost:8080",
        },
        pathPrefix: "",
        $transaction: mockPrisma.$transaction,
        sendEmpty: mock((status: number, headers: Record<string, string>) => {
          throw { status, headers };
        }),
      };

      const result = await route.inner(mockState);
      expect(result).toEqual({ success: true });
      expect(mockState.asserted).toBe(true);
    });

    it("should allow requests from /admin-htmx path", async () => {
      const route = admin(
        (z) => z.object({ test: z.string() }),
        async (state, prisma) => ({ success: true })
      );

      const mockState: any = {
        headers: {
          referer: "http://localhost:8080/admin-htmx",
          origin: "http://localhost:8080",
        },
        pathPrefix: "",
        $transaction: mockPrisma.$transaction,
        sendEmpty: mock((status: number, headers: Record<string, string>) => {
          throw { status, headers };
        }),
      };

      const result = await route.inner(mockState);
      expect(result).toEqual({ success: true });
      expect(mockState.asserted).toBe(true);
    });

    it("should allow requests from /admin-htmx/ subpaths", async () => {
      const route = admin(
        (z) => z.object({ test: z.string() }),
        async (state, prisma) => ({ success: true })
      );

      const mockState: any = {
        headers: {
          referer: "http://localhost:8080/admin-htmx/profile",
          origin: "http://localhost:8080",
        },
        pathPrefix: "",
        $transaction: mockPrisma.$transaction,
        sendEmpty: mock((status: number, headers: Record<string, string>) => {
          throw { status, headers };
        }),
      };

      const result = await route.inner(mockState);
      expect(result).toEqual({ success: true });
      expect(mockState.asserted).toBe(true);
    });

    it("should allow requests from root path /", async () => {
      const route = admin(
        (z) => z.object({ test: z.string() }),
        async (state, prisma) => ({ success: true })
      );

      const mockState: any = {
        headers: {
          referer: "http://localhost:8080/",
          origin: "http://localhost:8080",
        },
        pathPrefix: "",
        $transaction: mockPrisma.$transaction,
        sendEmpty: mock((status: number, headers: Record<string, string>) => {
          throw { status, headers };
        }),
      };

      const result = await route.inner(mockState);
      expect(result).toEqual({ success: true });
      expect(mockState.asserted).toBe(true);
    });

    it("should allow requests from /login path", async () => {
      const route = admin(
        (z) => z.object({ test: z.string() }),
        async (state, prisma) => ({ success: true })
      );

      const mockState: any = {
        headers: {
          referer: "http://localhost:8080/login",
          origin: "http://localhost:8080",
        },
        pathPrefix: "",
        $transaction: mockPrisma.$transaction,
        sendEmpty: mock((status: number, headers: Record<string, string>) => {
          throw { status, headers };
        }),
      };

      const result = await route.inner(mockState);
      expect(result).toEqual({ success: true });
      expect(mockState.asserted).toBe(true);
    });

    it("should block requests from external domains", async () => {
      const route = admin(
        (z) => z.object({ test: z.string() }),
        async (state, prisma) => ({ success: true })
      );

      const mockState: any = {
        headers: {
          referer: "http://evil.com/admin",
          origin: "http://evil.com",
        },
        pathPrefix: "",
        sendEmpty: mock((status: number, headers: Record<string, string>) => {
          throw { status, headers };
        }),
      };

      await expect(route.inner(mockState)).rejects.toMatchObject({
        status: 400,
      });
    });

    it("should block requests with similar but different paths", async () => {
      const route = admin(
        (z) => z.object({ test: z.string() }),
        async (state, prisma) => ({ success: true })
      );

      const mockState: any = {
        headers: {
          referer: "http://localhost:8080/admin-htmx-evil",
          origin: "http://localhost:8080",
        },
        pathPrefix: "",
        sendEmpty: mock((status: number, headers: Record<string, string>) => {
          throw { status, headers };
        }),
      };

      await expect(route.inner(mockState)).rejects.toMatchObject({
        status: 400,
      });
    });

    it("should require referer header", async () => {
      const route = admin(
        (z) => z.object({ test: z.string() }),
        async (state, prisma) => ({ success: true })
      );

      const mockState: any = {
        headers: {
          origin: "http://localhost:8080",
        },
        pathPrefix: "",
        sendEmpty: mock((status: number, headers: Record<string, string>) => {
          throw { status, headers };
        }),
      };

      await expect(route.inner(mockState)).rejects.toMatchObject({
        status: 400,
        headers: { "x-reason": "Missing referer header" },
      });
    });

    it("should respect pathPrefix in validation", async () => {
      const route = admin(
        (z) => z.object({ test: z.string() }),
        async (state, prisma) => ({ success: true })
      );

      const mockState: any = {
        headers: {
          referer: "http://localhost:8080/wiki/admin-htmx",
          origin: "http://localhost:8080",
        },
        pathPrefix: "/wiki",
        $transaction: mockPrisma.$transaction,
        sendEmpty: mock((status: number, headers: Record<string, string>) => {
          throw { status, headers };
        }),
      };

      const result = await route.inner(mockState);
      expect(result).toEqual({ success: true });
      expect(mockState.asserted).toBe(true);
    });

    it("should block requests with wrong pathPrefix", async () => {
      const route = admin(
        (z) => z.object({ test: z.string() }),
        async (state, prisma) => ({ success: true })
      );

      const mockState: any = {
        headers: {
          referer: "http://localhost:8080/admin-htmx",
          origin: "http://localhost:8080",
        },
        pathPrefix: "/wiki",
        sendEmpty: mock((status: number, headers: Record<string, string>) => {
          throw { status, headers };
        }),
      };

      await expect(route.inner(mockState)).rejects.toMatchObject({
        status: 400,
      });
    });
  });

  describe("Transaction Handling", () => {
    it("should call inner handler within transaction", async () => {
      let transactionCalled = false;
      let innerCalled = false;

      const route = admin(
        (z) => z.object({ test: z.string() }),
        async (state, prisma) => {
          innerCalled = true;
          return { success: true };
        }
      );

      const mockState: any = {
        headers: {
          referer: "http://localhost:8080/admin-htmx",
          origin: "http://localhost:8080",
        },
        pathPrefix: "",
        $transaction: async (callback: any) => {
          transactionCalled = true;
          return await callback(mockPrisma);
        },
        sendEmpty: mock((status: number, headers: Record<string, string>) => {
          throw { status, headers };
        }),
      };

      const result = await route.inner(mockState);

      expect(transactionCalled).toBe(true);
      expect(innerCalled).toBe(true);
      expect(result).toEqual({ success: true });
    });
  });
});
