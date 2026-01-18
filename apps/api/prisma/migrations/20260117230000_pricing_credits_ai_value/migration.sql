CREATE TABLE "org_entitlements" (
    "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "subject_type" TEXT NOT NULL,
    "org_id" UUID,
    "user_id" UUID,
    "plan_id" TEXT NOT NULL,
    "pro_started_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "org_entitlements_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "org_entitlements_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "org_entitlements_subject_type_org_id_key" ON "org_entitlements"("subject_type", "org_id");
CREATE UNIQUE INDEX "org_entitlements_subject_type_user_id_key" ON "org_entitlements"("subject_type", "user_id");

CREATE TABLE "org_ai_credits" (
    "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "subject_type" TEXT NOT NULL,
    "org_id" UUID,
    "user_id" UUID,
    "daily_credits" INTEGER NOT NULL,
    "credits_remaining" INTEGER NOT NULL,
    "grace_used" BOOLEAN NOT NULL DEFAULT false,
    "last_reset_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "org_ai_credits_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "org_ai_credits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "org_ai_credits_subject_type_org_id_key" ON "org_ai_credits"("subject_type", "org_id");
CREATE UNIQUE INDEX "org_ai_credits_subject_type_user_id_key" ON "org_ai_credits"("subject_type", "user_id");

CREATE TABLE "credit_events" (
    "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "org_id" UUID,
    "user_id" UUID,
    "event_type" TEXT NOT NULL,
    "credits_delta" INTEGER NOT NULL,
    "meta" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "credit_events_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "credit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "ai_value_daily" (
    "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    "org_id" UUID,
    "user_id" UUID,
    "date" DATE NOT NULL,
    "actions_count" INTEGER NOT NULL DEFAULT 0,
    "estimated_minutes_saved" INTEGER NOT NULL DEFAULT 0,
    "estimated_cost_saved_usd" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ai_value_daily_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ai_value_daily_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ai_value_daily_org_id_date_key" ON "ai_value_daily"("org_id", "date");
CREATE UNIQUE INDEX "ai_value_daily_user_id_date_key" ON "ai_value_daily"("user_id", "date");
