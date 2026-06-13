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

      // CSRF: the referer must be same-origin — its host must match the request's own
      // Host. Validating the pathname alone let a cross-origin referer (e.g.
      // https://evil.com/admin) through. A TLS-terminating reverse proxy such as
      // `tailscale serve` preserves the Host header, so legitimate requests still match.
      if (url.host !== state.headers.host)
        throw state.sendEmpty(400, { "x-reason": "Referer host does not match request host" });

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
