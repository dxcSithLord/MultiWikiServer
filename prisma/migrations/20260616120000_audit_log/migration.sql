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
