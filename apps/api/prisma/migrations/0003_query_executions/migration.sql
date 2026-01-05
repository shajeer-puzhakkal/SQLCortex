-- Query execution history for Sprint 2 Phase 2.7

CREATE TABLE "query_executions" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "project_id" UUID,
  "user_id" UUID,
  "org_id" UUID,
  "sql" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "client_extension_version" TEXT,
  "client_vscode_version" TEXT,
  "execution_time_ms" INTEGER NOT NULL,
  "rows_returned" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "query_executions_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "query_executions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "query_executions_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "query_executions_project_id_created_at_idx"
  ON "query_executions" ("project_id", "created_at" DESC);

