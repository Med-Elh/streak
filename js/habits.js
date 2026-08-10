/**
 * Habits: today's check-ins, streaks, the competition board, and the charts.
 *
 * Streak rules, decided here and used everywhere:
 *  - A habit is done on a date if a habit_entries row exists with completed.
 *  - A habit's current streak counts back from today, or from yesterday if
 *    today isn't ticked yet — the day isn't over, so an untouched today should
 *    not read as a broken streak.
 *  - A profile's overall streak (what the board ranks on) counts a day in which
 *    at least one habit was done. Requiring all of them punishes adding a habit.
 */

import { supabase, describeError } from './supabase.js';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js';
import { listProfiles, requireActiveProfile } from './profiles.js';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy, showBanner,
  streakMark, todayISO, formatDate, initials,
} from './ui.js';
import { completionChart } from './charts.js';

const DAY = 86400000;
/** Streaks can run long; a year of history is plenty to walk back through. */
const HISTORY_DAYS = 365;

const state = {
  profile: null,
  profiles: [],
  habits: [],        // every profile's active habits
  entries: [],       // { habit_id, date } for completed entries in the window
  filters: { profileId: 'all', habitId: 'all', days: 30 },
  mode: 'solo',      // 'solo' | 'comparison'
};

/* --------------------------------------------------------------- helpers -- */

const iso = (date) => date.toISOString().slice(0, 10);
const shiftDays = (isoDate, delta) => iso(new Date(new Date(`${isoDate}T12:00:00`).getTime() + delta * DAY));

/** Profile colours are assigned by position in the profile list, never by rank. */
function colorIndexFor(profileId) {
  return state.profiles.findIndex((p) => p.id === profileId);
}

function doneSet(habitIds) {
  const wanted = new Set(habitIds);
  const byDate = new Map();
  for (const entry of state.entries) {
    if (!wanted.has(entry.habit_id)) continue;
    if (!byDate.has(entry.date)) byDate.set(entry.date, new Set());
    byDate.get(entry.date).add(entry.habit_id);
  }
  return byDate;
}

/** Consecutive days ending today, or yesterday if today is still untouched. */
function currentStreak(dates) {
  const today = todayISO();
  let cursor = dates.has(today) ? today : shiftDays(today, -1);
  let streak = 0;
  while (dates.has(cursor)) {
    streak += 1;
    cursor = shiftDays(cursor, -1);
  }
  return streak;
}

function habitStreak(habitId) {
  const dates = new Set(state.entries.filter((e) => e.habit_id === habitId).map((e) => e.date));
  return currentStreak(dates);
}

function profileStreak(profileId) {
  const ids = new Set(state.habits.filter((h) => h.profile_id === profileId).map((h) => h.id));
  const dates = new Set(state.entries.filter((e) => ids.has(e.habit_id)).map((e) => e.date));
  return currentStreak(dates);
}

function lastSevenDays(habitId) {
  const dates = new Set(state.entries.filter((e) => e.habit_id === habitId).map((e) => e.date));
  const today = todayISO();
  return Array.from({ length: 7 }, (_, i) => dates.has(shiftDays(today, i - 6)));
}

/* ------------------------------------------------------------------ data -- */

async function loadAll() {
  const [profiles, habits] = await Promise.all([listProfiles(), fetchHabits()]);
  state.profiles = profiles;
  state.habits = habits;
  state.entries = habits.length ? await fetchEntries(habits.map((h) => h.id)) : [];
}

async function fetchHabits() {
  const { data, error } = await supabase
    .from('habits')
    .select('id, profile_id, name, icon, target_per_week, active')
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load habits.'));
  return data ?? [];
}

async function fetchEntries(habitIds) {
  const { data, error } = await supabase
    .from('habit_entries')
    .select('habit_id, date')
    .in('habit_id', habitIds)
    .eq('completed', true)
    .gte('date', shiftDays(todayISO(), -HISTORY_DAYS))
    .order('date', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load check-ins.'));
  return data ?? [];
}

async function toggleToday(habit, done) {
  const date = todayISO();
  if (done) {
    const { error } = await supabase
      .from('habit_entries')
      .upsert({ habit_id: habit.id, date, completed: true }, { onConflict: 'habit_id,date' });
    if (error) throw new Error(describeError(error, `Couldn’t tick ${habit.name}.`));
    state.entries.push({ habit_id: habit.id, date });
  } else {
    const { error } = await supabase
      .from('habit_entries')
      .delete()
      .eq('habit_id', habit.id)
      .eq('date', date);
    if (error) throw new Error(describeError(error, `Couldn’t untick ${habit.name}.`));
    state.entries = state.entries.filter((e) => !(e.habit_id === habit.id && e.date === date));
  }
}

/* ---------------------------------------------------------------- render -- */

function renderToday(mount) {
  const mine = state.habits.filter((h) => h.profile_id === state.profile.id);
  clear(mount);

  if (!mine.length) {
    mount.append(
      emptyState({
        title: 'No habits yet',
        body: 'Add the first thing you want to do every day. The streak starts the day you tick it.',
        actionLabel: 'Add a habit',
        onAction: openHabitModal,
      }),
    );
    return;
  }

  const today = todayISO();
  const done = doneSet(mine.map((h) => h.id)).get(today) ?? new Set();

  for (const habit of mine) {
    const isDone = done.has(habit.id);
    const streak = habitStreak(habit.id);

    const row = el('button', {
      class: 'habit-row',
      type: 'button',
      dataset: { done: String(isDone) },
      'aria-pressed': String(isDone),
      onclick: async () => {
        row.disabled = true;
        try {
          await toggleToday(habit, !isDone);
          toast(isDone ? `${habit.name} unticked.` : `${habit.name} done today.`, {
            type: 'success',
            duration: 2200,
          });
          renderAll();
        } catch (error) {
          toast(error.message, { type: 'error' });
          row.disabled = false;
        }
      },
    }, [
      el('span', { class: 'habit-check', 'aria-hidden': 'true', text: '✓' }),
      el('span', { class: 'habit-row__body' }, [
        el('span', { class: 'habit-row__name' }, [
          habit.icon ? el('span', { 'aria-hidden': 'true', text: habit.icon }) : null,
          el('span', { text: habit.name }),
        ]),
        el('span', {
          class: 'habit-row__meta',
          text: streak ? `${streak}-day streak · ${habit.target_per_week}× a week` : `${habit.target_per_week}× a week`,
        }),
      ]),
      streakMark(streak, { small: true }),
    ]);

    mount.append(row);
  }
}

function renderBoard(mount) {
  clear(mount);

  const ranked = state.profiles
    .map((p) => ({ profile: p, streak: profileStreak(p.id) }))
    .sort((a, b) => b.streak - a.streak || a.profile.name.localeCompare(b.profile.name));

  if (!ranked.length) {
    mount.append(el('p', { class: 'muted', text: 'No profiles to rank yet.' }));
    return;
  }

  const board = el('div', { class: 'board' });
  ranked.forEach((row, index) => {
    board.append(
      el('div', {
        class: 'board__row',
        dataset: { me: String(row.profile.id === state.profile.id) },
      }, [
        el('span', { class: 'board__rank num', text: String(index + 1) }),
        el('span', {
          class: 'avatar avatar--sm',
          style: `--avatar: ${row.profile.avatar_color}`,
          'aria-hidden': 'true',
          text: initials(row.profile.name),
        }),
        el('span', { class: 'board__name', text: row.profile.name }),
        streakMark(row.streak, { small: true }),
      ]),
    );
  });
  mount.append(board);
}

/**
 * Completion rate per day: habits done that day over habits held that day.
 * Held is measured as "active now" — a habit deleted last week is not counted
 * retroactively, which keeps the line readable at the cost of a little history.
 */
function seriesFor(profileId, dates) {
  const habitIds = state.habits
    .filter((h) => h.profile_id === profileId)
    .filter((h) => state.filters.habitId === 'all' || h.id === state.filters.habitId)
    .map((h) => h.id);

  if (!habitIds.length) return null;

  const byDate = doneSet(habitIds);
  return dates.map((date) => {
    const hit = byDate.get(date)?.size ?? 0;
    return Math.round((hit / habitIds.length) * 100);
  });
}

function renderChart(canvas, emptyMount) {
  const days = state.filters.days;
  const today = todayISO();
  const dates = Array.from({ length: days }, (_, i) => shiftDays(today, i - days + 1));
  const labels = dates.map((d) => formatDate(d, { day: 'numeric', month: 'short' }));

  const wanted = state.mode === 'comparison'
    ? state.profiles
    : state.profiles.filter((p) => p.id === (state.filters.profileId === 'all'
        ? state.profile.id
        : state.filters.profileId));

  const series = wanted
    .map((p) => {
      const points = seriesFor(p.id, dates);
      return points && { id: p.id, label: p.name, points, colorIndex: colorIndexFor(p.id) };
    })
    .filter(Boolean);

  if (!series.length) {
    canvas.hidden = true;
    emptyMount.hidden = false;
    emptyMount.textContent = 'Nothing to chart yet. Tick a habit and it shows up here.';
    return;
  }

  canvas.hidden = false;
  emptyMount.hidden = true;
  completionChart(canvas, { labels, series });
}

/* ----------------------------------------------------------------- setup -- */

let refs = {};

function renderAll() {
  renderToday(refs.today);
  renderBoard(refs.board);
  renderChart(refs.canvas, refs.chartEmpty);
}

function openHabitModal() {
  refs.habitForm.reset();
  showBanner(refs.habitError, null);
  refs.habitModal.showModal();
  refs.habitName.focus();
}

export async function initHabitsPage() {
  await requireSession();
  const profile = await requireActiveProfile();
  state.profile = profile;

  document.body.prepend(
    topbar({
      profile,
      current: 'habits.html',
      onSwitchProfile: () => goTo(PICKER_PAGE),
      onSignOut: signOut,
    }),
  );

  refs = {
    today: document.getElementById('today-list'),
    board: document.getElementById('board'),
    canvas: document.getElementById('completion-chart'),
    chartEmpty: document.getElementById('chart-empty'),
    filterProfile: document.getElementById('filter-profile'),
    filterHabit: document.getElementById('filter-habit'),
    filterRange: document.getElementById('filter-range'),
    modeSolo: document.getElementById('mode-solo'),
    modeComparison: document.getElementById('mode-comparison'),
    habitModal: document.getElementById('habit-modal'),
    habitForm: document.getElementById('habit-form'),
    habitError: document.getElementById('habit-error'),
    habitName: document.getElementById('habit-name'),
    habitIcon: document.getElementById('habit-icon'),
    habitTarget: document.getElementById('habit-target'),
    habitSubmit: document.getElementById('habit-submit'),
  };

  document.getElementById('profile-name').textContent = profile.name;
  refs.today.append(skeletonList(3, 'skeleton--text'));

  try {
    await loadAll();
  } catch (error) {
    clear(refs.today).append(
      emptyState({
        title: 'Couldn’t load habits',
        body: error.message,
        actionLabel: 'Try again',
        onAction: () => window.location.reload(),
      }),
    );
    return;
  }

  populateFilters();
  renderAll();
  wireControls();
}

function populateFilters() {
  clear(refs.filterProfile).append(
    el('option', { value: 'all', text: 'Everyone' }),
    ...state.profiles.map((p) => el('option', { value: p.id, text: p.name })),
  );
  refs.filterProfile.value = state.profile.id;
  state.filters.profileId = state.profile.id;

  refreshHabitFilter();
}

function refreshHabitFilter() {
  const scope = state.filters.profileId === 'all'
    ? state.habits
    : state.habits.filter((h) => h.profile_id === state.filters.profileId);

  clear(refs.filterHabit).append(
    el('option', { value: 'all', text: 'All habits' }),
    ...scope.map((h) => el('option', { value: h.id, text: h.name })),
  );
  refs.filterHabit.value = 'all';
  state.filters.habitId = 'all';
}

function wireControls() {
  refs.filterProfile.addEventListener('change', () => {
    state.filters.profileId = refs.filterProfile.value;
    refreshHabitFilter();
    renderChart(refs.canvas, refs.chartEmpty);
  });

  refs.filterHabit.addEventListener('change', () => {
    state.filters.habitId = refs.filterHabit.value;
    renderChart(refs.canvas, refs.chartEmpty);
  });

  refs.filterRange.addEventListener('change', () => {
    state.filters.days = Number(refs.filterRange.value);
    renderChart(refs.canvas, refs.chartEmpty);
  });

  const setMode = (mode) => {
    state.mode = mode;
    refs.modeSolo.setAttribute('aria-pressed', String(mode === 'solo'));
    refs.modeComparison.setAttribute('aria-pressed', String(mode === 'comparison'));
    renderChart(refs.canvas, refs.chartEmpty);
  };
  refs.modeSolo.addEventListener('click', () => setMode('solo'));
  refs.modeComparison.addEventListener('click', () => setMode('comparison'));

  document.getElementById('add-habit').addEventListener('click', openHabitModal);
  document.getElementById('habit-cancel').addEventListener('click', () => refs.habitModal.close());
  document.getElementById('habit-close').addEventListener('click', () => refs.habitModal.close());

  refs.habitForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showBanner(refs.habitError, null);

    const name = refs.habitName.value.trim();
    if (!name) {
      showBanner(refs.habitError, 'Give the habit a name.');
      refs.habitName.focus();
      return;
    }

    setBusy(refs.habitSubmit, true, 'Adding…');
    try {
      const { data, error } = await supabase
        .from('habits')
        .insert({
          profile_id: state.profile.id,
          name,
          icon: refs.habitIcon.value.trim() || null,
          target_per_week: Number(refs.habitTarget.value),
        })
        .select('id, profile_id, name, icon, target_per_week, active')
        .single();

      if (error) {
        showBanner(
          refs.habitError,
          error.code === '23505'
            ? 'This profile already has a habit with that name.'
            : describeError(error, 'Couldn’t add that habit.'),
        );
        return;
      }

      state.habits.push(data);
      refs.habitModal.close();
      toast(`${name} added.`, { type: 'success' });
      refreshHabitFilter();
      renderAll();
    } finally {
      setBusy(refs.habitSubmit, false);
    }
  });
}
