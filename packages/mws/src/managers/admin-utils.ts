import Debug from "debug";
import { JsonValue, Z2, zod, zodRoute, ZodState } from "@tiddlywiki/server";
const debug = Debug("mws:cors:admin")



export function admin<T extends zod.ZodTypeAny, R extends JsonValue>(
  zodRequest: (z: Z2<"JSON">) => T,
  inner: (state: ZodState<"POST", "json", {}, {}, T>, prisma: PrismaTxnClient) => Promise<R>
) {
  return zodRoute({
    method: ["POST"],
    path: "/admin/$key",
    zodPathParams: z => ({}),
    zodQueryParams: z => ({}),
    bodyFormat: "json",
    securityChecks: { requestedWithHeader: true },
    zodRequestBody: zodRequest,
    inner: async (state) => {

      debug("admin request from origin %s referer %s", state.headers.origin, state.headers.referer);

      if (!state.headers.referer)
        throw state.sendEmpty(400, { "x-reason": "Missing referer header" });

      const url = new URL(state.headers.referer);

      const allowed = url.pathname.startsWith(state.pathPrefix + "/admin/")
        || url.pathname === state.pathPrefix + "/admin"
        || url.pathname === state.pathPrefix + "/admin-htmx"
        || url.pathname.startsWith(state.pathPrefix + "/admin-htmx/")
        || url.pathname === state.pathPrefix + "/login"
        || url.pathname === state.pathPrefix + "/";


      if (!allowed)
        throw state.sendEmpty(400, { "x-reason": "Referer header must be from /admin or /admin-htmx paths" });

      state.asserted = true;
      return state.$transaction(async (prisma) => await inner(state, prisma));
    }
  });
}
