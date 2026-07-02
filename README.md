# SearchR API

Supabase backend for SearchR job ingestion, matching, application kits, and application tracking.

The deployed Edge Function still lives at `supabase/functions/scriptory-api` for compatibility with the existing Supabase project. The older Node server in `src/` remains as a local fallback while the product moves to Supabase.

## Supabase Shape

- `supabase/migrations/20260701000000_scriptory_backend.sql`
  Creates `jobs`, `ingestion_runs`, and `applications` in Postgres.
- `supabase/migrations/20260702000000_accounts_profiles_notifications.sql`
  Adds Supabase Auth-owned profiles, settings, CV documents, saved jobs, application kits, saved searches, notifications, delivery audit rows, and RLS policies.
- `supabase/functions/scriptory-api/index.ts`
  Serves the API as a Supabase Edge Function and runs notification matching.
- `supabase/functions/_shared/domain.ts`
  Contains job normalization, matching, application kit building, and source adapters.

Supabase Edge Functions run on Deno and are deployed with the Supabase CLI. Database migrations are tracked from `supabase/migrations`.

## Configure Supabase

Project:

```text
ref: fdtncidguldauilzlxgs
region: eu-west-3
url: https://fdtncidguldauilzlxgs.supabase.co
function: https://fdtncidguldauilzlxgs.supabase.co/functions/v1/scriptory-api
```

```bash
cd api
copy supabase\.env.example supabase\.env
```

Fill:

```text
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
ADZUNA_APP_ID=
ADZUNA_APP_KEY=
ADMIN_TOKEN=
RESEND_API_KEY=
NOTIFICATION_FROM_EMAIL=
```

Keep real keys out of `.env.example`.

## Deploy

On Windows, use the guarded setup script. It prompts for secrets in the terminal, writes only ignored local env files, links the project, pushes the migration, uploads function secrets, deploys the Edge Function, and checks `/health`.

```bash
cd api
npm run supabase:setup
```

Manual path:

```bash
cd api
npm run supabase:link
npm run supabase:db:push
npm run supabase:secrets:push
npm run supabase:deploy
```

Hosted API base:

```text
https://fdtncidguldauilzlxgs.supabase.co/functions/v1/scriptory-api
```

Local Edge Function:

```bash
npm run supabase:serve
```

Local function base:

```text
http://127.0.0.1:54321/functions/v1/scriptory-api
```

## Connect Web

Set the web app API base to the Supabase function URL:

```js
localStorage.setItem("searchr-api-url", "https://fdtncidguldauilzlxgs.supabase.co/functions/v1/scriptory-api");
```

Then refresh the web app.

## Endpoints

All routes are under the function base URL.

- `GET /health`
- `GET /v1/sources`
- `POST /v1/ingest/run`
- `GET /v1/jobs`
- `GET /v1/jobs/:id`
- `POST /v1/matches`
- `POST /v1/application-kits`
- `POST /v1/notifications/run`
- `GET /v1/applications`
- `POST /v1/applications`
- `POST /v1/admin/jobs`

Admin endpoints use `Authorization: Bearer <ADMIN_TOKEN>` when `ADMIN_TOKEN` is set.

`/v1/notifications/run` scores recently ingested jobs against primary user CVs, saved preferences, and application history. It writes in-app notifications and sends immediate email only when `RESEND_API_KEY`, `NOTIFICATION_FROM_EMAIL`, and the user's preferences allow it.

## Accounts

The web app uses Supabase Auth directly from the browser with the public anon key. User-owned tables are protected with Row Level Security:

- `profiles`
- `user_settings`
- `notification_preferences`
- `cv_documents`
- `saved_jobs`
- `application_kits`
- `job_alert_rules`
- `user_job_matches`
- `notifications`
- `account_events`

The auth trigger creates a profile, settings row, notification preferences row, and welcome notification for each new user.

## Ingestion

Use official or permissioned sources:

- Adzuna South Africa API through `/jobs/za/search`.
- Public ATS boards for Greenhouse and Lever when employer board slugs are configured.
- Partner JSON feeds controlled by employers, agencies, training providers, or job boards.
- Admin job upload for private partner imports.

Run ingestion:

```bash
curl -X POST \
  -H "Authorization: Bearer your-admin-token" \
  https://fdtncidguldauilzlxgs.supabase.co/functions/v1/scriptory-api/v1/ingest/run
```

For scheduled ingestion, use Supabase Cron with pg_cron and pg_net to call the Edge Function on your chosen schedule.

## Local Node Fallback

```bash
cd api
copy .env.example .env
npm start
```

Local Node URL:

```text
http://127.0.0.1:4000
```

## Validate

```bash
npm run validate
```

This checks the local Node fallback and the Supabase backend files.

## Source Links

- https://supabase.com/docs/guides/functions
- https://supabase.com/docs/guides/deployment/database-migrations
- https://supabase.com/docs/guides/functions/schedule-functions
- https://developer.adzuna.com/docs/search
- https://developers.greenhouse.io/job-board.html
- https://github.com/lever/postings-api
