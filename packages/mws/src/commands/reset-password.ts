import { BaseCommand, CommandInfo } from "@tiddlywiki/commander";

export const info: CommandInfo = {
  name: "reset-password",
  description: "Reset a user's password from the CLI (admin recovery — requires server/shell "
    + "access). Sets a new OPAQUE registration record server-side, the same way init-store "
    + "creates the default admin password.",
  arguments: [
    ["username", "Username whose password to reset"],
    ["password", "New password to set"],
  ],
};

export class Command extends BaseCommand<[string, string], {}> {

  async execute() {
    const username = this.params[0] as PrismaField<"Users", "username">;
    const password = this.params[1] as string;

    if (!username || !password) {
      return "Usage: reset-password <username> <password>";
    }

    return await this.config.$transaction(async (prisma) => {
      const user = await prisma.users.findUnique({
        where: { username },
        select: { user_id: true },
      });
      if (!user) return `User "${username}" not found.`;

      const record = await this.config.PasswordService.PasswordCreation(
        user.user_id.toString(), password);

      await prisma.users.update({
        where: { user_id: user.user_id },
        data: { password: record },
      });

      console.log(`Password reset for "${username}".`);
      return null;
    });
  }
}
