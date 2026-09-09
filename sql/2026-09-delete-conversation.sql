-- ====================================================================
-- 2026-09 — Clear-conversation capability, owner profile only
-- Run this in the Supabase SQL editor before deploying the new UI.
--
-- The chat panel grows a "Clear conversation" button that deletes the
-- whole thread with the other profile — both directions — so both sides
-- start fresh. Only the profile(s) flagged can_clear_chats see it.
--
-- The app is single-account: every profile belongs to one signed-in
-- user, and RLS cannot see which profile a client chose to act as.
-- So "only Mohamed" is enforced by the UI via the flag below, the same
-- place profile identity actually lives.
-- ====================================================================

-- Defaults to false, so every profile the app creates is excluded until
-- you explicitly flag one. Only one row is ever an "owner".
alter table public.profiles
  add column if not exists can_clear_chats boolean default false;

-- Flag the owner profile by name (case-insensitive). If the profile has a
-- different name, run this yourself with the right one instead:
--   update public.profiles set can_clear_chats = true where lower(btrim(name)) = '<name>';
update public.profiles
  set can_clear_chats = true
 where lower(btrim(name)) = 'mohamed';

-- Delete policy, matching the one policy everywhere else in the project:
-- any signed-in client may delete rows; the can_clear_chats gate lives in
-- the UI because all profiles share the same auth account.
create policy messages_delete
  on public.messages for delete to authenticated using (true);