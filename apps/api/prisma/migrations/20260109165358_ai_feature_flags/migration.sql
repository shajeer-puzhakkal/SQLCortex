-- DropIndex
DROP INDEX "project_db_connections_project_id_idx";

-- DropIndex
DROP INDEX "query_executions_project_id_created_at_idx";

-- AlterTable
ALTER TABLE "analyses" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "api_tokens" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "org_invites" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "org_members" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "organizations" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "plans" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "project_db_connections" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "projects" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "query_executions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "sessions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "subscriptions" ALTER COLUMN "id" DROP DEFAULT;

-- AlterTable
ALTER TABLE "usage_counters" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "id" DROP DEFAULT,
ALTER COLUMN "updated_at" DROP DEFAULT,
ALTER COLUMN "password_hash" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "org_members_user_org_unique" RENAME TO "org_members_user_id_org_id_key";

-- RenameIndex
ALTER INDEX "usage_counters_subject_month_unique" RENAME TO "usage_counters_subject_type_user_id_org_id_month_key";
