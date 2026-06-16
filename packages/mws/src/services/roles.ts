import type { ServerRequest } from "@tiddlywiki/server";

/**
 * Canonical role name for the wiki data-management tier.
 *
 * `WIKI_ADMIN` grants STRUCTURAL operations — creating and deleting recipes and
 * bags — without the broader site-admin content access. This is the middle tier
 * of the access model:
 *   READ       = download / local use
 *   WRITE      = server-side content edit
 *   WIKI_ADMIN = structure / data management (create & delete recipes/bags)
 *   ADMIN      = system administration (users, roles, every ACL)
 *
 * Least privilege: holding WIKI_ADMIN is NOT the same as being a site-admin. It
 * never confers the content-ACL bypass or owner reassignment reserved for
 * `isAdmin`.
 */
export const WIKI_ADMIN_ROLE = "WIKI_ADMIN";

/**
 * Whether the user holds the `WIKI_ADMIN` data-management role. Mirrors the
 * `isAdmin` derivation (membership of the `ADMIN` role) used by the auth service.
 * Defensive against a missing/empty roles array (e.g. anonymous requests).
 */
export function hasWikiAdmin(user: ServerRequest["user"]): boolean {
  return Array.isArray(user?.roles)
    && user.roles.some(r => r.role_name === WIKI_ADMIN_ROLE);
}
