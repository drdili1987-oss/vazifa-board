-- Vazifa Board: ruxsatlar (2026-10-20)
-- Supabase → SQL Editor → shu faylni to'liq joylab "Run" bosing. Ma'lumotlar o'chmaydi.

begin;

-- 1) Ustunlar (loyiha tuzilmasi): a'zolar ko'radi, faqat egasi o'zgartiradi
drop policy if exists "columns: members all" on public.columns;
create policy "columns: members read" on public.columns
  for select to authenticated using (private.is_member(project_id));
create policy "columns: owner insert" on public.columns
  for insert to authenticated with check (private.is_owner(project_id));
create policy "columns: owner update" on public.columns
  for update to authenticated using (private.is_owner(project_id)) with check (private.is_owner(project_id));
create policy "columns: owner delete" on public.columns
  for delete to authenticated using (private.is_owner(project_id));

-- 2) Loyiha: egasi faqat nom va rangni o'zgartiradi (egalikni almashtirib bo'lmaydi)
revoke update on public.projects from authenticated;
grant update (name, color) on public.projects to authenticated;
alter table public.projects
  add constraint projects_name_len check (char_length(btrim(name)) between 1 and 60),
  add constraint projects_color_hex check (color ~ '^#[0-9A-Fa-f]{6}$');

-- 3) Vazifalar: hamma a'zo qo'shadi/tahrirlaydi/ko'chiradi; o'chirish — faqat yaratgan odam
drop policy if exists "tasks: members insert" on public.tasks;
create policy "tasks: members insert" on public.tasks
  for insert to authenticated
  with check (
    private.is_member(project_id)
    and created_by = (select auth.uid())          -- boshqa birov nomidan yaratib bo'lmaydi
    and (assignee_id is null or exists (select 1 from public.project_members m
                                        where m.project_id = tasks.project_id and m.user_id = tasks.assignee_id))
  );

revoke update on public.tasks from authenticated;  -- created_by ni keyin o'zgartirib bo'lmaydi
grant update (column_id, title, description, assignee_id, due_date, priority, tags, position)
  on public.tasks to authenticated;

drop policy if exists "tasks: members delete" on public.tasks;
create policy "tasks: creator deletes" on public.tasks
  for delete to authenticated
  using (
    private.is_member(project_id)
    and (created_by = (select auth.uid())
         -- yaratuvchisining hisobi o'chgan bo'lsa, loyiha egasi o'chira oladi
         or (created_by is null and private.is_owner(project_id)))
  );

commit;
