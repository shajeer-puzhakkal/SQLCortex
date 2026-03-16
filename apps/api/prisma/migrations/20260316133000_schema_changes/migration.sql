CREATE TABLE IF NOT EXISTS "schema_changes" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "project_id" UUID NOT NULL,
  "change_type" TEXT NOT NULL,
  "object_name" TEXT NOT NULL,
  "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "schema_changes_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "schema_changes_project_detected_at_idx"
  ON "schema_changes" ("project_id", "detected_at" DESC);

CREATE INDEX IF NOT EXISTS "schema_changes_project_change_type_detected_at_idx"
  ON "schema_changes" ("project_id", "change_type", "detected_at" DESC);
