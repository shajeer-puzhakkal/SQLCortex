CREATE TABLE IF NOT EXISTS "schema_snapshots" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "project_id" UUID NOT NULL,
  "snapshot_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "schema_hash" TEXT NOT NULL,
  "schema_json" JSONB NOT NULL,
  CONSTRAINT "schema_snapshots_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "schema_snapshots_project_snapshot_time_idx"
  ON "schema_snapshots" ("project_id", "snapshot_time" DESC);

CREATE INDEX IF NOT EXISTS "schema_snapshots_project_schema_hash_idx"
  ON "schema_snapshots" ("project_id", "schema_hash");
