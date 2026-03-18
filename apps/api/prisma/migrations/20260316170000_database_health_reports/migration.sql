CREATE TABLE IF NOT EXISTS "database_health_reports" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "project_id" UUID NOT NULL,
  "report_week_start" TIMESTAMP(3) NOT NULL,
  "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "health_score" INTEGER NOT NULL,
  "report_json" JSONB NOT NULL,
  CONSTRAINT "database_health_reports_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "database_health_reports_project_week_unique"
  ON "database_health_reports" ("project_id", "report_week_start");

CREATE INDEX IF NOT EXISTS "database_health_reports_project_generated_at_idx"
  ON "database_health_reports" ("project_id", "generated_at" DESC);
