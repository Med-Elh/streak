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

import { supabase, describeError } from './supabase.js?v=14';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=14';
import { listProfiles, requireActiveProfile } from './profiles.js?v=14';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy, showBanner,
  todayISO, formatDate, initials, beat,
  applyProfileTheme,
} from './ui.js?v=14';
import { completionChart } from './charts.js?v=14';

const DAY = 86400000;
/** Streaks can run long; a year of history is plenty to walk back through. */
const HISTORY_DAYS = 365;

import { mountGreeting } from './greetings.js?v=14';

const state = {
  profile: null,
  profiles: [],
  habits: [],        // every profile's active habits
  entries: [],       // { habit_id, date } for completed entries in the window
  filters: { profileId: 'all', habitId: 'all', days: 30 },
  editingHabit: null,
  lastHeroStreak: 0,
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

/**
 * Archived habits come back too. Their check-ins still count toward the days
 * they were ticked — archiving stops a habit going forward, it doesn't rewrite
 * what already happened.
 */
async function fetchHabits() {
  const { data, error } = await supabase
    .from('habits')
    .select('id, profile_id, name, icon, target_per_week, active')
    .order('created_at', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load habits.'));
  return data ?? [];
}

const activeHabits = (profileId) =>
  state.habits.filter((h) => h.profile_id === profileId && h.active);

const archivedHabits = (profileId) =>
  state.habits.filter((h) => h.profile_id === profileId && !h.active);

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

/** Local state only. The streak, the dots and the grid all read from this. */
function applyTick(habit, done) {
  const date = todayISO();
  if (done) state.entries.push({ habit_id: habit.id, date });
  else state.entries = state.entries.filter((e) => !(e.habit_id === habit.id && e.date === date));
}

/** The write. Throws with a sentence the caller can show. */
async function persistTick(habit, done) {
  const date = todayISO();
  if (done) {
    const { error } = await supabase
      .from('habit_entries')
      .upsert({ habit_id: habit.id, date, completed: true }, { onConflict: 'habit_id,date' });
    if (error) throw new Error(describeError(error, `Couldn’t tick ${habit.name}.`));
  } else {
    const { error } = await supabase
      .from('habit_entries')
      .delete()
      .eq('habit_id', habit.id)
      .eq('date', date);
    if (error) throw new Error(describeError(error, `Couldn’t untick ${habit.name}.`));
  }
}

/* ---------------------------------------------------------------- render -- */

/** The ring fills over a month; a longer streak keeps it full and glowing. */
const RING_TARGET = 30;

function renderHero(mount) {
  const streak = profileStreak(state.profile.id);
  const mine = activeHabits(state.profile.id);
  const today = todayISO();
  const done = doneSet(mine.map((h) => h.id)).get(today) ?? new Set();
  const remaining = mine.length - done.size;

  const circumference = 2 * Math.PI * 74;
  const ratio = Math.min(streak / RING_TARGET, 1);

  clear(mount);
  const hero = el('div', { class: 'streak-hero', dataset: { count: String(streak) } });

  const dial = el('div', { class: 'streak-hero__dial' });
  dial.innerHTML = `
    <svg viewBox="0 0 168 168" aria-hidden="true">
      <defs>
        <linearGradient id="streak-hero-gradient" x1="0" y1="1" x2="0.4" y2="0">
          <stop offset="0%" stop-color="var(--flame-to)" />
          <stop offset="100%" stop-color="var(--flame-from)" />
        </linearGradient>
      </defs>
      <circle class="streak-hero__track" cx="84" cy="84" r="74" />
      <circle class="streak-hero__arc" cx="84" cy="84" r="74"
        stroke-dasharray="${circumference.toFixed(1)}"
        stroke-dashoffset="${(circumference * (1 - ratio)).toFixed(1)}" />
    </svg>`;
  dial.append(el('div', { class: 'streak-hero__inner' }, [
    el('span', { class: 'streak-hero__count', text: String(streak) }),
    el('span', { class: 'streak-hero__unit', text: streak === 1 ? 'day' : 'days' }),
  ]));

  hero.append(dial, el('div', { class: 'streak-hero__body' }, [
    el('p', { class: 'eyebrow', text: 'Current streak' }),
    el('h2', {
      class: 'streak-hero__title',
      text: streak === 0
        ? 'Today is day one.'
        : streak === 1
          ? 'One day down.'
          : `${streak} days and counting.`,
    }),
    el('p', {
      class: 'streak-hero__line',
      text: !mine.length
        ? 'Add a habit and the count starts tonight.'
        : remaining === 0
          ? 'Everything ticked today. The streak is safe.'
          : `${remaining} habit${remaining === 1 ? '' : 's'} left today to keep it going.`,
    }),
  ]));

  mount.append(hero);
  refs.hero = hero;
}

function renderToday(mount) {
  const mine = activeHabits(state.profile.id);
  clear(mount);

  if (!mine.length) {
    mount.append(archivedHabits(state.profile.id).length
      ? invite({
          emoji: '📦',
          title: 'Nothing being tracked',
          body: 'Everything here is archived. Restore one below, or start something new.',
          action: 'Add a habit',
        })
      : invite({
          emoji: '🔥',
          title: 'Light the first one',
          body: 'Pick one small thing you want to do every day. Tick it tonight and the streak starts at one — that is the whole trick.',
          action: 'Add your first habit',
        }));
    return;
  }

  const today = todayISO();
  const done = doneSet(mine.map((h) => h.id)).get(today) ?? new Set();

  const grid = el('div', { class: 'habit-grid' });
  for (const habit of mine) grid.append(habitCard(habit, done.has(habit.id)));
  mount.append(grid);
}

function invite({ emoji, title, body, action }) {
  return el('div', { class: 'invite' }, [
    el('span', { class: 'invite__flame', 'aria-hidden': 'true', text: emoji }),
    el('p', { class: 'invite__title', text: title }),
    el('p', { text: body }),
    el('button', {
      class: 'btn btn--primary btn--lg',
      type: 'button',
      text: action,
      onclick: () => openHabitModal(),
    }),
  ]);
}

const DOW_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function habitCard(habit, isDone) {
  const streak = habitStreak(habit.id);
  const today = todayISO();
  const dates = new Set(state.entries.filter((e) => e.habit_id === habit.id).map((e) => e.date));

  const card = el('div', {
    class: 'habit-card',
    // The id lets a re-render find this card again to celebrate on it.
    dataset: { id: habit.id, done: String(isDone), streak: String(streak) },
  });

  const tick = el('button', {
    class: 'habit-tick',
    type: 'button',
    'aria-pressed': String(isDone),
    'aria-label': isDone ? `Untick ${habit.name} for today` : `Tick ${habit.name} for today`,
  }, [
    el('span', { class: 'habit-tick__mark', 'aria-hidden': 'true', text: '✓' }),
    el('span', { text: isDone ? 'Done today' : 'Mark done today' }),
  ]);

  tick.addEventListener('click', () => onTick(habit, isDone, tick, card));

  card.append(
    el('div', { class: 'habit-card__top' }, [
      el('span', {
        class: 'habit-card__icon',
        'aria-hidden': 'true',
        text: habit.icon || '🔥',
      }),
      el('div', { class: 'habit-card__meta' }, [
        el('p', { class: 'habit-card__name', text: habit.name }),
        el('p', { class: 'habit-card__target', text: `${habit.target_per_week}× a week` }),
      ]),
      el('div', { class: 'habit-card__streak' }, [
        el('span', { class: 'habit-card__streak-num', text: String(streak) }),
        el('span', { class: 'habit-card__streak-unit', text: streak === 1 ? 'day' : 'days' }),
      ]),
      cardMenu(habit),
    ]),
    tick,
    weekDots(dates, today),
    contributionGrid(habit, dates, today),
  );

  return card;
}

/* Only one menu is open at a time, so the last one closes itself. */
let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  openMenu.panel.remove();
  openMenu.button.setAttribute('aria-expanded', 'false');
  openMenu = null;
}

document.addEventListener('click', (event) => {
  if (openMenu && !openMenu.wrap.contains(event.target)) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openMenu) {
    const { button } = openMenu;
    closeMenu();
    button.focus();
  }
});

/**
 * The ⋯ menu in a card's top-right. Managing a habit is rare next to ticking
 * it, so it stays folded away rather than competing with the thing you came
 * here to do.
 */
function cardMenu(habit) {
  const wrap = el('div', { class: 'card-menu' });

  const button = el('button', {
    class: 'card-menu__button',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': `Manage ${habit.name}`,
    title: `Manage ${habit.name}`,
    text: '⋯',
  });

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const wasOpen = openMenu?.button === button;
    closeMenu();
    if (wasOpen) return;

    const panel = el('div', { class: 'card-menu__panel', role: 'menu' }, [
      menuItem('Edit', `Edit ${habit.name}`, () => openHabitModal(habit)),
      menuItem('Archive', `Archive ${habit.name}`, () => setArchived(habit, true)),
      menuItem('Delete', `Delete ${habit.name}`, () => removeHabit(habit), 'is-danger'),
    ]);

    wrap.append(panel);
    button.setAttribute('aria-expanded', 'true');
    openMenu = { wrap, button, panel };
    panel.querySelector('button')?.focus();
  });

  wrap.append(button);
  return wrap;
}

function menuItem(label, description, action, modifier = '') {
  return el('button', {
    class: `card-menu__item ${modifier}`,
    type: 'button',
    role: 'menuitem',
    text: label,
    'aria-label': description,
    onclick: () => {
      closeMenu();
      action();
    },
  });
}

/**
 * The tick takes a moment on purpose. Ticking is the one thing this app is for,
 * so it gets a beat of acknowledgement before the page rearranges itself.
 */
async function onTick(habit, wasDone, tick, card) {
  const extending = !wasDone;
  const before = state.lastHeroStreak;

  // Everything the tick affects — the hero count and ring, the seven-day dots,
  // the contribution grid, the board — reads from state.entries, so changing it
  // here means the whole page moves on this frame rather than after the write.
  applyTick(habit, extending);
  if (extending) tick.classList.add('is-ticking');

  // Render before celebrating, so the pop happens on the new count rather than
  // over the old one that is about to be replaced.
  renderAll();

  if (extending && profileStreak(state.profile.id) > before) {
    refs.hero?.classList.add('is-celebrating');
    refs.today.querySelector(`[data-id="${habit.id}"]`)?.classList.add('is-celebrating');
    await beat(520);
  }

  toast(wasDone ? `${habit.name} unticked.` : `${habit.name} done today.`, {
    type: 'success',
    duration: 2200,
  });

  try {
    await persistTick(habit, extending);
  } catch (error) {
    applyTick(habit, wasDone);   // put it back exactly as it was
    renderAll();
    toast(error.message, { type: 'error' });
  }
}

function weekDots(dates, today) {
  const row = el('div', { class: 'week-dots', role: 'group', 'aria-label': 'Last seven days' });
  for (let i = 6; i >= 0; i -= 1) {
    const date = shiftDays(today, -i);
    const done = dates.has(date);
    // Monday-first initials, aligned to the real weekday of each column.
    const dow = (new Date(`${date}T12:00:00`).getDay() + 6) % 7;
    row.append(el('div', {
      class: 'week-dot',
      dataset: { done: String(done), today: String(date === today) },
      title: `${formatDate(date)} — ${done ? 'done' : 'not done'}`,
    }, [
      el('span', { class: 'week-dot__mark' }),
      el('span', { class: 'week-dot__label', text: DOW_INITIALS[dow] }),
    ]));
  }
  return row;
}

/**
 * A year of check-ins. A single habit is only ever done or not, so intensity
 * comes from the length of the run each day belonged to — a long streak reads
 * darker than a scattering of one-off days, which is the thing worth seeing.
 */
function contributionGrid(habit, dates, today) {
  const wrap = el('div', { class: 'contrib' });
  const grid = el('div', {
    class: 'contrib__grid',
    role: 'img',
    'aria-label': `${dates.size} check-ins for ${habit.name} in the last year`,
  });

  // Start on the Monday on or before a year ago, so columns are whole weeks.
  const start = shiftDays(today, -363);
  const startDow = (new Date(`${start}T12:00:00`).getDay() + 6) % 7;
  const first = shiftDays(start, -startDow);

  let run = 0;
  const levels = new Map();
  for (let i = 0; i < 371; i += 1) {
    const date = shiftDays(first, i);
    if (dates.has(date)) {
      run += 1;
      levels.set(date, run >= 21 ? 4 : run >= 7 ? 3 : run >= 3 ? 2 : 1);
    } else {
      run = 0;
    }
  }

  for (let i = 0; i < 371; i += 1) {
    const date = shiftDays(first, i);
    if (date > today) break;
    const level = levels.get(date) ?? 0;
    grid.append(el('div', {
      class: 'contrib__cell',
      dataset: { level: String(level) },
      title: `${formatDate(date)} — ${level ? 'done' : 'not done'}`,
    }));
  }

  wrap.append(
    el('div', { class: 'contrib__scroll' }, grid),
    el('div', { class: 'contrib__legend' }, [
      el('span', { text: 'Less' }),
      ...[0, 1, 2, 3, 4].map((level) =>
        el('span', { class: 'contrib__cell', dataset: { level: String(level) } })),
      el('span', { text: 'More' }),
    ]),
  );
  return wrap;
}

/**
 * Archived habits keep their history and stay out of the way. Restoring one
 * picks up exactly where it left off — the entries never went anywhere.
 */
function renderArchived(mount) {
  const archived = archivedHabits(state.profile.id);
  clear(mount);
  if (!archived.length) return;

  const group = el('details', { class: 'collapse' }, [
    el('summary', {}, [
      el('span', { text: 'Archived' }),
      el('span', { class: 'collapse__count', text: String(archived.length) }),
    ]),
  ]);

  for (const habit of archived) {
    group.append(el('div', { class: 'habit-row habit-row--archived' }, [
      el('span', { class: 'habit-row__body' }, [
        el('span', { class: 'habit-row__name' }, [
          habit.icon ? el('span', { 'aria-hidden': 'true', text: habit.icon }) : null,
          el('span', { text: habit.name }),
        ]),
        el('span', {
          class: 'habit-row__meta',
          text: `${entryCount(habit.id)} check-in${entryCount(habit.id) === 1 ? '' : 's'} kept`,
        }),
      ]),
      el('div', { class: 'habit-actions' }, [
        el('button', {
          class: 'btn btn--secondary btn--sm',
          type: 'button',
          text: 'Restore',
          'aria-label': `Restore ${habit.name}`,
          onclick: () => setArchived(habit, false),
        }),
        el('button', {
          class: 'btn btn--danger btn--sm',
          type: 'button',
          text: 'Delete',
          'aria-label': `Delete ${habit.name}`,
          onclick: () => removeHabit(habit),
        }),
      ]),
    ]));
  }

  mount.append(group);
}

function entryCount(habitId) {
  return state.entries.filter((e) => e.habit_id === habitId).length;
}

/* ------------------------------------------------------------- management -- */

async function setArchived(habit, archived) {
  try {
    const { error } = await supabase
      .from('habits')
      .update({ active: !archived })
      .eq('id', habit.id);
    if (error) throw new Error(describeError(error, `Couldn’t ${archived ? 'archive' : 'restore'} that habit.`));

    habit.active = !archived;
    toast(
      archived
        ? `${habit.name} archived. Its history is kept.`
        : `${habit.name} restored.`,
      { type: 'success' },
    );
    renderAll();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

/**
 * Deleting cascades to habit_entries in the database, so the confirm has to say
 * so plainly — the streak is the point of the app, and this is the one action
 * that destroys one.
 */
async function removeHabit(habit) {
  if (!window.confirm(`Delete ${habit.name}? Its check-in history goes too.`)) return;

  try {
    const { error } = await supabase.from('habits').delete().eq('id', habit.id);
    if (error) throw new Error(describeError(error, 'Couldn’t delete that habit.'));

    state.habits = state.habits.filter((h) => h.id !== habit.id);
    state.entries = state.entries.filter((e) => e.habit_id !== habit.id);
    toast(`${habit.name} deleted.`, { type: 'success' });
    refreshHabitFilter();
    renderAll();
  } catch (error) {
    toast(error.message, { type: 'error' });
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

  // Only a non-zero streak can lead, and a tie means nobody is ahead.
  const top = ranked[0]?.streak ?? 0;
  const leaders = ranked.filter((r) => r.streak === top && top > 0);
  const soleLeader = leaders.length === 1 ? leaders[0].profile.id : null;

  const board = el('div', { class: 'scoreboard' });
  ranked.forEach((row, index) => {
    const isLeader = row.profile.id === soleLeader;
    board.append(
      el('div', {
        class: `score-row${isLeader ? ' score-row--leader' : ''}`,
        dataset: { me: String(row.profile.id === state.profile.id) },
      }, [
        el('span', { class: 'score-row__rank', text: String(index + 1) }),
        el('span', {
          class: 'avatar',
          style: `--avatar: ${row.profile.avatar_color}`,
          'aria-hidden': 'true',
          text: initials(row.profile.name),
        }),
        el('span', { class: 'score-row__name', text: row.profile.name }),
        isLeader
          ? el('span', { class: 'score-row__crown', title: 'Longest streak', text: '👑' })
          : null,
        el('span', { class: 'score-row__streak' }, [
          el('b', { text: String(row.streak) }),
          el('span', { text: row.streak === 1 ? 'day' : 'days' }),
        ]),
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
  renderHero(refs.hero0);
  // Remembered so the next tick can tell whether the streak actually grew.
  state.lastHeroStreak = profileStreak(state.profile.id);
  renderToday(refs.today);
  renderArchived(refs.archived);
  renderBoard(refs.board);
  renderChart(refs.canvas, refs.chartEmpty);
}

/** One modal for both jobs: `habit` present means edit, absent means add. */
function openHabitModal(habit = null) {
  refs.habitForm.reset();
  showBanner(refs.habitError, null);

  state.editingHabit = habit?.id ?? null;
  refs.habitTitle.textContent = habit ? 'Edit habit' : 'Add a habit';
  refs.habitSubmit.textContent = habit ? 'Save changes' : 'Add habit';

  if (habit) {
    refs.habitName.value = habit.name;
    refs.habitIcon.value = habit.icon ?? '';
    refs.habitTarget.value = String(habit.target_per_week);
  }

  refs.habitModal.showModal();
  refs.habitName.focus();
  refs.habitName.select();
}

export async function initHabitsPage() {
  await requireSession();
  const profile = await requireActiveProfile();
  state.profile = profile;
  applyProfileTheme(profile.id);
  mountGreeting(profile);

  document.body.prepend(
    topbar({
      profile,
      current: 'habits.html',
      onSwitchProfile: () => goTo(PICKER_PAGE),
      onSignOut: signOut,
    }),
  );

  refs = {
    hero0: document.getElementById('streak-hero'),
    today: document.getElementById('today-list'),
    archived: document.getElementById('archived-list'),
    habitTitle: document.getElementById('habit-title'),
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
  // Archived habits stay out of the filter: you can't chart what isn't running.
  const scope = state.filters.profileId === 'all'
    ? state.habits.filter((h) => h.active)
    : state.habits.filter((h) => h.profile_id === state.filters.profileId && h.active);

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

    const editing = state.editingHabit;
    const values = {
      name,
      icon: refs.habitIcon.value.trim() || null,
      target_per_week: Number(refs.habitTarget.value),
    };

    setBusy(refs.habitSubmit, true, editing ? 'Saving…' : 'Adding…');
    try {
      const query = editing
        ? supabase.from('habits').update(values).eq('id', editing)
        : supabase.from('habits').insert({ profile_id: state.profile.id, ...values });

      const { data, error } = await query
        .select('id, profile_id, name, icon, target_per_week, active')
        .single();

      if (error) {
        showBanner(
          refs.habitError,
          error.code === '23505'
            ? 'This profile already has a habit with that name.'
            : describeError(error, `Couldn’t ${editing ? 'save' : 'add'} that habit.`),
        );
        return;
      }

      if (editing) Object.assign(state.habits.find((h) => h.id === editing), data);
      else state.habits.push(data);

      refs.habitModal.close();
      state.editingHabit = null;
      toast(editing ? `${name} updated.` : `${name} added.`, { type: 'success' });
      refreshHabitFilter();
      renderAll();
    } catch (error) {
      showBanner(refs.habitError, error.message);
    } finally {
      setBusy(refs.habitSubmit, false);
    }
  });
}
