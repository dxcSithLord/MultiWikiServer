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

interface FrameTemplateVars {
  pageTitle: string;
  pathPrefix: string;
  username: string;
  isRecipes?: boolean;
  isBags?: boolean;
  isUsers?: boolean;
  isRoles?: boolean;
  isSettings?: boolean;
  isAdmin: boolean;
}

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

  /**
   * Render a page using the frame template
   * Simple Handlebars-like template rendering
   */
  private static async renderFrame(content: string, vars: FrameTemplateVars): Promise<string> {
    const framePath = resolve(templatesDir, "htmx-admin-frame.html");
    let html = await readFile(framePath, "utf-8");

    // Replace {{content}} placeholder
    html = html.replace(/\{\{content\}\}/g, content);

    // Replace simple variables
    html = html.replace(/\{\{pageTitle\}\}/g, escapeHtml(vars.pageTitle));
    html = html.replace(/\{\{pathPrefix\}\}/g, vars.pathPrefix);
    html = html.replace(/\{\{username\}\}/g, escapeHtml(vars.username));

    // Handle {{#if}} conditionals
    html = html.replace(/\{\{#if isRecipes\}\}(.*?)\{\{\/if\}\}/gs, vars.isRecipes ? '$1' : '');
    html = html.replace(/\{\{#if isBags\}\}(.*?)\{\{\/if\}\}/gs, vars.isBags ? '$1' : '');
    html = html.replace(/\{\{#if isUsers\}\}(.*?)\{\{\/if\}\}/gs, vars.isUsers ? '$1' : '');
    html = html.replace(/\{\{#if isRoles\}\}(.*?)\{\{\/if\}\}/gs, vars.isRoles ? '$1' : '');
    html = html.replace(/\{\{#if isSettings\}\}(.*?)\{\{\/if\}\}/gs, vars.isSettings ? '$1' : '');
    html = html.replace(/\{\{#if isAdmin\}\}(.*?)\{\{\/if\}\}/gs, vars.isAdmin ? '$1' : '');

    return html;
  }

  /**
   * Send 403 Forbidden response
   */
  private static send403(state: ServerRequest) {
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

    // Recipes route (default admin-htmx page)
    root.defineRoute(
      {
        path: /^\/admin-htmx\/?$/,
        method: ["GET"],
      },
      async (state) => {
        try {
          state.okUser();
        } catch (error) {
          return state.sendBuffer(302, {
            "location": `${state.pathPrefix}/login?redirect=${encodeURIComponent(state.url)}`,
          }, Buffer.from("Redirecting to login...", "utf-8"));
        }

        if (!state.user.isAdmin) {
          await serverEvents.emitAsync("admin.htmx.page.forbidden", state, state.user.username || "unknown");
          return HtmxAdminManager.send403(state);
        }

        await serverEvents.emitAsync("admin.htmx.page.accessed", state, state.user.isAdmin);

        // Read the recipes template
        const templatePath = resolve(templatesDir, "htmx-admin-recipes.html");
        let content = await readFile(templatePath, "utf-8");

        // Replace path prefix in template
        content = content.replace(/\{\{pathPrefix\}\}/g, state.pathPrefix);

        const html = await HtmxAdminManager.renderFrame(content, {
          pageTitle: "Recipes",
          pathPrefix: state.pathPrefix,
          username: state.user?.username || "Guest",
          isRecipes: true,
          isAdmin: state.user.isAdmin,
        });

        return state.sendBuffer(200, {
          "content-type": "text/html; charset=utf-8",
        }, Buffer.from(html, "utf-8"));
      }
    );

    // Bags route
    root.defineRoute(
      {
        path: /^\/admin-htmx\/bags$/,
        method: ["GET"],
      },
      async (state) => {
        try {
          state.okUser();
        } catch (error) {
          return state.sendBuffer(302, {
            "location": `${state.pathPrefix}/login?redirect=${encodeURIComponent(state.url)}`,
          }, Buffer.from("Redirecting to login...", "utf-8"));
        }

        if (!state.user.isAdmin) {
          await serverEvents.emitAsync("admin.htmx.page.forbidden", state, state.user.username || "unknown");
          return HtmxAdminManager.send403(state);
        }

        await serverEvents.emitAsync("admin.htmx.page.accessed", state, state.user.isAdmin);

        const templatePath = resolve(templatesDir, "htmx-admin-bags.html");
        let content = await readFile(templatePath, "utf-8");
        content = content.replace(/\{\{pathPrefix\}\}/g, state.pathPrefix);

        const html = await HtmxAdminManager.renderFrame(content, {
          pageTitle: "Bags",
          pathPrefix: state.pathPrefix,
          username: state.user?.username || "Guest",
          isBags: true,
          isAdmin: state.user.isAdmin,
        });

        return state.sendBuffer(200, {
          "content-type": "text/html; charset=utf-8",
        }, Buffer.from(html, "utf-8"));
      }
    );

    // Users route - uses existing POC template
    root.defineRoute(
      {
        path: /^\/admin-htmx\/users$/,
        method: ["GET"],
      },
      async (state) => {
        try {
          state.okUser();
        } catch (error) {
          return state.sendBuffer(302, {
            "location": `${state.pathPrefix}/login?redirect=${encodeURIComponent(state.url)}`,
          }, Buffer.from("Redirecting to login...", "utf-8"));
        }

        if (!state.user.isAdmin) {
          await serverEvents.emitAsync("admin.htmx.page.forbidden", state, state.user.username || "unknown");
          return HtmxAdminManager.send403(state);
        }

        await serverEvents.emitAsync("admin.htmx.page.accessed", state, state.user.isAdmin);

        const username = state.user?.username || "Guest";
        const user_id = state.user?.user_id || "";

        // Read the existing POC template (just the body content)
        const templatePath = resolve(templatesDir, "htmx-admin-poc.html");
        let pocHtml = await readFile(templatePath, "utf-8");

        // Replace template variables in POC
        pocHtml = pocHtml.replace(/\{\{pathPrefix\}\}/g, state.pathPrefix);
        pocHtml = pocHtml.replace(/\{\{username\}\}/g, escapeHtml(username));
        pocHtml = pocHtml.replace(/\{\{user_id\}\}/g, escapeHtml(user_id));

        // Extract just the body content (everything between <body> and </body>)
        const bodyMatch = pocHtml.match(/<body>([\s\S]*)<\/body>/);
        const content = bodyMatch ? bodyMatch[1] : pocHtml;

        const html = await HtmxAdminManager.renderFrame(content, {
          pageTitle: "Users",
          pathPrefix: state.pathPrefix,
          username: state.user?.username || "Guest",
          isUsers: true,
          isAdmin: state.user.isAdmin,
        });

        return state.sendBuffer(200, {
          "content-type": "text/html; charset=utf-8",
        }, Buffer.from(html, "utf-8"));
      }
    );

    // Roles route
    root.defineRoute(
      {
        path: /^\/admin-htmx\/roles$/,
        method: ["GET"],
      },
      async (state) => {
        try {
          state.okUser();
        } catch (error) {
          return state.sendBuffer(302, {
            "location": `${state.pathPrefix}/login?redirect=${encodeURIComponent(state.url)}`,
          }, Buffer.from("Redirecting to login...", "utf-8"));
        }

        if (!state.user.isAdmin) {
          await serverEvents.emitAsync("admin.htmx.page.forbidden", state, state.user.username || "unknown");
          return HtmxAdminManager.send403(state);
        }

        await serverEvents.emitAsync("admin.htmx.page.accessed", state, state.user.isAdmin);

        const templatePath = resolve(templatesDir, "htmx-admin-roles.html");
        let content = await readFile(templatePath, "utf-8");
        content = content.replace(/\{\{pathPrefix\}\}/g, state.pathPrefix);

        const html = await HtmxAdminManager.renderFrame(content, {
          pageTitle: "Roles",
          pathPrefix: state.pathPrefix,
          username: state.user?.username || "Guest",
          isRoles: true,
          isAdmin: state.user.isAdmin,
        });

        return state.sendBuffer(200, {
          "content-type": "text/html; charset=utf-8",
        }, Buffer.from(html, "utf-8"));
      }
    );

    // Settings route
    root.defineRoute(
      {
        path: /^\/admin-htmx\/settings$/,
        method: ["GET"],
      },
      async (state) => {
        try {
          state.okUser();
        } catch (error) {
          return state.sendBuffer(302, {
            "location": `${state.pathPrefix}/login?redirect=${encodeURIComponent(state.url)}`,
          }, Buffer.from("Redirecting to login...", "utf-8"));
        }

        if (!state.user.isAdmin) {
          await serverEvents.emitAsync("admin.htmx.page.forbidden", state, state.user.username || "unknown");
          return HtmxAdminManager.send403(state);
        }

        await serverEvents.emitAsync("admin.htmx.page.accessed", state, state.user.isAdmin);

        const templatePath = resolve(templatesDir, "htmx-admin-settings.html");
        let content = await readFile(templatePath, "utf-8");
        content = content.replace(/\{\{pathPrefix\}\}/g, state.pathPrefix);

        const html = await HtmxAdminManager.renderFrame(content, {
          pageTitle: "Settings",
          pathPrefix: state.pathPrefix,
          username: state.user?.username || "Guest",
          isSettings: true,
          isAdmin: state.user.isAdmin,
        });

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
