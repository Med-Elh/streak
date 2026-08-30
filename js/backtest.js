/**
 * Backtesting: a sandbox that never touches the journal.
 *
 * Its own tables, its own trades, its own stats. Nothing here is written back
 * to `trades`, and the Compare view reads the journal without ever writing to
 * it — a backtest is a rehearsal, and a rehearsal that can edit the performance
 * is worthless.
 *
 * Logging is one tap. Win, Loss, Breakeven each log a trade at the session's
 * default R; tags, an R override and a note are all optional and all out of the
 * way until wanted.
 */

import { supabase, describeError } from './supabase.js?v=14';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=14';
import { requireActiveProfile } from './profiles.js?v=14';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy, showBanner,
  countUp, formatDate, todayISO, applyProfileTheme, prefersReducedMotion,
} from './ui.js?v=14';
import { mountGreeting } from './greetings.js?v=14';
import { SESSIONS, SETUPS, INSTRUMENTS, loadOptions } from './constants.js?v=14';
import {
  rEquityChart, rateBarsChart, outcomeDonut, rollingRateChart, compareBarsChart,
} from './charts.js?v=14';

export const BACKTEST_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'archived', label: 'Archived' },
];

export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', 'Daily', 'Weekly'];

/** Charts animate the first time a canvas is drawn, never on a re-render. */
const drawn = new WeakSet();

const state = {
  profile: null,
  sessions: [],
  sessionId: null,
  trades: [],
  counts: new Map(),
  tags: { session: null, setup: null },
  lists: { session: SESSIONS, setup: SETUPS, instrument: INSTRUMENTS },
  view: 'list',
  liveStats: null,
};

let refs = {};

/* ----------------------------------------------------------------- stats -- */
/* Pure and exported. R is stored as a magnitude; the outcome supplies the sign,
   so a loss of 2R is `outcome: 'loss', r: 2` rather than a negative number that
   could be typed either way. */

export function signedR(trade, session) {
  const raw = trade?.r ?? session?.default_r ?? 0;
  const magnitude = Math.abs(Number(raw));
  if (!Number.isFinite(magnitude)) return 0;
  if (trade?.outcome === 'win') return magnitude;
  if (trade?.outcome === 'loss') return -magnitude;
  return 0;
}

export function sessionStats(trades, session) {
  const wins = trades.filter((t) => t.outcome === 'win').length;
  const losses = trades.filter((t) => t.outcome === 'loss').length;
  const breakevens = trades.filter((t) => t.outcome === 'breakeven').length;
  const decided = wins + losses;
  const totalR = trades.reduce((sum, t) => sum + signedR(t, session), 0);

  return {
    count: trades.length,
    wins,
    losses,
    breakevens,
    decided,
    // Breakevens are excluded, as everywhere else in the app.
    winRate: decided ? (wins / decided) * 100 : null,
    totalR,
    expectancy: trades.length ? totalR / trades.length : null,
    streak: currentRun(trades),
  };
}

/** The run of same-outcome trades at the end. Breakevens are skipped, not fatal. */
export function currentRun(trades) {
  const decided = trades.filter((t) => t.outcome === 'win' || t.outcome === 'loss');
  if (!decided.length) return { kind: null, length: 0 };
  const kind = decided[decided.length - 1].outcome;
  let length = 0;
  for (let i = decided.length - 1; i >= 0; i -= 1) {
    if (decided[i].outcome !== kind) break;
    length += 1;
  }
  return { kind, length };
}

/** Cumulative R, opening at zero so a losing first trade doesn't start below. */
export function equitySeries(trades, session) {
  let running = 0;
  const values = [0];
  for (const trade of trades) {
    running += signedR(trade, session);
    values.push(Number(running.toFixed(3)));
  }
  return values;
}

/**
 * Win rate over a trailing window, one point per trade once the window is full.
 * Watching it settle is the point, so it only starts when there's enough sample
 * to mean anything.
 */
export function rollingWinRate(trades, window = 20) {
  const decided = trades.filter((t) => t.outcome === 'win' || t.outcome === 'loss');
  if (decided.length < window) return [];
  const points = [];
  for (let end = window; end <= decided.length; end += 1) {
    const slice = decided.slice(end - window, end);
    const wins = slice.filter((t) => t.outcome === 'win').length;
    points.push({ index: end, rate: (wins / window) * 100 });
  }
  return points;
}

/** Win rate per tag, best first, each carrying its sample size. */
export function rateByTag(trades, field) {
  const map = new Map();
  for (const trade of trades) {
    const tag = trade[field];
    if (!tag || trade.outcome === 'breakeven') continue;
    const entry = map.get(tag) ?? { tag, wins: 0, count: 0 };
    if (trade.outcome === 'win') entry.wins += 1;
    entry.count += 1;
    map.set(tag, entry);
  }
  return [...map.values()]
    .map((e) => ({ tag: e.tag, rate: (e.wins / e.count) * 100, count: e.count }))
    .sort((a, b) => b.rate - a.rate || b.count - a.count);
}

/** The tag with the best rate, ignoring samples too small to mean anything. */
export function bestSetup(trades, minimum = 3) {
  const ranked = rateByTag(trades, 'setup_tag').filter((r) => r.count >= minimum);
  return ranked[0] ?? null;
}

/* ------------------------------------------------------------------ data -- */

const SESSION_COLUMNS = `id, profile_id, name, instrument, timeframe, default_r,
  period_start, period_end, notes, status, created_at`;
const TRADE_COLUMNS = 'id, session_id, outcome, r, session_tag, setup_tag, note, created_at';

async function fetchSessions() {
  const { data, error } = await supabase
    .from('backtest_sessions')
    .select(SESSION_COLUMNS)
    .eq('profile_id', state.profile.id)
    .order('created_at', { ascending: false });
  if (error) throw new Error(describeError(error, 'Couldn’t load your sessions.'));
  return data ?? [];
}

async function fetchTrades(sessionId) {
  const { data, error } = await supabase
    .from('backtest_trades')
    .select(TRADE_COLUMNS)
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load the trades.'));
  return data ?? [];
}

async function fetchAllTrades(ids) {
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('backtest_trades')
    .select('id, session_id, outcome, r, setup_tag')
    .in('session_id', ids);
  if (error) throw new Error(describeError(error, 'Couldn’t load trade counts.'));
  return data ?? [];
}

/** Read-only. The journal is never written to from this section. */
async function fetchLiveStats() {
  const { data, error } = await supabase
    .from('trades')
    .select('outcome, rr, pnl, profile_id')
    .eq('profile_id', state.profile.id);
  if (error) throw new Error(describeError(error, 'Couldn’t load your journal stats.'));

  const rows = data ?? [];
  const wins = rows.filter((t) => t.outcome === 'win').length;
  const losses = rows.filter((t) => t.outcome === 'loss').length;
  const decided = wins + losses;
  const rrs = rows.map((t) => Number(t.rr)).filter(Number.isFinite);

  return {
    count: rows.length,
    winRate: decided ? (wins / decided) * 100 : null,
    avgRR: rrs.length ? rrs.reduce((a, b) => a + b, 0) / rrs.length : null,
  };
}

/* ------------------------------------------------------------------ views -- */

function show(view) {
  state.view = view;
  refs.viewList.hidden = view !== 'list';
  refs.viewSession.hidden = view !== 'session';
  refs.viewCompare.hidden = view !== 'compare';
}

function currentSession() {
  return state.sessions.find((s) => s.id === state.sessionId) ?? null;
}

/* ------------------------------------------------------------ sessions list */

function renderSessions() {
  show('list');
  window.location.hash = '';
  clear(refs.sessionList);

  if (!state.sessions.length) {
    refs.sessionList.append(emptyState({
      title: 'No sessions yet',
      body: 'A session is one instrument on one timeframe over one stretch of history. Start one and tap through it.',
      actionLabel: 'New session',
      onAction: openSessionModal,
    }));
    return;
  }

  const grid = el('div', { class: 'plan-grid' });
  for (const session of state.sessions) {
    const counts = state.counts.get(session.id) ?? { count: 0, winRate: null };
    grid.append(el('button', {
      class: 'bt-card',
      type: 'button',
      onclick: () => openSession(session.id),
    }, [
      el('div', { class: 'bt-card__head' }, [
        el('span', { class: 'bt-card__name', text: session.name }),
        el('span', {
          class: `pill pill--${session.status}`,
          text: BACKTEST_STATUSES.find((s) => s.value === session.status)?.label ?? session.status,
        }),
      ]),
      el('span', {
        class: 'bt-card__meta',
        text: `${session.instrument ?? '—'} · ${session.timeframe ?? '—'} · ${session.default_r}R default`,
      }),
      el('div', { class: 'bt-card__stats' }, [
        statBlock('Trades', String(counts.count)),
        statBlock('Win rate', counts.winRate === null ? '—' : `${Math.round(counts.winRate)}%`),
      ]),
    ]));
  }
  refs.sessionList.append(grid);
}

function statBlock(label, value) {
  return el('div', { class: 'bt-stat' }, [
    el('span', { class: 'bt-stat__label', text: label }),
    el('span', { class: 'bt-stat__value num', text: value }),
  ]);
}

/* --------------------------------------------------------------- one session */

async function openSession(id) {
  state.sessionId = id;
  window.location.hash = `session-${id}`;
  show('session');
  clear(refs.tradeList).append(skeletonList(3, 'skeleton--text'));

  try {
    state.trades = await fetchTrades(id);
  } catch (error) {
    clear(refs.tradeList).append(emptyState({ title: 'Couldn’t load this session', body: error.message }));
    return;
  }
  renderSession({ animate: true });
}

function renderSession({ animate = false } = {}) {
  const session = currentSession();
  if (!session) return renderSessions();

  refs.sessionName.textContent = session.name;
  refs.sessionMeta.textContent =
    `${session.instrument ?? '—'} · ${session.timeframe ?? '—'} · ${session.default_r}R default`
    + (session.period_start ? ` · ${formatDate(session.period_start)} → ${formatDate(session.period_end ?? session.period_start)}` : '');

  renderLiveBar();
  renderTagChips();
  renderTrades();
  renderCharts(animate);
}

/** The four numbers that matter while tapping, pinned above the buttons. */
function renderLiveBar() {
  const stats = sessionStats(state.trades, currentSession());
  clear(refs.liveBar);

  const tile = (label, value, format) => {
    const node = el('span', { class: 'bt-live__value num', text: '—' });
    const wrap = el('div', { class: 'bt-live__tile' }, [
      el('span', { class: 'bt-live__label', text: label }),
      node,
    ]);
    countUp(node, value, { format });
    return wrap;
  };

  refs.liveBar.append(
    tile('Trades', stats.count, (v) => String(Math.round(v))),
    tile('Win rate', stats.winRate ?? 0, (v) => (stats.winRate === null ? '—' : `${v.toFixed(0)}%`)),
    tile('Expectancy', stats.expectancy ?? 0, (v) => (stats.expectancy === null ? '—' : `${v.toFixed(2)}R`)),
    tile('Streak', stats.streak.length, (v) => (stats.streak.length
      ? `${Math.round(v)}${stats.streak.kind === 'win' ? 'W' : 'L'}`
      : '—')),
  );
}

function renderTagChips() {
  const build = (mount, list, key) => {
    clear(mount);
    for (const value of list) {
      const active = state.tags[key] === value;
      mount.append(el('button', {
        class: 'tag-chip',
        type: 'button',
        text: value,
        'aria-pressed': String(active),
        onclick: () => {
          state.tags[key] = active ? null : value;
          renderTagChips();
        },
      }));
    }
  };
  build(refs.sessionTags, state.lists.session, 'session');
  build(refs.setupTags, state.lists.setup, 'setup');
}

/* ---------------------------------------------------------------- logging -- */

/**
 * One tap. The trade appears immediately and the write follows; a failure takes
 * it back out and says so. Nothing else is required to log — tags, an R
 * override and a note are all optional.
 */
async function logTrade(outcome) {
  const session = currentSession();
  if (!session) return;

  const override = refs.rOverride.value.trim();
  const note = refs.noteInput.value.trim();

  const optimistic = {
    id: `pending-${Date.now()}`,
    session_id: session.id,
    outcome,
    r: override === '' ? null : Math.abs(Number(override)),
    session_tag: state.tags.session,
    setup_tag: state.tags.setup,
    note: note || null,
    created_at: new Date().toISOString(),
  };

  state.trades.push(optimistic);
  refs.rOverride.value = '';
  refs.noteInput.value = '';
  renderSession();

  try {
    const { id, ...payload } = optimistic;
    const { data, error } = await supabase
      .from('backtest_trades')
      .insert(payload)
      .select(TRADE_COLUMNS)
      .single();
    if (error) throw new Error(describeError(error, 'Couldn’t log that trade.'));

    const index = state.trades.findIndex((t) => t.id === optimistic.id);
    if (index !== -1) state.trades[index] = data;
    refs.undo.disabled = false;
  } catch (error) {
    state.trades = state.trades.filter((t) => t.id !== optimistic.id);
    renderSession();
    toast(error.message, { type: 'error' });
  }
}

async function undoLast() {
  const last = state.trades[state.trades.length - 1];
  if (!last) return;

  const removed = state.trades.pop();
  renderSession();

  try {
    const { error } = await supabase.from('backtest_trades').delete().eq('id', removed.id);
    if (error) throw new Error(describeError(error, 'Couldn’t undo that trade.'));
    toast('Last trade removed.', { type: 'success', duration: 1800 });
    refs.undo.disabled = state.trades.length === 0;
  } catch (error) {
    state.trades.push(removed);
    renderSession();
    toast(error.message, { type: 'error' });
  }
}

/* ------------------------------------------------------------ trade list -- */

function renderTrades() {
  const session = currentSession();
  clear(refs.tradeList);

  if (!state.trades.length) {
    refs.tradeList.append(emptyState({
      title: 'No trades in this session',
      body: 'Tap Win, Loss or Breakeven above. One tap is a whole trade.',
    }));
    return;
  }

  const table = el('table', { class: 'table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: '#' }),
      el('th', { text: 'Outcome' }),
      el('th', { class: 'align-right', text: 'R' }),
      el('th', { text: 'Session' }),
      el('th', { text: 'Setup' }),
      el('th', { text: 'Note' }),
      el('th', { class: 'align-right', text: 'Actions' }),
    ])),
  ]);

  const body = el('tbody');
  [...state.trades].reverse().forEach((trade, offset) => {
    const number = state.trades.length - offset;
    const r = signedR(trade, session);

    body.append(el('tr', {}, [
      el('td', { class: 'num num--muted', text: String(number) }),
      el('td', {}, el('span', { class: `chip chip--${trade.outcome}`, text: trade.outcome })),
      el('td', {
        class: `align-right num ${r > 0 ? 'num--positive' : r < 0 ? 'num--negative' : 'num--muted'}`,
        text: `${r > 0 ? '+' : ''}${r.toFixed(2)}R`,
      }),
      el('td', { text: trade.session_tag ?? '—' }),
      el('td', { text: trade.setup_tag ?? '—' }),
      el('td', { class: 'truncate', text: trade.note ?? '—' }),
      el('td', { class: 'align-right' }, el('div', { class: 'row row-end' }, [
        el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          text: 'Edit',
          onclick: () => editTrade(trade),
        }),
        el('button', {
          class: 'btn btn--danger btn--sm',
          type: 'button',
          text: 'Delete',
          onclick: () => removeTrade(trade),
        }),
      ])),
    ]));
  });

  table.append(body);
  refs.tradeList.append(el('div', { class: 'table-wrap' }, table));
}

function editTrade(trade) {
  const outcome = window.prompt('Outcome — win, loss or breakeven', trade.outcome);
  if (!outcome) return;
  if (!['win', 'loss', 'breakeven'].includes(outcome)) {
    toast('Outcome has to be win, loss or breakeven.', { type: 'error' });
    return;
  }
  const rInput = window.prompt('R for this trade (blank uses the session default)', trade.r ?? '');
  const r = rInput === null ? trade.r : (rInput.trim() === '' ? null : Math.abs(Number(rInput)));
  if (r !== null && !Number.isFinite(r)) {
    toast('R has to be a number.', { type: 'error' });
    return;
  }
  saveTrade(trade, { outcome, r });
}

async function saveTrade(trade, patch) {
  const previous = { outcome: trade.outcome, r: trade.r };
  Object.assign(trade, patch);
  renderSession();

  try {
    const { error } = await supabase.from('backtest_trades').update(patch).eq('id', trade.id);
    if (error) throw new Error(describeError(error, 'Couldn’t save that trade.'));
  } catch (error) {
    Object.assign(trade, previous);
    renderSession();
    toast(error.message, { type: 'error' });
  }
}

async function removeTrade(trade) {
  const index = state.trades.findIndex((t) => t.id === trade.id);
  state.trades.splice(index, 1);
  renderSession();

  try {
    const { error } = await supabase.from('backtest_trades').delete().eq('id', trade.id);
    if (error) throw new Error(describeError(error, 'Couldn’t delete that trade.'));
  } catch (error) {
    state.trades.splice(index, 0, trade);
    renderSession();
    toast(error.message, { type: 'error' });
  }
}

/* ----------------------------------------------------------------- charts -- */

function renderCharts(animate) {
  const session = currentSession();
  const trades = state.trades;
  const stats = sessionStats(trades, session);

  const first = animate && !drawn.has(refs.equity);
  if (first) drawn.add(refs.equity);

  // Equity in R
  if (!trades.length) {
    toggle(refs.equity, refs.equityEmpty, 'Tap a trade and the curve starts.');
  } else {
    toggle(refs.equity, refs.equityEmpty, null);
    rEquityChart(refs.equity, {
      labels: ['Start', ...trades.map((_, i) => String(i + 1))],
      values: equitySeries(trades, session),
      animate: first,
    });
    refs.equityTotal.textContent = `${stats.totalR >= 0 ? '+' : ''}${stats.totalR.toFixed(2)}R`;
    refs.equityTotal.className = `panel__total${stats.totalR < 0 ? ' is-negative' : ''}`;
  }

  bars(refs.setupChart, refs.setupEmpty, rateByTag(trades, 'setup_tag'), 1, first, 'setup');
  bars(refs.sessionChart, refs.sessionEmpty, rateByTag(trades, 'session_tag'), 2, first, 'session');

  // Outcome split
  if (!trades.length) {
    toggle(refs.donut, refs.donutEmpty, 'Nothing to split yet.');
  } else {
    toggle(refs.donut, refs.donutEmpty, null);
    outcomeDonut(refs.donut, {
      wins: stats.wins,
      losses: stats.losses,
      breakevens: stats.breakevens,
      animate: first,
    });
  }

  // Rolling win rate
  const rolling = rollingWinRate(trades);
  if (!rolling.length) {
    toggle(refs.rolling, refs.rollingEmpty,
      'Twenty decided trades and this starts showing how the rate settles.');
  } else {
    toggle(refs.rolling, refs.rollingEmpty, null);
    rollingRateChart(refs.rolling, {
      labels: rolling.map((p) => String(p.index)),
      values: rolling.map((p) => Number(p.rate.toFixed(1))),
      animate: first,
    });
  }
}

function bars(canvas, empty, ranked, slot, animate, label) {
  if (!ranked.length) {
    toggle(canvas, empty, `No decided trades tagged with a ${label} yet.`);
    return;
  }
  toggle(canvas, empty, null);
  rateBarsChart(canvas, {
    labels: ranked.map((r) => r.tag),
    values: ranked.map((r) => Math.round(r.rate)),
    counts: ranked.map((r) => r.count),
    slot,
    animate,
  });
}

function toggle(canvas, empty, message) {
  canvas.hidden = Boolean(message);
  empty.hidden = !message;
  if (message) empty.textContent = message;
}

/* ---------------------------------------------------------------- compare -- */

async function openCompare() {
  show('compare');
  window.location.hash = 'compare';
  clear(refs.compareTable).append(skeletonList(2, 'skeleton--text'));

  try {
    const rows = await fetchAllTrades(state.sessions.map((s) => s.id));
    state.compare = state.sessions.map((session) => {
      const mine = rows.filter((r) => r.session_id === session.id);
      const stats = sessionStats(mine, session);
      return { session, stats, best: bestSetup(mine) };
    });
    if (!state.liveStats) state.liveStats = await fetchLiveStats();
  } catch (error) {
    clear(refs.compareTable).append(emptyState({ title: 'Couldn’t compare', body: error.message }));
    return;
  }
  renderCompare();
}

function renderCompare() {
  const rows = state.compare ?? [];
  clear(refs.compareTable);

  if (!rows.length) {
    refs.compareTable.append(emptyState({
      title: 'Nothing to compare yet',
      body: 'Run a session or two and they line up here.',
    }));
    refs.compareChart.hidden = true;
    return;
  }

  refs.compareChart.hidden = false;
  compareBarsChart(refs.compareChart, {
    labels: rows.map((r) => r.session.name),
    winRates: rows.map((r) => Math.round(r.stats.winRate ?? 0)),
    expectancies: rows.map((r) => Number((r.stats.expectancy ?? 0).toFixed(2))),
    animate: !drawn.has(refs.compareChart),
  });
  drawn.add(refs.compareChart);

  const table = el('table', { class: 'table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Session' }),
      el('th', { class: 'align-right', text: 'Trades' }),
      el('th', { class: 'align-right', text: 'Win rate' }),
      el('th', { class: 'align-right', text: 'Expectancy' }),
      el('th', { text: 'Best setup' }),
    ])),
  ]);

  const body = el('tbody');
  for (const { session, stats, best } of rows) {
    body.append(el('tr', {}, [
      el('td', { text: session.name }),
      el('td', { class: 'align-right num', text: String(stats.count) }),
      el('td', { class: 'align-right num', text: stats.winRate === null ? '—' : `${Math.round(stats.winRate)}%` }),
      el('td', {
        class: `align-right num ${(stats.expectancy ?? 0) >= 0 ? 'num--positive' : 'num--negative'}`,
        text: stats.expectancy === null ? '—' : `${stats.expectancy.toFixed(2)}R`,
      }),
      el('td', { text: best ? `${best.tag} · ${Math.round(best.rate)}% of ${best.count}` : '—' }),
    ]));
  }
  table.append(body);
  refs.compareTable.append(el('div', { class: 'table-wrap' }, table));

  renderLivePanel();
}

/** Read-only, and labelled as such. Nothing here writes to the journal. */
function renderLivePanel() {
  const live = state.liveStats;
  const chosen = state.compare?.find((r) => r.session.id === refs.compareSelect.value)
    ?? state.compare?.[0];

  clear(refs.compareSelect);
  for (const row of state.compare ?? []) {
    refs.compareSelect.append(el('option', { value: row.session.id, text: row.session.name }));
  }
  if (chosen) refs.compareSelect.value = chosen.session.id;

  clear(refs.livePanel);
  if (!chosen || !live) return;

  const line = (label, backtest, journal) => el('div', { class: 'versus__row' }, [
    el('span', { class: 'versus__label', text: label }),
    el('span', { class: 'versus__value num', text: backtest }),
    el('span', { class: 'versus__value num', text: journal }),
  ]);

  refs.livePanel.append(
    el('div', { class: 'versus__head' }, [
      el('span', { class: 'versus__label', text: '' }),
      el('span', { class: 'versus__col', text: 'Backtest' }),
      el('span', { class: 'versus__col', text: 'Journal' }),
    ]),
    line('Trades', String(chosen.stats.count), String(live.count)),
    line(
      'Win rate',
      chosen.stats.winRate === null ? '—' : `${Math.round(chosen.stats.winRate)}%`,
      live.winRate === null ? '—' : `${Math.round(live.winRate)}%`,
    ),
    line(
      'Average R',
      chosen.stats.expectancy === null ? '—' : `${chosen.stats.expectancy.toFixed(2)}R`,
      live.avgRR === null ? '—' : `${live.avgRR.toFixed(2)}R`,
    ),
  );
}

/* ---------------------------------------------------------------- writes -- */

async function createSession(event) {
  event.preventDefault();
  showBanner(refs.newError, null);

  const name = refs.newName.value.trim();
  if (!name) {
    showBanner(refs.newError, 'Give the session a name.');
    refs.newName.focus();
    return;
  }
  const defaultR = Number(refs.newR.value);
  if (!Number.isFinite(defaultR) || defaultR <= 0) {
    showBanner(refs.newError, 'The default R has to be a number above zero.');
    refs.newR.focus();
    return;
  }

  setBusy(refs.newSubmit, true, 'Creating…');
  try {
    const { data, error } = await supabase
      .from('backtest_sessions')
      .insert({
        profile_id: state.profile.id,
        name,
        instrument: refs.newInstrument.value || null,
        timeframe: refs.newTimeframe.value || null,
        default_r: defaultR,
        period_start: refs.newStart.value || null,
        period_end: refs.newEnd.value || null,
      })
      .select(SESSION_COLUMNS)
      .single();
    if (error) throw new Error(describeError(error, 'Couldn’t create that session.'));

    state.sessions.unshift(data);
    state.counts.set(data.id, { count: 0, winRate: null });
    refs.newModal.close();
    toast(`${name} created.`, { type: 'success' });
    await openSession(data.id);
  } catch (error) {
    showBanner(refs.newError, error.message);
  } finally {
    setBusy(refs.newSubmit, false);
  }
}

async function setSessionStatus(status) {
  const session = currentSession();
  if (!session) return;
  const previous = session.status;
  session.status = status;
  renderSession();

  try {
    const { error } = await supabase
      .from('backtest_sessions')
      .update({ status })
      .eq('id', session.id);
    if (error) throw new Error(describeError(error, 'Couldn’t change the status.'));
  } catch (error) {
    session.status = previous;
    renderSession();
    toast(error.message, { type: 'error' });
  }
}

async function removeSession() {
  const session = currentSession();
  if (!session) return;
  if (!window.confirm(`Delete ${session.name}? Its ${state.trades.length} trades go too.`)) return;

  try {
    const { error } = await supabase.from('backtest_sessions').delete().eq('id', session.id);
    if (error) throw new Error(describeError(error, 'Couldn’t delete that session.'));
    state.sessions = state.sessions.filter((s) => s.id !== session.id);
    toast(`${session.name} deleted.`, { type: 'success' });
    await backToList();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

async function backToList() {
  state.sessionId = null;
  await refreshCounts();
  renderSessions();
}

async function refreshCounts() {
  try {
    const rows = await fetchAllTrades(state.sessions.map((s) => s.id));
    state.counts = new Map();
    for (const session of state.sessions) {
      const mine = rows.filter((r) => r.session_id === session.id);
      state.counts.set(session.id, sessionStats(mine, session));
    }
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

function openSessionModal() {
  refs.newForm.reset();
  refs.newR.value = '2';
  showBanner(refs.newError, null);
  refs.newModal.showModal();
  refs.newName.focus();
}

/* ----------------------------------------------------------------- setup -- */

export async function initBacktestPage() {
  await requireSession();
  const profile = await requireActiveProfile();
  state.profile = profile;
  applyProfileTheme(profile.id);
  mountGreeting(profile);

  document.body.prepend(topbar({
    profile,
    current: 'backtest.html',
    onSwitchProfile: () => goTo(PICKER_PAGE),
    onSignOut: signOut,
  }));

  refs = {
    viewList: document.getElementById('view-list'),
    viewSession: document.getElementById('view-session'),
    viewCompare: document.getElementById('view-compare'),
    sessionList: document.getElementById('session-list'),
    sessionName: document.getElementById('session-name'),
    sessionMeta: document.getElementById('session-meta'),
    liveBar: document.getElementById('live-bar'),
    sessionTags: document.getElementById('session-tags'),
    setupTags: document.getElementById('setup-tags'),
    rOverride: document.getElementById('r-override'),
    noteInput: document.getElementById('trade-note'),
    undo: document.getElementById('undo-trade'),
    tradeList: document.getElementById('trade-list'),
    equity: document.getElementById('bt-equity'),
    equityEmpty: document.getElementById('bt-equity-empty'),
    equityTotal: document.getElementById('bt-equity-total'),
    setupChart: document.getElementById('bt-setup'),
    setupEmpty: document.getElementById('bt-setup-empty'),
    sessionChart: document.getElementById('bt-session'),
    sessionEmpty: document.getElementById('bt-session-empty'),
    donut: document.getElementById('bt-donut'),
    donutEmpty: document.getElementById('bt-donut-empty'),
    rolling: document.getElementById('bt-rolling'),
    rollingEmpty: document.getElementById('bt-rolling-empty'),
    compareChart: document.getElementById('compare-chart'),
    compareTable: document.getElementById('compare-table'),
    compareSelect: document.getElementById('compare-select'),
    livePanel: document.getElementById('live-panel'),
    newModal: document.getElementById('session-modal'),
    newForm: document.getElementById('session-form'),
    newError: document.getElementById('session-error'),
    newName: document.getElementById('new-name'),
    newInstrument: document.getElementById('new-instrument'),
    newTimeframe: document.getElementById('new-timeframe'),
    newR: document.getElementById('new-r'),
    newStart: document.getElementById('new-start'),
    newEnd: document.getElementById('new-end'),
    newSubmit: document.getElementById('session-submit'),
    statusSelect: document.getElementById('session-status'),
  };

  document.getElementById('profile-name').textContent = profile.name;

  try {
    state.lists = await loadOptions(profile.id);
  } catch {
    /* Seeds are a fine fallback; the tags are optional anyway. */
  }

  for (const value of state.lists.instrument ?? INSTRUMENTS) {
    refs.newInstrument.append(el('option', { value, text: value }));
  }
  for (const value of TIMEFRAMES) {
    refs.newTimeframe.append(el('option', { value, text: value }));
  }
  for (const status of BACKTEST_STATUSES) {
    refs.statusSelect.append(el('option', { value: status.value, text: status.label }));
  }

  refs.sessionList.append(skeletonList(2, 'skeleton--card'));

  try {
    state.sessions = await fetchSessions();
    await refreshCounts();
  } catch (error) {
    clear(refs.sessionList).append(emptyState({
      title: 'Couldn’t load your sessions',
      body: error.message,
      actionLabel: 'Try again',
      onAction: () => window.location.reload(),
    }));
    return;
  }

  const hash = window.location.hash.replace('#', '');
  if (hash === 'compare') await openCompare();
  else if (hash.startsWith('session-') && state.sessions.some((s) => s.id === hash.slice(8))) {
    await openSession(hash.slice(8));
  } else renderSessions();

  wireControls();
}

function wireControls() {
  document.getElementById('new-session').addEventListener('click', openSessionModal);
  document.getElementById('open-compare').addEventListener('click', openCompare);
  document.getElementById('back-to-sessions').addEventListener('click', backToList);
  document.getElementById('compare-back').addEventListener('click', backToList);
  document.getElementById('session-cancel').addEventListener('click', () => refs.newModal.close());
  document.getElementById('session-close').addEventListener('click', () => refs.newModal.close());
  document.getElementById('delete-session').addEventListener('click', removeSession);

  refs.newForm.addEventListener('submit', createSession);
  refs.undo.addEventListener('click', undoLast);
  refs.compareSelect.addEventListener('change', renderLivePanel);
  refs.statusSelect.addEventListener('change', () => setSessionStatus(refs.statusSelect.value));

  for (const button of document.querySelectorAll('[data-outcome]')) {
    button.addEventListener('click', () => logTrade(button.dataset.outcome));
  }

  // Keyboard shortcuts for a fast pass: W, L, B, and U to undo.
  document.addEventListener('keydown', (event) => {
    if (state.view !== 'session') return;
    if (event.target.matches('input, textarea, select')) return;
    const key = event.key.toLowerCase();
    if (key === 'w') logTrade('win');
    else if (key === 'l') logTrade('loss');
    else if (key === 'b') logTrade('breakeven');
    else if (key === 'u') undoLast();
  });
}
