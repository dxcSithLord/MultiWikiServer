
import { registerZodRoutes, RouterKeyMap, RouterRouteMap, ServerRoute } from "@tiddlywiki/server";
import { admin } from "./admin-utils";
import { assertSignature } from "../services/sessions";
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
  role_create: true,
  role_update: true,
}

export type UserManagerMap = RouterRouteMap<UserManager>;

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
        roles: true,
        last_login: true,
        created_at: true,
      }
    });
    return res;
  });


  user_create = admin(z => z.object({
    username: z.string(),
    email: z.string(),
    role_ids: z.prismaField("Roles", "role_id", "string", false).array(),
  }), async (state, prisma) => {
    const { username, email, role_ids } = state.data;

    state.okAdmin();

    try {
      const user = await prisma.users.create({
        data: { username, email, password: "", roles: { connect: role_ids.map(role_id => ({ role_id })) } },
        select: { user_id: true, created_at: true }
      });

      return user;
    } catch (error) {
      handlePrismaUniqueConstraintError(error);
    }
  });

  user_update = admin(z => z.object({
    user_id: z.prismaField("Users", "user_id", "string"),
    username: z.prismaField("Users", "username", "string"),
    email: z.prismaField("Users", "email", "string"),
    role_ids: z.prismaField("Roles", "role_id", "string").array(),
  }), async (state, prisma) => {
    const { user_id, username, email, role_ids } = state.data;

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

    try {
      await prisma.users.update({
        where: { user_id },
        data: { username, email, roles: { set: role_ids.map(role_id => ({ role_id })) } }
      });
    } catch (error) {
      handlePrismaUniqueConstraintError(error);
    }

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

    // Return the temporary password to the admin (only shown once)
    return { temporaryPassword: tempPassword };
  });

  role_create = admin(z => z.object({
    role_name: z.string(),
    description: z.string(),
  }), async (state, prisma) => {
    const { role_name, description } = state.data;

    state.okAdmin();

    return await prisma.roles.create({
      data: { role_name, description }
    });

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

    return await prisma.roles.update({
      where: { role_id },
      data: { role_name, description }
    });

  });

}