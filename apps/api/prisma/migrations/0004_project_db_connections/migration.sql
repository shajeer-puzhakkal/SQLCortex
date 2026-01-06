-- Project database connections for Sprint 2 Phase 2.8A

CREATE TABLE "project_db_connections" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "project_id" UUID NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'postgres',
  "name" TEXT NOT NULL,
  "encrypted_credentials" JSONB NOT NULL,
  "ssl_mode" TEXT NOT NULL DEFAULT 'require',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "project_db_connections_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "project_db_connections_project_id_idx"
  ON "project_db_connections" ("project_id");
