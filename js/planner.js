/**
 * Planner: a week you can see at once, and a day you can see by the hour.
 *
 * The week strip answers "how full is this week?" — dots on small screens,
 * the first few events on wide ones. The day below answers "where does this
 * go?", which is why an empty hour is itself the button that fills it.
 *
 * Tasks due that day appear in it, read-only apart from the tick: the planner
 * shows them so a day's plan is honest about what's already owed, but they are
 * edited where they live, on the Tasks page.
 */

import { supabase, describeError } from './supabase.js?v=45';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=45';
import { requireActiveProfile } from './profiles.js?v=45';
import {
  el, clear, toast, topbar, emptyState, setBusy, showBanner, swatchPicker,
  formatDate, todayISO, applyProfileTheme,
} from './ui.js?v=45';
import { EVENT_COLOURS, PRIORITIES, eventColour, labelFor } from './constants.js?v=45';
import { mountGreeting } from './greetings.js?v=45';

const state = {
  profile: null,
  weekStart: null,     // Monday of the week on screen, 'YYYY-MM-DD'
  selected: null,      // the open day, 'YYYY-MM-DD'
  events: [],          // planner_events in the week on screen
  tasks: [],           // tasks due in the week on screen
  loading: true,
  error: null,
  editing: null,       // the event open in the modal, or null for a new one
  lastColour: EVENT_COLOURS[0].value,
  scrolledFor: null,   // the day the hour grid was last scrolled into place for
  request: 0,          // guards against an older week's response landing late
};

let refs = {};

/* Below this an event is drawn taller than it lasts, so it can still be read
   and tapped. Layout treats it as that tall too, so it never overlaps a
   neighbour it only appears to touch. */
const MIN_VISUAL_MINUTES = 30;
const DAY_MINUTES = 24 * 60;

/* ----------------------------------------------------------------- dates -- */
/* Pure and exported. Everything is done on ISO strings through UTC, so a
   daylight-saving change can never make a week six or eight days long. */

function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toISO(date) {
  return date.toISOString().slice(0, 10);
}

export function isISODate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(parseISO(value).valueOf()) && toISO(parseISO(value)) === value;
}

export function addDays(iso, days) {
  const date = parseISO(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return toISO(date);
}

/** The Monday on or before `iso`. */
export function startOfWeek(iso) {
  const weekday = parseISO(iso).getUTCDay(); // 0 = Sunday
  return addDays(iso, -((weekday + 6) % 7));
}

export function weekDays(monday) {
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Whole weeks from this week to the one starting `monday`. */
export function weeksFromNow(monday, today = todayISO()) {
  const diff = parseISO(monday) - parseISO(startOfWeek(today));
  return Math.round(diff / (7 * 86400000));
}

/* ----------------------------------------------------------------- times -- */

/** '09:30' or '09:30:00' → 570. '24:00' → 1440. */
export function toMinutes(time) {
  const [h, m] = String(time ?? '').split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** 570 → '09:30', for a time input. Midnight-at-the-end shows as '00:00'. */
export function toTimeValue(minutes) {
  const clamped = ((Math.round(minutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/**
 * The end as stored. A time input can't say 24:00, so an end of 00:00 after
 * a later start means "until midnight" rather than "before it began".
 */
export function normaliseEnd(startMinutes, endMinutes) {
  if (endMinutes === 0 && startMinutes > 0) return DAY_MINUTES;
  return endMinutes;
}

/** What's wrong with a draft event, or null. Messages say how to fix it. */
export function validateEvent({ title, date, start, end }) {
  if (!String(title ?? '').trim()) return { field: 'title', message: 'Give the event a title.' };
  if (!isISODate(date)) return { field: 'date', message: 'Pick a date for the event.' };
  if (start === null || start === undefined) return { field: 'start', message: 'Set a start time.' };
  if (end === null || end === undefined) return { field: 'end', message: 'Set an end time.' };
  if (end <= start) return { field: 'end', message: 'The end time has to be after the start. For an event that runs to midnight, set the end to 00:00.' };
  return null;
}

/**
 * Side-by-side columns for events that overlap.
 *
 * Events are grouped into clusters that overlap transitively; each cluster is
 * split into as many columns as it needs at its busiest, and every event in it
 * takes the leftmost column free when it starts. Returns one entry per event
 * with { start, end, column, columns } in minutes.
 */
export function layoutDay(events) {
  const items = events
    .map((event) => {
      const start = toMinutes(event.start_time) ?? 0;
      const end = Math.max(toMinutes(event.end_time) ?? start, start + 1);
      return { event, start, end, visualEnd: Math.max(end, start + MIN_VISUAL_MINUTES) };
    })
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const out = [];
  let cluster = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    const columnEnds = [];
    for (const item of cluster) {
      let column = columnEnds.findIndex((end) => end <= item.start);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(item.visualEnd);
      } else {
        columnEnds[column] = item.visualEnd;
      }
      item.column = column;
    }
    for (const item of cluster) item.columns = columnEnds.length;
    out.push(...cluster);
    cluster = [];
  };

  for (const item of items) {
    if (cluster.length && item.start >= clusterEnd) {
      flush();
      clusterEnd = -Infinity;
    }
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.visualEnd);
  }
  if (cluster.length) flush();

  return out.map(({ visualEnd, ...rest }) => rest);
}

/* ------------------------------------------------------------ formatting -- */

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const hourFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric' });

/* A fixed day to hang a time on. Midnight at the end prints as midnight. */
function clockDate(minutes) {
  return new Date(2000, 0, 1, Math.floor((minutes % DAY_MINUTES) / 60), minutes % 60);
}

function formatClock(minutes) {
  return timeFormat.format(clockDate(minutes));
}

function formatHour(hour) {
  return hourFormat.format(clockDate(hour * 60));
}

function formatSpan(event) {
  return `${formatClock(toMinutes(event.start_time))} – ${formatClock(toMinutes(event.end_time))}`;
}

function weekLabel(monday) {
  const from = parseISO(monday);
  const to = parseISO(addDays(monday, 6));
  const format = new Intl.DateTimeFormat(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
  return typeof format.formatRange === 'function'
    ? format.formatRange(from, to)
    : `${format.format(from)} – ${format.format(to)}`;
}

function relativeWeek(monday) {
  const weeks = weeksFromNow(monday);
  if (weeks === 0) return 'This week';
  if (weeks === 1) return 'Next week';
  if (weeks === -1) return 'Last week';
  return weeks > 0 ? `In ${weeks} weeks` : `${Math.abs(weeks)} weeks ago`;
}

function plural(count, word) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/* ------------------------------------------------------------------ data -- */

const EVENT_COLUMNS = 'id, title, date, start_time, end_time, color, created_at';
const MISSING_TABLE = new Set(['42P01', 'PGRST205']);

async function fetchWeek(monday) {
  const sunday = addDays(monday, 6);

  const [events, tasks] = await Promise.all([
    supabase
      .from('planner_events')
      .select(EVENT_COLUMNS)
      .eq('profile_id', state.profile.id)
      .gte('date', monday)
      .lte('date', sunday)
      .order('date', { ascending: true })
      .order('start_time', { ascending: true }),
    supabase
      .from('tasks')
      .select('id, title, due_date, priority, done, completed_at')
      .eq('profile_id', state.profile.id)
      .gte('due_date', monday)
      .lte('due_date', sunday)
      .order('created_at', { ascending: true }),
  ]);

  if (events.error) {
    if (MISSING_TABLE.has(events.error.code)) {
      throw new Error('The planner needs the latest migration. Run it in the Supabase SQL editor, then reload.');
    }
    throw new Error(describeError(events.error, 'Couldn’t load this week’s events.'));
  }

  // Tasks are a guest here; failing to load them shouldn't hide the plan.
  if (tasks.error) toast(describeError(tasks.error, 'Couldn’t load the tasks due this week.'), { type: 'error' });

  return { events: events.data ?? [], tasks: tasks.data ?? [] };
}

function eventsOn(date) {
  return state.events.filter((e) => e.date === date);
}

function tasksOn(date) {
  return state.tasks.filter((t) => t.due_date === date);
}

/* ------------------------------------------------------------ navigation -- */

/** Opens a day, fetching its week first if it isn't the one on screen. */
async function select(date, { focusTile = false } = {}) {
  state.selected = date;
  const url = new URL(window.location.href);
  url.searchParams.set('date', date);
  // A reload or a shared link reopens the same day. Not a history entry per tap.
  history.replaceState(null, '', url);

  const monday = startOfWeek(date);
  if (monday !== state.weekStart) {
    state.weekStart = monday;
    await loadWeek();
  } else {
    render();
  }

  if (focusTile) refs.days.querySelector(`[data-date="${date}"]`)?.focus();
}

async function loadWeek() {
  const request = ++state.request;
  state.loading = true;
  state.error = null;
  state.scrolledFor = null;
  render();

  try {
    const { events, tasks } = await fetchWeek(state.weekStart);
    if (request !== state.request) return; // A newer week was asked for meanwhile.
    state.events = events;
    state.tasks = tasks;
  } catch (error) {
    if (request !== state.request) return;
    state.error = error.message;
  }

  state.loading = false;
  render();
}

/* ---------------------------------------------------------------- render -- */

function render() {
  renderWeek();
  renderDay();
}

function renderWeek() {
  refs.weekRelative.textContent = relativeWeek(state.weekStart);
  refs.weekLabel.textContent = weekLabel(state.weekStart);
  refs.thisWeek.hidden = state.selected === todayISO();

  clear(refs.days);
  const today = todayISO();

  for (const date of weekDays(state.weekStart)) {
    const events = eventsOn(date);
    const tasks = tasksOn(date);
    const openTasks = tasks.filter((t) => !t.done);

    const described = [
      formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' }),
      date === today ? 'today' : null,
      state.loading ? null : plural(events.length, 'event'),
      !state.loading && tasks.length ? `${plural(tasks.length, 'task')} due` : null,
    ].filter(Boolean).join(', ');

    const tile = el('button', {
      class: 'planner-tile',
      type: 'button',
      dataset: { date },
      'aria-pressed': String(date === state.selected),
      'aria-current': date === today ? 'date' : null,
      'aria-label': described,
      onclick: () => select(date),
    }, [
      el('span', { class: 'planner-tile__dow', text: formatDate(date, { weekday: 'short' }) }),
      el('span', { class: 'planner-tile__date', text: formatDate(date, { day: 'numeric' }) }),
    ]);

    if (!state.loading && !state.error) {
      // Narrow screens: a dot per event (three at most) and one for tasks due.
      const marks = el('span', { class: 'planner-tile__marks', 'aria-hidden': 'true' });
      for (const event of events.slice(0, 3)) {
        marks.append(el('span', {
          class: 'planner-tile__dot',
          style: `--event: var(${eventColour(event.color).token})`,
        }));
      }
      if (events.length > 3) marks.append(el('span', { class: 'planner-tile__more', text: `+${events.length - 3}` }));
      if (openTasks.length) marks.append(el('span', { class: 'planner-tile__dot planner-tile__dot--task' }));
      tile.append(marks);

      // Wide screens: the first few events by name.
      const peek = el('span', { class: 'planner-tile__peek', 'aria-hidden': 'true' });
      for (const event of events.slice(0, 3)) {
        peek.append(el('span', {
          class: 'planner-tile__event',
          style: `--event: var(${eventColour(event.color).token})`,
        }, [
          el('span', { class: 'planner-tile__time', text: formatClock(toMinutes(event.start_time)) }),
          el('span', { class: 'planner-tile__title', text: event.title }),
        ]));
      }
      if (events.length > 3) peek.append(el('span', { class: 'planner-tile__overflow', text: `${events.length - 3} more` }));
      if (openTasks.length) {
        peek.append(el('span', { class: 'planner-tile__overflow', text: `${plural(openTasks.length, 'task')} due` }));
      }
      tile.append(peek);
    }

    refs.days.append(tile);
  }
}

function renderDay() {
  const date = state.selected;
  const today = todayISO();

  refs.dayTitle.textContent = formatDate(date, { weekday: 'long', day: 'numeric', month: 'long' });
  refs.dayAdd.disabled = state.loading || Boolean(state.error);

  // Emptying the grid clamps its scroll to zero; a tick or a save must not
  // throw you back to midnight.
  const keptScroll = refs.hours.scrollTop;

  clear(refs.dayTasks);
  clear(refs.dayNote);
  clear(refs.hours);

  if (state.error) {
    refs.daySummary.textContent = '';
    refs.hours.append(emptyState({
      title: 'Couldn’t load this week',
      body: state.error,
      actionLabel: 'Try again',
      onAction: loadWeek,
    }));
    return;
  }

  if (state.loading) {
    refs.daySummary.textContent = 'Loading…';
    refs.hours.append(el('div', { class: 'planner-hours__loading', 'aria-hidden': 'true' },
      Array.from({ length: 6 }, () => el('div', { class: 'skeleton skeleton--text' }))));
    return;
  }

  const events = eventsOn(date);
  const tasks = tasksOn(date);

  refs.daySummary.textContent = [
    date === today ? 'Today' : null,
    plural(events.length, 'event'),
    tasks.length ? `${plural(tasks.length, 'task')} due` : null,
  ].filter(Boolean).join(' · ');

  if (tasks.length) refs.dayTasks.append(taskList(tasks));

  if (!events.length && !tasks.length) {
    refs.dayNote.append(el('p', { class: 'planner-day__empty' }, [
      'Nothing planned. Tap an hour below to block it out, or ',
      el('button', { class: 'link-button', type: 'button', text: 'add an event', onclick: () => openEventModal() }),
      '.',
    ]));
  }

  refs.hours.append(hourGrid(date, events));
  placeNowLine();

  // Scroll to something worth seeing once per day opened, not on every save.
  if (state.scrolledFor !== date) {
    state.scrolledFor = date;
    scrollHoursTo(initialMinute(date, events));
  } else {
    refs.hours.scrollTop = keptScroll;
  }
}

function taskList(tasks) {
  return el('div', { class: 'planner-tasks' }, [
    el('p', { class: 'planner-tasks__label' }, [
      el('span', { text: 'Due this day' }),
      el('a', { href: 'tasks.html', class: 'planner-tasks__link', text: 'Open tasks' }),
    ]),
    el('ul', { class: 'planner-tasks__list' }, tasks.map((task) => {
      const checkbox = el('input', {
        type: 'checkbox',
        checked: task.done,
        'aria-label': task.done ? `Reopen ${task.title}` : `Complete ${task.title}`,
      });
      checkbox.addEventListener('change', () => toggleTask(task, checkbox.checked));
      return el('li', {
        class: 'planner-task',
        dataset: { done: String(task.done), priority: task.priority },
      }, [
        el('label', { class: 'planner-task__row' }, [
          checkbox,
          el('span', { class: 'planner-task__title', text: task.title }),
          el('span', { class: 'planner-task__priority', text: labelFor(PRIORITIES, task.priority) }),
        ]),
      ]);
    })),
  ]);
}

function hourGrid(date, events) {
  const grid = el('div', { class: 'planner-hours__grid' });

  // Events first in the DOM so Tab reaches what's planned before the 24 empty
  // hours; they're drawn above the slots regardless.
  const layer = el('div', { class: 'planner-events' });
  for (const item of layoutDay(events)) layer.append(eventBlock(item));
  grid.append(layer);

  for (let hour = 0; hour < 24; hour += 1) {
    grid.append(el('button', {
      class: 'planner-slot',
      type: 'button',
      style: `--h: ${hour}`,
      'aria-label': `Add an event at ${formatHour(hour)}`,
      onclick: (event) => {
        // The lower half of an hour starts on the half hour. A keyboard press
        // has no position, so it takes the hour itself.
        const half = event.detail > 0 && event.offsetY > event.currentTarget.offsetHeight / 2;
        const start = hour * 60 + (half ? 30 : 0);
        openEventModal(null, { date, start, end: Math.min(start + 60, DAY_MINUTES) });
      },
    }, el('span', { class: 'planner-slot__label', text: formatHour(hour) })));
  }

  grid.append(el('div', { class: 'planner-now', hidden: true, 'aria-hidden': 'true' }));
  return grid;
}

function eventBlock({ event, start, end, column, columns }) {
  const length = end - start;
  const colour = eventColour(event.color);
  const short = length < 45;

  return el('button', {
    class: `planner-event${short ? ' planner-event--short' : ''}`,
    type: 'button',
    style: [
      `--event: var(${colour.token})`,
      `--start: ${start / 60}`,
      `--length: ${Math.max(length, MIN_VISUAL_MINUTES) / 60}`,
      `--col: ${column}`,
      `--cols: ${columns}`,
    ].join('; '),
    'aria-label': `${event.title}, ${formatSpan(event)}. Edit`,
    onclick: () => openEventModal(event),
  }, [
    el('span', { class: 'planner-event__title', text: event.title }),
    el('span', { class: 'planner-event__time', text: short ? formatClock(start) : formatSpan(event) }),
  ]);
}

function hourHeight() {
  return parseFloat(getComputedStyle(refs.hours).getPropertyValue('--hour')) || 52;
}

function scrollHoursTo(minute) {
  refs.hours.scrollTop = Math.max(0, (minute / 60) * hourHeight());
}

/** Now, if it's today; else the first event; else the start of a working day. */
function initialMinute(date, events) {
  if (date === todayISO()) {
    const now = new Date();
    return Math.max(0, now.getHours() * 60 + now.getMinutes() - 60);
  }
  const first = Math.min(...events.map((e) => toMinutes(e.start_time) ?? DAY_MINUTES));
  if (Number.isFinite(first) && first < DAY_MINUTES) return Math.max(0, first - 30);
  return 7 * 60;
}

function placeNowLine() {
  const line = refs.hours.querySelector('.planner-now');
  if (!line) return;
  const isToday = state.selected === todayISO();
  line.hidden = !isToday;
  if (!isToday) return;
  const now = new Date();
  line.style.setProperty('--start', String((now.getHours() * 60 + now.getMinutes()) / 60));
}

/* ----------------------------------------------------------------- modal -- */

function openEventModal(event = null, draft = {}) {
  state.editing = event;
  showBanner(refs.error, null);
  refs.form.reset();

  const date = event?.date ?? draft.date ?? state.selected;
  let start = event ? toMinutes(event.start_time) : draft.start;
  if (start === undefined) {
    // From the button: the next full hour if it's today, nine o'clock otherwise.
    const now = new Date();
    start = date === todayISO() ? Math.min((now.getHours() + 1) * 60, 23 * 60) : 9 * 60;
  }
  const end = event ? toMinutes(event.end_time) : (draft.end ?? Math.min(start + 60, DAY_MINUTES));

  refs.title.value = event?.title ?? '';
  refs.date.value = date;
  refs.start.value = toTimeValue(start);
  refs.start.dataset.previous = refs.start.value;
  refs.end.value = toTimeValue(end);
  refs.colour.select(`var(${eventColour(event?.color ?? state.lastColour).token})`);
  paintEndHint();

  refs.modalTitle.textContent = event ? 'Edit event' : 'Add an event';
  refs.submit.textContent = event ? 'Save event' : 'Add event';
  refs.remove.hidden = !event;

  refs.modal.showModal();
  // On a phone, focusing the title raises the keyboard over a modal you
  // opened by tapping an hour — the time is often all you came to check.
  if (!event || !window.matchMedia('(pointer: coarse)').matches) refs.title.focus();
}

function paintEndHint() {
  const start = toMinutes(refs.start.value);
  const end = toMinutes(refs.end.value);
  refs.endHint.hidden = !(end === 0 && start > 0);
}

function colourKeyFromSwatch(value) {
  return EVENT_COLOURS.find((c) => `var(${c.token})` === value)?.value ?? EVENT_COLOURS[0].value;
}

async function saveEvent(submitEvent) {
  submitEvent.preventDefault();
  showBanner(refs.error, null);

  const start = toMinutes(refs.start.value);
  const rawEnd = toMinutes(refs.end.value);
  const draft = {
    title: refs.title.value.trim(),
    date: refs.date.value,
    start,
    end: rawEnd === null || start === null ? rawEnd : normaliseEnd(start, rawEnd),
  };

  const problem = validateEvent(draft);
  if (problem) {
    showBanner(refs.error, problem.message);
    refs[problem.field]?.focus();
    return;
  }

  const color = colourKeyFromSwatch(refs.colour.selected());
  const payload = {
    title: draft.title,
    date: draft.date,
    start_time: draft.start === DAY_MINUTES ? '24:00' : toTimeValue(draft.start),
    end_time: draft.end === DAY_MINUTES ? '24:00' : toTimeValue(draft.end),
    color,
  };

  const editing = state.editing;
  setBusy(refs.submit, true, editing ? 'Saving…' : 'Adding…');
  try {
    const query = editing
      ? supabase.from('planner_events').update(payload).eq('id', editing.id)
      : supabase.from('planner_events').insert({ ...payload, profile_id: state.profile.id });
    const { data, error } = await query.select(EVENT_COLUMNS).single();

    if (error) {
      showBanner(refs.error, describeError(error, editing ? 'Couldn’t save that event.' : 'Couldn’t add that event.'));
      return;
    }

    state.lastColour = color;
    state.events = state.events.filter((e) => e.id !== data.id);
    state.events.push(data);
    refs.modal.close();
    toast(editing ? 'Event saved.' : 'Event added.', { type: 'success', duration: 2000 });

    // Moved to another day: follow it there, so it doesn't seem to vanish.
    if (data.date !== state.selected) {
      await select(data.date);
    } else {
      render();
    }
  } catch (error) {
    showBanner(refs.error, describeError(error, 'Couldn’t save that event.'));
  } finally {
    setBusy(refs.submit, false);
  }
}

async function removeEvent() {
  const event = state.editing;
  if (!event) return;
  if (!window.confirm(`Delete ${event.title}? This can't be undone.`)) return;

  setBusy(refs.remove, true, 'Deleting…');
  try {
    const { error } = await supabase.from('planner_events').delete().eq('id', event.id);
    if (error) throw new Error(describeError(error, 'Couldn’t delete that event.'));

    state.events = state.events.filter((e) => e.id !== event.id);
    refs.modal.close();
    toast('Event deleted.', { type: 'success', duration: 2000 });
    render();
  } catch (error) {
    showBanner(refs.error, error.message);
  } finally {
    setBusy(refs.remove, false);
  }
}

/* ----------------------------------------------------------------- tasks -- */

async function toggleTask(task, done) {
  const live = state.tasks.find((t) => t.id === task.id);
  if (!live) return;

  const previous = { done: live.done, completed_at: live.completed_at };
  const patch = { done, completed_at: done ? new Date().toISOString() : null };
  Object.assign(live, patch);
  render();

  try {
    const { error } = await supabase.from('tasks').update(patch).eq('id', live.id);
    if (error) throw new Error(describeError(error, 'Couldn’t update that task.'));
    if (done) toast(`${live.title} done.`, { type: 'success', duration: 2000 });
  } catch (error) {
    Object.assign(live, previous);
    render();
    toast(error.message, { type: 'error' });
  }
}

/* ----------------------------------------------------------------- setup -- */

export async function initPlannerPage() {
  await requireSession();
  const profile = await requireActiveProfile();
  state.profile = profile;
  applyProfileTheme(profile.id);
  mountGreeting(profile);

  document.body.prepend(
    topbar({
      profile,
      current: 'planner.html',
      onSwitchProfile: () => goTo(PICKER_PAGE),
      onSignOut: signOut,
    }),
  );

  refs = {
    weekRelative: document.getElementById('week-relative'),
    weekLabel: document.getElementById('week-label'),
    days: document.getElementById('week-days'),
    prevWeek: document.getElementById('prev-week'),
    nextWeek: document.getElementById('next-week'),
    thisWeek: document.getElementById('this-week'),
    dayTitle: document.getElementById('day-title'),
    daySummary: document.getElementById('day-summary'),
    dayAdd: document.getElementById('day-add'),
    dayTasks: document.getElementById('day-tasks'),
    dayNote: document.getElementById('day-note'),
    hours: document.getElementById('day-hours'),
    modal: document.getElementById('event-modal'),
    modalTitle: document.getElementById('event-modal-title'),
    form: document.getElementById('event-form'),
    error: document.getElementById('event-error'),
    title: document.getElementById('event-title'),
    date: document.getElementById('event-date'),
    start: document.getElementById('event-start'),
    end: document.getElementById('event-end'),
    endHint: document.getElementById('event-end-hint'),
    submit: document.getElementById('event-submit'),
    remove: document.getElementById('event-delete'),
  };

  document.getElementById('profile-name').textContent = profile.name;

  refs.colour = swatchPicker({
    colors: EVENT_COLOURS.map((c) => `var(${c.token})`),
    names: EVENT_COLOURS.map((c) => c.label),
    value: `var(${EVENT_COLOURS[0].token})`,
    label: 'Event colour',
  });
  document.getElementById('event-colour').append(refs.colour);

  wireControls();

  const asked = new URL(window.location.href).searchParams.get('date');
  const date = isISODate(asked) ? asked : todayISO();
  state.selected = date;
  state.weekStart = startOfWeek(date);
  await loadWeek();

  // The red line keeps time, and at midnight "today" moves on by itself.
  let lastToday = todayISO();
  setInterval(() => {
    if (todayISO() !== lastToday) {
      lastToday = todayISO();
      render();
    } else {
      placeNowLine();
    }
  }, 60 * 1000);
}

function wireControls() {
  refs.prevWeek.addEventListener('click', () => select(addDays(state.selected, -7)));
  refs.nextWeek.addEventListener('click', () => select(addDays(state.selected, 7)));
  refs.thisWeek.addEventListener('click', () => select(todayISO()));
  refs.dayAdd.addEventListener('click', () => openEventModal());

  // Arrow keys walk the days, across week boundaries.
  refs.days.addEventListener('keydown', (event) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!step) return;
    event.preventDefault();
    select(addDays(state.selected, step), { focusTile: true });
  });

  // A sideways swipe on the strip turns the week, as it would in a calendar app.
  let touch = null;
  refs.days.addEventListener('touchstart', (event) => {
    const t = event.touches[0];
    touch = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  refs.days.addEventListener('touchend', (event) => {
    if (!touch) return;
    const t = event.changedTouches[0];
    const dx = t.clientX - touch.x;
    const dy = t.clientY - touch.y;
    touch = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      select(addDays(state.selected, dx < 0 ? 7 : -7));
    }
  }, { passive: true });

  refs.form.addEventListener('submit', saveEvent);
  refs.start.addEventListener('change', () => {
    // Moving the start carries the end with it, keeping the length you had.
    const start = toMinutes(refs.start.value);
    const before = toMinutes(refs.start.dataset.previous);
    const end = toMinutes(refs.end.value);
    if (start !== null && end !== null) {
      const length = before !== null ? normaliseEnd(before, end) - before : 0;
      refs.end.value = toTimeValue(Math.min(start + (length > 0 ? length : 60), DAY_MINUTES));
    }
    refs.start.dataset.previous = refs.start.value;
    paintEndHint();
  });
  refs.end.addEventListener('input', paintEndHint);
  refs.remove.addEventListener('click', removeEvent);
  document.getElementById('event-cancel').addEventListener('click', () => refs.modal.close());
  document.getElementById('event-close').addEventListener('click', () => refs.modal.close());
}
