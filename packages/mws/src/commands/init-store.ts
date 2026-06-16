import { dist_require_resolve, dist_resolve } from "@tiddlywiki/server";
import { BaseCommand, CommandInfo } from "@tiddlywiki/commander";
import { resolve } from "path";
import { randomInt } from "crypto";
import { Command as LoadWikiFolderCommand } from "./load-wiki-folder";
import { REFERENCE_RECIPES } from "../services/reference-recipes";
import { WIKI_ADMIN_ROLE } from "../services/roles";

export const info: CommandInfo = {
	name: "init-store",
	description: "Initialize the MWS data folder",
	arguments: [],
};

/**
 * Generate a cryptographically-random, unique-per-install initial admin password.
 *
 * This replaces the former universal `1234` default to align with the INTENT of the UK
 * Product Security and Telecommunications Infrastructure (PSTI) Act 2022 and the PSTI
 * (Security Requirements for Relevant Connectable Products) Regulations 2023 (SI 2023/1007),
 * Schedule 1, Part 1, para 1: a manufacturer-set password must be "unique per product" or
 * "defined by the user", and must not be guessable, based on incremental counters, or
 * derived from public information / identifiers. A CSPRNG-generated password is unique per
 * install and not derived from any such source. (See docs/security.md.) Rotate later with
 * `mws reset-password <username> <password>`.
 *
 * Uses an unambiguous charset (no 0/O/1/l/I): 24 chars over 56 symbols ≈ 139 bits of entropy.
 */
function generateInitialPassword(): string {
	const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
	let out = "";
	for (let i = 0; i < 24; i++) out += charset[randomInt(charset.length)];
	return out;
}


export class Command extends BaseCommand {

	async execute(): Promise<any> {
		await this.setupStore().catch((err) => {

			throw err;
		});
	}

	async setupStore() {

		await this.config.$transaction(async (prisma) => {
			const userCount = await prisma.users.count();

			if (!userCount) {

				await prisma.roles.createMany({
					data: [
						{ role_name: "ADMIN", description: "System Administrator" },
						{ role_name: "USER", description: "Basic User" },
						// Wiki data-management tier (access-model Batch 3): may create and
						// delete recipes/bags WITHOUT site-admin content access. See
						// services/roles.ts. Existing deployments add this role via the
						// admin Users/Roles UI; init-store seeds it for fresh installs.
						{ role_name: WIKI_ADMIN_ROLE, description: "Wiki data management" },
					]
				});

				// Connect the initial admin to BOTH ADMIN and USER. The USER role grants
				// read access to the default reference wikis via the seeded `USER -> READ`
				// ACLs (see the seeding block below), so the admin can read them without
				// any admin-specific content bypass (removed in access-model Batch 2).
				const user = await prisma.users.create({
					data: {
						username: "admin", email: "", password: "",
						roles: { connect: [{ role_name: "ADMIN" }, { role_name: "USER" }] }
					},
					select: { user_id: true }
				});

				const initialPassword = generateInitialPassword();
				const password = await this.config.PasswordService.PasswordCreation(user.user_id.toString(), initialPassword);

				await prisma.users.update({
					where: { user_id: user.user_id },
					data: { password: password }
				});

				console.log(
					"\n============================================================\n" +
					"  Initial admin account created:\n" +
					"      username: admin\n" +
					`      password: ${initialPassword}\n` +
					"\n" +
					"  RECORD THIS NOW — it is shown only once and cannot be recovered.\n" +
					"  Log in and change it, or rotate it any time with:\n" +
					"      mws reset-password admin <new-password>\n" +
					"\n" +
					"  This unique, per-install random password replaces the old fixed\n" +
					"  default, aligning with the intent of the UK PSTI Act 2022 /\n" +
					"  SI 2023/1007 Sch. 1 (no universal/guessable default passwords).\n" +
					"============================================================\n"
				);
			}

		});

		// should give us the path to boot.js
		const tweditions = resolve(dist_require_resolve("tiddlywiki"), "../../editions");

		const runner = async (path: string, bagName: string, bagDesc: string, recName: string, recDesc: string) => {
			const command = new LoadWikiFolderCommand([path!], {
				"bag-name": [bagName],
				"bag-description": [bagDesc],
				"recipe-name": [recName],
				"recipe-description": [recDesc],
				overwrite: false
			});
			command.$tw = this.$tw;
			command.config = this.config;
			await command.execute();
		}

		await runner(dist_resolve("../editions/mws-docs"),
			"mws-docs", "MWS Documentation from https://mws.tiddlywiki.com",
			"mws-docs", "MWS Documentation from https://mws.tiddlywiki.com");
		await runner(resolve(tweditions, "tw5.com"),
			"docs", "TiddlyWiki Documentation from https://tiddlywiki.com",
			"docs", "TiddlyWiki Documentation from https://tiddlywiki.com");
		await runner(resolve(tweditions, "dev"),
			"dev", "TiddlyWiki Developer Documentation from https://tiddlywiki.com/dev",
			"dev-docs", "TiddlyWiki Developer Documentation from https://tiddlywiki.com/dev");
		await runner(resolve(tweditions, "tour"),
			"tour", "TiddlyWiki Interactive Tour from https://tiddlywiki.com",
			"tour", "TiddlyWiki Interactive Tour from https://tiddlywiki.com");

		// Seed `USER -> READ` on the standard reference wikis so any USER-role user
		// can read them from `/home` on a fresh install (live stores were backfilled
		// manually via the ACL editor). Runs after the recipes are created above.
		// Additive and idempotent: it only ADDS the grant when that exact
		// (recipe, USER, READ) row is absent, never deleting or modifying existing
		// ACLs, so re-running init-store and any operator-set grants are preserved.
		// The recipe_acl table has no unique constraint, hence the explicit
		// existence check rather than relying on createMany skipDuplicates.
		await this.config.$transaction(async (prisma) => {
			const userRole = await prisma.roles.findUnique({
				where: { role_name: "USER" },
				select: { role_id: true }
			});
			if (!userRole) return;

			for (const recipe_name of REFERENCE_RECIPES) {
				const recipe = await prisma.recipes.findUnique({
					where: { recipe_name },
					select: { recipe_id: true }
				});
				if (!recipe) continue;

				const existing = await prisma.recipeAcl.findFirst({
					where: { recipe_id: recipe.recipe_id, role_id: userRole.role_id, permission: "READ" },
					select: { acl_id: true }
				});
				if (existing) continue;

				await prisma.recipeAcl.create({
					data: { recipe_id: recipe.recipe_id, role_id: userRole.role_id, permission: "READ" }
				});
			}
		});

		this.config.setupRequired = false;
	}
}

