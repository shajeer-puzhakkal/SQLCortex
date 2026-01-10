ALTER TABLE "organizations"
ADD COLUMN "ai_enabled" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "projects"
ADD COLUMN "ai_enabled" BOOLEAN NOT NULL DEFAULT true;
