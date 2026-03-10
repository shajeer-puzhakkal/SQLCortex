CREATE TABLE IF NOT EXISTS "query_intelligence_events" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "project_id" UUID NOT NULL,
  "user_id" UUID,
  "org_id" UUID,
  "connection_id" UUID,
  "query_fingerprint" TEXT NOT NULL,
  "score" INTEGER NOT NULL,
  "risk_level" TEXT NOT NULL,
  "cost_bucket" TEXT NOT NULL,
  "complexity" TEXT NOT NULL,
  "mode" TEXT NOT NULL,
  "reasons_json" JSONB NOT NULL,
  "feature_summary_json" JSONB NOT NULL,
  "query_text_encrypted" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "query_intelligence_events_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "query_intelligence_events_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "query_intelligence_events_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "query_intelligence_events_project_created_at_idx"
  ON "query_intelligence_events" ("project_id", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "query_intelligence_events_project_risk_created_at_idx"
  ON "query_intelligence_events" ("project_id", "risk_level", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "query_intelligence_events_project_fingerprint_created_at_idx"
  ON "query_intelligence_events" ("project_id", "query_fingerprint", "created_at" DESC);
