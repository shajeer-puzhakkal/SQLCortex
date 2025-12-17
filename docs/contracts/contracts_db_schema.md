# Database Schema (Postgres)

Tables and minimum columns required for Sprint 1.

## users
- `id` uuid PK
- `email` text UNIQUE
- `name` text nullable
- `created_at` timestamptz default now()
- `updated_at` timestamptz default now()

## organizations
- `id` uuid PK
- `name` text
- `created_at` timestamptz default now()
- `updated_at` timestamptz default now()

## org_members
- `id` uuid PK
- `role` text default `member`
- `user_id` uuid FK → users.id (cascade)
- `org_id` uuid FK → organizations.id (cascade)
- `created_at` timestamptz default now()
- UNIQUE (`user_id`, `org_id`)

## projects
- `id` uuid PK
- `name` text
- `org_id` uuid FK → organizations.id (set null)
- `owner_user_id` uuid FK → users.id (set null)
- `created_at` timestamptz default now()
- `updated_at` timestamptz default now()

## analyses
- `id` uuid PK
- `project_id` uuid FK → projects.id (set null)
- `user_id` uuid FK → users.id (set null)
- `sql` text
- `explain_json` jsonb
- `result` jsonb nullable
- `status` text default `queued`
- `created_at` timestamptz default now()
- `updated_at` timestamptz default now()

## api_tokens
- `id` uuid PK
- `token_hash` text UNIQUE
- `label` text nullable
- `user_id` uuid FK → users.id (set null)
- `org_id` uuid FK → organizations.id (set null)
- `created_at` timestamptz default now()
- `last_used_at` timestamptz nullable

## plans
- `id` uuid PK
- `code` text UNIQUE
- `name` text
- `monthly_analysis_limit` int
- `monthly_llm_call_limit` int
- `created_at` timestamptz default now()

## subscriptions
- `id` uuid PK
- `plan_id` uuid FK → plans.id (cascade)
- `subject_type` enum(`USER`,`ORG`)
- `user_id` uuid FK → users.id (set null)
- `org_id` uuid FK → organizations.id (set null)
- `created_at` timestamptz default now()

## usage_counters
- `id` uuid PK
- `subject_type` enum(`USER`,`ORG`)
- `user_id` uuid FK → users.id (set null)
- `org_id` uuid FK → organizations.id (set null)
- `month` timestamptz (month bucket)
- `analyses_count` int default 0
- `llm_calls_count` int default 0
- `created_at` timestamptz default now()
- `updated_at` timestamptz default now()
- UNIQUE (`subject_type`, `user_id`, `org_id`, `month`)
