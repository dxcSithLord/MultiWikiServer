import { readFile } from "fs/promises";
import { resolve } from "path";
import { ServerRoute, dist_resolve, dist_require_resolve, ServerRequest } from "@tiddlywiki/server";
import { serverEvents } from "@tiddlywiki/events";
import { createHash } from "crypto";
import { REFERENCE_RECIPES } from "../services/reference-recipes";
import { hasWikiAdmin } from "../services/roles";

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
    // Offer the "Log in with Tailscale (SSO)" short-cut only when SSO is enabled.
    // It clears the logout suppress marker (GET /resume-sso) so SSO resumes at once.
    // A plain link (not inlined JS); pathPrefix is attribute-escaped.
    const ssoButton = process.env.MWS_TAILSCALE_SSO === "1"
      ? `<p class="mws-login-sso"><a class="mws-btn" href="${escapeHtml(pathPrefix)}/resume-sso">Log in with Tailscale (SSO)</a></p>`
      : "";
    html = html.replace(/\{\{ssoButton\}\}/g, ssoButton);
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
   * List the wikis (recipe names) the current user may READ, for the user home
   * page. Mirrors the ACL filter used by StatusManager.index_json: an admin sees
   * all recipes; otherwise it is owner OR a bag-level READ grant via one of the
   * user's roles (at least one bag, all bags readable). Sorted by name.
   */
  private static async findAccessibleRecipes(state: ServerRequest): Promise<string[]> {
    const { user_id, roles, isAdmin } = state.user;
    const role_ids = roles.map(r => r.role_id);
    const OR = state.getBagWhereACL({ permission: "READ", user_id, role_ids });
    const recipes = await state.engine.recipes.findMany({
      select: { recipe_name: true },
      where: isAdmin ? undefined : {
        OR: [
          // `every` is vacuously true for a recipe with no bags; require at least
          // one bag (`some: {}`). `every` keeps the read semantics in step with
          // getRecipeACL.
          { recipe_bags: { some: {}, every: { bag: { OR } } } },
          user_id && { owner_id: { equals: user_id, not: null } },
        ].filter(truthy),
      },
      orderBy: { recipe_name: "asc" },
    });
    return recipes.map(r => r.recipe_name);
  }

  /**
   * The user home page: a standalone (non-admin-frame) page listing the wikis the
   * user can reach, with a logout button and — when permitted — a link to manage
   * wikis. Reference/doc wikis open in a new tab; task wikis open in the same tab.
   * If the user has no wiki yet, shows a "contact an administrator" message
   * (this replaces the former no-wiki page).
   */
  private static renderUserHome(state: ServerRequest, recipeNames: string[]) {
    const prefix = state.pathPrefix;
    // Manage-wikis is for the structural tier: site-admins and WIKI_ADMINs
    // (the latter can create/delete recipes & bags from the admin panel).
    const canManage = state.user.isAdmin || hasWikiAdmin(state.user);

    const list = recipeNames.map(name => {
      const ref = REFERENCE_RECIPES.has(name);
      const attrs = ref ? ' target="_blank" rel="noopener"' : '';
      const tag = ref ? ' <span class="ref">reference ↗</span>' : '';
      return `<li><a href="${escapeHtml(prefix)}/wiki/${encodeURIComponent(name)}"${attrs}>${escapeHtml(name)}</a>${tag}</li>`;
    }).join('\n');

    const body = recipeNames.length
      ? `<p>Choose a wiki:</p>\n<ul class="wikis">\n${list}\n</ul>`
      : `<p>Your account does not yet have access to any wiki. Please ask an administrator to grant you access.</p>`;

    const manage = canManage
      ? `<p class="manage"><a href="${escapeHtml(prefix)}/admin-htmx">Manage wikis</a></p>`
      : '';

    return state.sendBuffer(200, {
      "content-type": "text/html; charset=utf-8",
    }, Buffer.from(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>MWS — Your wikis</title>
        <style>
          body { font-family: sans-serif; max-width: 640px; margin: 80px auto; padding: 0 1rem; }
          h1 { color: #333; }
          ul.wikis { list-style: none; padding: 0; }
          ul.wikis li { margin: .4em 0; padding: .6em .8em; background: #eef3ff; border: 1px solid #c7d6f0; border-radius: 6px; }
          ul.wikis a { color: #1565c0; text-decoration: none; font-weight: bold; }
          .ref { color: #666; font-weight: normal; font-size: .85em; }
          .manage { margin-top: 1.5em; }
          a { color: #1565c0; }
          .signout { margin-top: 2em; border-top: 1px solid #eee; padding-top: 1em; }
        </style>
      </head>
      <body>
        <h1>Your wikis</h1>
        ${body}
        ${manage}
        <p class="signout"><a href="#" id="logout-link" data-path-prefix="${escapeHtml(prefix)}">Sign out</a></p>
        <script>
          document.getElementById('logout-link').addEventListener('click', async (e) => {
            e.preventDefault();
            // pathPrefix is read from a data-* attribute, never inlined into this script
            // (matches the login page; see security.md "Output encoding").
            const p = e.currentTarget.dataset.pathPrefix || "";
            try {
              await fetch(p + '/logout', {
                method: 'POST',
                headers: { 'X-Requested-With': 'TiddlyWiki' }
              });
            } catch (err) { /* fall through to redirect */ }
            window.location.href = p + '/login';
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

    // User home page — lists the wikis the signed-in user can reach, with logout.
    // Any authenticated user (admin or not); non-admins are routed here by the
    // front door and the /admin-htmx redirect.
    root.defineRoute(
      {
        path: /^\/home$/,
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
        const recipes = await HtmxAdminManager.findAccessibleRecipes(state);
        return HtmxAdminManager.renderUserHome(state, recipes);
      }
    );

    // Resume Tailscale SSO: clears the short-lived `mws_no_sso` suppress marker that
    // logout sets, so the next request re-authenticates via SSO immediately (the
    // login page offers this as a "Log in with Tailscale" short-cut). Fixed redirect
    // to the front door — no open-redirect.
    root.defineRoute(
      {
        path: /^\/resume-sso$/,
        method: ["GET"],
      },
      async (state) => {
        state.setCookie("mws_no_sso", "", {
          httpOnly: true,
          path: state.pathPrefix + "/",
          expires: new Date(0),
          secure: state.expectSecure,
          sameSite: "Strict",
        });
        return state.sendBuffer(302, {
          "location": `${state.pathPrefix}/`,
        }, Buffer.from("Resuming SSO...", "utf-8"));
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

        // Site-admins and WIKI_ADMINs get the structural Recipes page; everyone
        // else is sent to their user home page, which lists the wikis they can
        // reach (and a logout). The frame is rendered with the real `isAdmin`
        // below, so a WIKI_ADMIN sees Recipes/Bags but NOT the admin-only Users/
        // Roles/Settings nav. The front door (GET /) and the catch-all fallback
        // also route plain users to /home, so /home is the single user landing.
        if (!state.user.isAdmin && !hasWikiAdmin(state.user)) {
          return state.sendBuffer(302, {
            "location": `${state.pathPrefix}/home`,
          }, Buffer.from("Redirecting to home...", "utf-8"));
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

        // Bags are structural: site-admins and WIKI_ADMINs may manage them.
        if (!state.user.isAdmin && !hasWikiAdmin(state.user)) {
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
