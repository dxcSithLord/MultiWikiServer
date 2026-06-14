-- Account security (batch 1): add a reversible account-lock flag and an optional
-- user-chosen display nickname. Additive columns only (no table rebuild), so existing
-- user rows are preserved. `email` stays NOT NULL in the DB and is auto-derived by the
-- app when an admin omits it.
-- AlterTable
ALTER TABLE "users" ADD COLUMN "nickname" TEXT;
ALTER TABLE "users" ADD COLUMN "disabled" BOOLEAN NOT NULL DEFAULT false;
