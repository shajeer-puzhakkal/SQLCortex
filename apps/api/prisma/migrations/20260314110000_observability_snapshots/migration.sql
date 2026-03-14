CREATE TABLE IF NOT EXISTS "observability_snapshots" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "project_id" UUID NOT NULL,
  "snapshot_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "metric_type" TEXT NOT NULL,
  "metric_data" JSONB NOT NULL,
  CONSTRAINT "observability_snapshots_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "observability_snapshots_project_snapshot_time_idx"
  ON "observability_snapshots" ("project_id", "snapshot_time" DESC);

CREATE INDEX IF NOT EXISTS "observability_snapshots_project_metric_snapshot_time_idx"
  ON "observability_snapshots" ("project_id", "metric_type", "snapshot_time" DESC);
