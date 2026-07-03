create table if not exists public.legal_acceptances (
  user_id uuid not null references auth.users(id) on delete cascade,
  document_key text not null check (document_key in ('terms', 'privacy', 'popia')),
  document_version text not null default '2026-07-03',
  source text not null default '',
  accepted_at timestamptz not null default now(),
  primary key (user_id, document_key, document_version)
);

create index if not exists legal_acceptances_user_id_idx on public.legal_acceptances (user_id);
create index if not exists legal_acceptances_accepted_at_idx on public.legal_acceptances (accepted_at desc);

create table if not exists public.privacy_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_type text not null default 'other' check (request_type in ('access', 'correction', 'deletion', 'objection', 'marketing_opt_out', 'other')),
  details text not null default '',
  status text not null default 'received' check (status in ('received', 'verifying_identity', 'in_review', 'completed', 'rejected', 'withdrawn')),
  response_note text not null default '',
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists privacy_requests_user_id_idx on public.privacy_requests (user_id);
create index if not exists privacy_requests_status_idx on public.privacy_requests (status);
create index if not exists privacy_requests_created_at_idx on public.privacy_requests (created_at desc);

drop trigger if exists privacy_requests_set_updated_at on public.privacy_requests;
create trigger privacy_requests_set_updated_at before update on public.privacy_requests
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

  if coalesce(new.raw_user_meta_data ->> 'legal_accepted', '') = 'true' then
    insert into public.legal_acceptances (user_id, document_key, document_version, source)
    values
      (new.id, 'terms', coalesce(nullif(new.raw_user_meta_data ->> 'terms_version', ''), '2026-07-03'), coalesce(nullif(new.raw_user_meta_data ->> 'legal_source', ''), 'signup')),
      (new.id, 'privacy', coalesce(nullif(new.raw_user_meta_data ->> 'privacy_version', ''), '2026-07-03'), coalesce(nullif(new.raw_user_meta_data ->> 'legal_source', ''), 'signup')),
      (new.id, 'popia', coalesce(nullif(new.raw_user_meta_data ->> 'popia_version', ''), '2026-07-03'), coalesce(nullif(new.raw_user_meta_data ->> 'legal_source', ''), 'signup'))
    on conflict do nothing;
  end if;

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

alter table public.legal_acceptances enable row level security;
alter table public.privacy_requests enable row level security;

create policy "legal_acceptances_select_own" on public.legal_acceptances
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "legal_acceptances_insert_own" on public.legal_acceptances
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "legal_acceptances_update_own" on public.legal_acceptances
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

create policy "privacy_requests_select_own" on public.privacy_requests
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "privacy_requests_insert_own" on public.privacy_requests
  for insert to authenticated with check ((select auth.uid()) = user_id);

grant select, insert, update on public.legal_acceptances to authenticated;
grant select, insert on public.privacy_requests to authenticated;
