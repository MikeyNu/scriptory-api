import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

const requiredFiles = [
  "supabase/config.toml",
  "supabase/.env.example",
  "supabase/migrations/20260701000000_scriptory_backend.sql",
  "supabase/migrations/20260702000000_accounts_profiles_notifications.sql",
  "supabase/migrations/20260703000000_admin_cms.sql",
  "supabase/functions/scriptory-api/deno.json",
  "supabase/functions/scriptory-api/index.ts",
  "supabase/functions/searchr-admin/deno.json",
  "supabase/functions/searchr-admin/index.ts",
  "supabase/functions/_shared/domain.ts"
];

for (const file of requiredFiles) {
  await stat(join(root, file));
}

const migration = await readFile(join(root, "supabase/migrations/20260701000000_scriptory_backend.sql"), "utf8");
const accountMigration = await readFile(join(root, "supabase/migrations/20260702000000_accounts_profiles_notifications.sql"), "utf8");
const adminMigration = await readFile(join(root, "supabase/migrations/20260703000000_admin_cms.sql"), "utf8");
const indexSource = await readFile(join(root, "supabase/functions/scriptory-api/index.ts"), "utf8");
const adminSource = await readFile(join(root, "supabase/functions/searchr-admin/index.ts"), "utf8");
const domainSource = await readFile(join(root, "supabase/functions/_shared/domain.ts"), "utf8");
const envExample = await readFile(join(root, ".env.example"), "utf8");
const supabaseEnvExample = await readFile(join(root, "supabase/.env.example"), "utf8");
const config = await readFile(join(root, "supabase/config.toml"), "utf8");

for (const marker of [
  "create table if not exists public.jobs",
  "create table if not exists public.ingestion_runs",
  "create table if not exists public.applications",
  "enable row level security",
  "jobs_search_text_trgm_idx"
]) {
  assert.ok(migration.includes(marker), `Supabase migration missing marker: ${marker}`);
}

for (const marker of [
  "create table if not exists public.profiles",
  "create table if not exists public.cv_documents",
  "create table if not exists public.saved_jobs",
  "create table if not exists public.notification_preferences",
  "create table if not exists public.notifications",
  "create trigger on_auth_user_created",
  "auth.uid()",
  "grant select, insert, update on public.profiles"
]) {
  assert.ok(accountMigration.includes(marker), `Supabase account migration missing marker: ${marker}`);
}

for (const marker of [
  "create table if not exists public.admin_memberships",
  "create table if not exists public.content_blocks",
  "create table if not exists public.job_sources",
  "create table if not exists public.job_moderation",
  "create table if not exists public.template_catalog",
  "create table if not exists public.palette_catalog",
  "create or replace view public.public_jobs_v",
  "create or replace view public.admin_dashboard_summary_v"
]) {
  assert.ok(adminMigration.includes(marker), `Supabase admin migration missing marker: ${marker}`);
}

for (const marker of [
  "Deno.serve",
  "/v1/jobs",
  "/v1/ingest/run",
  "/v1/notifications/run",
  "/v1/application-kits",
  "SUPABASE_SERVICE_ROLE_KEY",
  "RESEND_API_KEY"
]) {
  assert.ok(indexSource.includes(marker) || config.includes(marker), `Supabase function missing marker: ${marker}`);
}

for (const marker of [
  "Deno.serve",
  "/v1/admin/me",
  "/v1/admin/dashboard",
  "/v1/admin/users",
  "/v1/admin/jobs",
  "/v1/admin/sources",
  "/v1/admin/content",
  "/v1/admin/notification-campaigns",
  "/v1/admin/admin-memberships",
  "admin_audit_logs",
  "admin_memberships"
]) {
  assert.ok(adminSource.includes(marker) || config.includes(marker), `Supabase admin function missing marker: ${marker}`);
}

for (const marker of [
  "normalizeJob",
  "scoreJob",
  "buildApplicationKit",
  "configuredSources",
  "Adzuna South Africa",
  "Greenhouse",
  "Lever",
  "Partner feed"
]) {
  assert.ok(domainSource.includes(marker), `Supabase domain layer missing marker: ${marker}`);
}

for (const source of [envExample, supabaseEnvExample]) {
  assert.ok(!/ADZUNA_APP_ID=.{4,}/.test(source), "Adzuna app id must not be committed in env examples.");
  assert.ok(!/ADZUNA_APP_KEY=.{4,}/.test(source), "Adzuna app key must not be committed in env examples.");
  assert.ok(!/SUPABASE_SERVICE_ROLE_KEY=.{4,}/.test(source), "Supabase service role key must not be committed in env examples.");
}

console.log("Supabase validation passed: migration, Edge Function, source adapters, and secret hygiene are present.");
