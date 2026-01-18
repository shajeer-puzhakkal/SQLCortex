DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'SubjectType') THEN
    CREATE TYPE "SubjectType" AS ENUM ('USER', 'ORG');
  END IF;
END $$;

ALTER TABLE "org_entitlements"
  ALTER COLUMN "subject_type" TYPE "SubjectType"
  USING "subject_type"::"SubjectType";

ALTER TABLE "org_ai_credits"
  ALTER COLUMN "subject_type" TYPE "SubjectType"
  USING "subject_type"::"SubjectType";
