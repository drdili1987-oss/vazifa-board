-- Topshiriq AI: Telegram bot integratsiyasi
-- Supabase SQL Editor'da ishga tushiring (/sql/new)

-- 1) Hisob bog'lash
create table if not exists public.telegram_links (
  user_id            uuid primary key references public.profiles(id) on delete cascade,
  chat_id            bigint not null unique,
  username           text,
  default_project_id uuid references public.projects(id) on delete set null,
  created_at         timestamptz not null default now()
);
alter table public.telegram_links enable row level security;

drop policy if exists tg_links_select_own on public.telegram_links;
create policy tg_links_select_own on public.telegram_links
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists tg_links_delete_own on public.telegram_links;
create policy tg_links_delete_own on public.telegram_links
  for delete to authenticated using (user_id = (select auth.uid()));

-- 2) Bir martalik ulash kodlari (10 daqiqa)
create table if not exists public.telegram_link_codes (
  code       text primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  expires_at timestamptz not null default now() + interval '10 minutes'
);
alter table public.telegram_link_codes enable row level security; -- policy yo'q: faqat RPC / service role

create or replace function public.create_telegram_link_code()
returns text
language plpgsql security definer set search_path = ''
as $$
declare v_code text;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  delete from public.telegram_link_codes where user_id = auth.uid() or expires_at < now();
  v_code := left(replace(gen_random_uuid()::text, '-', ''), 16);
  insert into public.telegram_link_codes (code, user_id) values (v_code, auth.uid());
  return v_code;
end $$;
revoke all on function public.create_telegram_link_code() from public, anon;
grant execute on function public.create_telegram_link_code() to authenticated;

-- 3) Tasdiqlashni kutayotgan qoralamalar
create table if not exists public.telegram_drafts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  chat_id    bigint not null,
  project_id uuid not null references public.projects(id) on delete cascade,
  payload    jsonb not null,           -- {title, description, assignee_ids[], due_date, transcript}
  created_at timestamptz not null default now()
);
alter table public.telegram_drafts enable row level security;

-- 4) Telegram qayta yuborgan update'larni takrorlamaslik
create table if not exists public.telegram_updates (
  update_id    bigint primary key,
  processed_at timestamptz not null default now()
);
alter table public.telegram_updates enable row level security;

-- 5) BUG FIX: service role orqali yozilganda auth.uid() = null
create or replace function private.notify_assigned()
returns trigger
language plpgsql security definer set search_path = ''
as $function$
declare v_actor uuid; v_title text; v_proj text; v_creator uuid;
begin
  select t.title, p.name, t.created_by into v_title, v_proj, v_creator
  from public.tasks t join public.projects p on p.id = t.project_id
  where t.id = new.task_id;
  v_actor := coalesce(auth.uid(), v_creator);
  if new.user_id is not distinct from v_actor then return null; end if;
  insert into public.notifications (user_id, project_id, task_id, actor_id, kind, payload)
  values (new.user_id, new.project_id, new.task_id, v_actor, 'assigned',
          jsonb_build_object('task', v_title, 'project', v_proj, 'actor', private.actor_name(v_actor)));
  return null;
end $function$;
