-- ====================================================================
-- 2026-09 — Online presence & chat between profiles
-- Run this in the Supabase SQL editor before deploying the new UI.
-- ====================================================================

-- Presence columns on profiles ------------------------------------------------
alter table public.profiles
  add column if not exists last_seen timestamptz;

alter table public.profiles
  add column if not exists show_online_status boolean default true;

alter table public.profiles
  add column if not exists chat_enabled boolean default true;

-- Messages table --------------------------------------------------------------
create table if not exists public.messages (
  id            uuid primary key default gen_random_uuid(),
  sender_id     uuid not null references public.profiles(id) on delete cascade,
  recipient_id  uuid not null references public.profiles(id) on delete cascade,
  body          text not null check (length(btrim(body)) between 1 and 2000),
  read_at       timestamptz,
  created_at    timestamptz not null default now()
);

alter table public.messages enable row level security;

create policy messages_select   on public.messages for select   to authenticated using (true);
create policy messages_insert   on public.messages for insert   to authenticated with check (true);
create policy messages_update   on public.messages for update   to authenticated using (true) with check (true);

-- Indexes for the two queries the chat UI makes every 15 seconds:
-- 1) unread count: recipient = me AND read_at IS NULL
-- 2) conversation thread between two profiles, ordered by time
create index if not exists idx_messages_recipient_unread
  on public.messages (recipient_id) where read_at is null;

create index if not exists idx_messages_conversation
  on public.messages (sender_id, recipient_id, created_at);

create index if not exists idx_messages_conversation_rev
  on public.messages (recipient_id, sender_id, created_at);
