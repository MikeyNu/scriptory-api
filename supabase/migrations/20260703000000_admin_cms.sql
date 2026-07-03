alter table public.profiles
  add column if not exists account_status text not null default 'active',
  add column if not exists status_reason text not null default '',
  add column if not exists suspended_at timestamptz;

alter table public.profiles
  drop constraint if exists profiles_account_status_check;

alter table public.profiles
  add constraint profiles_account_status_check
  check (account_status in ('active', 'suspended'));

create table if not exists public.admin_memberships (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null,
  status text not null default 'active',
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_memberships
  drop constraint if exists admin_memberships_role_check;

alter table public.admin_memberships
  add constraint admin_memberships_role_check
  check (role in ('owner', 'platform_admin', 'operations_admin', 'support_admin', 'content_admin', 'analyst'));

alter table public.admin_memberships
  drop constraint if exists admin_memberships_status_check;

alter table public.admin_memberships
  add constraint admin_memberships_status_check
  check (status in ('active', 'suspended'));

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text not null default '',
  action text not null,
  subject_type text not null,
  subject_id text not null default '',
  before_state jsonb not null default '{}'::jsonb,
  after_state jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  request_id text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_logs_actor_idx on public.admin_audit_logs (actor_user_id, created_at desc);
create index if not exists admin_audit_logs_subject_idx on public.admin_audit_logs (subject_type, subject_id, created_at desc);

create table if not exists public.admin_user_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  author_user_id uuid references auth.users(id) on delete set null,
  note_text text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists admin_user_notes_user_idx on public.admin_user_notes (user_id, created_at desc);

create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  description text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.feature_flags (
  key text primary key,
  enabled boolean not null default false,
  rules jsonb not null default '{}'::jsonb,
  description text not null default '',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.content_blocks (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  section text not null default '',
  locale text not null default 'en-ZA',
  content jsonb not null default '{}'::jsonb,
  status text not null default 'published',
  updated_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.content_blocks
  drop constraint if exists content_blocks_status_check;

alter table public.content_blocks
  add constraint content_blocks_status_check
  check (status in ('draft', 'published'));

create index if not exists content_blocks_section_idx on public.content_blocks (section, key);

create table if not exists public.job_sources (
  id uuid primary key default gen_random_uuid(),
  source_type text not null,
  name text not null,
  is_enabled boolean not null default true,
  config jsonb not null default '{}'::jsonb,
  secret_refs jsonb not null default '{}'::jsonb,
  schedule jsonb not null default '{}'::jsonb,
  last_tested_at timestamptz,
  last_success_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.job_sources
  drop constraint if exists job_sources_source_type_check;

alter table public.job_sources
  add constraint job_sources_source_type_check
  check (source_type in ('adzuna_query_set', 'greenhouse_board', 'lever_board', 'partner_feed'));

create index if not exists job_sources_type_idx on public.job_sources (source_type, is_enabled);

create table if not exists public.source_run_reports (
  id uuid primary key default gen_random_uuid(),
  ingestion_run_id text not null references public.ingestion_runs(id) on delete cascade,
  job_source_id uuid references public.job_sources(id) on delete set null,
  source_key text not null default '',
  fetched_count integer not null default 0,
  upserted_count integer not null default 0,
  failed_count integer not null default 0,
  error_text text not null default '',
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists source_run_reports_run_idx on public.source_run_reports (ingestion_run_id);
create index if not exists source_run_reports_source_idx on public.source_run_reports (job_source_id, started_at desc);

create table if not exists public.job_moderation (
  job_id text primary key references public.jobs(id) on delete cascade,
  visibility_status text not null default 'visible',
  review_state text not null default 'approved',
  pinned_rank integer,
  tags text[] not null default '{}'::text[],
  internal_notes text not null default '',
  override_payload jsonb not null default '{}'::jsonb,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table public.job_moderation
  drop constraint if exists job_moderation_visibility_status_check;

alter table public.job_moderation
  add constraint job_moderation_visibility_status_check
  check (visibility_status in ('visible', 'hidden', 'featured', 'archived'));

alter table public.job_moderation
  drop constraint if exists job_moderation_review_state_check;

alter table public.job_moderation
  add constraint job_moderation_review_state_check
  check (review_state in ('approved', 'needs_review', 'rejected'));

create index if not exists job_moderation_visibility_idx on public.job_moderation (visibility_status, review_state);

create table if not exists public.template_catalog (
  id text primary key,
  name text not null,
  short_name text not null,
  description text not null default '',
  audience text not null default '',
  preview_palette_id text not null default '',
  sort_order integer not null default 0,
  is_enabled boolean not null default true,
  is_featured boolean not null default false,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.palette_catalog (
  id text primary key,
  name text not null,
  description text not null default '',
  tokens jsonb not null default '{}'::jsonb,
  sort_order integer not null default 0,
  is_enabled boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create table if not exists public.admin_notification_campaigns (
  id uuid primary key default gen_random_uuid(),
  type text not null default 'account_notice',
  audience jsonb not null default '{}'::jsonb,
  title text not null default '',
  body jsonb not null default '{}'::jsonb,
  action_url text not null default '',
  status text not null default 'draft',
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.admin_notification_campaigns
  drop constraint if exists admin_notification_campaigns_status_check;

alter table public.admin_notification_campaigns
  add constraint admin_notification_campaigns_status_check
  check (status in ('draft', 'scheduled', 'sent', 'cancelled'));

drop trigger if exists admin_memberships_set_updated_at on public.admin_memberships;
create trigger admin_memberships_set_updated_at before update on public.admin_memberships
  for each row execute function public.set_updated_at();

drop trigger if exists admin_user_notes_set_updated_at on public.admin_user_notes;
create trigger admin_user_notes_set_updated_at before update on public.admin_user_notes
  for each row execute function public.set_updated_at();

drop trigger if exists platform_settings_set_updated_at on public.platform_settings;
create trigger platform_settings_set_updated_at before update on public.platform_settings
  for each row execute function public.set_updated_at();

drop trigger if exists feature_flags_set_updated_at on public.feature_flags;
create trigger feature_flags_set_updated_at before update on public.feature_flags
  for each row execute function public.set_updated_at();

drop trigger if exists content_blocks_set_updated_at on public.content_blocks;
create trigger content_blocks_set_updated_at before update on public.content_blocks
  for each row execute function public.set_updated_at();

drop trigger if exists job_sources_set_updated_at on public.job_sources;
create trigger job_sources_set_updated_at before update on public.job_sources
  for each row execute function public.set_updated_at();

drop trigger if exists job_moderation_set_updated_at on public.job_moderation;
create trigger job_moderation_set_updated_at before update on public.job_moderation
  for each row execute function public.set_updated_at();

drop trigger if exists template_catalog_set_updated_at on public.template_catalog;
create trigger template_catalog_set_updated_at before update on public.template_catalog
  for each row execute function public.set_updated_at();

drop trigger if exists palette_catalog_set_updated_at on public.palette_catalog;
create trigger palette_catalog_set_updated_at before update on public.palette_catalog
  for each row execute function public.set_updated_at();

drop trigger if exists admin_notification_campaigns_set_updated_at on public.admin_notification_campaigns;
create trigger admin_notification_campaigns_set_updated_at before update on public.admin_notification_campaigns
  for each row execute function public.set_updated_at();

alter table public.admin_memberships enable row level security;
alter table public.admin_audit_logs enable row level security;
alter table public.admin_user_notes enable row level security;
alter table public.platform_settings enable row level security;
alter table public.feature_flags enable row level security;
alter table public.content_blocks enable row level security;
alter table public.job_sources enable row level security;
alter table public.source_run_reports enable row level security;
alter table public.job_moderation enable row level security;
alter table public.template_catalog enable row level security;
alter table public.palette_catalog enable row level security;
alter table public.admin_notification_campaigns enable row level security;

insert into public.platform_settings (key, value, description)
values
  ('jobs.defaults', '{"pageSize":10}'::jsonb, 'Default jobs page settings.'),
  ('support.contact', '{"email":"","phone":""}'::jsonb, 'Support contact shown in admin and future public help views.')
on conflict (key) do nothing;

insert into public.feature_flags (key, enabled, rules, description)
values
  ('admin_cms', true, '{}'::jsonb, 'Enables the admin CMS.'),
  ('public_content_blocks', true, '{}'::jsonb, 'Enables DB-backed public content blocks.'),
  ('template_catalog', true, '{}'::jsonb, 'Enables DB-backed template catalog metadata.'),
  ('job_moderation', true, '{}'::jsonb, 'Enables job visibility and override moderation.')
on conflict (key) do nothing;

insert into public.content_blocks (key, section, content, status, published_at)
values
  ('home.hero', 'home', '{"eyebrow":"CVs, job matches, application kits","title":"Craft a CV that knows where it is going.","body":"Choose a print-ready template, shape your A4 proof, then search live roles, compare fit, and build an honest application kit.","primaryCta":"Start CV","secondaryCta":"Search jobs"}'::jsonb, 'published', now()),
  ('home.templates_intro', 'home', '{"eyebrow":"Templates","title":"Pick the paper that fits the work.","body":"Preview every layout with sample content, then switch later without losing a line."}'::jsonb, 'published', now()),
  ('home.flow_intro', 'home', '{"eyebrow":"The flow","title":"Write once. Aim better."}'::jsonb, 'published', now()),
  ('templates.intro', 'templates', '{"eyebrow":"Templates","title":"Choose the working paper.","body":"Pick a layout for the role in front of you. Switch later without losing your CV."}'::jsonb, 'published', now()),
  ('jobs.intro', 'jobs', '{"eyebrow":"Opportunity Engine","body":"Search live roles, rank them against your CV, and prepare the next application with care.","toolbarTitle":"Jobs"}'::jsonb, 'published', now()),
  ('auth.intro', 'auth', '{"eyebrow":"Account desk","title":"Save your career folio.","body":"Sign in to keep CVs, saved roles, kits, applications, and alerts in your SearchR account."}'::jsonb, 'published', now())
on conflict (key) do nothing;

insert into public.template_catalog (id, name, short_name, description, audience, preview_palette_id, sort_order, is_enabled, is_featured)
values
  ('service-retail-a4', 'Service Letterpress', 'Service Letterpress', 'Warm layout for retail, service, and general work.', 'Retail and service', 'oxblood', 10, true, true),
  ('corporate-ledger-a4', 'Corporate Ledger', 'Corporate Ledger', 'Formal layout for admin, reception, and office roles.', 'Admin and office', 'navy', 20, true, false),
  ('graduate-folio-a4', 'Graduate Folio', 'Graduate Folio', 'Clear structure for graduates, interns, and first roles.', 'Graduates', 'forest', 30, true, false),
  ('technical-dossier-a4', 'Technical Dossier', 'Technical Dossier', 'Practical layout for IT, logistics, and field roles.', 'Technical roles', 'charcoal', 40, true, false),
  ('creative-editorial-a4', 'Creative Editorial', 'Creative Editorial', 'Editorial style for creative and client-facing work.', 'Creative roles', 'atelier', 50, true, false),
  ('executive-ministerial-a4', 'Executive Ministerial', 'Executive Ministerial', 'Restrained senior layout for managers, supervisors, directors, and formal leadership roles.', 'Managers and senior professionals', 'sepia-blue', 60, true, false),
  ('modern-clerk-a4', 'Modern Clerk', 'Modern Clerk', 'Clean ledger structure for admin, office, reception, clerk, and support roles.', 'Admin and clerical roles', 'navy', 70, true, false),
  ('hospitality-service-a4', 'Hospitality Service', 'Hospitality Service', 'Warm service layout for waiters, runners, hotel staff, front desk teams, and restaurant applicants.', 'Hospitality and guest service', 'oxblood', 80, true, false),
  ('healthcare-caregiver-a4', 'Healthcare Caregiver', 'Healthcare Caregiver', 'Calm, trustworthy layout for care workers, wellness assistants, clinic support, and caregiving roles.', 'Care and clinic support', 'sage-brass', 90, true, false),
  ('security-operations-a4', 'Security Operations', 'Security Operations', 'Disciplined operations file for guards, control room staff, field officers, and security supervisors.', 'Security operations', 'charcoal', 100, true, false),
  ('driver-logistics-a4', 'Driver Logistics', 'Driver Logistics', 'Route-sheet CV for drivers, warehouse teams, dispatch assistants, logistics workers, and delivery staff.', 'Drivers and logistics', 'copper-pine', 110, true, false),
  ('beauty-wellness-a4', 'Beauty Wellness', 'Beauty Wellness', 'Soft editorial CV for spa, salon, massage, beauty retail, skincare, and wellness applicants.', 'Beauty and wellness', 'slate-rose', 120, true, false),
  ('artisan-trade-a4', 'Artisan Trade', 'Artisan Trade', 'Technical checklist CV for electricians, plumbers, installers, technicians, artisans, and site workers.', 'Artisans and trades', 'sepia-blue', 130, true, false),
  ('ats-plain-a4', 'ATS Plain', 'ATS Plain', 'Simple single-column CV for online applications.', 'ATS applications', 'plain', 140, true, false)
on conflict (id) do nothing;

insert into public.palette_catalog (id, name, description, tokens, sort_order, is_enabled)
values
  ('oxblood', 'Oxblood', 'Warm red seal.', '{"cvInk":"#17202a","cvAccent":"#8b3f2d","cvAccentDark":"#5d281d","cvPaper":"#fffdf8","cvPanel":"#f2e7d8","cvLine":"#d8c5a8","cvMuted":"#5d6670","cvSide":"#26384b","thumbMatte":"#d9c4a4","tileAccent":"#8b3f2d"}'::jsonb, 10, true),
  ('forest', 'Forest', 'Deep green.', '{"cvInk":"#18241e","cvAccent":"#2f5a43","cvAccentDark":"#1e3d2d","cvPaper":"#fffdf6","cvPanel":"#eaf0e6","cvLine":"#c7d0bd","cvMuted":"#59685d","cvSide":"#25392f","thumbMatte":"#c9d0bc","tileAccent":"#2f5a43"}'::jsonb, 20, true),
  ('navy', 'Navy', 'Traditional blue.', '{"cvInk":"#172131","cvAccent":"#2e4669","cvAccentDark":"#1d2f4b","cvPaper":"#fffefd","cvPanel":"#e9eef4","cvLine":"#c7d1df","cvMuted":"#586474","cvSide":"#24344e","thumbMatte":"#c2cad7","tileAccent":"#2e4669"}'::jsonb, 30, true),
  ('charcoal', 'Charcoal', 'Graphite and copper.', '{"cvInk":"#242422","cvAccent":"#9b6546","cvAccentDark":"#5b3a2c","cvPaper":"#fffdf8","cvPanel":"#eee7df","cvLine":"#d0c3b4","cvMuted":"#62615d","cvSide":"#30302d","thumbMatte":"#cec2b5","tileAccent":"#9b6546"}'::jsonb, 40, true),
  ('atelier', 'Atelier', 'Deep teal.', '{"cvInk":"#172826","cvAccent":"#2d6d6a","cvAccentDark":"#1f4e4c","cvPaper":"#fffdf8","cvPanel":"#e4efec","cvLine":"#bdd1ca","cvMuted":"#536a68","cvSide":"#214c50","thumbMatte":"#bfd3cf","tileAccent":"#2d6d6a"}'::jsonb, 50, true),
  ('sage-brass', 'Sage Brass', 'Sage green and aged brass.', '{"cvInk":"#1d281f","cvAccent":"#7a6a33","cvAccentDark":"#50451f","cvPaper":"#fffdf7","cvPanel":"#edf1e5","cvLine":"#c8cfb6","cvMuted":"#5f674f","cvSide":"#304131","thumbMatte":"#c8cfb6","tileAccent":"#7a6a33"}'::jsonb, 60, true),
  ('indigo-sand', 'Indigo Sand', 'Indigo with warm sand.', '{"cvInk":"#182033","cvAccent":"#b2874f","cvAccentDark":"#33456f","cvPaper":"#fffdf8","cvPanel":"#efe4d1","cvLine":"#d5c2a4","cvMuted":"#5e6472","cvSide":"#26395f","thumbMatte":"#d7c5a5","tileAccent":"#33456f"}'::jsonb, 70, true),
  ('mulberry-olive', 'Mulberry Olive', 'Mulberry ink and olive panel.', '{"cvInk":"#2c1b24","cvAccent":"#7b8151","cvAccentDark":"#743a58","cvPaper":"#fffaf6","cvPanel":"#eee7dc","cvLine":"#d4c3b4","cvMuted":"#675d5f","cvSide":"#4a2d3b","thumbMatte":"#d1c3b3","tileAccent":"#743a58"}'::jsonb, 80, true),
  ('copper-pine', 'Copper Pine', 'Pine green with copper.', '{"cvInk":"#17251f","cvAccent":"#9a5a34","cvAccentDark":"#5c3622","cvPaper":"#fffdf7","cvPanel":"#eee6da","cvLine":"#d2bfaa","cvMuted":"#5f6258","cvSide":"#214135","thumbMatte":"#ccb8a0","tileAccent":"#9a5a34"}'::jsonb, 90, true),
  ('sepia-blue', 'Sepia Blue', 'Sepia text with quiet blue.', '{"cvInk":"#2b241d","cvAccent":"#426275","cvAccentDark":"#2e4958","cvPaper":"#fffaf0","cvPanel":"#e9edf0","cvLine":"#c9d0d4","cvMuted":"#625e57","cvSide":"#3b5060","thumbMatte":"#c9d0d4","tileAccent":"#426275"}'::jsonb, 100, true),
  ('slate-rose', 'Slate Rose', 'Slate ink with muted rose.', '{"cvInk":"#20242a","cvAccent":"#7d4f57","cvAccentDark":"#57343a","cvPaper":"#fffaf7","cvPanel":"#eee2e3","cvLine":"#d4c0c3","cvMuted":"#62636a","cvSide":"#303841","thumbMatte":"#d0c0c4","tileAccent":"#7d4f57"}'::jsonb, 110, true),
  ('plain', 'Plain', 'Black and white.', '{"cvInk":"#111111","cvAccent":"#111111","cvAccentDark":"#000000","cvPaper":"#ffffff","cvPanel":"#f5f5f5","cvLine":"#d6d6d6","cvMuted":"#555555","cvSide":"#111111","thumbMatte":"#d5d5d5","tileAccent":"#111111"}'::jsonb, 120, true)
on conflict (id) do nothing;

insert into public.job_sources (source_type, name, is_enabled, config, secret_refs, schedule)
values
  ('adzuna_query_set', 'Adzuna South Africa', true, '{"queries":["retail","admin","customer service","warehouse","learnership","internship","reception","driver","call centre"],"locations":["South Africa","Johannesburg","Cape Town","Durban","Pretoria"],"resultsPerQuery":20}'::jsonb, '{"appIdEnv":"ADZUNA_APP_ID","appKeyEnv":"ADZUNA_APP_KEY"}'::jsonb, '{"mode":"manual_or_cron"}'::jsonb),
  ('greenhouse_board', 'Greenhouse bradken', true, '{"boardToken":"bradken"}'::jsonb, '{}'::jsonb, '{}'::jsonb),
  ('greenhouse_board', 'Greenhouse impact', true, '{"boardToken":"impact"}'::jsonb, '{}'::jsonb, '{}'::jsonb),
  ('greenhouse_board', 'Greenhouse spinnakersupport', true, '{"boardToken":"spinnakersupport"}'::jsonb, '{}'::jsonb, '{}'::jsonb),
  ('greenhouse_board', 'Greenhouse sapro', true, '{"boardToken":"sapro"}'::jsonb, '{}'::jsonb, '{}'::jsonb),
  ('greenhouse_board', 'Greenhouse ebury', true, '{"boardToken":"ebury"}'::jsonb, '{}'::jsonb, '{}'::jsonb),
  ('lever_board', 'Lever mamamoney', true, '{"companySlug":"https://jobs.lever.co/mamamoney"}'::jsonb, '{}'::jsonb, '{}'::jsonb),
  ('lever_board', 'Lever moo', true, '{"companySlug":"https://jobs.lever.co/moo"}'::jsonb, '{}'::jsonb, '{}'::jsonb),
  ('lever_board', 'Lever assist-world', true, '{"companySlug":"https://jobs.lever.co/assist-world"}'::jsonb, '{}'::jsonb, '{}'::jsonb),
  ('lever_board', 'Lever parallelwireless', true, '{"companySlug":"https://jobs.lever.co/parallelwireless"}'::jsonb, '{}'::jsonb, '{}'::jsonb),
  ('lever_board', 'Lever dlocal', true, '{"companySlug":"https://jobs.lever.co/dlocal"}'::jsonb, '{}'::jsonb, '{}'::jsonb),
  ('lever_board', 'Lever 1840&Company', true, '{"companySlug":"https://jobs.lever.co/1840%26Company"}'::jsonb, '{}'::jsonb, '{}'::jsonb),
  ('lever_board', 'Lever fresha', true, '{"companySlug":"https://jobs.lever.co/fresha"}'::jsonb, '{}'::jsonb, '{}'::jsonb)
on conflict do nothing;

create or replace view public.public_jobs_v as
select
  j.id,
  j.source,
  j.external_id,
  coalesce(jm.override_payload ->> 'canonicalUrl', jm.override_payload ->> 'canonical_url', j.canonical_url) as canonical_url,
  coalesce(jm.override_payload ->> 'applyUrl', jm.override_payload ->> 'apply_url', j.apply_url) as apply_url,
  coalesce(jm.override_payload ->> 'title', j.title) as title,
  coalesce(jm.override_payload ->> 'company', j.company) as company,
  coalesce(jm.override_payload ->> 'descriptionText', jm.override_payload ->> 'description_text', j.description_text) as description_text,
  coalesce(jm.override_payload ->> 'locationText', jm.override_payload ->> 'location_text', j.location_text) as location_text,
  coalesce(jm.override_payload ->> 'workplaceType', jm.override_payload ->> 'workplace_type', j.workplace_type) as workplace_type,
  coalesce(jm.override_payload ->> 'employmentType', jm.override_payload ->> 'employment_type', j.employment_type) as employment_type,
  j.salary_min,
  j.salary_max,
  j.salary_currency,
  j.posted_at,
  j.expires_at,
  j.status,
  coalesce(jm.override_payload ->> 'category', j.category) as category,
  coalesce(jm.override_payload -> 'requirements', j.requirements) as requirements,
  j.content_hash,
  j.raw_payload,
  j.first_seen_at,
  j.last_seen_at,
  j.updated_at,
  coalesce(jm.visibility_status, 'visible') as visibility_status,
  coalesce(jm.review_state, 'approved') as review_state,
  jm.pinned_rank,
  jm.tags,
  lower(
    coalesce(jm.override_payload ->> 'title', j.title, '') || ' ' ||
    coalesce(jm.override_payload ->> 'company', j.company, '') || ' ' ||
    coalesce(jm.override_payload ->> 'descriptionText', jm.override_payload ->> 'description_text', j.description_text, '') || ' ' ||
    coalesce(jm.override_payload ->> 'category', j.category, '') || ' ' ||
    coalesce(jm.override_payload ->> 'locationText', jm.override_payload ->> 'location_text', j.location_text, '')
  ) as search_text
from public.jobs j
left join public.job_moderation jm on jm.job_id = j.id
where coalesce(jm.visibility_status, 'visible') not in ('hidden', 'archived');

create or replace view public.admin_dashboard_summary_v as
select
  (select count(*)::integer from public.profiles) as total_users,
  (select count(*)::integer from public.profiles where created_at >= now() - interval '7 days') as users_last_7d,
  (select count(*)::integer from public.public_jobs_v where status <> 'expired') as total_public_jobs,
  (select count(*)::integer from public.job_moderation where visibility_status = 'hidden') as hidden_jobs,
  (select count(*)::integer from public.job_moderation where visibility_status = 'featured') as featured_jobs,
  (select count(*)::integer from public.applications where started_at >= now() - interval '1 day') as applications_last_24h,
  (select count(*)::integer from public.notification_deliveries where status = 'failed' and created_at >= now() - interval '7 days') as notification_failures_last_7d,
  (select id from public.ingestion_runs order by started_at desc limit 1) as last_ingestion_run_id,
  (select started_at from public.ingestion_runs order by started_at desc limit 1) as last_ingestion_started_at,
  (select finished_at from public.ingestion_runs order by started_at desc limit 1) as last_ingestion_finished_at;

create or replace view public.admin_source_health_v as
select
  js.id,
  js.source_type,
  js.name,
  js.is_enabled,
  js.last_tested_at,
  js.last_success_at,
  latest.source_key,
  latest.ingestion_run_id,
  latest.fetched_count,
  latest.upserted_count,
  latest.failed_count,
  latest.error_text,
  latest.started_at as last_run_started_at,
  latest.finished_at as last_run_finished_at
from public.job_sources js
left join lateral (
  select srr.*
  from public.source_run_reports srr
  where srr.job_source_id = js.id
  order by srr.started_at desc nulls last, srr.finished_at desc nulls last
  limit 1
) latest on true;

create or replace view public.admin_notification_failures_v as
select
  nd.id,
  nd.notification_id,
  n.user_id,
  n.type,
  n.title,
  n.action_url,
  nd.channel,
  nd.status,
  nd.provider_message_id,
  nd.error_text,
  nd.sent_at,
  nd.created_at
from public.notification_deliveries nd
join public.notifications n on n.id = nd.notification_id
where nd.status = 'failed';

create or replace view public.admin_job_review_queue_v as
select
  j.id,
  j.title,
  j.company,
  j.source,
  j.location_text,
  j.posted_at,
  coalesce(jm.visibility_status, 'visible') as visibility_status,
  coalesce(jm.review_state, 'approved') as review_state,
  jm.updated_at as moderation_updated_at
from public.jobs j
left join public.job_moderation jm on jm.job_id = j.id;

create or replace view public.admin_user_activity_v as
select
  p.id as user_id,
  p.email,
  p.display_name,
  p.account_status,
  p.created_at,
  (
    select ae.created_at
    from public.account_events ae
    where ae.user_id = p.id
    order by ae.created_at desc
    limit 1
  ) as last_account_event_at,
  (
    select a.started_at
    from public.applications a
    where a.user_id = p.id
    order by a.started_at desc
    limit 1
  ) as last_application_at
from public.profiles p;
