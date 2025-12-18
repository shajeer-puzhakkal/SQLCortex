-- Auth + orgs/projects/tokens additions for Sprint 1 Phase 02

-- Roles for org memberships/invites
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- Users: add password hash
ALTER TABLE "users" ADD COLUMN "password_hash" TEXT NOT NULL DEFAULT '';

-- Org members: role enum + default
ALTER TABLE "org_members" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "org_members"
  ALTER COLUMN "role" TYPE "OrgRole"
  USING (
    CASE LOWER("role")
      WHEN 'owner' THEN 'OWNER'
      WHEN 'admin' THEN 'ADMIN'
      WHEN 'member' THEN 'MEMBER'
      ELSE 'MEMBER'
    END
  )::"OrgRole";
ALTER TABLE "org_members" ALTER COLUMN "role" SET DEFAULT 'MEMBER';

-- Analyses: add org attribution
ALTER TABLE "analyses" ADD COLUMN "org_id" UUID;
ALTER TABLE "analyses"
  ADD CONSTRAINT "analyses_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- API tokens: replace subject scope columns
ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_user_id_fkey";
ALTER TABLE "api_tokens" DROP CONSTRAINT "api_tokens_org_id_fkey";
ALTER TABLE "api_tokens" DROP COLUMN "user_id";
ALTER TABLE "api_tokens" DROP COLUMN "org_id";

ALTER TABLE "api_tokens" ADD COLUMN "subject_type" "SubjectType";
ALTER TABLE "api_tokens" ADD COLUMN "subject_id" UUID;
ALTER TABLE "api_tokens" ADD COLUMN "project_id" UUID;
ALTER TABLE "api_tokens" ADD COLUMN "revoked_at" TIMESTAMP(3);

ALTER TABLE "api_tokens" ALTER COLUMN "subject_type" SET NOT NULL;
ALTER TABLE "api_tokens" ALTER COLUMN "subject_id" SET NOT NULL;

ALTER TABLE "api_tokens"
  ADD CONSTRAINT "api_tokens_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Sessions for browser auth
CREATE TABLE "sessions" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "token_hash" TEXT NOT NULL UNIQUE,
  "user_id" UUID NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "revoked_at" TIMESTAMP(3),
  CONSTRAINT "sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- Org invites
CREATE TABLE "org_invites" (
  "id" UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  "org_id" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
  "token_hash" TEXT NOT NULL UNIQUE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3),
  "accepted_at" TIMESTAMP(3),
  "accepted_by_user_id" UUID,
  CONSTRAINT "org_invites_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "org_invites_accepted_by_user_id_fkey"
    FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

-- Enforce exclusive project ownership
ALTER TABLE "projects"
  ADD CONSTRAINT "projects_owner_or_org_check"
  CHECK (("org_id" IS NULL) <> ("owner_user_id" IS NULL));
