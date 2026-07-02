create extension if not exists pgcrypto with schema extensions;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  display_name text not null default '',
  full_name text not null default '',
  phone text not null default '',
  location_text text not null default '',
  headline text not null default '',
  avatar_url text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  default_template_id text not null default '',
  default_palette_id text not null default '',
  job_location_preferences text[] not null default '{}'::text[],
  job_category_preferences text[] not null default '{}'::text[],
  minimum_match_score integer not null default 70 check (minimum_match_score between 0 and 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.notification_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  in_app_enabled boolean not null default true,
  email_job_alerts boolean not null default true,
  email_application_reminders boolean not null default true,
  email_product_updates boolean not null default false,
  frequency text not null default 'daily' check (frequency in ('immediate', 'daily', 'weekly')),
  quiet_hours_start text not null default '',
  quiet_hours_end text not null default '',
  timezone text not null default 'Africa/Johannesburg',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cv_documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'Primary CV',
  cv_state jsonb not null default '{}'::jsonb,
  template_id text not null default '',
  palette_id text not null default '',
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists cv_documents_one_primary_idx
  on public.cv_documents (user_id)
  where is_primary;

create index if not exists cv_documents_user_id_idx on public.cv_documents (user_id);
create index if not exists cv_documents_updated_at_idx on public.cv_documents (updated_at desc);

create table if not exists public.saved_jobs (
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id text not null references public.jobs(id) on delete cascade,
  notes text not null default '',
  saved_at timestamptz not null default now(),
  primary key (user_id, job_id)
);

create index if not exists saved_jobs_job_id_idx on public.saved_jobs (job_id);
create index if not exists saved_jobs_saved_at_idx on public.saved_jobs (saved_at desc);

create table if not exists public.application_kits (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id text references public.jobs(id) on delete set null,
  cv_document_id uuid references public.cv_documents(id) on delete set null,
  match jsonb not null default '{}'::jsonb,
  kit jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists application_kits_user_id_idx on public.application_kits (user_id);
create index if not exists application_kits_job_id_idx on public.application_kits (job_id);
create index if not exists application_kits_created_at_idx on public.application_kits (created_at desc);

alter table public.applications add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table public.applications add column if not exists cv_document_id uuid references public.cv_documents(id) on delete set null;
alter table public.applications add column if not exists application_kit_id uuid references public.application_kits(id) on delete set null;

create index if not exists applications_user_id_idx on public.applications (user_id);
create index if not exists applications_cv_document_id_idx on public.applications (cv_document_id);
create index if not exists applications_application_kit_id_idx on public.applications (application_kit_id);

create table if not exists public.job_alert_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Saved search',
  query text not null default '',
  location_text text not null default '',
  source text not null default '',
  minimum_match_score integer not null default 70 check (minimum_match_score between 0 and 100),
  enabled boolean not null default true,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists job_alert_rules_user_id_idx on public.job_alert_rules (user_id);
create index if not exists job_alert_rules_enabled_idx on public.job_alert_rules (enabled);

create table if not exists public.user_job_matches (
  user_id uuid not null references auth.users(id) on delete cascade,
  job_id text not null references public.jobs(id) on delete cascade,
  cv_document_id uuid references public.cv_documents(id) on delete set null,
  score integer not null default 0 check (score between 0 and 100),
  bucket text not null default '',
  matched jsonb not null default '[]'::jsonb,
  missing jsonb not null default '[]'::jsonb,
  blockers jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default now(),
  primary key (user_id, job_id)
);

create index if not exists user_job_matches_job_id_idx on public.user_job_matches (job_id);
create index if not exists user_job_matches_score_idx on public.user_job_matches (score desc);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null default 'account_notice',
  title text not null default '',
  body text not null default '',
  action_url text not null default '',
  payload jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists notifications_dedupe_idx on public.notifications (user_id, type, action_url);
create index if not exists notifications_user_id_idx on public.notifications (user_id);
create index if not exists notifications_created_at_idx on public.notifications (created_at desc);
create index if not exists notifications_unread_idx on public.notifications (user_id, created_at desc) where read_at is null;

create table if not exists public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  channel text not null default 'in_app',
  status text not null default 'queued',
  provider_message_id text not null default '',
  error_text text not null default '',
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notification_deliveries_notification_id_idx on public.notification_deliveries (notification_id);
create index if not exists notification_deliveries_status_idx on public.notification_deliveries (status);

create table if not exists public.account_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null default '',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists account_events_user_id_idx on public.account_events (user_id);
create index if not exists account_events_created_at_idx on public.account_events (created_at desc);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists user_settings_set_updated_at on public.user_settings;
create trigger user_settings_set_updated_at before update on public.user_settings
  for each row execute function public.set_updated_at();

drop trigger if exists notification_preferences_set_updated_at on public.notification_preferences;
create trigger notification_preferences_set_updated_at before update on public.notification_preferences
  for each row execute function public.set_updated_at();

drop trigger if exists cv_documents_set_updated_at on public.cv_documents;
create trigger cv_documents_set_updated_at before update on public.cv_documents
  for each row execute function public.set_updated_at();

drop trigger if exists application_kits_set_updated_at on public.application_kits;
create trigger application_kits_set_updated_at before update on public.application_kits
  for each row execute function public.set_updated_at();

drop trigger if exists job_alert_rules_set_updated_at on public.job_alert_rules;
create trigger job_alert_rules_set_updated_at before update on public.job_alert_rules
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name, full_name, avatar_url)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'name', new.raw_user_meta_data ->> 'full_name', split_part(coalesce(new.email, ''), '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture', '')
  )
  on conflict (id) do update set
    email = excluded.email,
    display_name = coalesce(nullif(public.profiles.display_name, ''), excluded.display_name),
    full_name = coalesce(nullif(public.profiles.full_name, ''), excluded.full_name),
    avatar_url = coalesce(nullif(public.profiles.avatar_url, ''), excluded.avatar_url),
    updated_at = now();

  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.notification_preferences (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.notifications (user_id, type, title, body, action_url, payload)
  values (
    new.id,
    'account_notice',
    'Account ready',
    'Your SearchR account is ready to save CVs, roles, and applications.',
    '#profile',
    jsonb_build_object('source', 'auth_trigger')
  )
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.cv_documents enable row level security;
alter table public.saved_jobs enable row level security;
alter table public.application_kits enable row level security;
alter table public.job_alert_rules enable row level security;
alter table public.user_job_matches enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.account_events enable row level security;

create policy "profiles_select_own" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

create policy "user_settings_select_own" on public.user_settings
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "user_settings_insert_own" on public.user_settings
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "user_settings_update_own" on public.user_settings
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "notification_preferences_select_own" on public.notification_preferences
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "notification_preferences_insert_own" on public.notification_preferences
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "notification_preferences_update_own" on public.notification_preferences
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "cv_documents_select_own" on public.cv_documents
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "cv_documents_insert_own" on public.cv_documents
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "cv_documents_update_own" on public.cv_documents
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "cv_documents_delete_own" on public.cv_documents
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "saved_jobs_select_own" on public.saved_jobs
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "saved_jobs_insert_own" on public.saved_jobs
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "saved_jobs_update_own" on public.saved_jobs
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "saved_jobs_delete_own" on public.saved_jobs
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "application_kits_select_own" on public.application_kits
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "application_kits_insert_own" on public.application_kits
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "application_kits_update_own" on public.application_kits
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "application_kits_delete_own" on public.application_kits
  for delete to authenticated using ((select auth.uid()) = user_id);

drop policy if exists "applications_select_own" on public.applications;
drop policy if exists "applications_insert_own" on public.applications;
drop policy if exists "applications_update_own" on public.applications;
drop policy if exists "applications_delete_own" on public.applications;

create policy "applications_select_own" on public.applications
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "applications_insert_own" on public.applications
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "applications_update_own" on public.applications
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "applications_delete_own" on public.applications
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "job_alert_rules_select_own" on public.job_alert_rules
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "job_alert_rules_insert_own" on public.job_alert_rules
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "job_alert_rules_update_own" on public.job_alert_rules
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "job_alert_rules_delete_own" on public.job_alert_rules
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "user_job_matches_select_own" on public.user_job_matches
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "user_job_matches_insert_own" on public.user_job_matches
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "user_job_matches_update_own" on public.user_job_matches
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "user_job_matches_delete_own" on public.user_job_matches
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "notifications_select_own" on public.notifications
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "notifications_insert_own" on public.notifications
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "notifications_update_own" on public.notifications
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "notifications_delete_own" on public.notifications
  for delete to authenticated using ((select auth.uid()) = user_id);

create policy "notification_deliveries_select_own" on public.notification_deliveries
  for select to authenticated using (
    exists (
      select 1
      from public.notifications
      where notifications.id = notification_deliveries.notification_id
        and notifications.user_id = (select auth.uid())
    )
  );

create policy "account_events_select_own" on public.account_events
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "account_events_insert_own" on public.account_events
  for insert to authenticated with check ((select auth.uid()) = user_id);

grant select, insert, update on public.profiles to authenticated;
grant select, insert, update on public.user_settings to authenticated;
grant select, insert, update on public.notification_preferences to authenticated;
grant select, insert, update, delete on public.cv_documents to authenticated;
grant select, insert, update, delete on public.saved_jobs to authenticated;
grant select, insert, update, delete on public.application_kits to authenticated;
grant select, insert, update, delete on public.applications to authenticated;
grant select, insert, update, delete on public.job_alert_rules to authenticated;
grant select, insert, update, delete on public.user_job_matches to authenticated;
grant select, insert, update, delete on public.notifications to authenticated;
grant select on public.notification_deliveries to authenticated;
grant select, insert on public.account_events to authenticated;
