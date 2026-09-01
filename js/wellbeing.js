/**
 * Wellbeing: how the day actually felt.
 *
 * The rest of the app is about output — streaks, P&L, tasks closed. This one
 * isn't scored and doesn't rank anything. Logging is two taps: pick a feeling,
 * press save. Intensity and a note are there if you want them and invisible if
 * you don't.
 */

import { supabase, describeError } from './supabase.js?v=29';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=29';
import { requireActiveProfile } from './profiles.js?v=29';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy,
  todayISO, formatDate, applyProfileTheme, beat,
} from './ui.js?v=29';
import { FEELINGS, INTENSITY_LABELS, feeling } from './constants.js?v=29';
import { countBarChart } from './charts.js?v=29';

const LAST_REFLECTION_KEY = 'streak.last_reflection';
/** Four bands, so a week reads as a shape rather than 168 cells. */
const BANDS = [
  { key: 'morning', label: 'Morning', from: 5, to: 12 },
  { key: 'afternoon', label: 'Afternoon', from: 12, to: 17 },
  { key: 'evening', label: 'Evening', from: 17, to: 22 },
  { key: 'night', label: 'Night', from: 22, to: 5 },
];

import { mountGreeting } from './greetings.js?v=29';

const state = {
  profile: null,
  entries: [],
  selected: null,
  intensity: 3,
  range: 30,
};

let refs = {};

/* ----------------------------------------------------------------- logic -- */

export function bandFor(hour) {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'afternoon';
  if (hour >= 17 && hour < 22) return 'evening';
  return 'night';
}

export function localDate(timestamp) {
  const d = new Date(timestamp);
  const offset = d.getTimezoneOffset() * 60000;
  return new Date(d - offset).toISOString().slice(0, 10);
}

/** Most-felt first. Ties keep the grid's own order, so it never jitters. */
export function tally(entries) {
  const counts = new Map(FEELINGS.map((f) => [f.value, 0]));
  for (const entry of entries) {
    if (counts.has(entry.feeling)) counts.set(entry.feeling, counts.get(entry.feeling) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
}

/**
 * Never the same line twice in a row. With one reflection on file it repeats,
 * which is better than showing nothing.
 */
export function chooseReflection(rows, lastId) {
  if (!rows.length) return null;
  const fresh = rows.filter((r) => r.id !== lastId);
  const pool = fresh.length ? fresh : rows;
  return pool[Math.floor(Math.random() * pool.length)];
}

const token = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const colorFor = (value) => token(feeling(value)?.token ?? '--neutral');

/* ------------------------------------------------------------------ data -- */

async function fetchEntries() {
  const since = new Date(Date.now() - 120 * 86400000).toISOString();
  const { data, error } = await supabase
    .from('mood_entries')
    .select('id, feeling, intensity, note, logged_at')
    .eq('profile_id', state.profile.id)
    .gte('logged_at', since)
    .order('logged_at', { ascending: false });
  if (error) throw new Error(describeError(error, 'Couldn’t load your entries.'));
  return data ?? [];
}

async function fetchReflections(value) {
  const { data, error } = await supabase
    .from('reflections')
    .select('id, body, author')
    .eq('feeling', value);
  if (error) throw new Error(describeError(error, 'Couldn’t load a reflection.'));
  return data ?? [];
}

/* ---------------------------------------------------------------- logging -- */

function renderFeelingGrid() {
  clear(refs.grid);
  for (const item of FEELINGS) {
    const chosen = state.selected === item.value;
    refs.grid.append(el('button', {
      class: 'feeling',
      type: 'button',
      dataset: { tone: item.tone },
      style: `--feeling: ${colorFor(item.value)}`,
      'aria-pressed': String(chosen),
      onclick: () => {
        state.selected = chosen ? null : item.value;
        renderFeelingGrid();
        renderDetail();
      },
    }, [
      el('span', { class: 'feeling__icon', 'aria-hidden': 'true', text: item.icon }),
      el('span', { class: 'feeling__name', text: item.value }),
    ]));
  }
}

/** Intensity and note only appear once something is chosen. */
function renderDetail() {
  refs.detail.hidden = !state.selected;
  if (!state.selected) return;
  refs.intensityLabel.textContent = INTENSITY_LABELS[state.intensity - 1];
  refs.intensity.value = String(state.intensity);
  refs.saveLabel.textContent = `Log ${state.selected.toLowerCase()}`;
}

async function saveEntry() {
  if (!state.selected) return;

  setBusy(refs.save, true, 'Saving…');
  try {
    const { data, error } = await supabase
      .from('mood_entries')
      .insert({
        profile_id: state.profile.id,
        feeling: state.selected,
        intensity: state.intensity,
        note: refs.note.value.trim() || null,
      })
      .select('id, feeling, intensity, note, logged_at')
      .single();

    if (error) throw new Error(describeError(error, 'Couldn’t save that entry.'));

    state.entries.unshift(data);
    await showReflection(state.selected);

    // Reset gently — the feeling stays lit for a moment before clearing.
    refs.note.value = '';
    await beat(200);
    state.selected = null;
    state.intensity = 3;
    renderFeelingGrid();
    renderDetail();
    renderHistory();
  } catch (error) {
    toast(error.message, { type: 'error' });
  } finally {
    setBusy(refs.save, false);
  }
}

/* ------------------------------------------------------------- reflection -- */

async function showReflection(value) {
  try {
    const rows = await fetchReflections(value);
    const lastId = localStorage.getItem(`${LAST_REFLECTION_KEY}.${value}`);
    const pick = chooseReflection(rows, lastId);

    clear(refs.reflection);
    if (!pick) {
      refs.reflection.hidden = true;
      return;
    }

    localStorage.setItem(`${LAST_REFLECTION_KEY}.${value}`, pick.id);
    refs.reflection.hidden = false;
    refs.reflection.style.setProperty('--feeling', colorFor(value));

    // Filtered before it reaches append(): the DOM's own append() stringifies a
    // null argument into the literal text "null" — unlike el(), which drops
    // null children. An original line has no author, and so gets no author row.
    const author = (pick.author ?? '').trim();
    refs.reflection.append(...[
      el('p', { class: 'reflection__body', text: pick.body }),
      author ? el('p', { class: 'reflection__author', text: `— ${author}` }) : null,
    ].filter(Boolean));
    // Re-trigger the fade each time, even for the same element.
    refs.reflection.classList.remove('is-in');
    void refs.reflection.offsetWidth;
    refs.reflection.classList.add('is-in');
  } catch (error) {
    // A missing reflection must never cost you the entry you just logged.
    toast(error.message, { type: 'error' });
  }
}

/* ---------------------------------------------------------------- history -- */

function renderHistory() {
  renderTimeline();
  renderWeek();
  renderChart();
}

function renderTimeline() {
  const today = todayISO();
  const rows = state.entries.filter((e) => localDate(e.logged_at) === today);

  clear(refs.timeline);
  if (!rows.length) {
    refs.timeline.append(emptyState({
      title: 'Nothing logged today',
      body: 'Whenever you notice how you feel, put it here. Two taps.',
    }));
    return;
  }

  const list = el('div', { class: 'timeline' });
  for (const entry of rows) {
    const item = feeling(entry.feeling);
    list.append(el('div', { class: 'timeline__row', style: `--feeling: ${colorFor(entry.feeling)}` }, [
      el('span', {
        class: 'timeline__time num',
        text: new Date(entry.logged_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      }),
      el('span', { class: 'timeline__dot', 'aria-hidden': 'true' }),
      el('div', { class: 'timeline__body' }, [
        el('span', { class: 'timeline__feeling' }, [
          el('span', { 'aria-hidden': 'true', text: `${item?.icon ?? ''} ` }),
          el('span', { text: entry.feeling }),
          el('span', {
            class: 'timeline__intensity',
            title: INTENSITY_LABELS[(entry.intensity ?? 3) - 1],
            text: '•'.repeat(entry.intensity ?? 0),
          }),
        ]),
        entry.note ? el('p', { class: 'timeline__note', text: entry.note }) : null,
      ]),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        text: 'Remove',
        'aria-label': `Remove ${entry.feeling} entry`,
        onclick: () => removeEntry(entry),
      }),
    ]));
  }
  refs.timeline.append(list);
}

/** Seven days across, four parts of the day down. */
function renderWeek() {
  const today = todayISO();
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() - (6 - i));
    return localDate(d);
  });

  const cells = new Map();
  for (const entry of state.entries) {
    const date = localDate(entry.logged_at);
    if (!days.includes(date)) continue;
    const key = `${date}:${bandFor(new Date(entry.logged_at).getHours())}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(entry);
  }

  clear(refs.week);
  const grid = el('div', { class: 'week-grid' });

  grid.append(el('span', {}));
  for (const date of days) {
    grid.append(el('span', {
      class: 'week-grid__day',
      text: formatDate(date, { weekday: 'short' }),
      title: formatDate(date),
    }));
  }

  for (const band of BANDS) {
    grid.append(el('span', { class: 'week-grid__band', text: band.label }));
    for (const date of days) {
      const found = cells.get(`${date}:${band.key}`) ?? [];
      // The strongest entry in the band speaks for it; the rest are in the title.
      const lead = [...found].sort((a, b) => (b.intensity ?? 0) - (a.intensity ?? 0))[0];
      grid.append(el('span', {
        class: 'week-grid__cell',
        dataset: { filled: String(Boolean(lead)) },
        style: lead
          ? `--feeling: ${colorFor(lead.feeling)}; --strength: ${0.25 + 0.15 * (lead.intensity ?? 3)}`
          : null,
        title: found.length
          ? `${formatDate(date, { weekday: 'long' })} ${band.label.toLowerCase()}: ${found.map((f) => f.feeling).join(', ')}`
          : `${formatDate(date, { weekday: 'long' })} ${band.label.toLowerCase()} — nothing logged`,
      }));
    }
  }

  refs.week.append(grid);
}

function renderChart() {
  const cutoff = new Date(Date.now() - state.range * 86400000).toISOString();
  const rows = state.entries.filter((e) => e.logged_at >= cutoff);
  const counts = tally(rows);

  if (!counts.length) {
    refs.chart.hidden = true;
    refs.chartEmpty.hidden = false;
    refs.chartEmpty.textContent = 'Nothing logged in this period yet.';
    return;
  }

  refs.chart.hidden = false;
  refs.chartEmpty.hidden = true;
  countBarChart(refs.chart, {
    labels: counts.map(([value]) => value),
    values: counts.map(([, n]) => n),
    colors: counts.map(([value]) => colorFor(value)),
    unit: 'entry',
  });
}

async function removeEntry(entry) {
  try {
    const { error } = await supabase.from('mood_entries').delete().eq('id', entry.id);
    if (error) throw new Error(describeError(error, 'Couldn’t remove that entry.'));
    state.entries = state.entries.filter((e) => e.id !== entry.id);
    toast('Entry removed.', { type: 'success', duration: 2000 });
    renderHistory();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

/* ----------------------------------------------------------------- setup -- */

export async function initWellbeingPage() {
  await requireSession();
  const profile = await requireActiveProfile();
  state.profile = profile;
  applyProfileTheme(profile.id);
  mountGreeting(profile);

  document.body.prepend(topbar({
    profile,
    current: 'wellbeing.html',
    onSwitchProfile: () => goTo(PICKER_PAGE),
    onSignOut: signOut,
  }));

  refs = {
    grid: document.getElementById('feeling-grid'),
    detail: document.getElementById('log-detail'),
    intensity: document.getElementById('intensity'),
    intensityLabel: document.getElementById('intensity-label'),
    note: document.getElementById('note'),
    save: document.getElementById('save-entry'),
    saveLabel: document.getElementById('save-label'),
    reflection: document.getElementById('reflection'),
    timeline: document.getElementById('timeline'),
    week: document.getElementById('week-view'),
    chart: document.getElementById('feeling-chart'),
    chartEmpty: document.getElementById('feeling-chart-empty'),
    range: document.getElementById('chart-range'),
  };

  document.getElementById('profile-name').textContent = profile.name;
  renderFeelingGrid();
  renderDetail();

  refs.timeline.append(skeletonList(2, 'skeleton--text'));

  try {
    state.entries = await fetchEntries();
  } catch (error) {
    clear(refs.timeline).append(emptyState({
      title: 'Couldn’t load your entries',
      body: error.message,
      actionLabel: 'Try again',
      onAction: () => window.location.reload(),
    }));
    return;
  }

  renderHistory();

  refs.intensity.addEventListener('input', () => {
    state.intensity = Number(refs.intensity.value);
    refs.intensityLabel.textContent = INTENSITY_LABELS[state.intensity - 1];
  });
  refs.save.addEventListener('click', saveEntry);
  refs.range.addEventListener('change', () => {
    state.range = Number(refs.range.value);
    renderChart();
  });
}
