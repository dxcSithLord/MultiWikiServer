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
});

serverEvents.on("mws.routes.fallback", (root, config) => {

  root.defineRoute({
    method: ['GET'],
    path: /^\/.*/,
    bodyFormat: "stream",
  }, async state => {
    await state.sendAdmin(200, null);
    return STREAM_ENDED;
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

