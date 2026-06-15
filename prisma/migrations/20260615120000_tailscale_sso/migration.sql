-- Account security (batch 3): optional Tailscale identity for passwordless SSO.
-- Additive: a nullable column + a unique index (SQLite treats NULLs as distinct, so multiple
-- users may have NULL tailscale_login). Existing rows are unaffected.
-- AlterTable
ALTER TABLE "users" ADD COLUMN "tailscale_login" TEXT;
-- CreateIndex
CREATE UNIQUE INDEX "users_tailscale_login_key" ON "users"("tailscale_login");
