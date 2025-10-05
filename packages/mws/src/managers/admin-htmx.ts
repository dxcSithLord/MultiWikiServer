import { readFile } from "fs/promises";
import { resolve } from "path";
import { ServerRoute, dist_resolve, ServerRequest } from "@tiddlywiki/server";
import { serverEvents } from "@tiddlywiki/events";
import { createHash } from "crypto";

declare module "@tiddlywiki/events" {
  interface ServerEventsMap {
    "admin.htmx.page.accessed": [state: ServerRequest, isAdmin: boolean];
    "admin.htmx.page.forbidden": [state: ServerRequest, username: string];
  }
}

const templatesDir = dist_resolve("../packages/mws/src/templates");
const stylesDir = dist_resolve("../packages/mws/src/styles");

serverEvents.on("mws.routes", (root) => {
  HtmxAdminManager.defineRoutes(root);
});

export class HtmxAdminManager {
  private static cssCache: { content: string; etag: string } | null = null;

  /**
   * Get CSS content with ETag for caching
   * Caches in memory in production, reads from disk in development
   */
  private static async getCss(): Promise<{ content: string; etag: string }> {
    // In development, always read from disk to allow live updates
    const isDev = process.env.NODE_ENV === 'development' || process.env.ENABLE_DEV_SERVER;

    if (!this.cssCache || isDev) {
      const cssPath = resolve(stylesDir, "admin-htmx.css");
      const content = await readFile(cssPath, "utf-8");
      const etag = createHash('md5').update(content).digest('hex').slice(0, 8);

      this.cssCache = { content, etag };
    }

    return this.cssCache;
  }

  static defineRoutes(root: ServerRoute) {
    // CSS stylesheet route with ETag caching
    root.defineRoute(
      {
        path: /^\/admin-htmx\/styles\.css$/,
        method: ["GET"],
      },
      async (state) => {
        const { content, etag } = await HtmxAdminManager.getCss();

        // Check if client has cached version
        const clientEtag = state.headers['if-none-match'];
        if (clientEtag === etag) {
          return state.sendEmpty(304, {
            'etag': etag,
            'cache-control': 'public, max-age=3600',
          });
        }

        return state.sendBuffer(200, {
          "content-type": "text/css; charset=utf-8",
          "cache-control": "public, max-age=3600",
          "etag": etag,
        }, Buffer.from(content, "utf-8"));
      }
    );

    // Profile route - redirects to user's own profile in user management
    root.defineRoute(
      {
        path: /^\/admin-htmx\/profile$/,
        method: ["GET"],
      },
      async (state) => {
        // Check authentication
        try {
          state.okUser();
        } catch (error) {
          console.warn(`[admin-htmx] Authentication failed for request to ${state.url}:`, error);
          return state.sendBuffer(302, {
            "location": `${state.pathPrefix}/login?redirect=${encodeURIComponent(state.url)}`,
          }, Buffer.from("Redirecting to login...", "utf-8"));
        }

        // Check admin role
        if (!state.user.isAdmin) {
          await serverEvents.emitAsync("admin.htmx.page.forbidden", state, state.user.username || "unknown");

          return state.sendBuffer(403, {
            "content-type": "text/html; charset=utf-8",
          }, Buffer.from(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>403 Forbidden</title>
              <style>
                body { font-family: sans-serif; max-width: 600px; margin: 100px auto; text-align: center; }
                h1 { color: #d32f2f; }
              </style>
            </head>
            <body>
              <h1>403 Forbidden</h1>
              <p>Admin access required to view this page.</p>
              <p><a href="${state.pathPrefix}/">Return to Home</a></p>
            </body>
            </html>
          `, "utf-8"));
        }

        // Redirect to the user's own profile in the user management interface
        const user_id = state.user?.user_id || "";

        return state.sendBuffer(302, {
          "location": `${state.pathPrefix}/admin-htmx?editUser=${encodeURIComponent(user_id)}`,
        }, Buffer.from("Redirecting to profile...", "utf-8"));
      }
    );

    // Main route for HTMX admin interface
    // Matches: /admin-htmx, /admin-htmx/, /admin-htmx/users
    root.defineRoute(
      {
        path: /^\/admin-htmx(?:\/?|\/users)$/,
        method: ["GET"],
      },
      async (state) => {
        // Check authentication
        try {
          state.okUser();
        } catch (error) {
          return state.sendBuffer(302, {
            "location": `${state.pathPrefix}/login?redirect=${encodeURIComponent(state.url)}`,
          }, Buffer.from("Redirecting to login...", "utf-8"));
        }

        // Check admin role
        if (!state.user.isAdmin) {
          // Emit forbidden event for audit/logging
          await serverEvents.emitAsync("admin.htmx.page.forbidden", state, state.user.username || "unknown");

          return state.sendBuffer(403, {
            "content-type": "text/html; charset=utf-8",
          }, Buffer.from(`
            <!DOCTYPE html>
            <html>
            <head>
              <title>403 Forbidden</title>
              <style>
                body { font-family: sans-serif; max-width: 600px; margin: 100px auto; text-align: center; }
                h1 { color: #d32f2f; }
              </style>
            </head>
            <body>
              <h1>403 Forbidden</h1>
              <p>Admin access required to view this page.</p>
              <p><a href="${state.pathPrefix}/">Return to Home</a></p>
            </body>
            </html>
          `, "utf-8"));
        }

        // Emit page accessed event for audit/logging
        await serverEvents.emitAsync("admin.htmx.page.accessed", state, state.user.isAdmin);

        const username = state.user?.username || "Guest";
        const user_id = state.user?.user_id || "";

        // Read the HTML template
        const templatePath = resolve(templatesDir, "htmx-admin-poc.html");
        let html = await readFile(templatePath, "utf-8");

        // Replace template variables
        html = html.replace(/\{\{pathPrefix\}\}/g, state.pathPrefix);
        html = html.replace(/\{\{username\}\}/g, escapeHtml(username));
        html = html.replace(/\{\{user_id\}\}/g, escapeHtml(user_id));

        return state.sendBuffer(200, {
          "content-type": "text/html; charset=utf-8",
        }, Buffer.from(html, "utf-8"));
      }
    );
  }
}

function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (m) => map[m]);
}
