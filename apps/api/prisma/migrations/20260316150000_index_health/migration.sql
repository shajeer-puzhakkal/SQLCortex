CREATE TABLE IF NOT EXISTS "index_health" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "project_id" UUID NOT NULL,
  "index_name" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "recommendation" TEXT NOT NULL,
  CONSTRAINT "index_health_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "index_health_project_id_idx"
  ON "index_health" ("project_id");

CREATE INDEX IF NOT EXISTS "index_health_project_status_idx"
  ON "index_health" ("project_id", "status");
