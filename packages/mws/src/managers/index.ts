//these use serverEvents
import "./admin-recipes";
import "./admin-users";
import "./admin-settings";
import "./admin-htmx";
import "./wiki-index";
import "./user-status";

// other imports
import { admin } from "./admin-utils";
import { RouterKeyMap, RouterRouteMap, ServerRoute, registerZodRoutes } from "@tiddlywiki/server";
import { ServerState } from "../ServerState";
import { serverEvents } from "@tiddlywiki/events";

export * from "./admin-recipes";
export * from "./admin-users";
export * from "./wiki-index";
// export * from "./wiki-routes";

serverEvents.on("mws.routes", (root: ServerRoute, config: ServerState) => {
  StatusManager.defineRoutes(root);

  // Gradual React -> HTMX cutover (step 1): the front door (exact "/") now
  // redirects to the HTMX admin. Registered on "mws.routes" so it is matched
  // before the React fallback below (first match wins). The regex matches ONLY
  // "/", so "/login" and other paths still fall through to the React SPA during
  // the gradual phase. The HTMX admin itself gates auth (unauthenticated users
  // are sent on to "/login"), so no auth check is needed here.
  root.defineRoute({
    path: /^\/$/,
    method: ["GET"],
  }, async (state) => {
    // Dispatch the front door by role: anonymous → login; admin → the admin UI;
    // a normal user → their home page (the wikis they can reach + logout). The
    // in-wiki "🏠 MWS home" button points here, so this is where it lands.
    const location = !state.user.isLoggedIn
      ? `${state.pathPrefix}/login?redirect=${encodeURIComponent(state.pathPrefix + "/")}`
      : state.user.isAdmin
        ? `${state.pathPrefix}/admin-htmx`
        : `${state.pathPrefix}/home`;
    return state.sendBuffer(302, {
      "location": location,
    }, Buffer.from("Redirecting...", "utf-8"));
  });
});

serverEvents.on("mws.routes.fallback", (root, config) => {

  // Clean-phase cutover (step 4): the catch-all fallback no longer serves the
  // React SPA. Every named surface now has its own route (HTMX admin, /login,
  // /wiki, the admin/login APIs), so anything reaching here is an unmatched GET.
  // Redirect it to the HTMX admin home, which itself gates auth (sending
  // unauthenticated users on to /login). This drops the last functional
  // dependency on state.sendAdmin / the React bundle from the live request path.
  root.defineRoute({
    method: ['GET'],
    path: /^\/.*/,
    bodyFormat: "stream",
  }, async state => {
    return state.sendBuffer(302, {
      "location": `${state.pathPrefix}/admin-htmx`,
    }, Buffer.from("Redirecting to admin...", "utf-8"));
  });
});

export const StatusKeyMap: RouterKeyMap<StatusManager, true> = {
  index_json: true,
}

export type StatusManagerMap = RouterRouteMap<StatusManager>;

export class StatusManager {

  static defineRoutes(root: ServerRoute) {
    registerZodRoutes(root, new StatusManager(), Object.keys(StatusKeyMap));
  }


  constructor() {

  }

  index_json = admin(z => z.undefined(), async (state, prisma) => {

    const { isAdmin, user_id, username, roles } = state.user;
    const role_ids = roles.map(r => r.role_id);
    const OR = state.getBagWhereACL({ permission: "READ", user_id, role_ids });

    const clientPlugins = [...state.pluginCache.pluginFiles.keys()];
    const corePlugins = state.pluginCache.requiredPlugins;

    const bagList = await prisma.bags.findMany({
      include: {
        _count: isAdmin ? undefined : {
          select: {
            acl: {
              where: {
                permission: "ADMIN",
                role_id: { in: role_ids }
              }
            }
          }
        },
        acl: true,
      },
      where: isAdmin ? undefined : { OR }
    });

    const recipeList = await prisma.recipes.findMany({
      include: {
        recipe_bags: {
          select: { bag_id: true, position: true, with_acl: true, },
          orderBy: { position: "asc" }
        },
        acl: true,
        _count: isAdmin ? undefined : {
          select: {
            acl: {
              where: {
                permission: "ADMIN",
                role_id: { in: role_ids }
              }
            }
          }
        },
      },
      where: isAdmin ? undefined : {
        OR: [
          { recipe_bags: { every: { bag: { OR } } } },
          user_id && { owner_id: { equals: user_id, not: null } }
        ].filter(truthy)
      }
    });

    const userListUser = !isAdmin && await prisma.users.findMany({
      select: { user_id: true, username: true }
    });

    const userListAdmin = !!isAdmin && await prisma.users.findMany({
      select: { user_id: true, username: true, email: true, roles: true, last_login: true, created_at: true }
    });

    const roleList = await prisma.roles.findMany();

    return {
      bagList,
      recipeList,
      isAdmin,
      user_id,
      userListUser,
      userListAdmin,
      roleList,
      username,
      clientPlugins,
      corePlugins,
      isLoggedIn: state.user.isLoggedIn,
      allowAnonReads: false,
      allowAnonWrites: false,
      versions: state.config.versions,
    }
  });


}

