-- Access-model (batch 4): append-only audit trail.
-- Additive: a new table + two indexes. Existing data is unaffected. MWS applies new
-- migrations at startup by reading prisma/migrations/*/migration.sql, so deploy = restart.
-- CreateTable
CREATE TABLE "audit_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "created_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_user_id" TEXT,
    "actor_label" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "target_name" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" JSONB,
    "source" TEXT
);

-- CreateIndex
CREATE INDEX "audit_log_created_at_idx" ON "audit_log"("created_at");

-- CreateIndex
CREATE INDEX "audit_log_actor_user_id_idx" ON "audit_log"("actor_user_id");

-- Append-only (WORM) enforcement at the database layer (NIST SP 800-53 AU-9 — protection of
-- audit information). The application only ever INSERTs audit rows; these triggers make that a
-- hard constraint so no SQL path (a bug, a future handler, or manual access) can alter or erase
-- the trail. INSERT is unaffected. NOTE: these triggers are intentional and are NOT represented
-- in prisma/schema.prisma (Prisma does not model triggers), so they will not appear in
-- `prisma migrate diff` output — they are maintained here by hand.
-- Retention/pruning is therefore a deliberate maintenance action: stop the service, drop the
-- delete trigger, prune, then recreate it (see docs/operations.md §8).
CREATE TRIGGER "audit_log_no_update"
BEFORE UPDATE ON "audit_log"
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: UPDATE is not allowed');
END;

CREATE TRIGGER "audit_log_no_delete"
BEFORE DELETE ON "audit_log"
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only: DELETE is not allowed');
END;
