-- Streak. — waveforms on voice notes
--
-- Adds task_audio.peaks: the bar heights drawn in a voice note's waveform,
-- worked out once in the browser when the note is recorded (Web Audio decode,
-- ~40 values from 0 to 100) so nobody has to download and decode the file
-- again just to draw it.
--
-- Nullable on purpose: notes recorded before this ran have no peaks, and the
-- app decodes those on the fly (or shows evenly spaced placeholder bars).
--
-- Needs 2026-11-planner-voice-notes.sql to have been run first.
-- Safe to run more than once. No policy changes: task_audio already has its
-- one "for all to authenticated" policy, and it covers the new column.

alter table public.task_audio
  add column if not exists peaks smallint[];

alter table public.task_audio
  drop constraint if exists task_audio_peaks_check;

alter table public.task_audio
  add constraint task_audio_peaks_check check (
    peaks is null or (
      cardinality(peaks) between 1 and 200
      and 0 <= all (peaks)
      and 100 >= all (peaks)
    )
  );

-- PostgREST caches the schema; without this the new column can take a while
-- to appear to the app.
notify pgrst, 'reload schema';
