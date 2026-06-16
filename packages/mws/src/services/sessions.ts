
import { jsonify, JsonValue, registerZodRoutes, RouterKeyMap, ServerRoute, Streamer, Z2, zod, ZodRoute, zodRoute, ZodState } from "@tiddlywiki/server";
import { createHash, randomBytes } from "node:crypto";
import { ServerState } from "../ServerState";
import { serverEvents } from "@tiddlywiki/events";
import { recordAudit, actorLabel } from "./audit";

declare module "@tiddlywiki/server" {
  interface IncomingHttpHeaders {
    /** Identity header injected by Tailscale Serve for proxied tailnet requests (SSO). */
    'tailscale-user-login'?: string;
  }
}


export interface AuthUser {
  /** User ID. 0 if the user is not logged in. */
  user_id: PrismaField<"Users", "user_id">;
  /** User role_ids. This may have length even if the user isn't logged in, to allow ACL for anon. */
  roles: {
    role_id: PrismaField<"Roles", "role_id">;
    role_name: PrismaField<"Roles", "role_name">;
  }[];
  /** Username passed to the client */
  username: PrismaField<"Users", "username">;
  /** Optional user-chosen display name; null falls back to the username for attribution. */
  nickname: string | null;
  /** A session_id isn't guarenteed. There may be a session even if the user isn't logged in, and may not be even if they are, depending on the the situation. */
  sessionId: PrismaField<"Sessions", "session_id"> | undefined;
  /** Is this user considered a site-admin. This is determined by the auth service, not MWS. */
  isAdmin: boolean;
  /** Is the user logged in? This also means that user_id should be 0. role_ids may still be specified. */
  isLoggedIn: boolean;
  /** Web URL for the user's avatar. */
  avatarUrl?: string;
}

export const SessionKeyMap: RouterKeyMap<SessionManager, true> = {
  login1: true,
  login2: true,
  logout: true,
}


/**
 * 
 * @param path path starting with a forward slash
 * @param zodRequest the zod for state.data
 * @param inner the handler to call
 * @returns the ZodRoute
 */
export function zodSession<P extends string, T extends zod.ZodTypeAny, R extends JsonValue>(
  path: P,
  zodRequest: (z: Z2<"JSON">) => T,
  inner: (state: ZodState<"POST", "json", {}, {}, T>, prisma: PrismaTxnClient) => Promise<R>
): ZodSessionRoute<P, T, R> {
  return {
    ...zodRoute({
      method: ["POST"], path,
      bodyFormat: "json",
      zodPathParams: z => ({}),
      zodQueryParams: z => ({}),
      zodRequestBody: zodRequest,
      securityChecks: { requestedWithHeader: true },
      inner: async (state) => {
        state.asserted = true;
        return state.$transaction(async (prisma) => await inner(state, prisma));
      }
    }),
    path,
  };
}

export interface ZodSessionRoute<
  PATH extends string,
  T extends zod.ZodTypeAny,
  R extends JsonValue
> extends ZodRoute<"POST", "json", {}, {}, T, R> {
  path: PATH;
}

export type RouterPathRouteMap<T> = {
  [K in keyof T as T[K] extends ZodSessionRoute<any, any, any> ? K : never]:
  T[K] extends ZodSessionRoute<infer P, infer REQ, infer RES> ? {
    (data: zod.input<REQ>): Promise<jsonify<RES>>;
    path: P;
    key: K;
  } : never;
}
export type SessionManagerMap = RouterPathRouteMap<SessionManager>;

serverEvents.on("mws.routes", (root, config) => {
  SessionManager.defineRoutes(root)
});

export class SessionManager {

  static defineRoutes(root: ServerRoute) {
    registerZodRoutes(root, new SessionManager(), Object.keys(SessionKeyMap))
  }

  // ── Login rate limiting ──────────────────────────────────────────────────
  // In-memory, per-username throttle on /login/1 (resets on process restart; mirrors the
  // passwordGenerationCooldowns pattern). Keyed by USERNAME deliberately: behind a TLS proxy
  // (Tailscale Serve) the client IP is always the loopback proxy, so per-IP limiting is not
  // meaningful here. With OPAQUE a wrong password fails client-side, so the server-side signal
  // of an attempt is the /login/1 start — that is what we count. Tradeoff: a username-keyed
  // lockout can be used to temporarily lock a victim out (acceptable on a tailnet-only deploy).
  private static loginAttempts = new Map<string, { times: number[]; lockedUntil: number }>();
  static readonly LOGIN_WINDOW_MS = 15 * 60_000;   // sliding window
  static readonly LOGIN_MAX_ATTEMPTS = 10;         // starts allowed per window
  static readonly LOGIN_LOCKOUT_MS = 15 * 60_000;  // lock duration once exceeded
  static readonly LOGIN_MAX_TRACKED = 5000;        // hard cap on tracked usernames (anti-spray)

  /** Number of currently-tracked usernames (exposed for tests / diagnostics). */
  static get loginTrackedCount(): number { return SessionManager.loginAttempts.size; }

  /** Throws a user-facing string if the username is locked out or exceeds the attempt cap. */
  static checkLoginRateLimit(username: string, now: number = Date.now()): void {
    const rec = SessionManager.loginAttempts.get(username) ?? { times: [], lockedUntil: 0 };

    if (rec.lockedUntil > now) {
      const mins = Math.ceil((rec.lockedUntil - now) / 60_000);
      throw `Too many login attempts. Try again in ${mins} minute${mins === 1 ? "" : "s"}.`;
    }

    rec.times = rec.times.filter(t => now - t < SessionManager.LOGIN_WINDOW_MS);
    rec.times.push(now);

    if (rec.times.length > SessionManager.LOGIN_MAX_ATTEMPTS) {
      rec.lockedUntil = now + SessionManager.LOGIN_LOCKOUT_MS;
      rec.times = [];
      SessionManager.storeAttempt(username, rec, now);
      throw `Too many login attempts. Try again in ${Math.ceil(SessionManager.LOGIN_LOCKOUT_MS / 60_000)} minutes.`;
    }

    SessionManager.storeAttempt(username, rec, now);
  }

  /**
   * Store an attempt record and keep the map bounded. The Map's insertion order is used as an
   * LRU (re-inserting moves a key to the end), so the freshly-touched username is never the one
   * evicted. Beyond the hard cap we drop stale entries first, then LRU-evict the oldest — this
   * bounds memory/CPU under a username-spray attack (many distinct fresh usernames in-window,
   * which the staleness check alone would never reclaim).
   */
  private static storeAttempt(username: string, rec: { times: number[]; lockedUntil: number }, now: number): void {
    SessionManager.loginAttempts.delete(username);
    SessionManager.loginAttempts.set(username, rec);

    if (SessionManager.loginAttempts.size <= SessionManager.LOGIN_MAX_TRACKED) return;

    for (const [k, v] of SessionManager.loginAttempts) {
      const last = v.times[v.times.length - 1] ?? 0;
      if (v.lockedUntil < now && now - last > SessionManager.LOGIN_WINDOW_MS)
        SessionManager.loginAttempts.delete(k);
    }
    while (SessionManager.loginAttempts.size > SessionManager.LOGIN_MAX_TRACKED) {
      const oldest = SessionManager.loginAttempts.keys().next().value;
      if (oldest === undefined) break;
      SessionManager.loginAttempts.delete(oldest);
    }
  }

  static async parseIncomingRequest(streamer: Streamer, config: ServerState): Promise<AuthUser> {

    const sessionId = streamer.cookies.getAll("session") as PrismaField<"Sessions", "session_id">[];
    const session = sessionId && await config.engine.sessions.findFirst({
      where: { session_id: { in: sessionId } },
      select: { session_id: true, user: { select: { user_id: true, username: true, nickname: true, disabled: true, roles: { select: { role_id: true, role_name: true } } } } }
    });

    // A disabled user is treated as logged out (their session no longer authenticates).
    if (sessionId && session && !session.user.disabled) return {
      user_id: session.user.user_id,
      username: session.user.username,
      nickname: session.user.nickname,
      isAdmin: session.user.roles.some(e => e.role_name === "ADMIN"),
      roles: session.user.roles.map(e => ({
        role_id: e.role_id,
        role_name: e.role_name
      })),
      sessionId: session.session_id,
      isLoggedIn: true,
    };

    // No valid session cookie — try opt-in Tailscale SSO before treating as anonymous,
    // UNLESS the user just logged out: the short-lived `mws_no_sso` cookie (set by
    // logout) suppresses SSO so they can stay logged out or sign in as a different
    // persona by password. It is TTL-bounded, so SSO resumes automatically when it
    // expires (or immediately via GET /resume-sso). A valid session cookie above
    // always wins, so password login still works while the marker is present.
    const ssoSuppressed = streamer.cookies.getAll("mws_no_sso").length > 0;
    if (!ssoSuppressed) {
      const ssoUser = await SessionManager.resolveTailscaleSSO(streamer, config);
      if (ssoUser) return ssoUser;
    }

    return {
      user_id: "" as PrismaField<"Users", "user_id">,
      username: "(anon)" as PrismaField<"Users", "username">,
      nickname: null,
      isAdmin: false,
      roles: [],
      sessionId: undefined,
      isLoggedIn: false,
    };
  }

  /**
   * Opt-in passwordless auth from Tailscale's `Tailscale-User-Login` identity header.
   *
   * SAFE ONLY because MWS binds loopback and Tailscale Serve (a) strips any client-supplied
   * `Tailscale-*` headers and (b) injects the verified tailnet identity. Funnel does NOT inject
   * it, so public requests carry no header and fall through to password auth. Enabling
   * `MWS_TAILSCALE_SSO=1` is the operator's attestation that this setup holds (loopback bind +
   * Tailscale Serve + Funnel off).
   *
   * Stateless (no session row): the identity is re-validated from the header on every request.
   * Deny-unless-mapped (no auto-provision); disabled users are rejected; roles are as mapped.
   */
  private static async resolveTailscaleSSO(streamer: Streamer, config: ServerState): Promise<AuthUser | null> {
    if (process.env.MWS_TAILSCALE_SSO !== "1") return null;

    const login = streamer.headers["tailscale-user-login"];
    if (typeof login !== "string" || !login) return null;

    const u = await config.engine.users.findUnique({
      where: { tailscale_login: login },
      select: { user_id: true, username: true, nickname: true, disabled: true, roles: { select: { role_id: true, role_name: true } } }
    });
    if (!u || u.disabled) return null;

    return {
      user_id: u.user_id,
      username: u.username,
      nickname: u.nickname,
      isAdmin: u.roles.some(e => e.role_name === "ADMIN"),
      roles: u.roles.map(e => ({ role_id: e.role_id, role_name: e.role_name })),
      sessionId: undefined,
      isLoggedIn: true,
    };
  }

  login1 = zodSession("/login/1", z => z.object({
    username: z.prismaField("Users", "username", "string"),
    startLoginRequest: z.string(),
  }), async (state, prisma) => {
    const { username, startLoginRequest } = state.data;

    // Throttle repeated login starts per username (brute-force / credential-stuffing).
    // Audit via state.engine (not the txn `prisma`) so denials are recorded durably.
    try {
      SessionManager.checkLoginRateLimit(username);
    } catch (e) {
      await recordAudit(state.engine, {
        action: "login.lockout", outcome: "denied", actor_label: username,
        detail: { reason: "rate_limit" },
      });
      throw e;
    }

    const user = await prisma.users.findUnique({
      where: { username },
      select: { user_id: true, password: true, disabled: true, }
    });

    if (!user) {
      await recordAudit(state.engine, {
        action: "login.failure", outcome: "denied", actor_label: username,
        detail: { reason: "user_not_found" },
      });
      throw "User not found.";
    }
    if (user.disabled) {
      await recordAudit(state.engine, {
        action: "login.failure", outcome: "denied", actor_label: username,
        actor_user_id: user.user_id, detail: { reason: "disabled" },
      });
      throw "Account is disabled.";
    }

    const { user_id, password } = user;

    const stater = state.PasswordService.LoginGenerator({
      user_id,
      startLoginRequest,
      registrationRecord: password,
    });

    const loginResponse = await stater.next(0);

    if (loginResponse.done) throw "Login failed.";

    const loginSession = await state.PasswordService.startLoginSession(stater);

    return { loginResponse: loginResponse.value, loginSession };

  })

  login2 = zodSession("/login/2", z => z.object({
    finishLoginRequest: z.string(),
    loginSession: z.string(),
    skipCookie: z.boolean().optional().default(false),
  }), async (state, prisma) => {
    const { finishLoginRequest, skipCookie, loginSession } = state.data;

    if (!loginSession) throw "Login session not found.";

    const stater = state.PasswordService.serverState.get(loginSession);

    if (!stater) throw "Login session not found.";

    const { value } = await stater.next(1, finishLoginRequest);

    if (!value?.session?.sessionKey) throw "Login failed.";

    // Re-check the account here too: it may have been disabled between /login/1 and /login/2.
    const account = await prisma.users.findUnique({
      where: { user_id: value.user_id },
      select: { disabled: true, username: true },
    });
    if (!account || account.disabled) throw "Account is disabled.";

    const session_id = await createSession(prisma, value.user_id, value.session.sessionKey);

    await recordAudit(state.engine, {
      action: "login.success", outcome: "success",
      actor_user_id: value.user_id, actor_label: account.username,
    });

    if (!skipCookie) {
      // the client can ask to skip the cookie for things like password change
      state.setCookie("session", session_id, {
        httpOnly: true,
        path: state.pathPrefix + "/",
        secure: state.expectSecure,
        sameSite: "Strict"
      });
      // Clear any SSO-suppress marker left by a previous logout, so SSO resumes
      // normally once this password session ends.
      state.setCookie("mws_no_sso", "", {
        httpOnly: true,
        path: state.pathPrefix + "/",
        expires: new Date(0),
        secure: state.expectSecure,
        sameSite: "Strict"
      });
    }

    // NEVER send the session_key! The client already has it!
    return { user_id: value.user_id, session_id, };

  })

  logout = zodSession("/logout", z => z.object({
    session_id: z.string(),
    signature: z.string(),
    skipCookie: z.boolean().refine(e => e === true),
  }).optional(), async (state, prisma) => {

    if (state.data?.skipCookie) {
      const session = await prisma.sessions.findUnique({
        where: { session_id: state.data.session_id },
        select: { user_id: true, session_key: true }
      });
      if (!session?.session_key) throw "Session not found.";
      const { session_key } = session;
      const { session_id, signature } = state.data;
      assertSignature({ session_id, signature, session_key });
      await prisma.sessions.delete({ where: { session_id: state.data.session_id } });
      await recordAudit(state.engine, {
        action: "logout", outcome: "success",
        actor_user_id: session.user_id, actor_label: actorLabel(state.user),
      });
      return null;
    }

    // SSO users are authenticated per-request from the header and have no session row.
    if (state.user.isLoggedIn && state.user.sessionId) {
      await prisma.sessions.delete({ where: { session_id: state.user.sessionId } });
    }
    if (state.user.isLoggedIn) {
      await recordAudit(state.engine, {
        action: "logout", outcome: "success",
        actor_user_id: state.user.user_id, actor_label: actorLabel(state.user),
      });
    }
    var cookies = state.headers.cookie ? state.headers.cookie.split(";") : [];
    for (var i = 0; i < cookies.length; i++) {
      var cookie = cookies[i]?.trim().split("=")[0];
      if (!cookie) continue;
      // state.setHeader("Set-Cookie", cookie + "=; HttpOnly; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Strict");
      state.setCookie(cookie, "", {
        httpOnly: true,
        path: state.pathPrefix + "/",
        expires: new Date(0),
        secure: state.expectSecure,
        sameSite: "Strict"
      });
    }

    // Under Tailscale SSO, the next request would re-authenticate instantly from the
    // identity header, making logout a no-op. Set a short-lived suppress marker so
    // the user actually lands logged out (and can sign in as a different persona);
    // parseIncomingRequest honours it before SSO. TTL-bounded — SSO resumes after.
    if (process.env.MWS_TAILSCALE_SSO === "1") {
      state.setCookie("mws_no_sso", "1", {
        httpOnly: true,
        path: state.pathPrefix + "/",
        expires: new Date(Date.now() + 5 * 60_000),
        secure: state.expectSecure,
        sameSite: "Strict"
      });
    }

    return null;
  });


}


async function createSession(prisma: PrismaTxnClient, user_id: PrismaField<"Users", "user_id">, session_key: string) {
  const session_id = randomBytes(16).toString("base64url");
  return await prisma.sessions.create({
    data: {
      user_id,
      session_key,
      session_id,
      last_accessed: new Date(),
    }
  }).then(({ session_id }) => session_id);
}


export function assertSignature({ session_id, signature, session_key }: {
  session_id: string; signature: string; session_key: string;
}) {
  const hash = createHash("sha256").update(session_key + session_id).digest("base64");
  if (hash !== signature) throw "Invalid session signature.";
}
