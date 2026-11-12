/**
 * Wellbeing: how the day actually felt.
 *
 * The rest of the app is about output — streaks, P&L, tasks closed. This one
 * isn't scored and doesn't rank anything. Logging is two taps: pick a feeling,
 * press save. Intensity and a note are there if you want them and invisible if
 * you don't.
 */

import { supabase, describeError } from './supabase.js?v=47';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=47';
import { requireActiveProfile } from './profiles.js?v=47';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy,
  todayISO, formatDate, applyProfileTheme, beat,
} from './ui.js?v=47';
import { FEELINGS, INTENSITY_LABELS, feeling } from './constants.js?v=47';
import { moodLineChart, destroyChart } from './charts.js?v=47';

const LAST_REFLECTION_KEY = 'streak.last_reflection';
/** Four bands, so a week reads as a shape rather than 168 cells. */
const BANDS = [
  { key: 'morning', label: 'Morning', from: 5, to: 12 },
  { key: 'afternoon', label: 'Afternoon', from: 12, to: 17 },
  { key: 'evening', label: 'Evening', from: 17, to: 22 },
  { key: 'night', label: 'Night', from: 22, to: 5 },
];

import { mountGreeting } from './greetings.js?v=47';

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

/**
 * A reference to the feeling's token, not its value. This used to read the
 * hex once, so everything kept the old theme's colours after a dark/light
 * switch; as `var(--series-2)` the browser re-resolves it on every switch.
 */
export const colorFor = (value) => `var(${feeling(value)?.token ?? '--neutral'})`;

export const toneOf = (value) => feeling(value)?.tone ?? null;

/** The last `range` calendar days, oldest first, ending today. */
export function periodDays(range, today = todayISO()) {
  return Array.from({ length: range }, (_, i) => {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() - (range - 1 - i));
    return localDate(d);
  });
}

/** Good against difficult, by count, as percentages that add up to 100. */
export function balanceOf(entries) {
  let good = 0;
  let difficult = 0;
  for (const entry of entries) {
    const tone = toneOf(entry.feeling);
    if (tone === 'good') good++;
    else if (tone === 'difficult') difficult++;
  }
  const total = good + difficult;
  const goodPct = total ? Math.round((good / total) * 100) : 0;
  return { good, difficult, total, goodPct, difficultPct: total ? 100 - goodPct : 0 };
}

/**
 * One row per day in `days`: the average intensity, and which way the day
 * leaned (whichever tone carried more intensity; a tie is 'even'). A day with
 * nothing logged is null, so it shows as a gap, never as a zero.
 */
export function dailyMood(entries, days) {
  const byDay = new Map(days.map((date) => [date, []]));
  for (const entry of entries) byDay.get(localDate(entry.logged_at))?.push(entry);

  return days.map((date) => {
    const rows = byDay.get(date);
    if (!rows.length) return { date, value: null, count: 0, tone: null };
    let sum = 0;
    let good = 0;
    let difficult = 0;
    for (const entry of rows) {
      const strength = entry.intensity ?? 3;
      sum += strength;
      const tone = toneOf(entry.feeling);
      if (tone === 'good') good += strength;
      else if (tone === 'difficult') difficult += strength;
    }
    const tone = good > difficult ? 'good' : difficult > good ? 'difficult' : 'even';
    return { date, value: Math.round((sum / rows.length) * 10) / 10, count: rows.length, tone };
  });
}

const LEANED = { good: 'leaned good', difficult: 'leaned difficult', even: 'evenly mixed' };
export const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

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
  renderTrends();
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

/* ---------------------------------------------------------------- trends -- */

/* Bumped on every render, so a chart waiting for its box to get a size can
   tell that a newer render (another period, a new entry) has replaced it. */
let trendsRender = 0;

/**
 * Balance, mood over time and what comes up most, all for the chosen period.
 * They share one data set, so they're empty together, and one empty state
 * speaks for all three rather than the same sentence three times.
 */
function renderTrends() {
  const render = ++trendsRender;
  const days = periodDays(state.range);
  const rows = state.entries.filter((e) => localDate(e.logged_at) >= days[0]);

  if (!rows.length) {
    destroyChart(refs.moodChart);
    refs.moodBox.querySelector('.skeleton')?.remove();
    refs.trends.hidden = true;
    refs.trendsSummary.textContent = '';
    clear(refs.trendsEmpty).append(emptyState({
      title: `Nothing logged in the last ${state.range} days.`,
      body: 'Log how you feel above.',
      actionLabel: 'Log how you feel',
      onAction: () => {
        const first = refs.grid.querySelector('.feeling');
        first?.scrollIntoView({ block: 'center' });
        first?.focus({ preventScroll: true });
      },
    }));
    refs.trendsEmpty.hidden = false;
    return;
  }

  const loggedDays = new Set(rows.map((e) => localDate(e.logged_at))).size;
  refs.trendsSummary.textContent =
    `${count(rows.length, 'entry', 'entries')} on ${count(loggedDays, 'day', 'days')} of the last ${state.range}`;
  refs.trendsEmpty.hidden = true;
  refs.trends.hidden = false;

  renderBalance(rows);
  renderFeelingBars(rows);
  renderMood(rows, days, render);
}

/** One split bar: the share of good feelings against difficult ones. */
function renderBalance(rows) {
  const b = balanceOf(rows);
  const side = (tone, label, pct, n) => el('span', { class: `balance__side balance__side--${tone}` }, [
    el('span', { class: `tone-dot tone-dot--${tone}`, 'aria-hidden': 'true' }),
    el('span', { text: label }),
    el('strong', { class: 'num', text: `${pct}%` }),
    el('span', { class: 'faint num', text: `(${n})` }),
  ]);

  clear(refs.balance).append(
    el('div', {
      class: 'balance__bar',
      role: 'img',
      'aria-label': `${b.goodPct}% good, ${b.difficultPct}% difficult, from ${count(b.total, 'entry', 'entries')}`,
    }, [
      // Grown by count, so the split is exact; each side keeps a sliver of
      // width so 1 in 100 is still visible.
      b.good ? el('span', { class: 'balance__part balance__part--good', style: `flex-grow: ${b.good}` }) : null,
      b.difficult ? el('span', { class: 'balance__part balance__part--difficult', style: `flex-grow: ${b.difficult}` }) : null,
    ]),
    el('div', { class: 'balance__legend', 'aria-hidden': 'true' }, [
      side('good', 'Good', b.goodPct, b.good),
      side('difficult', 'Difficult', b.difficultPct, b.difficult),
    ]),
  );
}

/**
 * Plain HTML bars rather than a chart: one row per feeling, so the block is as
 * tall as the list (about 36px a row). One feeling is one slim row, not a
 * giant bar, and ten don't get squashed. The longest bar is the most-felt
 * feeling; the others are drawn against it.
 */
function renderFeelingBars(rows) {
  const counts = tally(rows);
  const most = counts[0]?.[1] ?? 1;

  const list = el('ol', { class: 'feeling-bars', 'aria-label': 'Feelings, most often first' });
  counts.forEach(([value, n], index) => {
    const item = feeling(value);
    const pct = Math.round((n / rows.length) * 100);
    list.append(el('li', {
      class: 'feeling-bar',
      style: `--feeling: ${colorFor(value)}; --i: ${index}`,
    }, [
      el('span', { class: 'feeling-bar__label' }, [
        el('span', { class: 'feeling-bar__icon', 'aria-hidden': 'true', text: item?.icon ?? '' }),
        el('span', { class: 'feeling-bar__name', text: value }),
      ]),
      el('span', { class: 'feeling-bar__track', 'aria-hidden': 'true' },
        el('span', { class: 'feeling-bar__fill', style: `--share: ${(n / most).toFixed(4)}` })),
      el('span', { class: 'feeling-bar__value num' }, [
        el('span', { class: 'sr-only', text: `${count(n, 'time', 'times')}, ` }),
        el('span', { 'aria-hidden': 'true', text: String(n) }),
        el('span', { class: 'feeling-bar__pct', text: `${pct}%` }),
      ]),
    ]));
  });

  clear(refs.bars).append(list);
}

/**
 * Chart.js sizes itself from its box at the moment it's created. A box that
 * was hidden a moment ago, or not laid out yet, measures 0×0, and the chart
 * comes out blank or stale. So wait for a real size first.
 */
function whenSized(box) {
  return new Promise((resolve) => {
    const sized = () => box.clientWidth > 0 && box.clientHeight > 0;
    requestAnimationFrame(() => {
      if (sized()) return resolve();
      const watch = new ResizeObserver(() => {
        if (!sized()) return;
        watch.disconnect();
        resolve();
      });
      watch.observe(box);
    });
  });
}

async function renderMood(rows, days, render) {
  const daily = dailyMood(rows, days);
  const short = days.length <= 7;
  const labels = days.map((d) => formatDate(d, short ? { weekday: 'short' } : { day: 'numeric', month: 'short' }));
  const titles = days.map((d) => formatDate(d, { weekday: 'long', day: 'numeric', month: 'long' }));
  const points = daily.map((d) => ({
    value: d.value,
    tone: d.tone,
    lines: d.count
      ? [
          `Felt ${INTENSITY_LABELS[Math.round(d.value) - 1].toLowerCase()} on average (${d.value} of 5)`,
          `${count(d.count, 'entry', 'entries')}, ${LEANED[d.tone]}`,
        ]
      : [],
  }));

  const logged = daily.filter((d) => d.count);
  const leaned = (tone) => logged.filter((d) => d.tone === tone).length;
  refs.moodChart.setAttribute('aria-label',
    `Mood over the last ${days.length} days: ${count(logged.length, 'day', 'days')} logged, `
    + `${leaned('good')} leaned good, ${leaned('difficult')} leaned difficult.`);

  await whenSized(refs.moodBox);
  if (render !== trendsRender) return;
  refs.moodBox.querySelector('.skeleton')?.remove();
  moodLineChart(refs.moodChart, { labels, titles, points });
}

/** Stand-ins while the entries load, the same shape as what replaces them. */
function renderTrendsLoading() {
  refs.trendsEmpty.hidden = true;
  refs.trends.hidden = false;
  clear(refs.balance).append(el('div', { class: 'skeleton skeleton--balance', 'aria-hidden': 'true' }));
  refs.moodBox.append(el('div', { class: 'skeleton skeleton--fill', 'aria-hidden': 'true' }));
  clear(refs.bars).append(skeletonList(4, 'skeleton--bar-row'));
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
    range: document.getElementById('chart-range'),
    trends: document.getElementById('trends'),
    trendsEmpty: document.getElementById('trends-empty'),
    trendsSummary: document.getElementById('trends-summary'),
    balance: document.getElementById('balance'),
    moodBox: document.getElementById('mood-box'),
    moodChart: document.getElementById('mood-chart'),
    bars: document.getElementById('feeling-bars'),
  };

  document.getElementById('profile-name').textContent = profile.name;
  renderFeelingGrid();
  renderDetail();

  refs.timeline.append(skeletonList(2, 'skeleton--text'));
  refs.week.append(el('div', { class: 'skeleton skeleton--week', 'aria-hidden': 'true' }));
  renderTrendsLoading();

  try {
    state.entries = await fetchEntries();
  } catch (error) {
    const failed = () => emptyState({
      title: 'Couldn’t load your entries',
      body: error.message,
      actionLabel: 'Try again',
      onAction: () => window.location.reload(),
    });
    clear(refs.timeline).append(failed());
    clear(refs.week);
    refs.moodBox.querySelector('.skeleton')?.remove();
    refs.trends.hidden = true;
    clear(refs.trendsEmpty).append(failed());
    refs.trendsEmpty.hidden = false;
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
    renderTrends();
  });
}
