import { readFile } from "fs/promises";
import { resolve } from "path";
import { ServerRoute, dist_resolve, ServerRequest } from "@tiddlywiki/server";
import { serverEvents } from "@tiddlywiki/events";

declare module "@tiddlywiki/events" {
  interface ServerEventsMap {
    "admin.htmx.page.accessed": [state: ServerRequest, isAdmin: boolean];
    "admin.htmx.page.forbidden": [state: ServerRequest, username: string];
  }
}

const templatesDir = dist_resolve("../packages/mws/src/templates");

serverEvents.on("mws.routes", (root) => {
  HtmxAdminManager.defineRoutes(root);
});

export class HtmxAdminManager {
  static defineRoutes(root: ServerRoute) {
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
    root.defineRoute(
      {
        path: /^\/admin-htmx$/,
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
