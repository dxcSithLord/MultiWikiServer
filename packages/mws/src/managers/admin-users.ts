
import { registerZodRoutes, RouterKeyMap, RouterRouteMap, ServerRoute } from "@tiddlywiki/server";
import { admin } from "./admin-utils";
import { assertSignature } from "../services/sessions";
import { recordAudit, actorLabel } from "../services/audit";
import { serverEvents } from "@tiddlywiki/events";
import { randomInt } from "node:crypto";
import { Prisma } from "@tiddlywiki/mws-prisma";


export const UserKeyMap: RouterKeyMap<UserManager, true> = {
  user_edit_data: true,
  user_create: true,
  user_delete: true,
  user_list: true,
  user_update: true,
  user_update_password: true,
  user_generate_temp_password: true,
  user_set_disabled: true,
  role_create: true,
  role_update: true,
  audit_list: true,
}

export type UserManagerMap = RouterRouteMap<UserManager>;

/**
 * Soft cap on the number of roles. There is no DB constraint; this is a guard
 * against accidental role sprawl (the ACL model is hierarchical and a handful of
 * roles is expected). Raise this constant if a deployment legitimately needs more.
 */
const ROLE_SOFT_CAP = 20;

/**
 * Handle Prisma unique constraint violations and convert to user-friendly error messages
 */
function handlePrismaUniqueConstraintError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    const target = error.meta?.target;
    if (Array.isArray(target)) {
      if (target.includes('email')) {
        throw "Email address is already in use";
      } else if (target.includes('username')) {
        throw "Username is already taken";
      } else if (target.includes('tailscale_login')) {
        throw "That Tailscale login is already mapped to another user";
      }
    }
    throw "A user with these details already exists";
  }
  throw error;
}

serverEvents.on("mws.routes", (root) => {
  UserManager.defineRoutes(root);
});

export class UserManager {
  // In-memory rate limiting for password generation (user_id -> last generation timestamp)
  private static passwordGenerationCooldowns = new Map<string, number>();
  private static readonly PASSWORD_GENERATION_COOLDOWN_MS = 60000; // 1 minute

  static defineRoutes(root: ServerRoute) {
    registerZodRoutes(root, new UserManager(), Object.keys(UserKeyMap));
  }

  constructor() { }

  /**
   * Check if password generation is allowed for a user (rate limiting)
   */
  private checkPasswordGenerationRateLimit(user_id: string): void {
    const lastGeneration = UserManager.passwordGenerationCooldowns.get(user_id);
    const now = Date.now();

    if (lastGeneration && now - lastGeneration < UserManager.PASSWORD_GENERATION_COOLDOWN_MS) {
      const remainingSeconds = Math.ceil((UserManager.PASSWORD_GENERATION_COOLDOWN_MS - (now - lastGeneration)) / 1000);
      throw `Please wait ${remainingSeconds} seconds before generating another password for this user`;
    }

    // Record this generation
    UserManager.passwordGenerationCooldowns.set(user_id, now);

    // Clean up old entries (older than 5 minutes)
    const cutoff = now - 300000;
    for (const [uid, timestamp] of UserManager.passwordGenerationCooldowns.entries()) {
      if (timestamp < cutoff) {
        UserManager.passwordGenerationCooldowns.delete(uid);
      }
    }
  }

  user_edit_data = admin(z => z.object({
    user_id: z.prismaField("Users", "user_id", "string")
  }), async (state, prisma) => {
    state.okUser();

    const { user_id } = state.data;

    if (!state.user.isAdmin && state.user.user_id !== user_id)
      throw "Non-admins cannot retrieve the profile of other users"

    const user = await prisma.users.findUnique({
      where: { user_id },
      select: {
        user_id: true,
        username: true,
        email: true,
        nickname: true,
        disabled: true,
        tailscale_login: true,
        roles: true,
        last_login: true,
        created_at: true,
      }
    });

    if (!user) throw "User not found";

    const allRoles = await prisma.roles.findMany({
      select: {
        role_id: true,
        role_name: true,
        description: true,
      }
    });

    return { user, allRoles }
  });

  user_list = admin(z => z.undefined(), async (state, prisma) => {

    state.okAdmin();

    const res = await prisma.users.findMany({
      select: {
        user_id: true,
        username: true,
        email: true,
        nickname: true,
        disabled: true,
        tailscale_login: true,
        roles: true,
        last_login: true,
        created_at: true,
      }
    });
    return res;
  });


  user_create = admin(z => z.object({
    username: z.string(),
    email: z.string().optional(),
    nickname: z.string().optional(),
    tailscale_login: z.string().optional(),
    role_ids: z.prismaField("Roles", "role_id", "string", false).array(),
  }), async (state, prisma) => {
    const { username, role_ids } = state.data;

    state.okAdmin();

    // Email is optional for the admin; the column stays unique + required, so derive a
    // stable placeholder from the (unique) username when none is supplied.
    const email = state.data.email?.trim() || `${username}@local`;
    const nickname = state.data.nickname?.trim() || null;
    // tailscale_login is unique; blank must be null (not "") so multiple unset users don't collide.
    const tailscale_login = state.data.tailscale_login?.trim() || null;

    // Every enabled user must hold at least one role; default new users to the
    // baseline "USER" role when the admin selects none, so they are never created
    // role-less (which would deny them all default wiki access).
    let effectiveRoleIds = role_ids;
    if (effectiveRoleIds.length === 0) {
      const userRole = await prisma.roles.findUnique({
        where: { role_name: "USER" },
        select: { role_id: true },
      });
      // Fail closed: never create a role-less user. The baseline "USER" role is seeded
      // at init, so its absence is a misconfiguration the admin must fix first.
      if (!userRole) throw "Baseline 'USER' role is missing; cannot create a user without a role.";
      effectiveRoleIds = [userRole.role_id];
    }

    try {
      const user = await prisma.users.create({
        data: { username, email, nickname, tailscale_login, password: "", roles: { connect: effectiveRoleIds.map(role_id => ({ role_id })) } },
        select: { user_id: true, created_at: true }
      });

      await recordAudit(state.engine, {
        action: "user.create", outcome: "success",
        actor_user_id: state.user.user_id, actor_label: actorLabel(state.user),
        target_type: "user", target_id: user.user_id, target_name: username,
        detail: { roles: effectiveRoleIds.length },
      });

      return user;
    } catch (error) {
      handlePrismaUniqueConstraintError(error);
    }
  });

  user_update = admin(z => z.object({
    user_id: z.prismaField("Users", "user_id", "string"),
    username: z.prismaField("Users", "username", "string"),
    email: z.prismaField("Users", "email", "string").optional(),
    nickname: z.string().optional(),
    tailscale_login: z.string().optional(),
    role_ids: z.prismaField("Roles", "role_id", "string").array(),
  }), async (state, prisma) => {
    const { user_id, username, role_ids } = state.data;
    const nickname = state.data.nickname?.trim() || null;
    // Blank clears the SSO mapping (null, not "" — the column is unique).
    const tailscale_login = state.data.tailscale_login?.trim() || null;
    // Email is optional (matching user_create + the UI): a blank/omitted value leaves the
    // existing email unchanged, rather than forcing one or clobbering it with a placeholder.
    const email = state.data.email?.trim();

    state.okAdmin();

    // Check if admin is updating themselves
    if (state.user.user_id === user_id) {
      // Get current roles to see if they're being changed
      const currentUser = await prisma.users.findUnique({
        where: { user_id },
        select: { roles: { select: { role_id: true } } }
      });

      const currentRoleIds = currentUser?.roles.map(r => r.role_id).sort() || [];
      const newRoleIds = [...role_ids].sort();

      // Prevent admins from changing their own roles (to avoid lock-out)
      if (JSON.stringify(currentRoleIds) !== JSON.stringify(newRoleIds)) {
        throw "Admin cannot change their own roles";
      }

      // Allow email/username updates for self
    }

    // An enabled user must keep at least one role; only a disabled (locked) account
    // may have all roles removed. This pairs with the lock/disable workflow.
    if (role_ids.length === 0) {
      const target = await prisma.users.findUnique({
        where: { user_id },
        select: { disabled: true },
      });
      if (!target) throw "User not found";
      if (!target.disabled)
        throw "An enabled user must have at least one role. Lock (disable) the account first to remove all roles.";
    }

    try {
      await prisma.users.update({
        where: { user_id },
        data: { username, ...(email ? { email } : {}), nickname, tailscale_login, roles: { set: role_ids.map(role_id => ({ role_id })) } }
      });
    } catch (error) {
      handlePrismaUniqueConstraintError(error);
    }

    await recordAudit(state.engine, {
      action: "user.update", outcome: "success",
      actor_user_id: state.user.user_id, actor_label: actorLabel(state.user),
      target_type: "user", target_id: user_id, target_name: username,
    });

    return null;
  });

  user_set_disabled = admin(z => z.object({
    user_id: z.prismaField("Users", "user_id", "string"),
    disabled: z.boolean(),
  }), async (state, prisma) => {
    state.okAdmin();
    const { user_id, disabled } = state.data;

    // Guard against an admin locking themselves out.
    if (state.user.user_id === user_id && disabled)
      throw "You cannot disable your own account";

    // updateMany returns a count instead of throwing an ORM error for a missing user,
    // so we can surface a stable domain error.
    const { count } = await prisma.users.updateMany({ where: { user_id }, data: { disabled } });
    if (!count) throw "User not found";
    // Disabling immediately ends any active sessions for that user.
    if (disabled) await prisma.sessions.deleteMany({ where: { user_id } });

    await recordAudit(state.engine, {
      action: "user.set_disabled", outcome: "success",
      actor_user_id: state.user.user_id, actor_label: actorLabel(state.user),
      target_type: "user", target_id: user_id, detail: { disabled },
    });

    return null;
  });


  user_delete = admin(z => z.object({
    user_id: z.prismaField("Users", "user_id", "string"),
  }), async (state, prisma) => {
    const { user_id } = state.data;

    state.okAdmin();

    if (state.user.user_id === user_id) throw "Admin cannot delete themselves";

    const bags = await prisma.bags.count({ where: { owner_id: user_id } });

    if (bags) throw "User owns bags and cannot be deleted";

    await prisma.users.delete({ where: { user_id } });

    await recordAudit(state.engine, {
      action: "user.delete", outcome: "success",
      actor_user_id: state.user.user_id, actor_label: actorLabel(state.user),
      target_type: "user", target_id: user_id,
    });

    return null;
  });


  user_update_password = admin(z => z.object({
    user_id: z.prismaField("Users", "user_id", "string"),
    registrationRequest: z.string().optional(),
    registrationRecord: z.string().optional(),
    session_id: z.string().optional(),
    signature: z.string().optional(),
  }), async (state, prisma) => {
    const { user_id, registrationRecord, registrationRequest } = state.data;

    state.okUser();

    if (!state.user.isAdmin) {
      if (!state.data) throw "Session id and signature are required";
      const session = await prisma.sessions.findUnique({
        where: { session_id: state.data.session_id },
      });

      if (!session?.session_key)
        throw "Session not found";
      const { session_key } = session;
      const { session_id, signature } = state.data;
      if (!session_id || !signature)
        throw "Session id and signature are required";
      assertSignature({ session_id, session_key, signature });

      if (session.user_id !== user_id)
        throw "You must be an admin to update another user's password";

      if (state.user.user_id !== user_id)
        throw "You must be logged in as this user to update the password, "
        + "but normally this isn't supposed to happen (this is a bug, please report it)";

    }

    const userExists = await prisma.users.count({ where: { user_id } });
    if (!userExists) throw "User does not exist";

    if (registrationRequest) {
      return state.PasswordService.createRegistrationResponse({
        userID: user_id,
        registrationRequest
      });
    } else if (registrationRecord) {
      await prisma.users.update({
        where: { user_id },
        data: { password: registrationRecord }
      });
    }

    return null;
  });

  user_generate_temp_password = admin(z => z.object({
    user_id: z.prismaField("Users", "user_id", "string"),
  }), async (state, prisma) => {
    const { user_id } = state.data;

    state.okAdmin();

    // Check rate limiting to prevent abuse
    this.checkPasswordGenerationRateLimit(user_id);

    // Check if user exists
    const userExists = await prisma.users.count({ where: { user_id } });
    if (!userExists) throw "User does not exist";

    // Generate a cryptographically secure random temporary password (16 chars, readable but secure)
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*';
    const tempPassword = Array.from(
      { length: 16 },
      () => chars[randomInt(0, chars.length)]
    ).join('');

    // Use PasswordService.PasswordCreation to create OPAQUE registration server-side
    // This is designed for temporary passwords
    const registrationRecord = await state.PasswordService.PasswordCreation(user_id, tempPassword);

    // Store the OPAQUE registration record
    await prisma.users.update({
      where: { user_id },
      data: { password: registrationRecord }
    });

    await recordAudit(state.engine, {
      action: "user.temp_password", outcome: "success",
      actor_user_id: state.user.user_id, actor_label: actorLabel(state.user),
      target_type: "user", target_id: user_id,
    });

    // Return the temporary password to the admin (only shown once)
    return { temporaryPassword: tempPassword };
  });

  role_create = admin(z => z.object({
    role_name: z.string(),
    description: z.string(),
  }), async (state, prisma) => {
    const { role_name, description } = state.data;

    state.okAdmin();

    const roleCount = await prisma.roles.count();
    if (roleCount >= ROLE_SOFT_CAP)
      throw `Role limit reached (${ROLE_SOFT_CAP}). Delete an unused role or raise ROLE_SOFT_CAP.`;

    const role = await prisma.roles.create({
      data: { role_name, description }
    });

    await recordAudit(state.engine, {
      action: "role.create", outcome: "success",
      actor_user_id: state.user.user_id, actor_label: actorLabel(state.user),
      target_type: "role", target_id: role.role_id, target_name: role_name,
    });

    return role;
  });

  role_update = admin(z => z.object({
    role_id: z.prismaField("Roles", "role_id", "string"),
    role_name: z.prismaField("Roles", "role_name", "string"),
    description: z.prismaField("Roles", "description", "string"),
  }), async (state, prisma) => {
    const { role_id, role_name, description } = state.data;

    state.okUser();


    const roles = await prisma.roles.findMany({
      where: { role_name: { in: ["ADMIN", "USER"] } }
    });

    const forbidRoleIDs = new Set(roles.map(e => e.role_id));
    const forbidRoleNames = new Set(roles.map(e => e.role_name));

    if (!role_id) throw "Invalid role id"; // redundant, but it's security
    if (forbidRoleIDs.has(role_id)) throw "Cannot make changes to this role";
    if (forbidRoleNames.has(role_name)) throw "This role name is reserved";

    const updated = await prisma.roles.update({
      where: { role_id },
      data: { role_name, description }
    });

    await recordAudit(state.engine, {
      action: "role.update", outcome: "success",
      actor_user_id: state.user.user_id, actor_label: actorLabel(state.user),
      target_type: "role", target_id: role_id, target_name: role_name,
    });

    return updated;
  });

  // Read-only, paged, filterable view of the audit trail (access-model Batch 4).
  // Admin-only. Newest first. Reading the log is itself NOT audited (to avoid
  // self-referential noise from simply viewing the page).
  audit_list = admin(z => z.object({
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
    action: z.string().optional(),
    actor: z.string().optional(),
  }).optional(), async (state, prisma) => {
    state.okAdmin();

    const page = state.data?.page ?? 1;
    const pageSize = state.data?.pageSize ?? 50;

    const where: import("@tiddlywiki/mws-prisma").Prisma.AuditLogWhereInput = {};
    if (state.data?.action) where.action = state.data.action;
    if (state.data?.actor) where.actor_label = { contains: state.data.actor };

    const total = await prisma.auditLog.count({ where });
    const rows = await prisma.auditLog.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });

    return {
      total, page, pageSize,
      rows: rows.map(r => ({
        id: r.id,
        created_at: r.created_at.toISOString(),
        actor_user_id: r.actor_user_id,
        actor_label: r.actor_label,
        action: r.action,
        target_type: r.target_type,
        target_id: r.target_id,
        target_name: r.target_name,
        outcome: r.outcome,
        detail: r.detail ?? null,
        source: r.source,
      })),
    };
  });

}