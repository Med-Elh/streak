-- ====================================================================
-- 2026-11 — Planner events, and voice notes on tasks
-- Run this whole file once in the Supabase SQL editor before deploying
-- the new UI. Safe to run again: every statement checks before it acts.
--
-- Same access rule as everywhere else in the project: signed in means
-- full read and write on every row, signed out means nothing. Profiles
-- are not a privacy boundary, so neither table filters by profile in RLS.
-- ====================================================================


-- Planner events ------------------------------------------------------
-- One row per block on a day. `end_time` may be 24:00 so an event can run
-- to midnight without spilling into the next day's row.
-- `color` is a palette key ('ember', 'teal', …) from constants.js, not a
-- hex: the key is resolved to a theme token at draw time, so one event
-- reads correctly in both light and dark mode.
create table if not exists public.planner_events (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 120),
  date        date not null,
  start_time  time not null,
  end_time    time not null,
  color       text not null default 'ember',
  created_at  timestamptz not null default now(),
  constraint planner_events_time_order_check check (end_time > start_time)
);

-- The planner only ever asks one question: this profile, this week.
create index if not exists idx_planner_events_profile_date
  on public.planner_events (profile_id, date);

alter table public.planner_events enable row level security;

drop policy if exists planner_events_authenticated on public.planner_events;
create policy planner_events_authenticated
  on public.planner_events for all to authenticated
  using (true) with check (true);


-- Voice notes on tasks ------------------------------------------------
-- The audio itself lives in the task-audio storage bucket; this row is the
-- index that ties a file to its task. Deleting a task cascades these rows.
-- The files are removed by the app first, because Supabase does not allow
-- deleting storage objects from SQL.
-- `duration_ms` is measured while recording rather than read from the file:
-- Chrome's webm recordings carry no duration header at all.
create table if not exists public.task_audio (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks(id) on delete cascade,
  path         text not null unique,
  mime_type    text not null,
  duration_ms  integer not null check (duration_ms between 0 and 125000),
  size_bytes   integer check (size_bytes >= 0),
  created_at   timestamptz not null default now()
);

create index if not exists idx_task_audio_task
  on public.task_audio (task_id, created_at);

alter table public.task_audio enable row level security;

drop policy if exists task_audio_authenticated on public.task_audio;
create policy task_audio_authenticated
  on public.task_audio for all to authenticated
  using (true) with check (true);


-- Storage bucket --------------------------------------------------------
-- Private: files are only reachable through short-lived signed URLs the
-- signed-in app asks for, never by a public link.
-- 5 MB is roughly ten times what two minutes of speech comes to, so the
-- cap catches mistakes without ever clipping a real note.
-- audio/mp4 is what iPhone Safari records; audio/webm is Chrome and Firefox.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'task-audio',
  'task-audio',
  false,
  5242880,
  array['audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav']
)
on conflict (id) do update
  set public             = excluded.public,
      file_size_limit    = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Storage policies are rows on the shared storage.objects table, so each
-- one is scoped to this bucket by its condition, not by the table.
drop policy if exists task_audio_objects_authenticated on storage.objects;
create policy task_audio_objects_authenticated
  on storage.objects for all to authenticated
  using (bucket_id = 'task-audio')
  with check (bucket_id = 'task-audio');
