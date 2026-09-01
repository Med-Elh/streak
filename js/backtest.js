/**
 * Backtesting: a sandbox that never touches the journal.
 *
 * Its own tables, its own trades, its own stats. Nothing here is written back
 * to `trades`, and the Compare view reads the journal without ever writing to
 * it — a backtest is a rehearsal, and a rehearsal that can edit the performance
 * is worthless.
 *
 * Logging is one tap. Win, Loss, Breakeven each log a trade at whatever risk
 * the session has in force; tags, a risk override and a note are all optional
 * and all out of the way until wanted.
 */

import {
  supabase, describeError, constraintOf, columnOf, plainError,
} from './supabase.js?v=29';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=29';
import { requireActiveProfile } from './profiles.js?v=29';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy, showBanner,
  failField, clearFieldErrors, attachTip,
  countUp, formatDate, todayISO, applyProfileTheme, prefersReducedMotion,
  formatMoney, formatSignedMoney, compactMoney, useCurrency, initMoney,
} from './ui.js?v=29';
import { mountGreeting } from './greetings.js?v=29';
import { SESSIONS, SETUPS, INSTRUMENTS, loadOptions } from './constants.js?v=29';
import {
  equityAreaChart, rateBarsChart, outcomeDonut, rollingRateChart,
  metricBarsChart, multiEquityChart, seriesColor,
  signedBarChart, countBarChart,
} from './charts.js?v=29';

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
  tags: { session: null, setup: null, exit: null },
  capResult: null,
  workingDate: null,
  includeWeekends: false,
  movingTrade: null,
  lists: { session: SESSIONS, setup: SETUPS, instrument: INSTRUMENTS },
  view: 'list',
  liveStats: null,
  editingSession: null,
  // Live only while the session form is open; the saved values live on the row.
  triggerUnit: 'percent',
  reductionUnit: 'percent',
  reference: 'peak',
  candidates: [],
  selection: [],
  metric: 'winRate',
};

let refs = {};

/* ----------------------------------------------------------------- money -- */
/*
 * Everything here is dollars. A session sets the risk per trade and the payout
 * multiple; a win pays risk × ratio, a loss costs the risk, a breakeven is zero.
 *
 * The resolved risk and result are written onto each trade when it is logged,
 * so changing a session's settings later re-prices nothing that already
 * happened. `amountOf` only recomputes for rows saved before that was true.
 */

const num = (value, fallback = 0) => {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

/**
 * The risk in force after `completed` trades. Stepped sessions move the risk
 * every N trades by a fixed amount, which may be negative to step down — but
 * never below zero, because a negative risk is not a thing.
 */
export function riskInForce(session, completed = 0) {
  const base = num(session?.risk_amount);
  if (session?.risk_mode !== 'stepped') return Math.max(base, 0);

  const every = num(session?.risk_step_trades);
  const by = num(session?.risk_step_amount);
  if (every <= 0) return Math.max(base, 0);

  const steps = Math.floor(Math.max(completed, 0) / every);
  return Math.max(base + steps * by, 0);
}

/**
 * How many reduction tiers a given drawdown has earned. One tier per whole
 * multiple of the trigger, so 22% down against a 10% trigger is two tiers.
 *
 * `reference` is whatever the session measures from — the running peak, or the
 * starting balance. Percentages are of that same figure.
 */
export function tiersAt(session, reference, balance) {
  const trigger = num(session?.drawdown_trigger);
  if (trigger <= 0) return 0;
  const drawdown = Math.max(reference - balance, 0);
  const measure = session?.drawdown_unit === 'dollars'
    ? drawdown
    : (reference > 0 ? (drawdown / reference) * 100 : 0);
  return Math.max(Math.floor(measure / trigger), 0);
}

/**
 * Base risk after `tiers` cuts. Percent reductions are linear rather than
 * compounding — "drops by 25% for every 10% down" means two tiers is half, not
 * 43.75%, which is what the sentence on the form promises.
 */
export function reduceRisk(base, tiers, session) {
  const start = Math.max(num(base), 0);
  if (tiers <= 0) return start;
  const cut = num(session?.risk_reduction);
  if (session?.reduction_unit === 'dollars') return Math.max(start - tiers * cut, 0);
  return Math.max(start * (1 - (tiers * cut) / 100), 0);
}

/**
 * Walks the balance to find the reference point, the drawdown against it, and
 * how many tiers down the account currently sits.
 *
 * Two things vary. The reference is either the running peak — so any pullback
 * counts, even from a high water mark far above where you started — or the
 * starting balance, which cuts nothing while you are still in profit.
 *
 * The recovery modes then differ in how the tier is released. `stepped_back`
 * reads it off the current drawdown, so it comes back a tier at a time as the
 * balance recovers. `on_new_peak` holds the deepest tier reached until the
 * reference is cleared. That holding is why this is a walk rather than a
 * calculation on the final balance.
 */
export function drawdownState(session, priorTrades = []) {
  const start = num(session?.starting_balance);
  const fromStart = session?.drawdown_reference === 'starting_balance';
  const stepped = session?.recovery_mode === 'stepped_back';

  let peak = start;
  let balance = start;
  let held = 0;

  for (const trade of priorTrades) {
    balance += num(trade.amount);
    const newHigh = balance > peak;
    if (newHigh) peak = balance;

    // A peak has to be beaten to clear the tier; the starting balance only has
    // to be reached, because being level with it is not a drawdown.
    if (fromStart ? balance >= start : newHigh) {
      held = 0;
      continue;
    }

    const tiers = tiersAt(session, fromStart ? start : peak, balance);
    held = stepped ? tiers : Math.max(held, tiers);
  }

  const reference = fromStart ? start : peak;
  const drawdown = Math.max(reference - balance, 0);
  return {
    peak,
    balance,
    reference,
    fromStart,
    drawdown,
    percent: reference > 0 ? (drawdown / reference) * 100 : 0,
    tiers: held,
  };
}

/** Risk for the next trade, whichever mode the session is in. */
export function riskFor(session, priorTrades = []) {
  if (session?.risk_mode === 'adaptive') {
    const { tiers } = drawdownState(session, priorTrades);
    return reduceRisk(num(session?.risk_amount), tiers, session);
  }
  return riskInForce(session, priorTrades.length);
}

/** What one trade is worth, given the risk it was taken at. */
export function tradeResult(outcome, risk, rewardRatio) {
  const stake = Math.max(num(risk), 0);
  if (outcome === 'win') return stake * num(rewardRatio, 1);
  if (outcome === 'loss') return -stake;
  return 0;
}

/** When the risk next moves, and to what. Null in fixed mode. */
export function nextStep(session, completed = 0) {
  if (session?.risk_mode !== 'stepped') return null;
  const every = num(session?.risk_step_trades);
  const by = num(session?.risk_step_amount);
  if (every <= 0 || by === 0) return null;

  const inTrades = every - (Math.max(completed, 0) % every);
  const nextRisk = riskInForce(session, Math.max(completed, 0) + inTrades);
  if (nextRisk === riskInForce(session, completed)) return null;
  return { inTrades, nextRisk, rising: nextRisk > riskInForce(session, completed) };
}

/**
 * A trade's dollar result. Stored `amount` wins — that is the whole point of
 * storing it — and only rows written before this feature get recomputed from
 * their position in the sequence.
 */
export function amountOf(trade, session, index = 0) {
  if (trade?.amount !== null && trade?.amount !== undefined) return num(trade.amount);
  const risk = trade?.risk_amount !== null && trade?.risk_amount !== undefined
    ? num(trade.risk_amount)
    : riskInForce(session, index);
  return tradeResult(trade?.outcome, risk, num(session?.reward_ratio, 1));
}

export function sessionStats(trades, session) {
  const wins = trades.filter((t) => t.outcome === 'win').length;
  const losses = trades.filter((t) => t.outcome === 'loss').length;
  const breakevens = trades.filter((t) => t.outcome === 'breakeven').length;
  const decided = wins + losses;
  const total = trades.reduce((sum, t, i) => sum + amountOf(t, session, i), 0);

  return {
    count: trades.length,
    wins,
    losses,
    breakevens,
    decided,
    // Breakevens are excluded, as everywhere else in the app.
    winRate: decided ? (wins / decided) * 100 : null,
    total,
    balance: num(session?.starting_balance) + total,
    expectancy: trades.length ? total / trades.length : null,
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

/** Cumulative dollars, opening at zero so a losing first trade doesn't start below. */
export function equitySeries(trades, session) {
  let running = 0;
  const values = [0];
  trades.forEach((trade, index) => {
    running += amountOf(trade, session, index);
    values.push(Number(running.toFixed(2)));
  });
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

/* ---------------------------------------------------------- working date -- */
/*
 * The date a trade is logged *against*, which is not the date it was typed.
 *
 * A backtest replays months of history in an afternoon. Left to the real
 * clock, every trade lands on today, every trade is #1 of its own day, and
 * every day-based breakdown becomes noise. The working date is the simulated
 * calendar; the clock only supplies the time of day.
 */

const WORKING_DATE_KEY = 'streak.backtest.workingDate';
const WEEKEND_KEY = 'streak.backtest.includeWeekends';

/** `YYYY-MM-DD` parsed as local midnight, never UTC. */
export function parseISODate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso ?? ''));
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function toISODate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const isWeekend = (date) => date.getDay() === 0 || date.getDay() === 6;

/**
 * Moves the working date by whole days, stepping over the weekend unless asked
 * not to — markets are shut, so a Saturday in a backtest is a day that never
 * had trades and would sit in the analysis as a false gap.
 */
export function shiftWorkingDate(iso, step, { includeWeekends = false } = {}) {
  const date = parseISODate(iso);
  if (!date || !step) return iso;

  const direction = step > 0 ? 1 : -1;
  let remaining = Math.abs(step);

  while (remaining > 0) {
    date.setDate(date.getDate() + direction);
    if (includeWeekends || !isWeekend(date)) remaining -= 1;
  }
  return toISODate(date);
}

export const nextWorkingDate = (iso, options) => shiftWorkingDate(iso, 1, options);
export const previousWorkingDate = (iso, options) => shiftWorkingDate(iso, -1, options);

/**
 * The stamp written to `traded_at`: the working date's calendar day carrying
 * the real clock's time, so hour-of-day analysis still has something to read.
 */
export function stampFor(iso, clock = new Date()) {
  const date = parseISODate(iso);
  if (!date) return clock.toISOString();

  date.setHours(clock.getHours(), clock.getMinutes(), clock.getSeconds(), 0);
  return date.toISOString();
}

/** "Tue 9 Jun" — short, and with the weekday, which is the part that matters. */
export function formatWorkingDate(iso) {
  const date = parseISODate(iso);
  if (!date) return '—';
  return date.toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

/** Where a session starts when it has never been opened before. */
export function defaultWorkingDate(session) {
  return session?.period_start ?? todayISO();
}

export function loadWorkingDate(sessionId) {
  const stored = localStorage.getItem(`${WORKING_DATE_KEY}.${sessionId}`);
  return parseISODate(stored) ? stored : null;
}

export function saveWorkingDate(sessionId, iso) {
  if (parseISODate(iso)) localStorage.setItem(`${WORKING_DATE_KEY}.${sessionId}`, iso);
}

export function loadIncludeWeekends() {
  return localStorage.getItem(WEEKEND_KEY) === 'true';
}

export function saveIncludeWeekends(value) {
  localStorage.setItem(WEEKEND_KEY, String(value));
}

/* -------------------------------------------------------------- analysis -- */
/*
 * Breakdowns for deriving rules from the log.
 *
 * Two rules hold throughout. Every function takes trades in chronological
 * order and returns `{ rows, n, excluded }`, where `n` is how many trades the
 * finding actually rests on and `excluded` is how many were dropped for
 * missing data — because a breakdown that quietly discards half its input is
 * worse than no breakdown. And nothing here writes: analysis reads the log.
 */

/** Below this a breakdown is a hint, not a finding. */
export const THIN_DATA = 20;

/**
 * A win rate needs several trades before it means anything. One trade at a
 * position reads as 100% or 0%, which is not a rate — it's a single outcome
 * wearing a percentage sign.
 */
export const MIN_RATE_SAMPLE = 5;

/**
 * A cap needs several days behind it. Over one day, "the best cap" is just
 * "stop before the trade that lost" — hindsight, not a rule.
 */
export const MIN_CAP_DAYS = 5;

export const EXIT_REASONS = [
  { value: 'tp', label: 'Target' },
  { value: 'sl', label: 'Stop' },
  { value: 'manual', label: 'Manual' },
  { value: 'breakeven', label: 'Breakeven' },
  { value: 'timeout', label: 'Timeout' },
];

export const RATIOS = [1, 1.5, 2, 2.5, 3];

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** When a trade happened, preferring the explicit stamp over the row's birth. */
function timeOf(trade) {
  const raw = trade?.traded_at ?? trade?.created_at;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Local calendar day, `YYYY-MM-DD`. Local, because sessions are traded local. */
export function dayKey(trade) {
  const date = timeOf(trade);
  if (!date) return null;
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function hourOf(trade) {
  const date = timeOf(trade);
  return date ? date.getHours() : null;
}

/** 0 = Monday, so the working week reads left to right. */
export function weekdayOf(trade) {
  const date = timeOf(trade);
  return date ? (date.getDay() + 6) % 7 : null;
}

/**
 * Each trade tagged with its day and its position within that day.
 *
 * Prefers the stored `trade_of_day`, falling back to counting through the
 * sequence — so rows logged before the column existed still analyse, and rows
 * written since keep the number they were saved with.
 */
export function sequenced(trades) {
  const counter = new Map();
  return trades.map((trade) => {
    const day = dayKey(trade);
    const next = (counter.get(day) ?? 0) + 1;
    counter.set(day, next);
    const stored = Number(trade.trade_of_day);
    return { ...trade, day, n: Number.isFinite(stored) && stored > 0 ? stored : next };
  });
}

/** Win rate over decided trades. Breakevens are excluded, as everywhere else. */
function rateOf(trades) {
  const wins = trades.filter((t) => t.outcome === 'win').length;
  const losses = trades.filter((t) => t.outcome === 'loss').length;
  return wins + losses ? (wins / (wins + losses)) * 100 : null;
}

function netOf(trades) {
  return trades.reduce((sum, trade) => sum + num(trade.amount), 0);
}

function summarise(trades) {
  return {
    count: trades.length,
    wins: trades.filter((t) => t.outcome === 'win').length,
    losses: trades.filter((t) => t.outcome === 'loss').length,
    winRate: rateOf(trades),
    net: netOf(trades),
    expectancy: trades.length ? netOf(trades) / trades.length : null,
  };
}

/** Does the third trade of the day still pay? */
export function byTradeNumber(trades, maxN = 10) {
  const seq = sequenced(trades);
  const groups = new Map();

  for (const trade of seq) {
    if (trade.n > maxN) continue;
    if (!groups.has(trade.n)) groups.set(trade.n, []);
    groups.get(trade.n).push(trade);
  }

  const rows = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([n, list]) => ({ n, ...summarise(list) }));

  const used = rows.reduce((sum, row) => sum + row.count, 0);
  return { rows, n: used, excluded: seq.length - used };
}

/**
 * What the session would have made under a cap of N trades a day.
 *
 * Every trade past the cap is simply not taken — the ones before it are
 * untouched, so this is a filter on the real log rather than a re-simulation.
 */
export function capSimulation(trades, maxCap = 10) {
  const seq = sequenced(trades);
  const rows = [];

  for (let cap = 1; cap <= maxCap; cap += 1) {
    const kept = seq.filter((trade) => trade.n <= cap);
    rows.push({ cap, ...summarise(kept) });
  }

  const best = rows.reduce(
    (top, row) => (top === null || row.net > top.net ? row : top),
    null,
  );

  // How many days are behind it decides whether `best` is a finding at all.
  const days = new Set(seq.map((trade) => trade.day)).size;
  return { rows, best, days, meaningful: days >= MIN_CAP_DAYS, n: seq.length, excluded: 0 };
}

/** The trade after a win, against the trade after a loss. */
export function afterOutcome(trades) {
  const after = { win: [], loss: [] };

  for (let i = 1; i < trades.length; i += 1) {
    const previous = trades[i - 1].outcome;
    if (previous === 'win' || previous === 'loss') after[previous].push(trades[i]);
  }

  const classified = after.win.length + after.loss.length;
  return {
    afterWin: summarise(after.win),
    afterLoss: summarise(after.loss),
    rows: [
      { key: 'win', label: 'After a win', ...summarise(after.win) },
      { key: 'loss', label: 'After a loss', ...summarise(after.loss) },
    ],
    n: classified,
    // The first trade has no predecessor, and a trade after a breakeven
    // belongs to neither group.
    excluded: Math.max(trades.length - classified, 0),
  };
}

/** Stopping for the day after N losses. `null` means never stopping. */
export function stopAfterLoss(trades, limits = [1, 2, null]) {
  const days = new Map();
  for (const trade of sequenced(trades)) {
    if (!days.has(trade.day)) days.set(trade.day, []);
    days.get(trade.day).push(trade);
  }

  const rows = limits.map((limit) => {
    const taken = [];
    for (const day of days.values()) {
      let losses = 0;
      for (const trade of day) {
        // The losing trade that trips the limit is still taken; the stop
        // applies from the next one.
        if (limit !== null && losses >= limit) break;
        taken.push(trade);
        if (trade.outcome === 'loss') losses += 1;
      }
    }
    return {
      limit,
      label: limit === null ? 'Never stop' : `Stop after ${limit}`,
      ...summarise(taken),
    };
  });

  return { rows, n: trades.length, excluded: 0 };
}

function bucketBy(trades, keyOf, labelOf) {
  const groups = new Map();
  let excluded = 0;

  for (const trade of trades) {
    const key = keyOf(trade);
    if (key === null) { excluded += 1; continue; }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(trade);
  }

  const rows = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([key, list]) => ({ key, label: labelOf(key), ...summarise(list) }));

  return { rows, n: trades.length - excluded, excluded };
}

export function byHour(trades) {
  return bucketBy(trades, hourOf, (h) => `${String(h).padStart(2, '0')}:00`);
}

export function byWeekday(trades) {
  return bucketBy(trades, weekdayOf, (d) => WEEKDAYS[d]);
}

/** How each exit was reached, and what it paid. */
export function byExitReason(trades) {
  const known = new Set(EXIT_REASONS.map((r) => r.value));
  const result = bucketBy(
    trades,
    (t) => (known.has(t.exit_reason) ? t.exit_reason : null),
    (value) => EXIT_REASONS.find((r) => r.value === value)?.label ?? value,
  );
  // Order by the list rather than alphabetically, so target sits beside stop.
  result.rows.sort(
    (a, b) => EXIT_REASONS.findIndex((r) => r.value === a.key)
      - EXIT_REASONS.findIndex((r) => r.value === b.key),
  );
  return result;
}

const mean = (values) => (values.length
  ? values.reduce((a, b) => a + b, 0) / values.length
  : null);

/**
 * A recorded number, or null when it was never recorded.
 *
 * `Number(null)` is `0`, and zero is finite — so testing with `Number.isFinite`
 * alone silently treats an unrecorded excursion as a trade that never moved,
 * dragging every average towards zero.
 */
function recorded(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** How far trades ran in favour, and against, before they closed. */
export function mfeStats(trades) {
  const usable = trades.filter((t) => recorded(t.mfe) !== null);
  const pick = (list, field) => mean(
    list.map((t) => recorded(t[field])).filter((v) => v !== null),
  );

  const winners = usable.filter((t) => t.outcome === 'win');
  const losers = usable.filter((t) => t.outcome === 'loss');

  return {
    rows: [
      { label: 'Winners', count: winners.length, mfe: pick(winners, 'mfe'), mae: pick(winners, 'mae') },
      { label: 'Losers', count: losers.length, mfe: pick(losers, 'mfe'), mae: pick(losers, 'mae') },
    ],
    n: usable.length,
    excluded: trades.length - usable.length,
  };
}

/**
 * What each target would have paid, rebuilt from how far trades actually ran.
 *
 * A trade whose MFE reached the target is counted as a win at that target; one
 * whose MAE reached a full R is counted as a stop-out. Trades that did neither
 * are unresolved and counted separately rather than assumed either way.
 *
 * The honest limit: MFE and MAE don't record which came first, so a trade that
 * reached both could have gone either way. `unresolved` plus that caveat is
 * why this is a prompt to look, not a verdict.
 */
export function ratioSimulation(trades, ratios = RATIOS) {
  const usable = trades.filter(
    (t) => recorded(t.mfe) !== null && recorded(t.mae) !== null,
  );

  const rows = ratios.map((ratio) => {
    let net = 0;
    let wins = 0;
    let losses = 0;
    let unresolved = 0;

    for (const trade of usable) {
      const risk = Math.max(num(trade.risk_amount), 0);
      if (recorded(trade.mfe) >= ratio) { net += risk * ratio; wins += 1; }
      else if (recorded(trade.mae) >= 1) { net -= risk; losses += 1; }
      else unresolved += 1;
    }

    return {
      ratio,
      label: `1:${ratio}`,
      net,
      wins,
      losses,
      unresolved,
      count: usable.length,
      winRate: wins + losses ? (wins / (wins + losses)) * 100 : null,
    };
  });

  return { rows, n: usable.length, excluded: trades.length - usable.length };
}

/** The losing streaks: the worst one, and how often each length happened. */
export function lossRuns(trades) {
  const counts = new Map();
  let run = 0;
  let longest = 0;

  const close = () => {
    if (run > 0) counts.set(run, (counts.get(run) ?? 0) + 1);
    run = 0;
  };

  for (const trade of trades) {
    if (trade.outcome === 'loss') {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      // A breakeven ends a losing run without being part of it.
      close();
    }
  }
  close();

  const rows = [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([length, count]) => ({ length, count }));

  return { rows, longest, n: trades.length, excluded: 0 };
}

/* -------------------------------------------------------------- verdicts -- */
/*
 * One sentence per panel, in ordinary words.
 *
 * Each returns `{ text, tone }`. `tone` is 'plain' when the reading stands,
 * 'unreliable' when there isn't enough behind it to act on, and 'quiet' when
 * there is nothing to say yet. A thin sample never gets a confident sentence:
 * the hedge is part of the finding, not a disclaimer bolted beside it.
 */

const quiet = (text) => ({ text, tone: 'quiet' });
const plain = (text) => ({ text, tone: 'plain' });

/** States it plainly above the threshold, tentatively below it. */
function graded(n, text) {
  if (n < THIN_DATA) {
    return {
      tone: 'unreliable',
      text: `Only ${n} trade${n === 1 ? '' : 's'} behind this, so treat it as a hint rather than a finding: ${text}`,
    };
  }
  return plain(text);
}

const money = (value) => formatSignedMoney(value);

export function tradeNumberVerdict(result) {
  const rows = result.rows;
  if (!rows.length) return quiet('Nothing logged yet.');
  if (rows.length === 1) {
    return quiet('Only one trade per day so far — log a few days with several trades to see whether the later ones hold up.');
  }

  const first = rows[0];
  const later = rows.slice(1);
  const laterNet = later.reduce((sum, row) => sum + row.net, 0);

  if (first.net > 0 && laterNet < 0) {
    return graded(result.n,
      `your first trade of the day is your best, and the later ones give back ${money(laterNet)} of it.`);
  }
  if (first.net > 0 && laterNet >= 0) {
    return graded(result.n,
      `later trades are still paying — nothing here says you should stop after the first.`);
  }
  if (first.net <= 0 && laterNet > 0) {
    return graded(result.n,
      `your first trade of the day is the weak one, and the later trades make up for it.`);
  }
  return graded(result.n,
    `every position in the day is losing, so the problem isn't when you trade — it's what you're taking.`);
}

export function capVerdict(result) {
  if (!result.n) return quiet('Nothing logged yet.');

  if (!result.meaningful) {
    const days = result.days;
    return {
      tone: 'unreliable',
      text: `Trades on only ${days} day${days === 1 ? '' : 's'} so far. A cap can't mean anything yet — with one trade at each position, the "best" cap just excludes the single worst trade rather than finding a rule. Come back after about ${MIN_CAP_DAYS} days of trading.`,
    };
  }

  const uncapped = result.rows[result.rows.length - 1];
  const best = result.best;

  if (!best || best.cap === uncapped.cap || best.net <= uncapped.net) {
    return graded(result.n, 'no daily cap would have beaten simply taking every trade.');
  }
  return graded(result.n,
    `capping at ${best.cap} trade${best.cap === 1 ? '' : 's'} a day would have turned ${money(uncapped.net)} into ${money(best.net)}.`);
}

export function afterOutcomeVerdict(result) {
  const { afterWin, afterLoss } = result;
  if (!afterWin.count || !afterLoss.count) {
    return quiet('Not enough trades yet to compare how you follow a win against how you follow a loss.');
  }
  if (afterWin.winRate === null || afterLoss.winRate === null) {
    return quiet('Not enough decided trades yet to say.');
  }

  const gap = afterWin.winRate - afterLoss.winRate;
  if (gap >= 10) {
    return graded(result.n,
      `you trade worse straight after a loss — ${Math.round(afterLoss.winRate)}% win rate against ${Math.round(afterWin.winRate)}% after a win.`);
  }
  if (gap <= -10) {
    return graded(result.n,
      `a loss doesn't shake you — you actually do better after one (${Math.round(afterLoss.winRate)}% against ${Math.round(afterWin.winRate)}%).`);
  }
  return graded(result.n,
    `the last result doesn't change the next one — you trade about the same either way.`);
}

export function stopVerdict(result) {
  if (!result.n) return quiet('Nothing logged yet.');

  const never = result.rows.find((row) => row.limit === null);
  const best = result.rows.reduce(
    (top, row) => (top === null || row.net > top.net ? row : top),
    null,
  );

  if (!best || !never) return quiet('Not enough logged yet to say.');

  // A tie is not a win for stopping. "+$0.00 better off" is technically true
  // and completely useless.
  const gain = best.net - never.net;
  if (best.limit === null || gain <= 0) {
    return graded(result.n,
      'stopping early would not have helped — trading through the losses paid at least as well.');
  }
  return graded(result.n,
    `stopping for the day after ${best.limit} loss${best.limit === 1 ? '' : 'es'} would have left you ${money(gain)} better off.`);
}

export function clockVerdict(result, unit) {
  const solid = result.rows.filter((row) => row.count >= MIN_RATE_SAMPLE);
  if (!solid.length) {
    return quiet(`No single ${unit} has ${MIN_RATE_SAMPLE} trades yet, so there's nothing to compare.`);
  }
  if (solid.length === 1) {
    return quiet(`Only ${solid[0].label} has enough trades to judge so far.`);
  }

  const best = solid.reduce((top, row) => (row.net > top.net ? row : top), solid[0]);
  const worst = solid.reduce((low, row) => (row.net < low.net ? row : low), solid[0]);
  if (best.label === worst.label) {
    return graded(result.n, `everything lands on ${best.label} so far.`);
  }
  return graded(result.n,
    `${best.label} is your best ${unit} at ${money(best.net)}, and ${worst.label} your worst at ${money(worst.net)}.`);
}

export function exitVerdict(result) {
  if (!result.rows.length) {
    return quiet('No exit reasons recorded yet. Tag a few trades to see whether your manual exits cost you.');
  }

  const per = (row) => (row.count ? row.net / row.count : null);
  const target = result.rows.find((row) => row.key === 'tp');
  const manual = result.rows.find((row) => row.key === 'manual');

  if (!target || !manual) {
    const top = result.rows.reduce((best, row) => (row.net > best.net ? row : best), result.rows[0]);
    return graded(result.n, `${top.label.toLowerCase()} exits are where your money comes from so far.`);
  }

  if (per(manual) < per(target)) {
    return graded(result.n,
      `your manual exits pay less than letting the target fill — ${money(per(manual))} a trade against ${money(per(target))}. That's the discipline cost.`);
  }
  return graded(result.n,
    `your manual exits are holding up against your targets — ${money(per(manual))} a trade against ${money(per(target))}.`);
}

export function excursionVerdict(excursions, ratios) {
  if (!ratios.n) {
    return quiet('Record MFE and MAE on a few trades to see whether your target sits in the right place.');
  }

  const best = ratios.rows.reduce((top, row) => (row.net > top.net ? row : top), ratios.rows[0]);
  const losers = excursions.rows.find((row) => row.label === 'Losers');

  const near = losers && losers.mfe !== null && losers.mfe >= 1
    ? ` Your losing trades ran ${losers.mfe.toFixed(1)}R in your favour before turning, so a nearer target would have caught some of them.`
    : '';

  return graded(ratios.n,
    `a ${best.label} target would have paid the most, at ${money(best.net)}.${near}`);
}

export function runsVerdict(result) {
  if (!result.n) return quiet('Nothing logged yet.');
  if (result.longest === 0) return quiet('No losing runs yet.');

  return graded(result.n,
    `your worst run was ${result.longest} losses in a row. Expect that again, and size so it doesn't matter when it happens.`);
}

/* ------------------------------------------------------------------ data -- */

const SESSION_COLUMNS = `id, profile_id, name, instrument, timeframe,
  starting_balance, risk_amount, risk_mode, risk_step_trades, risk_step_amount,
  drawdown_trigger, drawdown_unit, risk_reduction, reduction_unit, recovery_mode,
  drawdown_reference,
  reward_ratio, period_start, period_end, notes, status, created_at`;
const TRADE_COLUMNS = `id, session_id, outcome, risk_amount, amount, session_tag,
  setup_tag, note, traded_at, trade_of_day, exit_reason, mfe, mae, created_at`;

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
    .select('id, session_id, outcome, risk_amount, amount, setup_tag')
    .in('session_id', ids);
  if (error) throw new Error(describeError(error, 'Couldn’t load trade counts.'));
  return data ?? [];
}

/* ------------------------------------------------------------------ views -- */

function show(view) {
  state.view = view;
  refs.viewList.hidden = view !== 'list';
  refs.viewSession.hidden = view !== 'session';
  refs.viewCompare.hidden = view !== 'compare';
  refs.viewAnalysis.hidden = view !== 'analysis';
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
      onAction: () => openSessionModal(),
    }));
    return;
  }

  const grid = el('div', { class: 'plan-grid' });
  for (const session of state.sessions) {
    const counts = state.counts.get(session.id) ?? { count: 0, winRate: null };
    // A card is a div holding two buttons: one that opens it, one that edits.
    // Nesting a button inside a button is invalid, so the card cannot be one.
    grid.append(el('div', { class: 'bt-card' }, [
      el('button', {
        class: 'bt-card__open',
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
          text: `${session.instrument ?? '—'} · ${session.timeframe ?? '—'} · ${formatMoney(session.risk_amount)} a trade`,
        }),
        el('div', { class: 'bt-card__stats' }, [
          statBlock('Trades', String(counts.count)),
          statBlock('Win rate', counts.winRate === null ? '—' : `${Math.round(counts.winRate)}%`),
        ]),
      ]),
      el('button', {
        class: 'bt-card__edit',
        type: 'button',
        text: 'Edit',
        'aria-label': `Edit ${session.name}`,
        onclick: () => openSessionModal(session),
      }),
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

  // Picks up where this session was left, falling back to where it starts.
  state.includeWeekends = loadIncludeWeekends();
  state.workingDate = loadWorkingDate(id) ?? defaultWorkingDate(currentSession());

  renderSession({ animate: true });
}

function renderSession({ animate = false } = {}) {
  const session = currentSession();
  if (!session) return renderSessions();

  refs.sessionName.textContent = session.name;
  renderDayBar();
  refs.sessionMeta.textContent =
    `${session.instrument ?? '—'} · ${session.timeframe ?? '—'} · ${formatMoney(session.risk_amount)} a trade`
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
    tile('Net', stats.total, (v) => formatSignedMoney(v)),
    tile('Per trade', stats.expectancy ?? 0, (v) => (stats.expectancy === null ? '—' : formatSignedMoney(v))),
  );

  renderRiskLine();
}

/** What the next trade will cost, and what is moving that number. */
function renderRiskLine() {
  const session = currentSession();
  if (!session) return;

  const risk = riskFor(session, state.trades);
  const payout = risk * Number(session.reward_ratio ?? 1);

  refs.riskLine.textContent =
    `Risking ${formatMoney(risk)} · a win pays ${formatMoney(payout)}`;

  if (session.risk_mode === 'adaptive') {
    const dd = drawdownState(session, state.trades);
    refs.stepLine.hidden = false;

    if (dd.drawdown <= 0) {
      refs.stepLine.textContent = dd.fromStart
        ? `At or above your starting balance · full risk`
        : `At your peak · ${formatMoney(dd.peak)} · full risk`;
      return;
    }

    const tiers = dd.tiers === 0
      ? 'full risk'
      : `${dd.tiers} tier${dd.tiers === 1 ? '' : 's'} down`;
    refs.stepLine.textContent =
      `${depthOf(dd, session, 1)} below ${referenceLabel(dd)} · ${tiers}`;
    return;
  }

  const step = nextStep(session, state.trades.length);
  refs.stepLine.hidden = !step;
  if (step) {
    refs.stepLine.textContent =
      `${step.rising ? 'Rises' : 'Falls'} to ${formatMoney(step.nextRisk)} in `
      + `${step.inTrades} trade${step.inTrades === 1 ? '' : 's'}`;
  }
}

/** Which figure the drawdown is being measured against, in words. */
function referenceLabel(dd) {
  return dd.fromStart ? 'your starting balance' : 'your peak';
}

/** How far down, in the unit the session set its trigger in. */
function depthOf(dd, session, places = 0) {
  return session.drawdown_unit === 'dollars'
    ? formatMoney(dd.drawdown)
    : `${dd.percent.toFixed(places)}%`;
}

/**
 * A cut you didn't ask for should say why it happened. Only speaks when the
 * number actually moved.
 */
function announceRiskChange(session, before) {
  const after = riskFor(session, state.trades);
  if (Math.abs(after - before) < 0.005) return;

  const dd = drawdownState(session, state.trades);

  if (after > before) {
    const cleared = dd.fromStart
      ? 'back to your starting balance'
      : 'new peak';
    toast(
      dd.tiers === 0
        ? `Risk restored to ${formatMoney(after)} — ${cleared}.`
        : `Risk raised to ${formatMoney(after)} — recovered to ${depthOf(dd, session)} below ${referenceLabel(dd)}.`,
      { type: 'success' },
    );
    return;
  }
  toast(
    `Risk reduced to ${formatMoney(after)} — ${depthOf(dd, session)} below ${referenceLabel(dd)}.`,
    { type: 'info' },
  );
}

/* ------------------------------------------------------------- day bar -- */

/** The working date, its weekday, and what has been logged against it. */
function renderDayBar() {
  const session = currentSession();
  if (!session || !state.workingDate) return;

  refs.workingDateLabel.textContent = formatWorkingDate(state.workingDate);
  refs.workingDateInput.value = state.workingDate;
  refs.includeWeekends.checked = state.includeWeekends;

  const logged = state.trades.filter((t) => dayKey(t) === state.workingDate).length;
  refs.workingDateCount.textContent = logged === 0
    ? 'No trades yet on this day'
    : `${logged} trade${logged === 1 ? '' : 's'} on this day`;
}

/** Moves the working date and remembers it against this session. */
function setWorkingDate(iso, { announce = false } = {}) {
  if (!parseISODate(iso)) return;

  state.workingDate = iso;
  saveWorkingDate(state.sessionId, iso);
  renderDayBar();

  if (announce) {
    toast(`Now logging against ${formatWorkingDate(iso)}.`, {
      type: 'info',
      duration: 1800,
    });
  }
}

function stepDay(direction) {
  const options = { includeWeekends: state.includeWeekends };
  setWorkingDate(
    direction > 0
      ? nextWorkingDate(state.workingDate, options)
      : previousWorkingDate(state.workingDate, options),
    { announce: true },
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

  // Exit reasons are a fixed vocabulary, not a per-profile list, because the
  // analysis reads specific values out of them.
  clear(refs.exitTags);
  for (const reason of EXIT_REASONS) {
    const active = state.tags.exit === reason.value;
    refs.exitTags.append(el('button', {
      class: 'tag-chip',
      type: 'button',
      text: reason.label,
      'aria-pressed': String(active),
      onclick: () => {
        state.tags.exit = active ? null : reason.value;
        renderTagChips();
      },
    }));
  }
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

  const override = refs.riskOverride.value.trim();
  const note = refs.noteInput.value.trim();

  // Against the working date, not the real one: the whole point of a backtest
  // is that its calendar is simulated. The clock supplies only the time.
  const stamp = stampFor(state.workingDate);
  const soFar = state.trades.filter((t) => dayKey(t) === state.workingDate).length;

  const optional = (input) => {
    const raw = input.value.trim();
    if (raw === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };

  // Resolved here and stored, so editing the session later cannot re-price a
  // trade that has already happened.
  const before = riskFor(session, state.trades);
  const risk = override === '' ? before : Math.max(Number(override), 0);

  const optimistic = {
    id: `pending-${Date.now()}`,
    session_id: session.id,
    outcome,
    risk_amount: Number(risk.toFixed(2)),
    amount: Number(tradeResult(outcome, risk, session.reward_ratio).toFixed(2)),
    session_tag: state.tags.session,
    setup_tag: state.tags.setup,
    note: note || null,
    traded_at: stamp,
    trade_of_day: soFar + 1,
    exit_reason: state.tags.exit,
    mfe: optional(refs.mfeInput),
    mae: optional(refs.maeInput),
    created_at: new Date().toISOString(),
  };

  state.trades.push(optimistic);
  refs.riskOverride.value = '';
  refs.noteInput.value = '';
  refs.mfeInput.value = '';
  refs.maeInput.value = '';
  // The exit reason is per-trade, unlike the session and setup tags which
  // usually repeat across a run.
  state.tags.exit = null;
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
    announceRiskChange(session, before);
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
      el('th', { text: 'Date' }),
      el('th', { text: 'Outcome' }),
      el('th', { class: 'align-right', text: 'Result' }),
      el('th', { class: 'align-right', text: 'Risked' }),
      el('th', { text: 'Session' }),
      el('th', { text: 'Setup' }),
      el('th', { text: 'Note' }),
      el('th', { class: 'align-right', text: 'Actions' }),
    ])),
  ]);

  const body = el('tbody');
  [...state.trades].reverse().forEach((trade, offset) => {
    const number = state.trades.length - offset;
    const amount = amountOf(trade, session, state.trades.length - 1 - offset);

    body.append(el('tr', {}, [
      el('td', { class: 'num num--muted', text: String(number) }),
      el('td', { class: 'nowrap' }, [
        el('span', { text: formatWorkingDate(dayKey(trade)) }),
        // Its place within its own day, which is what the analysis reads.
        el('span', { class: 'num num--muted day-tag', text: `#${trade.trade_of_day ?? '?'}` }),
      ]),
      el('td', {}, el('span', { class: `chip chip--${trade.outcome}`, text: trade.outcome })),
      el('td', {
        class: `align-right num ${amount > 0 ? 'num--positive' : amount < 0 ? 'num--negative' : 'num--muted'}`,
        text: formatSignedMoney(amount),
      }),
      el('td', {
        class: 'align-right num num--muted',
        text: formatMoney(trade.risk_amount ?? riskInForce(session, state.trades.length - 1 - offset)),
      }),
      el('td', { text: trade.session_tag ?? '—' }),
      el('td', { text: trade.setup_tag ?? '—' }),
      el('td', { class: 'truncate', text: trade.note ?? '—' }),
      el('td', { class: 'align-right' }, el('div', { class: 'row row-end' }, [
        el('button', {
          class: 'btn btn--ghost btn--sm',
          type: 'button',
          text: 'Move',
          title: 'Change the date this trade is logged against',
          onclick: () => openDateModal(trade),
        }),
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

function openDateModal(trade) {
  state.movingTrade = trade.id;
  showBanner(refs.dateError, null);
  clearFieldErrors(refs.dateForm);

  const current = dayKey(trade);
  refs.tradeDate.value = current ?? state.workingDate ?? todayISO();
  refs.dateContext.textContent =
    `Currently ${formatWorkingDate(current)}, trade #${trade.trade_of_day ?? '?'} of that day.`;

  refs.dateModal.showModal();
  refs.tradeDate.focus();
}

/**
 * Moves a trade to another day.
 *
 * Both days have to be renumbered, not just the new one: pulling the second
 * trade out of a day leaves the third still calling itself the third, and the
 * whole trade-number breakdown reads from that field.
 */
async function moveTrade(event) {
  event.preventDefault();
  showBanner(refs.dateError, null);

  const trade = state.trades.find((t) => t.id === state.movingTrade);
  if (!trade) return;

  const target = refs.tradeDate.value;
  if (!parseISODate(target)) {
    failField(refs.tradeDate, 'Pick a date.');
    return;
  }

  const from = dayKey(trade);
  if (target === from) {
    refs.dateModal.close();
    return;
  }

  const previous = { traded_at: trade.traded_at, trade_of_day: trade.trade_of_day };
  const clock = new Date(trade.traded_at ?? trade.created_at ?? Date.now());

  trade.traded_at = stampFor(target, clock);
  const renumbered = renumberDays(from, target);
  renderSession();

  setBusy(refs.dateSubmit, true, 'Moving…');
  try {
    const { error } = await supabase.from('backtest_trades').upsert(renumbered, { onConflict: 'id' });
    if (error) {
      logWriteFailure('Move trade', renumbered[0], error);
      throw new Error(describeError(error, 'Couldn’t move that trade.'));
    }
    refs.dateModal.close();
    toast(`Moved to ${formatWorkingDate(target)}.`, { type: 'success', duration: 2200 });
  } catch (error) {
    Object.assign(trade, previous);
    renumberDays(from, target);
    renderSession();
    showBanner(refs.dateError, error.message);
  } finally {
    setBusy(refs.dateSubmit, false);
  }
}

/**
 * Renumbers `trade_of_day` on the given days and returns the rows that changed,
 * ready to upsert. Mutates local state first so the table is right immediately.
 */
function renumberDays(...days) {
  const touched = new Set(days.filter(Boolean));
  const changed = [];

  for (const day of touched) {
    const onDay = state.trades
      .filter((trade) => dayKey(trade) === day)
      .sort((a, b) => String(a.traded_at ?? a.created_at).localeCompare(String(b.traded_at ?? b.created_at)));

    onDay.forEach((trade, index) => {
      const n = index + 1;
      if (trade.trade_of_day === n && !changed.some((row) => row.id === trade.id)) return;
      trade.trade_of_day = n;
      changed.push({
        id: trade.id,
        session_id: trade.session_id,
        outcome: trade.outcome,
        traded_at: trade.traded_at,
        trade_of_day: n,
      });
    });
  }
  return changed;
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
    if (error) {
      logWriteFailure('Trade edit', patch, error);
      throw new Error(describeError(error, 'Couldn’t save that trade.'));
    }
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
    equityAreaChart(refs.equity, {
      labels: ['Start', ...trades.map((_, i) => String(i + 1))],
      values: equitySeries(trades, session),
      animate: first,
    });
    refs.equityTotal.textContent = formatSignedMoney(stats.total);
    refs.equityTotal.className = `panel__total${stats.total < 0 ? ' is-negative' : ''}`;
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
/*
 * Read-only throughout. Backtest sessions and live trading accounts are pulled
 * into one shape, compared, and never written to. Nothing crosses between the
 * two sets of tables in either direction.
 */

const COMPARE_KEY = 'streak.compare_selection';
const MAX_COMPARE = 6;
const MIN_COMPARE = 2;

export const COMPARE_METRICS = [
  { key: 'winRate', label: 'Win rate', format: (v) => `${Math.round(v)}%` },
  { key: 'net', label: 'Net result', money: true },
  { key: 'expectancy', label: 'Per trade', money: true },
  { key: 'count', label: 'Trades', format: (v) => String(Math.round(v)) },
  { key: 'profitFactor', label: 'Profit factor', format: (v) => v.toFixed(2) },
];

/**
 * One metric set from a normalised trade list. Both sources reduce to
 * `{ outcome, amount, setup, session }` before they get here, so a backtest and
 * a live account are measured by exactly the same arithmetic.
 */
export function compareMetrics(trades) {
  const wins = trades.filter((t) => t.outcome === 'win').length;
  const losses = trades.filter((t) => t.outcome === 'loss').length;
  const decided = wins + losses;
  const amounts = trades.map((t) => num(t.amount));
  const net = amounts.reduce((a, b) => a + b, 0);
  const gross = amounts.reduce((a, b) => a + Math.max(b, 0), 0);
  const bled = Math.abs(amounts.reduce((a, b) => a + Math.min(b, 0), 0));

  return {
    count: trades.length,
    winRate: decided ? (wins / decided) * 100 : null,
    net,
    expectancy: trades.length ? net / trades.length : null,
    profitFactor: bled ? gross / bled : (gross ? Infinity : null),
    bestSetup: topTag(trades, 'setup'),
    bestSession: topTag(trades, 'session'),
  };
}

/** Best win rate for a tag, needing at least three trades to count. */
export function topTag(trades, field, minimum = 3) {
  const map = new Map();
  for (const trade of trades) {
    const tag = trade[field];
    if (!tag || trade.outcome === 'breakeven') continue;
    const entry = map.get(tag) ?? { tag, wins: 0, count: 0 };
    if (trade.outcome === 'win') entry.wins += 1;
    entry.count += 1;
    map.set(tag, entry);
  }
  const ranked = [...map.values()]
    .filter((e) => e.count >= minimum)
    .map((e) => ({ tag: e.tag, rate: (e.wins / e.count) * 100, count: e.count }))
    .sort((a, b) => b.rate - a.rate || b.count - a.count);
  return ranked[0] ?? null;
}

/** Running total from zero, so curves of any size can share one axis. */
export function normalisedCurve(trades) {
  let running = 0;
  const values = [0];
  for (const trade of trades) {
    running += num(trade.amount);
    values.push(Number(running.toFixed(2)));
  }
  return values;
}

export function loadSelection(profileId) {
  try {
    const raw = JSON.parse(localStorage.getItem(`${COMPARE_KEY}.${profileId}`) ?? '[]');
    return Array.isArray(raw) ? raw.filter((k) => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function saveSelection(profileId, keys) {
  localStorage.setItem(`${COMPARE_KEY}.${profileId}`, JSON.stringify(keys));
}

/** Every account in the journal. Read only — this section never writes there. */
async function fetchLiveAccounts() {
  const { data, error } = await supabase
    .from('trading_accounts')
    .select('id, name, status')
    .eq('profile_id', state.profile.id)
    .order('created_at', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load your trading accounts.'));
  return data ?? [];
}

async function fetchLiveTrades(accountIds) {
  if (!accountIds.length) return [];
  const { data, error } = await supabase
    .from('trades')
    .select('account_id, outcome, pnl, setup, session, date, created_at')
    .in('account_id', accountIds)
    .order('date', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load your journal trades.'));
  return data ?? [];
}

/**
 * Both sources flattened to the same shape. From here on a backtest session and
 * a live account are indistinguishable to the arithmetic, which is the only way
 * the comparison means anything.
 */
async function loadCandidates() {
  const [backtestTrades, accounts] = await Promise.all([
    fetchAllTrades(state.sessions.map((s) => s.id)),
    fetchLiveAccounts(),
  ]);
  const liveTrades = await fetchLiveTrades(accounts.map((a) => a.id));

  const candidates = [];

  state.sessions.forEach((session) => {
    const mine = backtestTrades.filter((r) => r.session_id === session.id);
    candidates.push({
      key: `backtest:${session.id}`,
      kind: 'backtest',
      name: session.name,
      live: false,
      trades: mine.map((t, i) => ({
        outcome: t.outcome,
        amount: amountOf(t, session, i),
        setup: t.setup_tag,
        session: t.session_tag,
      })),
    });
  });

  accounts.forEach((account) => {
    const mine = liveTrades.filter((t) => t.account_id === account.id);
    candidates.push({
      key: `live:${account.id}`,
      kind: 'live',
      name: account.name,
      live: true,
      trades: mine.map((t) => ({
        outcome: t.outcome,
        amount: num(t.pnl),
        setup: t.setup,
        session: t.session,
      })),
    });
  });

  return candidates;
}

async function openCompare() {
  show('compare');
  window.location.hash = 'compare';
  clear(refs.compareTable).append(skeletonList(2, 'skeleton--text'));

  try {
    state.candidates = await loadCandidates();
  } catch (error) {
    clear(refs.compareTable).append(emptyState({ title: 'Couldn’t compare', body: error.message }));
    return;
  }

  const remembered = loadSelection(state.profile.id)
    .filter((key) => state.candidates.some((c) => c.key === key));
  state.selection = remembered.length
    ? remembered
    : state.candidates.slice(0, MIN_COMPARE).map((c) => c.key);

  renderPicker();
  renderCompare();
}

function renderPicker() {
  clear(refs.picker);

  const group = (title, kind) => {
    const items = state.candidates.filter((c) => c.kind === kind);
    if (!items.length) return null;

    const box = el('div', { class: 'picker-group' }, [
      el('span', { class: 'picker-group__title', text: title }),
    ]);

    for (const item of items) {
      const chosen = state.selection.includes(item.key);
      const full = state.selection.length >= MAX_COMPARE && !chosen;

      const checkbox = el('input', {
        type: 'checkbox',
        checked: chosen,
        disabled: full,
      });
      checkbox.addEventListener('change', () => toggleCandidate(item.key, checkbox.checked));

      box.append(el('label', {
        class: `picker-item${full ? ' is-full' : ''}`,
        title: full ? `Up to ${MAX_COMPARE} at a time` : item.name,
      }, [
        checkbox,
        el('span', {
          class: 'picker-item__swatch',
          style: `background: ${colourFor(item.key)}`,
          'aria-hidden': 'true',
        }),
        el('span', { class: 'picker-item__name', text: item.name }),
        item.live ? el('span', { class: 'pill pill--live', text: 'Live' }) : null,
        el('span', { class: 'picker-item__count num', text: `${item.trades.length}` }),
      ]));
    }
    return box;
  };

  refs.picker.append(
    group('Backtest sessions', 'backtest'),
    group('Trading accounts · live', 'live'),
  );
  refs.pickerNote.textContent =
    `${state.selection.length} selected · pick between ${MIN_COMPARE} and ${MAX_COMPARE}`;
}

/** Colour follows the item, keyed to its position in the full candidate list. */
function colourFor(key) {
  const index = state.candidates.findIndex((c) => c.key === key);
  return seriesColor(index < 0 ? 0 : index % 6);
}

function toggleCandidate(key, on) {
  if (on && state.selection.length >= MAX_COMPARE) return;
  state.selection = on
    ? [...state.selection, key]
    : state.selection.filter((k) => k !== key);
  saveSelection(state.profile.id, state.selection);
  renderPicker();
  renderCompare();
}

function renderCompare() {
  const chosen = state.selection
    .map((key) => state.candidates.find((c) => c.key === key))
    .filter(Boolean)
    .map((item) => ({ ...item, metrics: compareMetrics(item.trades) }));

  clear(refs.compareTable);
  clear(refs.compareLegend);

  if (chosen.length < MIN_COMPARE) {
    refs.compareTable.append(emptyState({
      title: `Pick at least ${MIN_COMPARE}`,
      body: 'Tick two or more above — any mix of backtest sessions and live accounts.',
    }));
    refs.compareChart.hidden = true;
    refs.curveChart.hidden = true;
    return;
  }

  refs.compareChart.hidden = false;
  refs.curveChart.hidden = false;

  // One shared HTML legend: it carries the live badge, which a canvas legend
  // cannot, and it serves both charts below.
  for (const item of chosen) {
    refs.compareLegend.append(el('span', { class: 'legend__item' }, [
      el('span', {
        class: 'legend__dot',
        style: `background: ${colourFor(item.key)}`,
        'aria-hidden': 'true',
      }),
      el('span', { text: item.name }),
      item.live ? el('span', { class: 'pill pill--live', text: 'Live' }) : null,
    ]));
  }

  renderMetricChart(chosen);

  multiEquityChart(refs.curveChart, {
    series: chosen.map((item) => ({
      label: item.live ? `${item.name} (live)` : item.name,
      values: normalisedCurve(item.trades),
      color: colourFor(item.key),
      live: item.live,
    })),
    animate: !drawn.has(refs.curveChart),
  });
  drawn.add(refs.curveChart);

  renderCompareTable(chosen);
}

/**
 * One metric at a time. A win rate, a dollar figure and a ratio cannot honestly
 * share a y-axis, so the metric is chosen rather than crammed in beside the
 * others on a scale that would flatter one of them.
 */
function renderMetricChart(chosen) {
  const metric = COMPARE_METRICS.find((m) => m.key === state.metric) ?? COMPARE_METRICS[0];
  const values = chosen.map((item) => {
    const raw = item.metrics[metric.key];
    if (raw === null || raw === Infinity) return 0;
    return Number(Number(raw).toFixed(2));
  });

  metricBarsChart(refs.compareChart, {
    labels: chosen.map((item) => item.name),
    values,
    colors: chosen.map((item) => colourFor(item.key)),
    format: metric.money ? (v) => compactMoney(v) : metric.format,
    animate: !drawn.has(refs.compareChart),
  });
  drawn.add(refs.compareChart);
}

function renderCompareTable(chosen) {
  const cell = (value, extra = '') => el('td', { class: `align-right num ${extra}`, text: value });

  const table = el('table', { class: 'table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Item' }),
      el('th', { class: 'align-right', text: 'Trades' }),
      el('th', { class: 'align-right', text: 'Win rate' }),
      el('th', { class: 'align-right', text: 'Net' }),
      attachTipTo(el('th', { class: 'align-right', text: 'Per trade' }), GLOSSARY.expectancy),
      attachTipTo(el('th', { class: 'align-right', text: 'Profit factor' }), GLOSSARY.profitFactor),
      el('th', { text: 'Best setup' }),
      el('th', { text: 'Best session' }),
    ])),
  ]);

  const body = el('tbody');
  for (const item of chosen) {
    const m = item.metrics;
    body.append(el('tr', {}, [
      el('td', {}, el('span', { class: 'row' }, [
        el('span', {
          class: 'legend__dot',
          style: `background: ${colourFor(item.key)}`,
          'aria-hidden': 'true',
        }),
        el('span', { text: item.name }),
        item.live ? el('span', { class: 'pill pill--live', text: 'Live' }) : null,
      ])),
      cell(String(m.count)),
      cell(m.winRate === null ? '—' : `${Math.round(m.winRate)}%`),
      cell(formatSignedMoney(m.net), m.net >= 0 ? 'num--positive' : 'num--negative'),
      cell(
        m.expectancy === null ? '—' : formatSignedMoney(m.expectancy),
        (m.expectancy ?? 0) >= 0 ? 'num--positive' : 'num--negative',
      ),
      cell(m.profitFactor === null ? '—'
        : m.profitFactor === Infinity ? '∞'
        : m.profitFactor.toFixed(2)),
      el('td', { text: m.bestSetup ? `${m.bestSetup.tag} · ${Math.round(m.bestSetup.rate)}% of ${m.bestSetup.count}` : '—' }),
      el('td', { text: m.bestSession ? `${m.bestSession.tag} · ${Math.round(m.bestSession.rate)}% of ${m.bestSession.count}` : '—' }),
    ]));
  }
  table.append(body);
  refs.compareTable.append(el('div', { class: 'table-wrap' }, table));
}



/* ------------------------------------------------------- analysis render -- */

/**
 * What each panel measures, in words someone who doesn't trade could follow.
 *
 * Every one says what a good result looks like and what a bad one looks like,
 * because a chart that tells you nothing about which way is better is just
 * decoration.
 */
const PANEL_HELP = {
  anNumberMeta: 'Splits your trades by whether they were the first, second, third and so on of that day. Good: the later ones earn about as much as the early ones. Bad: a strong first trade and losses after it — that means you keep trading once your edge is spent.',
  anCapMeta: 'Replays your real history as if you had stopped after a set number of trades each day. If a low cap makes more than taking everything, over-trading is costing you. It needs several days behind it before the answer means anything.',
  anAfterMeta: 'Compares the very next trade after a win with the very next trade after a loss. Good: they look about the same. Bad: a much lower win rate after a loss, which usually means chasing it back.',
  anStopMeta: 'Replays your history as if you had stopped for the rest of the day once you had taken one loss, or two. If stopping earns more than trading on, your bad days are where the damage is done.',
  anHourMeta: 'Which hours of the day you actually make money in. Good: one or two hours clearly and repeatedly ahead. Bad: no pattern — which means the clock is not your problem.',
  anWeekdayMeta: 'Which weekdays you make money on. Only worth acting on when one day is clearly different again and again, not just once.',
  anExitMeta: 'How each trade ended — the target filled, the stop hit, or you closed it by hand. If your manual exits pay less per trade than your targets do, closing early is costing you money.',
  anMfeMeta: 'Uses how far your trades actually travelled to work out what a bigger or smaller target would have paid. Tells you whether your target is too near, so you leave money behind, or too far, so winners turn around before they reach it.',
  anRunsMeta: 'How long your losing streaks got, and how often each length happened. The longest run is the one to size for — whatever it was, it will happen again.',
};

/** Terms that appear in figures rather than titles. */
const GLOSSARY = {
  mfe: 'MFE, or maximum favourable excursion: how far a trade travelled in your favour before it closed, counted in R. A trade that ran 2R your way before you closed it for 1R has an MFE of 2 — you were right, and you left half of it behind.',
  mae: 'MAE, or maximum adverse excursion: how far a trade travelled against you before it closed, counted in R. A high MAE on your winners means you are getting them right but sitting through a lot of pain first.',
  expectancy: 'Expectancy is what one trade is worth on average, wins and losses counted together. Positive means the average trade makes money. It is the number that matters more than win rate — a 30% win rate can beat a 70% one if the wins are big enough.',
  profitFactor: 'Profit factor is everything you won divided by everything you lost. Above 1 means you are ahead. 2 means you made two dollars for every one you gave back.',
  r: 'R is one unit of risk — what you lose if the stop hits. Counting in R instead of money lets you compare trades taken at different sizes.',
};

/** Hangs the ⓘ explanations on the panels. Runs once, after refs are bound. */
function mountPanelHelp() {
  for (const [ref, text] of Object.entries(PANEL_HELP)) {
    const meta = refs[ref];
    // The tip belongs beside the title, not beside the sample count.
    attachTip(meta?.closest('.panel__head')?.querySelector('.panel__label'), text);
  }
  attachTip(refs.anAfterMeta?.closest('.panel')?.querySelector('.hint'), GLOSSARY.expectancy);
}

/** `attachTip` that returns the node, for use inline in an element tree. */
function attachTipTo(node, text) {
  attachTip(node, text);
  return node;
}

/** The sentence under a chart. Replaces whatever was there. */
function showVerdict(anchor, verdict) {
  const panel = anchor?.closest('.panel');
  if (!panel) return;

  panel.querySelector('.verdict')?.remove();
  panel.append(el('div', {
    class: `verdict verdict--${verdict.tone}`,
  }, [
    el('span', { 'aria-hidden': 'true', text: verdict.tone === 'plain' ? '→' : '·' }),
    el('p', { text: verdict.text }),
  ]));
}

/**
 * The sample line every breakdown carries: what it rests on, what it dropped,
 * and whether that is enough to believe.
 */
function renderMeta(node, { n, excluded = 0, missing = 'no data' }) {
  clear(node);
  node.append(el('span', { class: 'sample__n', text: `n = ${n}` }));

  if (excluded > 0) {
    node.append(el('span', {
      class: 'sample__excluded',
      text: `${excluded} excluded · ${missing}`,
    }));
  }
  if (n < THIN_DATA) {
    node.append(el('span', { class: 'pill pill--thin', text: 'Thin data' }));
  }
}

/** True when the breakdown has nothing to draw. Leaves an empty state behind. */
function noRows(result, mount, message) {
  clear(mount);
  if (result.rows.length) return false;
  mount.append(el('p', { class: 'muted', text: message }));
  return true;
}

const pct = (value) => (value === null ? '—' : `${Math.round(value)}%`);

function renderAnalysis() {
  const session = currentSession();
  if (!session || state.view !== 'analysis') return;

  refs.analysisName.textContent = session.name;
  const trades = state.trades;

  renderTradeNumber(trades);
  renderCapSim(trades);
  renderAfterOutcome(trades);
  renderStopAfterLoss(trades);
  renderClockBreakdown(trades);
  renderExitReasons(trades);
  renderExcursions(trades);
  renderLossRuns(trades);
}

function renderTradeNumber(trades) {
  const result = byTradeNumber(trades);
  renderMeta(refs.anNumberMeta, { ...result, missing: 'beyond the tenth of a day' });
  showVerdict(refs.anNumberMeta, tradeNumberVerdict(result));
  if (noRows(result, refs.anNumberEmpty, 'No trades logged yet.')) return;

  // A win rate over one trade is 100% or 0% — a single outcome wearing a
  // percentage sign. Positions that thin are left off the chart rather than
  // drawn as though they meant something.
  const solid = result.rows.filter((row) => row.count >= MIN_RATE_SAMPLE);
  const rateBox = refs.anNumberRate.closest('.chart');

  if (!solid.length) {
    rateBox.hidden = true;
    refs.anNumberEmpty.append(el('p', {
      class: 'muted',
      text: `Win rate is hidden here until a position has ${MIN_RATE_SAMPLE} trades behind it. `
        + `Right now the most any position has is ${Math.max(...result.rows.map((r) => r.count))}, `
        + `so every bar would read 100% or 0% and tell you nothing. The net figures on the right still count.`,
    }));
  } else {
    rateBox.hidden = false;
    rateBarsChart(refs.anNumberRate, {
      labels: solid.map((row) => `#${row.n}`),
      values: solid.map((row) => (row.winRate === null ? 0 : row.winRate)),
      counts: solid.map((row) => row.count),
      animate: !drawn.has(refs.anNumberRate),
    });
    drawn.add(refs.anNumberRate);

    if (solid.length < result.rows.length) {
      refs.anNumberEmpty.append(el('p', {
        class: 'muted',
        text: `${result.rows.length - solid.length} position${result.rows.length - solid.length === 1 ? ' is' : 's are'} `
          + `left off the win-rate chart for having under ${MIN_RATE_SAMPLE} trades.`,
      }));
    }
  }

  // Net is a sum, not a rate, so one trade is still a real figure.
  signedBarChart(refs.anNumberNet, {
    labels: result.rows.map((row) => `#${row.n}`),
    values: result.rows.map((row) => Number(row.net.toFixed(2))),
    counts: result.rows.map((row) => row.count),
  });
}

function renderCapSim(trades) {
  const result = capSimulation(trades);
  state.capResult = result;
  renderMeta(refs.anCapMeta, result);
  showVerdict(refs.anCapMeta, capVerdict(result));
  if (noRows(result, refs.anCapEmpty, 'No trades logged yet.')) return;

  signedBarChart(refs.anCapChart, {
    labels: result.rows.map((row) => String(row.cap)),
    values: result.rows.map((row) => Number(row.net.toFixed(2))),
    counts: result.rows.map((row) => row.count),
  });
  renderCapNote();
}

/** The slider reads the already-computed table; it recomputes nothing. */
function renderCapNote() {
  const result = state.capResult;
  if (!result) return;

  const cap = Number(refs.anCapSlider.value);
  const row = result.rows.find((r) => r.cap === cap);
  refs.anCapValue.textContent = String(cap);
  if (!row) return;

  const kept = `${row.count} of ${result.n} trades kept · ${formatSignedMoney(row.net)} · `
    + `${pct(row.winRate)} win rate.`;

  // Naming a "best cap" over a single day would be describing hindsight as a
  // rule: with one trade at each position, the best cap is only the one that
  // happens to exclude the worst trade.
  if (!result.meaningful) {
    refs.anCapNote.textContent =
      `${kept} No best cap yet — that needs trades across about ${MIN_CAP_DAYS} days, and this session has ${result.days}.`;
    return;
  }

  const best = result.best;
  const bestNote = best && best.cap !== cap
    ? ` Best is a cap of ${best.cap}, at ${formatSignedMoney(best.net)}.`
    : ' That is the best cap in this session.';

  refs.anCapNote.textContent = kept + bestNote;
}

function renderAfterOutcome(trades) {
  const result = afterOutcome(trades);
  renderMeta(refs.anAfterMeta, {
    ...result,
    missing: 'first trade, or followed a breakeven',
  });
  showVerdict(refs.anAfterMeta, afterOutcomeVerdict(result));

  clear(refs.anAfterStats);
  for (const row of result.rows) {
    refs.anAfterStats.append(el('div', { class: 'stat' }, [
      el('span', { class: 'stat__label', text: row.label }),
      el('span', { class: 'stat__value num', text: pct(row.winRate) }),
      el('span', {
        class: `stat__meta num ${row.net >= 0 ? 'num--positive' : 'num--negative'}`,
        text: row.expectancy === null
          ? `${row.count} trades`
          : `${formatSignedMoney(row.expectancy)} a trade · ${row.count} trades`,
      }),
    ]));
  }
}

function renderStopAfterLoss(trades) {
  const result = stopAfterLoss(trades);
  renderMeta(refs.anStopMeta, result);
  showVerdict(refs.anStopMeta, stopVerdict(result));

  signedBarChart(refs.anStopChart, {
    labels: result.rows.map((row) => row.label),
    values: result.rows.map((row) => Number(row.net.toFixed(2))),
    counts: result.rows.map((row) => row.count),
  });

  clear(refs.anStopTable);
  refs.anStopTable.append(simpleTable(
    ['Rule', 'Trades', 'Win rate', 'Net'],
    result.rows.map((row) => [
      row.label,
      String(row.count),
      pct(row.winRate),
      { money: row.net },
    ]),
  ));
}

function renderClockBreakdown(trades) {
  const pairs = [
    [byHour(trades), refs.anHourMeta, refs.anHourRate, refs.anHourNet, refs.anHourEmpty, 'hour'],
    [byWeekday(trades), refs.anWeekdayMeta, refs.anWeekdayRate, refs.anWeekdayNet, refs.anWeekdayEmpty, 'day'],
  ];

  for (const [result, meta, rateCanvas, netCanvas, empty, unit] of pairs) {
    renderMeta(meta, { ...result, missing: 'no timestamp' });
    showVerdict(meta, clockVerdict(result, unit));
    if (noRows(result, empty, 'Nothing logged with a timestamp yet.')) continue;

    // Same rule as trade number: a rate needs a sample before it is a rate.
    const solid = result.rows.filter((row) => row.count >= MIN_RATE_SAMPLE);
    const rateBox = rateCanvas.closest('.chart');
    rateBox.hidden = solid.length === 0;

    if (!solid.length) {
      empty.append(el('p', {
        class: 'muted',
        text: `Win rate is hidden until one ${unit} has ${MIN_RATE_SAMPLE} trades behind it. `
          + `The net figures still count.`,
      }));
    } else {
      rateBarsChart(rateCanvas, {
        labels: solid.map((row) => row.label),
        values: solid.map((row) => (row.winRate === null ? 0 : row.winRate)),
        counts: solid.map((row) => row.count),
        animate: !drawn.has(rateCanvas),
      });
      drawn.add(rateCanvas);
    }

    signedBarChart(netCanvas, {
      labels: result.rows.map((row) => row.label),
      values: result.rows.map((row) => Number(row.net.toFixed(2))),
      counts: result.rows.map((row) => row.count),
    });
  }
}

function renderExitReasons(trades) {
  const result = byExitReason(trades);
  renderMeta(refs.anExitMeta, { ...result, missing: 'no exit reason recorded' });
  showVerdict(refs.anExitMeta, exitVerdict(result));
  if (noRows(result, refs.anExitTable, 'No exit reasons recorded yet. Add one when you log a trade.')) return;

  signedBarChart(refs.anExitChart, {
    labels: result.rows.map((row) => row.label),
    values: result.rows.map((row) => Number(row.net.toFixed(2))),
    counts: result.rows.map((row) => row.count),
  });

  refs.anExitTable.append(simpleTable(
    ['Exit', 'Trades', 'Share', 'Win rate', 'Net'],
    result.rows.map((row) => [
      row.label,
      String(row.count),
      `${Math.round((row.count / result.n) * 100)}%`,
      pct(row.winRate),
      { money: row.net },
    ]),
  ));
}

function renderExcursions(trades) {
  const excursions = mfeStats(trades);
  renderMeta(refs.anMfeMeta, { ...excursions, missing: 'no MFE recorded' });

  clear(refs.anMfeTable);
  refs.anMfeTable.append(simpleTable(
    ['', 'Trades', { text: 'Average MFE', tip: GLOSSARY.mfe }, { text: 'Average MAE', tip: GLOSSARY.mae }],
    excursions.rows.map((row) => [
      row.label,
      String(row.count),
      row.mfe === null ? '—' : `${row.mfe.toFixed(2)}R`,
      row.mae === null ? '—' : `${row.mae.toFixed(2)}R`,
    ]),
  ));

  const ratios = ratioSimulation(trades);
  showVerdict(refs.anMfeMeta, excursionVerdict(excursions, ratios));
  const unresolved = ratios.rows.reduce((most, row) => Math.max(most, row.unresolved), 0);

  refs.anRatioNote.textContent = ratios.n === 0
    ? 'Record MFE and MAE on your trades to rebuild what each target would have paid.'
    : `Rebuilt from ${ratios.n} trades with both MFE and MAE. A trade counts as a `
      + `win where MFE reached the target, and a loss where MAE reached 1R. `
      + `${unresolved > 0 ? `Up to ${unresolved} reached neither and are left out of the totals. ` : ''}`
      + `MFE and MAE don’t record which came first, so read this as a prompt to look, not a verdict.`;

  if (!ratios.n) {
    signedBarChart(refs.anRatioChart, { labels: [], values: [], counts: [] });
    return;
  }
  signedBarChart(refs.anRatioChart, {
    labels: ratios.rows.map((row) => row.label),
    values: ratios.rows.map((row) => Number(row.net.toFixed(2))),
    counts: ratios.rows.map((row) => row.wins + row.losses),
  });
}

function renderLossRuns(trades) {
  const result = lossRuns(trades);
  renderMeta(refs.anRunsMeta, result);
  showVerdict(refs.anRunsMeta, runsVerdict(result));

  refs.anRunsNote.textContent = result.longest === 0
    ? 'No losing runs yet.'
    : `Longest losing run: ${result.longest} in a row. A breakeven ends a run without joining it.`;

  countBarChart(refs.anRunsChart, {
    labels: result.rows.map((row) => `${row.length} in a row`),
    values: result.rows.map((row) => row.count),
    unit: 'run',
  });
}

/** A plain table. A cell of `{ money }` is formatted and coloured as currency. */
function simpleTable(headers, rows) {
  const table = el('table', { class: 'table' }, [
    el('thead', {}, el('tr', {}, headers.map((head, i) => {
      // A header may be a plain string, or `{ text, tip }` to carry an ⓘ.
      const cell = el('th', {
        class: i === 0 ? '' : 'align-right',
        text: typeof head === 'string' ? head : head.text,
      });
      if (typeof head === 'object' && head.tip) attachTip(cell, head.tip);
      return cell;
    }))),
  ]);

  const body = el('tbody');
  for (const row of rows) {
    body.append(el('tr', {}, row.map((cell, i) => {
      if (cell !== null && typeof cell === 'object' && 'money' in cell) {
        return el('td', {
          class: `align-right num ${cell.money >= 0 ? 'num--positive' : 'num--negative'}`,
          text: formatSignedMoney(cell.money),
        });
      }
      return el('td', { class: i === 0 ? '' : 'align-right num', text: String(cell) });
    })));
  }

  table.append(body);
  return el('div', { class: 'table-wrap' }, table);
}

/* ---------------------------------------------------------------- writes -- */

/**
 * Which field a rejected constraint belongs to. Postgres names the constraint
 * it enforced; this turns that name into the input that has to change.
 *
 * Keyed on a substring so it survives however the constraint was named — the
 * schema may carry `backtest_sessions_risk_mode_check` or just `risk_mode`.
 */
const CONSTRAINT_FIELDS = [
  // Named rules first: these carry no column name, so the substring matches
  // below would never catch them.
  ['step_complete', 'newMode',
    'The database still requires the stepped fields in every mode. Run the step-completeness migration.'],
  ['adaptive_complete', 'newTrigger',
    'Adaptive mode needs all of its fields filled in before the database will accept it.'],
  ['risk_mode', 'newMode', 'This database doesn’t accept that risk mode yet. Run the adaptive-mode migration.'],
  ['drawdown_reference', 'newTrigger', 'The reference point wasn’t accepted. Run the drawdown-reference migration.'],
  ['drawdown_trigger', 'newTrigger', 'That trigger was rejected by the database.'],
  ['drawdown_unit', 'newTrigger', 'The trigger unit wasn’t accepted. Run the adaptive-mode migration.'],
  ['risk_reduction', 'newReduction', 'That reduction was rejected by the database.'],
  ['reduction_unit', 'newReduction', 'The reduction unit wasn’t accepted. Run the adaptive-mode migration.'],
  ['recovery_mode', 'newRecovery', 'That recovery mode wasn’t accepted. Run the adaptive-mode migration.'],
  ['risk_step_trades', 'newStepTrades', 'That step interval was rejected by the database.'],
  ['risk_step_amount', 'newStepAmount', 'That step amount was rejected by the database.'],
  ['starting_balance', 'newBalance', 'The database won’t accept that starting balance.'],
  ['risk_amount', 'newRisk', 'The database won’t accept that risk amount.'],
  ['reward_ratio', 'newRatio', 'The database won’t accept that reward ratio.'],
  ['name', 'newName', 'That name was rejected. Try a different one.'],
];

/**
 * Points at the field the database complained about. Falls back to the banner
 * when the failure isn't about any one field.
 */
function blameField(error, message) {
  const named = `${constraintOf(error) ?? ''} ${columnOf(error) ?? ''}`;
  const hit = CONSTRAINT_FIELDS.find(([column]) => named.includes(column));

  if (hit && refs[hit[1]]) {
    showBanner(refs.newError, message);
    failField(refs[hit[1]], hit[2]);
    return;
  }
  showBanner(refs.newError, message);
}

/**
 * Everything about a failed write, in one console group.
 *
 * Kept deliberately: a check-constraint rejection is a conversation between the
 * form and the schema, and neither half is legible without the other.
 */
function logWriteFailure(label, payload, error) {
  // Flat and unconditional. No group to expand, no interactive object to drill
  // into — two blocks of text that can be read and pasted straight out.
  console.error(`Streak. — ${label} failed\n\nRAW SUPABASE ERROR:`);
  console.error(JSON.stringify(plainError(error), null, 2));
  console.error('PAYLOAD SENT:');
  console.error(JSON.stringify(payload, null, 2));

  // The live object too: it expands in the console and survives anything the
  // flattening above might have missed.
  console.error('error object:', error);
}

async function createSession(event) {
  event.preventDefault();
  showBanner(refs.newError, null);
  clearFieldErrors(refs.newForm);

  const name = refs.newName.value.trim();
  if (!name) return failField(refs.newName, 'Give the session a name.');

  const risk = Number(refs.newRisk.value);
  if (!Number.isFinite(risk) || risk <= 0) {
    return failField(refs.newRisk, 'Risk per trade has to be an amount above zero.');
  }
  const ratio = Number(refs.newRatio.value);
  if (!Number.isFinite(ratio) || ratio <= 0) {
    return failField(refs.newRatio, 'The reward ratio has to be a number above zero.');
  }

  const mode = refs.newMode.value;
  const stepped = mode === 'stepped';
  const adaptive = mode === 'adaptive';
  const stepTrades = stepped ? Number(refs.newStepTrades.value) : null;
  const stepAmount = stepped ? Number(refs.newStepAmount.value) : null;
  const trigger = adaptive ? Number(refs.newTrigger.value) : null;
  const reduction = adaptive ? Number(refs.newReduction.value) : null;

  if (stepped && (!Number.isFinite(stepTrades) || stepTrades < 1)) {
    return failField(refs.newStepTrades, 'Say how many trades pass before the risk changes.');
  }
  if (stepped && !Number.isFinite(stepAmount)) {
    return failField(refs.newStepAmount,
      'Say how much the risk changes by. A negative number steps it down.');
  }
  if (adaptive && (!Number.isFinite(trigger) || trigger <= 0)) {
    return failField(refs.newTrigger,
      `Say how far below your ${state.reference === 'starting_balance' ? 'starting balance' : 'peak'} the risk starts to come down.`);
  }
  if (adaptive && (!Number.isFinite(reduction) || reduction < 0)) {
    return failField(refs.newReduction, 'Say how much the risk comes down at each tier.');
  }
  if (adaptive && state.triggerUnit === 'percent' && trigger > 100) {
    return failField(refs.newTrigger, 'A drawdown trigger above 100% can never be reached.');
  }

  const values = {
    name,
    instrument: refs.newInstrument.value || null,
    timeframe: refs.newTimeframe.value || null,
    starting_balance: Number(refs.newBalance.value) || 0,
    risk_amount: risk,
    reward_ratio: ratio,
    risk_mode: mode,
    risk_step_trades: stepped ? stepTrades : null,
    risk_step_amount: stepped ? stepAmount : null,
    drawdown_trigger: adaptive ? trigger : null,
    drawdown_unit: adaptive ? state.triggerUnit : null,
    risk_reduction: adaptive ? reduction : null,
    reduction_unit: adaptive ? state.reductionUnit : null,
    recovery_mode: adaptive ? refs.newRecovery.value : null,
    // Kept at the column default rather than nulled, so the check constraint
    // holds and a session switched back to adaptive reads as "from peak".
    drawdown_reference: adaptive ? state.reference : 'peak',
    period_start: refs.newStart.value || null,
    period_end: refs.newEnd.value || null,
    notes: refs.newNotes.value.trim() || null,
  };

  // Editing an existing session leaves its logged trades exactly as they are.
  if (state.editingSession) {
    setBusy(refs.newSubmit, true, 'Saving…');
    try {
      const { data, error } = await supabase
        .from('backtest_sessions')
        .update(values)
        .eq('id', state.editingSession)
        .select(SESSION_COLUMNS)
        .single();
      if (error) {
        logWriteFailure('Session edit', values, error);
        blameField(error, describeError(error, 'Couldn’t save that session.'));
        return;
      }

      const index = state.sessions.findIndex((s) => s.id === data.id);
      if (index !== -1) state.sessions[index] = data;
      refs.newModal.close();
      toast('Session saved.', { type: 'success' });
      if (state.sessionId === data.id) renderSession();
      else renderSessions();
    } catch (error) {
      logWriteFailure('Session edit', values, error);
      showBanner(refs.newError, error.message);
    } finally {
      setBusy(refs.newSubmit, false);
    }
    return;
  }

  setBusy(refs.newSubmit, true, 'Creating…');
  try {
    const { data, error } = await supabase
      .from('backtest_sessions')
      .insert({ profile_id: state.profile.id, ...values })
      .select(SESSION_COLUMNS)
      .single();
    if (error) {
      logWriteFailure('Session create', { profile_id: state.profile.id, ...values }, error);
      blameField(error, describeError(error, 'Couldn’t create that session.'));
      return;
    }

    state.sessions.unshift(data);
    state.counts.set(data.id, { count: 0, winRate: null });
    refs.newModal.close();
    toast(`${name} created.`, { type: 'success' });
    await openSession(data.id);
  } catch (error) {
    logWriteFailure('Session create', values, error);
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
    // A row-level check rejects any update to the row, not just the column
    // being changed, so this can fail for a reason nothing to do with status.
    if (error) {
      logWriteFailure('Session status change', { id: session.id, status }, error);
      throw new Error(describeError(error, 'Couldn’t change the status.'));
    }
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

/**
 * The adaptive form's three either/or choices. They live in `state` rather than
 * in the DOM because the summary sentence has to read all of them at once.
 */
const CHOICES = {
  trigger: {
    attribute: 'data-trigger-unit', key: 'triggerUnit',
    allowed: ['percent', 'dollars'],
  },
  reduction: {
    attribute: 'data-reduction-unit', key: 'reductionUnit',
    allowed: ['percent', 'dollars'],
  },
  reference: {
    attribute: 'data-reference', key: 'reference',
    allowed: ['peak', 'starting_balance'],
  },
};

function setChoice(which, value) {
  const { attribute, key, allowed } = CHOICES[which];
  const chosen = allowed.includes(value) ? value : allowed[0];
  state[key] = chosen;

  for (const button of refs.newForm.querySelectorAll(`[${attribute}]`)) {
    button.setAttribute('aria-pressed', String(button.getAttribute(attribute) === chosen));
  }
  renderAdaptiveSummary();
}

/** Shows only the fields the chosen mode actually uses. */
function syncModeFields() {
  const mode = refs.newMode.value;
  refs.stepFields.hidden = mode !== 'stepped';
  refs.adaptiveFields.hidden = mode !== 'adaptive';
  if (mode === 'adaptive') renderAdaptiveSummary();
}

/**
 * The rules in a sentence. Adaptive risk is easy to configure into something
 * you didn't mean, so the form says back what it is about to do.
 */
function renderAdaptiveSummary() {
  if (!refs.adaptiveSummary) return;

  // The hint under the trigger names the reference, so it has to move with it.
  if (refs.triggerHint) {
    refs.triggerHint.textContent = state.reference === 'starting_balance'
      ? 'Below your starting balance.'
      : 'Below your peak balance.';
  }

  const trigger = Number(refs.newTrigger.value);
  const reduction = Number(refs.newReduction.value);
  if (!Number.isFinite(trigger) || trigger <= 0 || !Number.isFinite(reduction)) {
    refs.adaptiveSummary.textContent =
      'Fill in both figures and this will say what the rule does.';
    return;
  }

  const depth = state.triggerUnit === 'dollars'
    ? formatMoney(trigger)
    : `${trigger}%`;
  const cut = state.reductionUnit === 'dollars'
    ? formatMoney(reduction)
    : `${reduction}%`;

  const fromStart = state.reference === 'starting_balance';
  const from = fromStart ? 'your starting balance' : 'your peak';
  const recovery = refs.newRecovery.value === 'stepped_back'
    ? 'climbs back one tier at a time as the drawdown recovers'
    : (fromStart
      ? 'returns to full once you are back to your starting balance'
      : 'returns to full when you make a new high');

  refs.adaptiveSummary.textContent =
    `Risk drops by ${cut} for every ${depth} below ${from}, and ${recovery}.`;
}

/** One modal for both jobs: a session means edit, no session means create. */
function openSessionModal(session = null) {
  refs.newForm.reset();
  showBanner(refs.newError, null);
  clearFieldErrors(refs.newForm);
  state.editingSession = session?.id ?? null;

  refs.modalTitle.textContent = session ? 'Edit session' : 'New session';
  refs.newSubmit.textContent = session ? 'Save session' : 'Create session';
  refs.editNote.hidden = !session;
  // Recalculating an empty session would be theatre.
  refs.recalcBlock.hidden = !session || !state.counts.get(session.id)?.count;

  if (session) {
    refs.newName.value = session.name;
    refs.newInstrument.value = session.instrument ?? '';
    refs.newTimeframe.value = session.timeframe ?? '';
    refs.newBalance.value = session.starting_balance ?? '';
    refs.newRisk.value = session.risk_amount ?? '';
    refs.newRatio.value = session.reward_ratio ?? '2';
    refs.newMode.value = session.risk_mode ?? 'fixed';
    refs.newStepTrades.value = session.risk_step_trades ?? '';
    refs.newStepAmount.value = session.risk_step_amount ?? '';
    refs.newTrigger.value = session.drawdown_trigger ?? '';
    refs.newReduction.value = session.risk_reduction ?? '';
    refs.newRecovery.value = session.recovery_mode ?? 'on_new_peak';
    setChoice('trigger', session.drawdown_unit ?? 'percent');
    setChoice('reduction', session.reduction_unit ?? 'percent');
    setChoice('reference', session.drawdown_reference ?? 'peak');
    refs.newStart.value = session.period_start ?? '';
    refs.newEnd.value = session.period_end ?? '';
    refs.newNotes.value = session.notes ?? '';
  } else {
    refs.newRatio.value = '2';
    refs.newMode.value = 'fixed';
    refs.newRecovery.value = 'on_new_peak';
    setChoice('trigger', 'percent');
    setChoice('reduction', 'percent');
    setChoice('reference', 'peak');
  }

  syncModeFields();
  refs.newModal.showModal();
  refs.newName.focus();
  refs.newName.select();
}

/**
 * Reapplies the session's current schedule to every trade it holds, in order.
 * This is the one operation here that rewrites history, so it asks twice — once
 * in the form's copy and once in the confirm — and says what it costs.
 */
async function recalculateAll() {
  const session = state.sessions.find((s) => s.id === state.editingSession);
  if (!session) return;

  // Editing the form doesn't save it; recalculating uses what is stored.
  const trades = state.editingSession === state.sessionId
    ? state.trades
    : await fetchTrades(session.id).catch(() => null);

  if (!trades) {
    showBanner(refs.newError, 'Couldn’t read this session’s trades to recalculate.');
    return;
  }
  if (!trades.length) return;

  if (!window.confirm(
    `Recalculate all ${trades.length} trades in ${session.name} using its saved settings?\n\n`
    + 'Every stored figure is overwritten, including any risk you set by hand on '
    + 'an individual trade. This cannot be undone.',
  )) return;

  const ratio = Number(session.reward_ratio ?? 1);

  // Rebuilt forwards, not mapped: in adaptive mode each trade's risk depends on
  // the balance path the recomputed trades before it produced, so the replay
  // has to carry its own history rather than read the stored one.
  const replayed = [];
  const rows = [];
  for (const trade of trades) {
    const risk = riskFor(session, replayed);
    const amount = Number(tradeResult(trade.outcome, risk, ratio).toFixed(2));
    replayed.push({ outcome: trade.outcome, amount });
    rows.push({
      id: trade.id,
      session_id: session.id,
      outcome: trade.outcome,
      risk_amount: Number(risk.toFixed(2)),
      amount,
    });
  }

  setBusy(refs.recalcAll, true, 'Recalculating…');
  try {
    const { error } = await supabase.from('backtest_trades').upsert(rows, { onConflict: 'id' });
    if (error) {
      logWriteFailure('Recalculate all trades', rows[0], error);
      throw new Error(describeError(error, 'Couldn’t recalculate those trades.'));
    }

    for (const row of rows) {
      const live = trades.find((t) => t.id === row.id);
      if (live) Object.assign(live, { risk_amount: row.risk_amount, amount: row.amount });
    }

    refs.newModal.close();
    toast(`${rows.length} trades recalculated.`, { type: 'success' });
    await refreshCounts();
    if (state.sessionId === session.id) renderSession();
    else renderSessions();
  } catch (error) {
    showBanner(refs.newError, error.message);
  } finally {
    setBusy(refs.recalcAll, false);
  }
}

/* ----------------------------------------------------------------- setup -- */

export async function initBacktestPage() {
  await requireSession();
  const profile = await requireActiveProfile();
  state.profile = profile;
  applyProfileTheme(profile.id);
  // Backtest amounts are dollars, the same as the journal.
  initMoney(profile, 'trading');
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
    exitTags: document.getElementById('exit-tags'),
    prevDay: document.getElementById('prev-day'),
    nextDay: document.getElementById('next-day'),
    workingDateLabel: document.getElementById('working-date-label'),
    workingDateCount: document.getElementById('working-date-count'),
    workingDateInput: document.getElementById('working-date'),
    includeWeekends: document.getElementById('include-weekends'),
    dateModal: document.getElementById('date-modal'),
    dateForm: document.getElementById('date-form'),
    dateError: document.getElementById('date-error'),
    dateContext: document.getElementById('date-context'),
    tradeDate: document.getElementById('trade-date'),
    dateSubmit: document.getElementById('date-submit'),
    dateCancel: document.getElementById('date-cancel'),
    dateClose: document.getElementById('date-close'),
    mfeInput: document.getElementById('trade-mfe'),
    maeInput: document.getElementById('trade-mae'),
    viewAnalysis: document.getElementById('view-analysis'),
    openAnalysis: document.getElementById('open-analysis'),
    analysisBack: document.getElementById('analysis-back'),
    analysisName: document.getElementById('analysis-name'),
    anNumberMeta: document.getElementById('an-number-meta'),
    anNumberRate: document.getElementById('an-number-rate'),
    anNumberNet: document.getElementById('an-number-net'),
    anNumberEmpty: document.getElementById('an-number-empty'),
    anCapMeta: document.getElementById('an-cap-meta'),
    anCapSlider: document.getElementById('an-cap-slider'),
    anCapValue: document.getElementById('an-cap-value'),
    anCapNote: document.getElementById('an-cap-note'),
    anCapChart: document.getElementById('an-cap-chart'),
    anCapEmpty: document.getElementById('an-cap-empty'),
    anAfterMeta: document.getElementById('an-after-meta'),
    anAfterStats: document.getElementById('an-after-stats'),
    anStopMeta: document.getElementById('an-stop-meta'),
    anStopChart: document.getElementById('an-stop-chart'),
    anStopTable: document.getElementById('an-stop-table'),
    anHourMeta: document.getElementById('an-hour-meta'),
    anHourRate: document.getElementById('an-hour-rate'),
    anHourNet: document.getElementById('an-hour-net'),
    anHourEmpty: document.getElementById('an-hour-empty'),
    anWeekdayMeta: document.getElementById('an-weekday-meta'),
    anWeekdayRate: document.getElementById('an-weekday-rate'),
    anWeekdayNet: document.getElementById('an-weekday-net'),
    anWeekdayEmpty: document.getElementById('an-weekday-empty'),
    anExitMeta: document.getElementById('an-exit-meta'),
    anExitChart: document.getElementById('an-exit-chart'),
    anExitTable: document.getElementById('an-exit-table'),
    anMfeMeta: document.getElementById('an-mfe-meta'),
    anMfeTable: document.getElementById('an-mfe-table'),
    anRatioNote: document.getElementById('an-ratio-note'),
    anRatioChart: document.getElementById('an-ratio-chart'),
    anRunsMeta: document.getElementById('an-runs-meta'),
    anRunsNote: document.getElementById('an-runs-note'),
    anRunsChart: document.getElementById('an-runs-chart'),
    riskOverride: document.getElementById('risk-override'),
    riskLine: document.getElementById('risk-line'),
    stepLine: document.getElementById('step-line'),
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
    picker: document.getElementById('compare-picker'),
    pickerNote: document.getElementById('picker-note'),
    compareLegend: document.getElementById('compare-legend'),
    curveChart: document.getElementById('curve-chart'),
    metricSelect: document.getElementById('metric-select'),
    newModal: document.getElementById('session-modal'),
    newForm: document.getElementById('session-form'),
    newError: document.getElementById('session-error'),
    newName: document.getElementById('new-name'),
    newInstrument: document.getElementById('new-instrument'),
    newTimeframe: document.getElementById('new-timeframe'),
    newBalance: document.getElementById('new-balance'),
    newRisk: document.getElementById('new-risk'),
    newRatio: document.getElementById('new-ratio'),
    newMode: document.getElementById('new-mode'),
    newStepTrades: document.getElementById('new-step-trades'),
    newStepAmount: document.getElementById('new-step-amount'),
    stepFields: document.getElementById('step-fields'),
    adaptiveFields: document.getElementById('adaptive-fields'),
    adaptiveSummary: document.getElementById('adaptive-summary'),
    newTrigger: document.getElementById('new-trigger'),
    triggerHint: document.getElementById('trigger-hint'),
    newReduction: document.getElementById('new-reduction'),
    newRecovery: document.getElementById('new-recovery'),
    newNotes: document.getElementById('new-notes'),
    modalTitle: document.getElementById('session-modal-title'),
    editNote: document.getElementById('session-edit-note'),
    recalcBlock: document.getElementById('recalc-block'),
    recalcAll: document.getElementById('recalc-all'),
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
  document.getElementById('new-session').addEventListener('click', () => openSessionModal());
  document.getElementById('edit-session').addEventListener('click', () => openSessionModal(currentSession()));
  refs.recalcAll.addEventListener('click', recalculateAll);
  document.getElementById('open-compare').addEventListener('click', openCompare);
  document.getElementById('back-to-sessions').addEventListener('click', backToList);
  document.getElementById('compare-back').addEventListener('click', backToList);
  document.getElementById('session-cancel').addEventListener('click', () => refs.newModal.close());
  document.getElementById('session-close').addEventListener('click', () => refs.newModal.close());
  document.getElementById('delete-session').addEventListener('click', removeSession);

  refs.newForm.addEventListener('submit', createSession);
  // Fixed says everything in the two fields above; the other modes need more.
  refs.newMode.addEventListener('change', syncModeFields);
  refs.newRecovery.addEventListener('change', renderAdaptiveSummary);
  refs.newTrigger.addEventListener('input', renderAdaptiveSummary);
  refs.newReduction.addEventListener('input', renderAdaptiveSummary);
  refs.newForm.addEventListener('click', (event) => {
    for (const [which, { attribute }] of Object.entries(CHOICES)) {
      const button = event.target.closest(`[${attribute}]`);
      if (button) {
        setChoice(which, button.getAttribute(attribute));
        return;
      }
    }
  });
  refs.undo.addEventListener('click', undoLast);
  refs.openAnalysis.addEventListener('click', () => {
    show('analysis');
    renderAnalysis();
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  });
  refs.analysisBack.addEventListener('click', () => {
    show('session');
    renderSession();
  });
  refs.anCapSlider.addEventListener('input', renderCapNote);
  mountPanelHelp();

  refs.nextDay.addEventListener('click', () => stepDay(1));
  refs.prevDay.addEventListener('click', () => stepDay(-1));
  refs.workingDateInput.addEventListener('change', () => {
    setWorkingDate(refs.workingDateInput.value);
  });
  refs.includeWeekends.addEventListener('change', () => {
    state.includeWeekends = refs.includeWeekends.checked;
    saveIncludeWeekends(state.includeWeekends);
  });

  refs.dateForm.addEventListener('submit', moveTrade);
  refs.dateCancel.addEventListener('click', () => refs.dateModal.close());
  refs.dateClose.addEventListener('click', () => refs.dateModal.close());
  for (const metric of COMPARE_METRICS) {
    refs.metricSelect.append(el('option', { value: metric.key, text: metric.label }));
  }
  refs.metricSelect.addEventListener('change', () => {
    state.metric = refs.metricSelect.value;
    renderCompare();
  });
  refs.statusSelect.addEventListener('change', () => setSessionStatus(refs.statusSelect.value));

  for (const button of document.querySelectorAll('[data-outcome]')) {
    button.addEventListener('click', () => logTrade(button.dataset.outcome));
  }

  // Keyboard shortcuts for a fast pass: W, L, B to log, U to undo, N and P to
  // move through the days. N is the one that carries a backtest along.
  document.addEventListener('keydown', (event) => {
    if (state.view !== 'session') return;
    if (event.target.matches('input, textarea, select')) return;
    if (refs.dateModal.open || refs.newModal.open) return;

    const key = event.key.toLowerCase();
    if (key === 'w') logTrade('win');
    else if (key === 'l') logTrade('loss');
    else if (key === 'b') logTrade('breakeven');
    else if (key === 'u') undoLast();
    else if (key === 'n') stepDay(1);
    else if (key === 'p') stepDay(-1);
  });
}
