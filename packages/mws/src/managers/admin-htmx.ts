import { readFile } from "fs/promises";
import { resolve } from "path";
import { ServerRoute, dist_resolve, dist_require_resolve, ServerRequest } from "@tiddlywiki/server";
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
  isPlugins?: boolean;
  isUsers?: boolean;
  isRoles?: boolean;
  isSettings?: boolean;
  isAdmin: boolean;
}

export class HtmxAdminManager {
  private static cssCache: { content: string; etag: string } | null = null;
  private static opaqueJsCache: { content: string; etag: string } | null = null;

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
   * Get the self-hosted OPAQUE client ESM bundle (WASM inlined, no external imports)
   * with an ETag for caching. Served locally so the login page never depends on a CDN
   * and works offline. Cached in memory after the first read.
   */
  private static async getOpaqueJs(): Promise<{ content: string; etag: string }> {
    if (!this.opaqueJsCache) {
      const opaquePath = dist_require_resolve("@serenity-kit/opaque/esm/index.js");
      const content = await readFile(opaquePath, "utf-8");
      const etag = createHash('md5').update(content).digest('hex').slice(0, 8);
      this.opaqueJsCache = { content, etag };
    }
    return this.opaqueJsCache;
  }

  /**
   * Validate a post-login redirect target to prevent open redirects (OWASP).
   * Only same-origin, single-slash absolute paths are allowed; anything else
   * (absolute URLs, protocol-relative "//host", backslash tricks) falls back to
   * the HTMX admin home.
   */
  private static safeRedirect(raw: string | undefined, pathPrefix: string): string {
    const fallback = `${pathPrefix}/admin-htmx`;
    if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) {
      return fallback;
    }
    return raw;
  }

  /**
   * Render the HTMX login page. The pathPrefix and validated redirect are injected
   * only as HTML-attribute-escaped data-* values; the page script reads them as
   * plain strings, so no untrusted value is templated into executable JavaScript.
   */
  private static async renderLogin(pathPrefix: string, redirect: string): Promise<string> {
    const templatePath = resolve(templatesDir, "htmx-login.html");
    let html = await readFile(templatePath, "utf-8");
    html = html.replace(/\{\{pathPrefix\}\}/g, escapeHtml(pathPrefix));
    html = html.replace(/\{\{redirect\}\}/g, escapeHtml(redirect));
    return html;
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
    html = html.replace(/\{\{#if isPlugins\}\}(.*?)\{\{\/if\}\}/gs, vars.isPlugins ? '$1' : '');
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

  /**
   * Find the first wiki (recipe) the current non-admin user may READ, so the
   * front door can land them on a usable page instead of the admin-only 403.
   * Mirrors the ACL filter used by StatusManager.index_json (owner OR a bag-level
   * READ grant via one of the user's roles). Returns the recipe_name or null.
   */
  private static async findFirstAccessibleRecipe(state: ServerRequest): Promise<string | null> {
    const { user_id, roles } = state.user;
    const role_ids = roles.map(r => r.role_id);
    const OR = state.getBagWhereACL({ permission: "READ", user_id, role_ids });
    const recipe = await state.engine.recipes.findFirst({
      select: { recipe_name: true },
      where: {
        OR: [
          // `every` alone is vacuously true for a recipe with no bags; require at
          // least one bag (`some: {}`) so a bag-less recipe is not picked as a landing
          // target. `every` keeps the read semantics in step with getRecipeACL.
          { recipe_bags: { some: {}, every: { bag: { OR } } } },
          user_id && { owner_id: { equals: user_id, not: null } },
        ].filter(truthy),
      },
      orderBy: { recipe_name: "asc" },
    });
    return recipe?.recipe_name ?? null;
  }

  /**
   * Friendly landing for a logged-in non-admin who has no wiki granted yet.
   * Returns 200 (not 403) with a logout link — they are authenticated, just
   * not yet assigned access.
   */
  private static sendNoWiki(state: ServerRequest) {
    return state.sendBuffer(200, {
      "content-type": "text/html; charset=utf-8",
    }, Buffer.from(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>No wikis assigned</title>
        <style>
          body { font-family: sans-serif; max-width: 600px; margin: 100px auto; text-align: center; }
          h1 { color: #555; }
          a { color: #1565c0; }
        </style>
      </head>
      <body>
        <h1>No wikis assigned yet</h1>
        <p>Your account does not yet have access to any wiki. Please ask an administrator to grant you access.</p>
        <p><a href="#" id="logout-link">Sign out</a></p>
        <script>
          document.getElementById('logout-link').addEventListener('click', async (e) => {
            e.preventDefault();
            try {
              await fetch('${state.pathPrefix}/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TiddlyWiki' },
                body: JSON.stringify(undefined)
              });
            } catch (err) { /* fall through to redirect */ }
            window.location.href = '${state.pathPrefix}/login';
          });
        </script>
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

    // Self-hosted OPAQUE client bundle for the login page (ETag-cached).
    root.defineRoute(
      {
        path: /^\/admin-htmx\/opaque\.js$/,
        method: ["GET"],
      },
      async (state) => {
        const { content, etag } = await HtmxAdminManager.getOpaqueJs();

        const clientEtag = state.headers['if-none-match'];
        if (clientEtag === etag) {
          return state.sendEmpty(304, {
            'etag': etag,
            'cache-control': 'public, max-age=3600',
          });
        }

        return state.sendBuffer(200, {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=3600",
          "etag": etag,
        }, Buffer.from(content, "utf-8"));
      }
    );

    // HTMX login page. Shadows the React "/login" (registered on mws.routes, so it
    // wins first-match over the React fallback). Unauthenticated admin redirects
    // already point here. If already signed in, skip straight to the target.
    root.defineRoute(
      {
        path: /^\/login$/,
        method: ["GET"],
      },
      async (state) => {
        const redirect = HtmxAdminManager.safeRedirect(
          state.queryParams["redirect"]?.[0], state.pathPrefix);

        if (state.user.isLoggedIn) {
          return state.sendBuffer(302, {
            "location": redirect,
          }, Buffer.from("Already signed in...", "utf-8"));
        }

        const html = await HtmxAdminManager.renderLogin(state.pathPrefix, redirect);
        return state.sendBuffer(200, {
          "content-type": "text/html; charset=utf-8",
        }, Buffer.from(html, "utf-8"));
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

        // Redirect to the user's own entry on the USERS page, which reads ?editUser=
        // and auto-opens the edit modal (where "Generate Temporary Password" lives).
        // (Must target /admin-htmx/users — /admin-htmx is the Recipes page and ignores
        // editUser, so it just looked like Profile bounced to the home page.)
        const user_id = state.user?.user_id || "";

        return state.sendBuffer(302, {
          "location": `${state.pathPrefix}/admin-htmx/users?editUser=${encodeURIComponent(user_id)}`,
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

        // Non-admins do not get the admin Recipes page; land them on their first
        // accessible wiki instead of a dead-end 403. The front door (GET /) and the
        // catch-all fallback both funnel here, so this is the single landing chokepoint.
        if (!state.user.isAdmin) {
          const recipeName = await HtmxAdminManager.findFirstAccessibleRecipe(state);
          if (recipeName) {
            return state.sendBuffer(302, {
              "location": `${state.pathPrefix}/wiki/${encodeURIComponent(recipeName)}`,
            }, Buffer.from("Redirecting to wiki...", "utf-8"));
          }
          return HtmxAdminManager.sendNoWiki(state);
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

    // Plugins route
    root.defineRoute(
      {
        path: /^\/admin-htmx\/plugins$/,
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

        await serverEvents.emitAsync("admin.htmx.page.accessed", state, state.user.isAdmin);

        const templatePath = resolve(templatesDir, "htmx-admin-plugins.html");
        let content = await readFile(templatePath, "utf-8");
        content = content.replace(/\{\{pathPrefix\}\}/g, state.pathPrefix);

        const html = await HtmxAdminManager.renderFrame(content, {
          pageTitle: "TW5 Plugins",
          pathPrefix: state.pathPrefix,
          username: state.user?.username || "Guest",
          isPlugins: true,
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
