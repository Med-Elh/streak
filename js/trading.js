/**
 * Trading: the log form, the rules checklist, the stats strip, the trade table,
 * and the performance charts.
 *
 * Logging a trade has to be fast, so everything except the numbers and the notes
 * is a click. R:R and P&L compute themselves from the prices as you type, but a
 * typed value wins and stays won until you ask for the calculation back — the
 * fill you got is not always the fill you planned.
 */

import { supabase, describeError } from './supabase.js?v=12';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=12';
import { requireActiveProfile } from './profiles.js?v=12';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy, showBanner, statRing,
  formatSignedMoney, compactNumber, signClass, formatDate, todayISO, formatPercent,
  moneyContext, initMoney,
  applyProfileTheme,
} from './ui.js?v=12';
import {
  equityCurveChart, signedBarChart, rateBarChart,
} from './charts.js?v=12';
import {
  INSTRUMENTS, SESSIONS, SETUPS, EMOTIONS, DIRECTIONS, OUTCOMES, options, loadOptions,
} from './constants.js?v=12';
import {
  ACCOUNT_STATUSES, evaluate, groupAccounts, pickAccount,
  listAccounts, createAccount, updateAccount, deleteAccount, setStatus,
  loadSelectedAccountId, saveSelectedAccountId,
  isDismissed, dismiss, clearDismissals, hasBaseline, percentOf,
} from './accounts.js?v=12';

import { mountGreeting } from './greetings.js?v=12';

const state = {
  profile: null,
  trades: [],
  rules: [],
  filters: { instrument: '', direction: '', session: '', setup: '', emotion: '', outcome: '' },
  sort: { key: 'date', dir: 'desc' },
  grouping: 'month',   // P&L chart: 'day' | 'month' | 'year'
  calendarMonth: todayISO().slice(0, 7),
  editingId: null,
  lists: { instrument: INSTRUMENTS, session: SESSIONS, setup: SETUPS, emotion: EMOTIONS },
  accounts: [],
  account: null,
  evaluation: null,
  pendingStatus: null,
  editingAccount: null,
  equityMode: 'amount',   // 'amount' | 'percent'
};

let refs = {};

/* ------------------------------------------------------------------- math -- */

/** Planned R:R — reward to target over risk to stop. Null unless all three exist. */
export function computeRR({ entry, stop, target }) {
  const e = Number(entry), s = Number(stop), t = Number(target);
  if (![e, s, t].every(Number.isFinite)) return null;
  const risk = Math.abs(e - s);
  const reward = Math.abs(t - e);
  if (!risk) return null;
  return Number((reward / risk).toFixed(2));
}

/** Realised P&L. Direction decides the sign; size scales it. */
export function computePnL({ entry, exit, size, direction }) {
  const e = Number(entry), x = Number(exit), q = Number(size);
  if (![e, x, q].every(Number.isFinite)) return null;
  const move = direction === 'short' ? e - x : x - e;
  return Number((move * q).toFixed(2));
}

export function outcomeFor(pnl) {
  if (pnl === null || pnl === undefined || Number.isNaN(Number(pnl))) return null;
  const n = Number(pnl);
  if (n > 0) return 'win';
  if (n < 0) return 'loss';
  return 'breakeven';
}

/**
 * Trades in the order they happened. Date alone leaves same-day trades in
 * whatever order the array arrived in, and the running total then bakes that
 * arbitrary order into the curve; created_at breaks the tie by when the trade
 * was actually logged.
 */
export function chronologicalOrder(trades) {
  return [...trades].sort((a, b) =>
    String(a.date ?? '').localeCompare(String(b.date ?? ''))
    || String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
}

/**
 * The running total, starting from a zero point before the first trade — without
 * it the line opens at the first trade's P&L and a losing first trade looks like
 * an account that started in the red.
 */
export function cumulativeSeries(ordered) {
  let running = 0;
  const values = [0];
  for (const trade of ordered) {
    running += Number(trade.pnl ?? 0);
    values.push(Number(running.toFixed(2)));
  }
  return values;
}

/* ------------------------------------------------------------------ stats -- */

function computeStats(trades) {
  const withPnL = trades.filter((t) => t.pnl !== null && t.pnl !== undefined);
  const pnls = withPnL.map((t) => Number(t.pnl));
  const wins = trades.filter((t) => t.outcome === 'win').length;
  const losses = trades.filter((t) => t.outcome === 'loss').length;
  const decided = wins + losses;

  const rrs = trades.map((t) => Number(t.rr)).filter(Number.isFinite);
  const gross = pnls.reduce((a, b) => a + Math.max(b, 0), 0);
  const bled = Math.abs(pnls.reduce((a, b) => a + Math.min(b, 0), 0));
  const total = pnls.reduce((a, b) => a + b, 0);

  return {
    count: trades.length,
    // Breakevens are excluded: they are neither a win nor a loss, and counting
    // them in the denominator quietly drags the rate down.
    winRate: decided ? (wins / decided) * 100 : null,
    wins,
    losses,
    decided,
    avgRR: rrs.length ? rrs.reduce((a, b) => a + b, 0) / rrs.length : null,
    total,
    best: pnls.length ? Math.max(...pnls) : null,
    worst: pnls.length ? Math.min(...pnls) : null,
    profitFactor: bled ? gross / bled : (gross ? Infinity : null),
    // What the average trade returns. Not a forecast — a description of what
    // this sample has done per trade so far.
    expectancy: pnls.length ? total / pnls.length : null,
    streak: currentStreak(trades),
    span: dateSpan(trades),
  };
}

/**
 * The run of same-outcome trades ending at the most recent one.
 *
 * Breakevens are skipped rather than treated as a break: they are neither a win
 * nor a loss, so a scratch trade in the middle of three winners leaves you on
 * three, not on one. Same reasoning as the win rate.
 */
export function currentStreak(trades) {
  const ordered = trades
    .filter((t) => t.outcome === 'win' || t.outcome === 'loss')
    .sort((a, b) =>
      String(b.date ?? '').localeCompare(String(a.date ?? ''))
      || String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

  if (!ordered.length) return { kind: null, length: 0 };

  const kind = ordered[0].outcome;
  let length = 0;
  for (const trade of ordered) {
    if (trade.outcome !== kind) break;
    length += 1;
  }
  return { kind, length };
}

/** "August 2026" when the trades sit in one month, a range when they don't. */
export function dateSpan(trades) {
  const dates = trades.map((t) => t.date).filter(Boolean).sort();
  if (!dates.length) return 'No trades yet';
  const first = dates[0];
  const last = dates[dates.length - 1];

  const monthYear = (d) => formatDate(d, { month: 'long', year: 'numeric' });
  if (first.slice(0, 7) === last.slice(0, 7)) return monthYear(first);
  if (first.slice(0, 4) === last.slice(0, 4)) {
    return `${formatDate(first, { month: 'short' })} – ${formatDate(last, { month: 'short', year: 'numeric' })}`;
  }
  return `${formatDate(first, { month: 'short', year: 'numeric' })} – ${monthYear(last)}`;
}

/* ------------------------------------------------------------------- data -- */

/* Everything on this page is scoped to the selected account. */

async function fetchTrades() {
  if (!state.account) return [];
  const { data, error } = await supabase
    .from('trades')
    .select('*')
    .eq('account_id', state.account.id)
    .order('date', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw new Error(describeError(error, 'Couldn’t load your trades.'));
  return data ?? [];
}

async function fetchRules() {
  if (!state.account) return [];
  const { data, error } = await supabase
    .from('trading_rules')
    .select('id, rule, active')
    .eq('account_id', state.account.id)
    .order('created_at', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load your rules.'));
  return data ?? [];
}

/* --------------------------------------------------------------- the form -- */

function fillSelect(select, list, { placeholder } = {}) {
  clear(select);
  if (placeholder) select.append(el('option', { value: '', text: placeholder }));
  for (const opt of options(list)) {
    select.append(el('option', { value: opt.value, text: opt.label }));
  }
}

/** Auto-fills R:R and P&L unless the field has been typed in by hand. */
function recalculate() {
  const values = readForm();

  if (refs.rr.dataset.manual !== 'true') {
    const rr = computeRR(values);
    refs.rr.value = rr ?? '';
  }
  if (refs.pnl.dataset.manual !== 'true') {
    const pnl = computePnL(values);
    refs.pnl.value = pnl ?? '';
  }

  const outcome = outcomeFor(refs.pnl.value === '' ? null : refs.pnl.value);
  refs.outcome.textContent = outcome
    ? OUTCOMES.find((o) => o.value === outcome).label
    : 'Set by P&L';
  refs.outcome.className = `chip ${outcome ? `chip--${outcome}` : ''}`;

  const anyManual = refs.rr.dataset.manual === 'true' || refs.pnl.dataset.manual === 'true';
  refs.recalc.hidden = !anyManual;
}

function readForm() {
  return {
    date: refs.date.value,
    instrument: refs.instrument.value,
    direction: refs.direction.value,
    session: refs.session.value || null,
    setup: refs.setup.value || null,
    emotion: refs.emotion.value || null,
    entry: refs.entry.value === '' ? null : Number(refs.entry.value),
    exit: refs.exit.value === '' ? null : Number(refs.exit.value),
    stop: refs.stop.value === '' ? null : Number(refs.stop.value),
    target: refs.target.value === '' ? null : Number(refs.target.value),
    size: refs.size.value === '' ? null : Number(refs.size.value),
    rr: refs.rr.value === '' ? null : Number(refs.rr.value),
    pnl: refs.pnl.value === '' ? null : Number(refs.pnl.value),
    notes: refs.notes.value.trim() || null,
    screenshot_url: refs.screenshot.value.trim() || null,
  };
}

async function submitTrade(event) {
  event.preventDefault();
  showBanner(refs.formError, null);

  const values = readForm();

  if (!values.date) {
    showBanner(refs.formError, 'Pick the date you took the trade.');
    refs.date.focus();
    return;
  }
  if (!values.instrument) {
    showBanner(refs.formError, 'Choose an instrument.');
    refs.instrument.focus();
    return;
  }
  if (values.screenshot_url && !/^https?:\/\//i.test(values.screenshot_url)) {
    showBanner(refs.formError, 'A screenshot link has to start with http:// or https://');
    refs.screenshot.focus();
    return;
  }

  if (!state.account) {
    showBanner(refs.formError, 'Create an account before logging a trade.');
    return;
  }

  const payload = {
    ...values,
    profile_id: state.profile.id,
    account_id: state.account.id,
    outcome: outcomeFor(values.pnl),
  };

  setBusy(refs.submit, true, 'Logging…');
  try {
    const { data, error } = await supabase
      .from('trades')
      .insert(payload)
      .select('*')
      .single();

    if (error) {
      showBanner(refs.formError, describeError(error, 'Couldn’t log that trade.'));
      return;
    }

    state.trades.unshift(data);
    sortTrades();
    resetForm();
    toast('Trade logged.', { type: 'success' });
    // A new trade can move the account across a limit, so the banner is
    // re-evaluated here rather than only on load.
    renderAll();
  } finally {
    setBusy(refs.submit, false);
  }
}

function resetForm() {
  refs.form.reset();
  refs.date.value = todayISO();
  refs.direction.value = 'long';
  delete refs.rr.dataset.manual;
  delete refs.pnl.dataset.manual;
  // A fresh trade means a fresh pre-trade check.
  for (const box of refs.rulesList.querySelectorAll('input[type="checkbox"]')) box.checked = false;
  updateRuleCount();
  recalculate();
}

/* -------------------------------------------------------------- the rules -- */

function renderRules() {
  clear(refs.rulesList);

  const active = state.rules.filter((r) => r.active);
  if (!active.length) {
    refs.rulesList.append(
      el('p', { class: 'muted', text: 'No rules yet. Add the ones you break most.' }),
    );
    updateRuleCount();
    return;
  }

  for (const rule of active) {
    refs.rulesList.append(
      el('label', { class: 'rule' }, [
        el('input', { type: 'checkbox', onchange: updateRuleCount }),
        el('span', { class: 'rule__text', text: rule.rule }),
        el('button', {
          class: 'btn btn--icon btn--sm',
          type: 'button',
          'aria-label': `Remove rule: ${rule.rule}`,
          text: '×',
          onclick: (event) => {
            event.preventDefault();
            removeRule(rule);
          },
        }),
      ]),
    );
  }
  updateRuleCount();
}

/**
 * The pre-trade check as a ring: one number standing on its own, which is
 * exactly what the ring component is for.
 */
function updateRuleCount() {
  const boxes = [...refs.rulesList.querySelectorAll('input[type="checkbox"]')];
  const checked = boxes.filter((b) => b.checked).length;
  const complete = boxes.length > 0 && checked === boxes.length;

  clear(refs.ruleCount).append(
    statRing({
      value: checked,
      max: boxes.length || 1,
      display: boxes.length ? `${checked}/${boxes.length}` : '—',
      label: 'Checked',
      tone: complete ? 'positive' : 'accent',
      size: 'sm',
    }),
  );
}

async function addRule(event) {
  event.preventDefault();
  const text = refs.ruleInput.value.trim();
  if (!text) return;

  if (!state.account) return;

  const { data, error } = await supabase
    .from('trading_rules')
    .insert({ profile_id: state.profile.id, account_id: state.account.id, rule: text })
    .select('id, rule, active')
    .single();

  if (error) {
    toast(
      error.code === '23505' ? 'That rule is already on your list.' : describeError(error, 'Couldn’t add that rule.'),
      { type: 'error' },
    );
    return;
  }

  state.rules.push(data);
  refs.ruleInput.value = '';
  renderRules();
}

async function removeRule(rule) {
  const { error } = await supabase.from('trading_rules').delete().eq('id', rule.id);
  if (error) {
    toast(describeError(error, 'Couldn’t remove that rule.'), { type: 'error' });
    return;
  }
  state.rules = state.rules.filter((r) => r.id !== rule.id);
  renderRules();
}

/* -------------------------------------------------------------- filtering -- */

function visibleTrades() {
  return state.trades.filter((trade) =>
    Object.entries(state.filters).every(([key, value]) => !value || trade[key] === value));
}

function sortTrades() {
  const { key, dir } = state.sort;
  const factor = dir === 'asc' ? 1 : -1;
  state.trades.sort((a, b) => {
    const x = a[key], y = b[key];
    if (x === y) return 0;
    if (x === null || x === undefined) return 1;      // blanks sink, either way
    if (y === null || y === undefined) return -1;
    return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * factor;
  });
}

/* ------------------------------------------------------------- stats strip -- */

/** Six cards, one shape: label above, the number, the context underneath. */
function statCard(label, value, sub, tone = '') {
  return el('div', { class: 'stat-card' }, [
    el('span', { class: 'stat-card__label', text: label }),
    el('span', { class: `stat-card__value ${tone}`, text: value }),
    el('span', { class: 'stat-card__sub', text: sub }),
  ]);
}

function toneFor(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return '';
  return n > 0 ? 'is-positive' : 'is-negative';
}

function renderStats() {
  const stats = computeStats(visibleTrades());
  clear(refs.stats);

  const pf = stats.profitFactor;
  const streakText = stats.streak.length
    ? `${stats.streak.length}${stats.streak.kind === 'win' ? 'W' : 'L'}`
    : '—';

  refs.stats.append(
    statCard('Net P&L', formatSignedMoney(stats.total), stats.span, toneFor(stats.total)),
    // Withheld rather than faked when the account has no starting balance:
    // a return needs something to be a return on.
    statCard(
      'Return %',
      hasBaseline(state.account)
        ? formatPercent(percentOf(stats.total, state.account), { signed: true })
        : '—',
      hasBaseline(state.account)
        ? `on ${formatSignedMoney(state.account.starting_balance).replace(/^\+/, '')}`
        : 'Set a starting balance',
      hasBaseline(state.account) ? toneFor(stats.total) : '',
    ),
    statCard(
      'Win rate',
      stats.winRate === null ? '—' : `${stats.winRate.toFixed(0)}%`,
      stats.decided ? `${stats.wins} W / ${stats.losses} L` : 'Nothing decided yet',
      stats.winRate === null ? '' : toneFor(stats.winRate >= 50 ? 1 : -1),
    ),
    statCard(
      'Avg R:R',
      stats.avgRR === null ? '—' : `${stats.avgRR.toFixed(2)}R`,
      `Across ${stats.count} trade${stats.count === 1 ? '' : 's'}`,
      stats.avgRR === null ? '' : toneFor(stats.avgRR >= 1 ? 1 : -1),
    ),
    statCard(
      'Profit factor',
      pf === null ? '—' : pf === Infinity ? '∞' : pf.toFixed(2),
      'Gross win / gross loss',
      pf === null ? '' : toneFor(pf >= 1 ? 1 : -1),
    ),
    statCard(
      'Expectancy',
      stats.expectancy === null ? '—' : formatSignedMoney(stats.expectancy),
      'Per trade',
      toneFor(stats.expectancy),
    ),
    statCard(
      'Streak',
      streakText,
      'In a row',
      stats.streak.length ? toneFor(stats.streak.kind === 'win' ? 1 : -1) : '',
    ),
  );
}

/* --------------------------------------------------------------- account -- */

function renderAccountBar() {
  const { open, closed } = groupAccounts(state.accounts);

  clear(refs.accountSelect);
  const fill = (label, list) => {
    if (!list.length) return;
    const group = el('optgroup', { label });
    for (const account of list) {
      group.append(el('option', { value: account.id, text: account.name }));
    }
    refs.accountSelect.append(group);
  };
  fill('Open', open);
  fill('Closed', closed);
  refs.accountSelect.append(el('option', { value: '__new', text: '+ New account' }));

  if (state.account) refs.accountSelect.value = state.account.id;

  clear(refs.accountPill);
  if (state.account && state.account.status !== 'active') {
    refs.accountPill.append(el('span', {
      class: `pill pill--${state.account.status}`,
      text: ACCOUNT_STATUSES.find((s) => s.value === state.account.status)?.label ?? state.account.status,
      title: state.account.status_note || '',
    }));
  }

  refs.accountEdit.disabled = !state.account;
  renderAccountSummary();
  renderAccountAlert();
}

/** Balance against the target, and how much drawdown room is left. */
function renderAccountSummary() {
  clear(refs.accountSummary);
  if (!state.account) return;

  const view = evaluate(state.account, state.trades, todayISO());
  state.evaluation = view;

  const bar = (label, percent, detail, tone) => el('div', { class: 'meter' }, [
    el('div', { class: 'meter__head' }, [
      el('span', { class: 'meter__label', text: label }),
      el('span', { class: `meter__detail num ${tone}`, text: detail }),
    ]),
    el('div', {
      class: 'meter__track',
      role: 'progressbar',
      'aria-valuenow': String(Math.round(percent)),
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-label': label,
    }, el('span', {
      class: `meter__fill meter__fill--${tone === 'num--negative' ? 'down' : 'up'}`,
      style: `width: ${percent}%`,
    })),
  ]);

  refs.accountSummary.append(el('div', { class: 'stat' }, [
    el('span', { class: 'stat__label', text: 'Balance' }),
    el('span', {
      class: `stat__value ${signClass(view.netPnl)}`,
      text: formatSignedMoney(view.balance).replace(/^\+/, ''),
    }),
    el('span', {
      class: 'stat__meta',
      text: `${formatSignedMoney(view.netPnl)} from ${formatSignedMoney(view.starting).replace(/^\+/, '')}`,
    }),
  ]));

  if (view.targetPercent !== null) {
    // "6.2% of 10%" when there's a balance to measure against; otherwise the
    // amount still to go, which needs no baseline.
    const gainPct = percentOf(view.netPnl, state.account);
    const targetPct = percentOf(view.target, state.account);
    const detail = gainPct !== null && targetPct !== null
      ? `${formatPercent(gainPct, { digits: 1 })} of ${formatPercent(targetPct, { digits: 1 })}`
      : `${formatSignedMoney(Math.max(view.target - view.netPnl, 0)).replace(/^\+/, '')} to go`;

    refs.accountSummary.append(bar('Profit target', view.targetPercent, detail, 'num--positive'));
  }

  if (view.drawdownPercent !== null) {
    refs.accountSummary.append(bar(
      'Drawdown room',
      view.drawdownPercent,
      `${formatSignedMoney(Math.max(view.roomLeft, 0)).replace(/^\+/, '')} left`,
      view.drawdownPercent < 25 ? 'num--negative' : 'num--muted',
    ));
  }
}

/**
 * A suggestion, never a decision. The account keeps running until someone says
 * otherwise — a wrongly auto-failed account is a worse outcome than a banner
 * that sits there for a day.
 */
function renderAccountAlert() {
  const view = state.evaluation;
  const suggestion = view?.suggested;

  if (!state.account || !suggestion || isDismissed(state.account.id, suggestion)) {
    refs.accountAlert.hidden = true;
    return;
  }

  refs.accountAlert.hidden = false;
  refs.accountAlert.className = `banner account-alert banner--${suggestion === 'passed' ? 'success' : 'error'}`;
  refs.accountAlertText.textContent = `${view.reason}. Mark it as ${suggestion}?`;
  state.pendingStatus = suggestion;
}

async function applySuggestedStatus() {
  const suggestion = state.pendingStatus;
  if (!state.account || !suggestion) return;

  try {
    const updated = await setStatus(state.account.id, suggestion);
    Object.assign(state.account, updated);
    const index = state.accounts.findIndex((a) => a.id === updated.id);
    if (index !== -1) state.accounts[index] = { ...state.accounts[index], ...updated };
    toast(`Account marked ${suggestion}.`, { type: 'success' });
    renderAccountBar();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

async function switchAccount(accountId) {
  const account = state.accounts.find((a) => a.id === accountId);
  if (!account) return;

  state.account = account;
  saveSelectedAccountId(state.profile.id, account.id);
  state.editingId = null;

  refs.table.append(skeletonList(3, 'skeleton--text'));
  try {
    [state.trades, state.rules] = await Promise.all([fetchTrades(), fetchRules()]);
  } catch (error) {
    toast(error.message, { type: 'error' });
    return;
  }
  renderRules();
  renderAll();
}

/* -------------------------------------------------------- calendar heatmap -- */

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function dailyTotals(trades) {
  const map = new Map();
  for (const trade of trades) {
    const day = map.get(trade.date) ?? { pnl: 0, count: 0 };
    day.pnl += Number(trade.pnl ?? 0);
    day.count += 1;
    map.set(trade.date, day);
  }
  return map;
}

function renderCalendar() {
  const totals = dailyTotals(visibleTrades());
  const [year, month] = state.calendarMonth.split('-').map(Number);
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // getUTCDay is Sunday-first; this grid starts on Monday.
  const leading = (first.getUTCDay() + 6) % 7;

  refs.calMonth.textContent = new Intl.DateTimeFormat(undefined, {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(first);

  // Intensity is relative to this month's biggest day, so a quiet month still
  // reads instead of washing out against an outlier from some other month.
  let peak = 0;
  for (let d = 1; d <= daysInMonth; d += 1) {
    peak = Math.max(peak, Math.abs(totals.get(dayKey(d))?.pnl ?? 0));
  }

  clear(refs.calGrid);
  for (const name of DOW) {
    refs.calGrid.append(el('div', { class: 'calendar__dow', text: name[0], title: name }));
  }
  for (let i = 0; i < leading; i += 1) {
    refs.calGrid.append(el('div', { class: 'cal-cell cal-cell--blank' }));
  }

  const today = todayISO();
  let monthPnL = 0;
  let monthTrades = 0;

  for (let d = 1; d <= daysInMonth; d += 1) {
    const key = dayKey(d);
    const day = totals.get(key);
    const classes = ['cal-cell'];
    let tint = null;

    if (day) {
      monthPnL += day.pnl;
      monthTrades += day.count;
      if (day.pnl > 0) classes.push('cal-cell--profit');
      else if (day.pnl < 0) classes.push('cal-cell--loss');
      else classes.push('cal-cell--flat');
      // Floored at 0.14 so a small day still reads as a day with trades in it.
      if (peak) tint = (0.14 + 0.66 * (Math.abs(day.pnl) / peak)).toFixed(2);
    }
    if (key === today) classes.push('cal-cell--today');

    refs.calGrid.append(el('div', {
      class: classes.join(' '),
      style: tint ? `--tint: ${tint}` : null,
      title: day
        ? `${formatDate(key)} · ${formatSignedMoney(day.pnl)} · ${day.count} trade${day.count === 1 ? '' : 's'}`
        : formatDate(key),
    }, [
      el('span', { class: 'cal-cell__date', text: String(d) }),
      day ? el('span', { class: 'cal-cell__pnl', text: compactNumber(day.pnl) }) : null,
      day ? el('span', { class: 'cal-cell__count', text: `${day.count}×` }) : null,
    ]));
  }

  refs.calSummary.textContent = monthTrades
    ? `${monthTrades} trade${monthTrades === 1 ? '' : 's'} · ${formatSignedMoney(monthPnL)}`
    : 'No trades this month';
  refs.calSummary.className = `num ${monthTrades ? signClass(monthPnL) : 'num--muted'}`;

  function dayKey(d) {
    return `${state.calendarMonth}-${String(d).padStart(2, '0')}`;
  }
}

/**
 * Trading P&L is in dollars, full stop — there is no selector on this form.
 * Nothing is converted on the way into the database, so the label says which
 * currency the field takes regardless of what the toggle is showing.
 */
function labelAmountFields() {
  const { converted } = moneyContext();
  refs.pnlCurrency.textContent = converted ? 'USD — always entered in dollars' : 'USD';
}

function shiftMonth(delta) {
  const [year, month] = state.calendarMonth.split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1 + delta, 1));
  state.calendarMonth = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
  renderCalendar();
}

/* ------------------------------------------------------------- trade table -- */

const COLUMNS = [
  { key: 'date', label: 'Date', type: 'date' },
  // `listKey` is resolved against the profile's edited lists at render time, so
  // an inline edit offers the same options the log form does.
  { key: 'instrument', label: 'Instrument', type: 'select', listKey: 'instrument' },
  { key: 'direction', label: 'Direction', type: 'select', list: DIRECTIONS },
  { key: 'session', label: 'Session', type: 'select', listKey: 'session', optional: true },
  { key: 'setup', label: 'Setup', type: 'select', listKey: 'setup', optional: true },
  { key: 'emotion', label: 'Emotion', type: 'select', listKey: 'emotion', optional: true },
  { key: 'entry', label: 'Entry', type: 'number', numeric: true },
  { key: 'exit', label: 'Exit', type: 'number', numeric: true },
  { key: 'rr', label: 'R:R', type: 'number', numeric: true },
  { key: 'pnl', label: 'P&L', type: 'number', numeric: true },
  { key: 'outcome', label: 'Outcome', type: 'derived' },
];

function renderTable() {
  const rows = visibleTrades();
  clear(refs.table);

  if (!rows.length) {
    refs.table.append(
      emptyState({
        title: state.trades.length ? 'No trades match these filters' : 'No trades yet',
        body: state.trades.length
          ? 'Clear a filter to see the rest.'
          : 'Log your first one — the form above is the whole thing.',
        actionLabel: state.trades.length ? 'Clear filters' : 'Log a trade',
        onAction: state.trades.length ? clearFilters : () => refs.instrument.focus(),
      }),
    );
    return;
  }

  const head = el('tr');
  for (const col of COLUMNS) {
    const sorted = state.sort.key === col.key;
    head.append(el('th', {
      class: col.numeric ? 'align-right' : '',
      'aria-sort': sorted ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none',
      tabindex: '0',
      role: 'columnheader',
      text: col.label,
      onclick: () => toggleSort(col.key),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(col.key); }
      },
    }));
  }
  head.append(el('th', { class: 'align-right', text: 'Actions' }));

  const body = el('tbody');
  for (const trade of rows) {
    body.append(state.editingId === trade.id ? editRow(trade) : readRow(trade));
  }

  refs.table.append(
    el('div', { class: 'table-wrap' },
      el('table', { class: 'table' }, [el('thead', {}, head), body])),
  );
}

function readRow(trade) {
  const cells = COLUMNS.map((col) => {
    if (col.key === 'outcome') {
      return el('td', {}, trade.outcome
        ? el('span', { class: `chip chip--${trade.outcome}`, text: OUTCOMES.find((o) => o.value === trade.outcome).label })
        : el('span', { class: 'faint', text: '—' }));
    }
    if (col.key === 'date') return el('td', { text: formatDate(trade.date, { day: 'numeric', month: 'short', year: '2-digit' }) });
    if (col.key === 'pnl') {
      const pct = percentOf(trade.pnl, state.account);
      return el('td', { class: `align-right num ${signClass(trade.pnl)}` }, [
        el('span', { text: trade.pnl === null ? '—' : formatSignedMoney(trade.pnl) }),
        // The percentage only appears when there's a balance to measure against.
        pct === null || trade.pnl === null
          ? null
          : el('span', { class: 'pnl-pct', text: formatPercent(pct, { signed: true }) }),
      ]);
    }
    if (col.key === 'rr') {
      return el('td', { class: 'align-right num', text: trade.rr === null ? '—' : `${Number(trade.rr).toFixed(2)}R` });
    }
    if (col.numeric) {
      return el('td', { class: 'align-right num', text: trade[col.key] === null ? '—' : trimNumber(trade[col.key]) });
    }
    if (col.key === 'direction') {
      return el('td', {}, el('span', {
        class: 'chip',
        text: DIRECTIONS.find((d) => d.value === trade.direction)?.label ?? trade.direction,
      }));
    }
    return el('td', { text: trade[col.key] ?? '—' });
  });

  return el('tr', {}, [
    ...cells,
    el('td', { class: 'align-right' }, el('div', { class: 'row row-end' }, [
      el('button', { class: 'btn btn--ghost btn--sm', type: 'button', text: 'Edit', onclick: () => startEdit(trade.id) }),
      el('button', { class: 'btn btn--danger btn--sm', type: 'button', text: 'Delete', onclick: () => removeTrade(trade) }),
    ])),
  ]);
}

/** Inline edit: the row's own cells become fields, in place. */
function editRow(trade) {
  const inputs = {};

  const cells = COLUMNS.map((col) => {
    if (col.key === 'outcome') {
      return el('td', {}, el('span', { class: 'faint', text: 'From P&L' }));
    }
    if (col.type === 'select') {
      const select = el('select', { class: 'select select--inline' });
      const list = col.list ?? state.lists[col.listKey] ?? [];
      fillSelect(select, list, { placeholder: col.optional ? '—' : undefined });
      select.value = trade[col.key] ?? '';
      inputs[col.key] = select;
      return el('td', {}, select);
    }
    const input = el('input', {
      class: `input input--inline ${col.numeric ? 'input--num' : ''}`,
      type: col.type,
      step: col.numeric ? 'any' : null,
      inputmode: col.numeric ? 'decimal' : null,
      value: trade[col.key] ?? '',
    });
    inputs[col.key] = input;

    // P&L is the one column that can legitimately be negative, and the phone
    // keypad has no minus. Same sign button as the log form, in miniature.
    if (col.key === 'pnl') {
      return el('td', { class: 'align-right' }, el('div', { class: 'signed-field' }, [
        input,
        el('button', {
          class: 'btn btn--secondary btn--sm signed-field__sign',
          type: 'button',
          text: '±',
          'aria-label': 'Flip the sign of the P&L',
          onclick: () => toggleSign(input),
        }),
      ]));
    }

    return el('td', { class: col.numeric ? 'align-right' : '' }, input);
  });

  const save = async () => {
    const patch = {};
    for (const col of COLUMNS) {
      if (col.key === 'outcome') continue;
      const raw = inputs[col.key].value;
      patch[col.key] = raw === '' ? null : (col.numeric ? Number(raw) : raw);
    }
    patch.outcome = outcomeFor(patch.pnl);

    const { data, error } = await supabase
      .from('trades')
      .update(patch)
      .eq('id', trade.id)
      .select('*')
      .single();

    if (error) {
      toast(describeError(error, 'Couldn’t save those changes.'), { type: 'error' });
      return;
    }

    Object.assign(state.trades.find((t) => t.id === trade.id), data);
    state.editingId = null;
    toast('Trade updated.', { type: 'success' });
    renderAll();
  };

  return el('tr', { class: 'row--editing' }, [
    ...cells,
    el('td', { class: 'align-right' }, el('div', { class: 'row row-end' }, [
      el('button', { class: 'btn btn--primary btn--sm', type: 'button', text: 'Save', onclick: save }),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        text: 'Cancel',
        onclick: () => { state.editingId = null; renderTable(); },
      }),
    ])),
  ]);
}

function trimNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(5)));
}

function startEdit(id) {
  state.editingId = id;
  renderTable();
}

async function removeTrade(trade) {
  const { error } = await supabase.from('trades').delete().eq('id', trade.id);
  if (error) {
    toast(describeError(error, 'Couldn’t delete that trade.'), { type: 'error' });
    return;
  }
  state.trades = state.trades.filter((t) => t.id !== trade.id);
  toast('Trade deleted.', { type: 'success', duration: 2500 });
  renderAll();
}

function toggleSort(key) {
  if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  else state.sort = { key, dir: 'desc' };
  sortTrades();
  renderTable();
}

function clearFilters() {
  for (const key of Object.keys(state.filters)) state.filters[key] = '';
  for (const select of refs.filterBar.querySelectorAll('select')) select.value = '';
  renderAll();
}

/* ----------------------------------------------------------------- charts -- */

function renderCharts() {
  const rows = visibleTrades();
  const chronological = chronologicalOrder(rows);

  // Equity curve
  if (!chronological.length) {
    toggleChart(refs.equity, refs.equityEmpty, 'Log a trade and the curve starts here.');
    refs.equityTotal.textContent = formatSignedMoney(0);
    refs.equityTotal.className = 'panel__total';
  } else {
    const values = cumulativeSeries(chronological);
    const labels = [
      'Start',
      ...chronological.map((t) => formatDate(t.date, { day: 'numeric', month: 'short' })),
    ];

    logEquitySeries(chronological, values);

    // Percent mode divides the same running total by the starting balance, so
    // the shape is identical and only the scale changes.
    const asPercent = state.equityMode === 'percent' && hasBaseline(state.account);
    const plotted = asPercent
      ? values.map((v) => Number(percentOf(v, state.account).toFixed(4)))
      : values;

    toggleChart(refs.equity, refs.equityEmpty, null);
    equityCurveChart(refs.equity, {
      labels,
      values: plotted,
      mode: asPercent ? 'percent' : 'amount',
    });

    // Green by default, per the panel's design; a running total in the red says
    // so, because a loss printed in green is a lie the rest of the page doesn't tell.
    const total = values.at(-1) ?? 0;
    refs.equityTotal.textContent = asPercent
      ? formatPercent(percentOf(total, state.account), { signed: true })
      : formatSignedMoney(total);
    refs.equityTotal.className = `panel__total${total < 0 ? ' is-negative' : ''}`;
  }

  // P&L by day / month / year
  const buckets = new Map();
  for (const trade of chronological) {
    const key = state.grouping === 'year' ? trade.date.slice(0, 4)
      : state.grouping === 'month' ? trade.date.slice(0, 7)
      : trade.date;
    const bucket = buckets.get(key) ?? { total: 0, count: 0 };
    bucket.total += Number(trade.pnl ?? 0);
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  if (!buckets.size) {
    toggleChart(refs.pnlChart, refs.pnlEmpty, 'Nothing to total up yet.');
  } else {
    toggleChart(refs.pnlChart, refs.pnlEmpty, null);
    signedBarChart(refs.pnlChart, {
      labels: [...buckets.keys()].map(bucketLabel),
      values: [...buckets.values()].map((b) => Number(b.total.toFixed(2))),
      counts: [...buckets.values()].map((b) => b.count),
    });
  }

  renderRateChart(refs.setupChart, refs.setupEmpty, rows, 'setup', 1);
  renderRateChart(refs.sessionChart, refs.sessionEmpty, rows, 'session', 2);

  // P&L by emotion
  const byEmotion = groupSum(rows, 'emotion');
  if (!byEmotion.length) {
    toggleChart(refs.emotionChart, refs.emotionEmpty, 'Tag a few trades with how you felt.');
  } else {
    toggleChart(refs.emotionChart, refs.emotionEmpty, null);
    signedBarChart(refs.emotionChart, {
      labels: byEmotion.map((g) => g.key),
      values: byEmotion.map((g) => Number(g.total.toFixed(2))),
      counts: byEmotion.map((g) => g.count),
    });
  }
}

/**
 * Debug output for checking the plotted order against the order trades were
 * logged in. Temporary — say the word and it comes out.
 */
function logEquitySeries(chronological, values) {
  console.log('[Streak.] cumulative P&L plotted:', values);
  console.table(chronological.map((trade, i) => ({
    '#': i + 1,
    date: trade.date,
    created_at: trade.created_at,
    instrument: trade.instrument,
    direction: trade.direction,
    pnl: trade.pnl === null ? null : Number(trade.pnl),
    cumulative: values[i + 1],   // values[0] is the prepended zero
  })));
}

function bucketLabel(key) {
  if (key.length === 4) return key;
  if (key.length === 7) return formatDate(`${key}-01`, { month: 'short', year: '2-digit' });
  return formatDate(key, { day: 'numeric', month: 'short' });
}

function groupSum(trades, field) {
  const map = new Map();
  for (const trade of trades) {
    if (!trade[field]) continue;
    const g = map.get(trade[field]) ?? { key: trade[field], total: 0, count: 0 };
    g.total += Number(trade.pnl ?? 0);
    g.count += 1;
    map.set(trade[field], g);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function renderRateChart(canvas, empty, trades, field, slot) {
  const map = new Map();
  for (const trade of trades) {
    if (!trade[field] || !trade.outcome || trade.outcome === 'breakeven') continue;
    const g = map.get(trade[field]) ?? { wins: 0, count: 0 };
    if (trade.outcome === 'win') g.wins += 1;
    g.count += 1;
    map.set(trade[field], g);
  }

  const groups = [...map.entries()]
    .map(([key, g]) => ({ key, rate: (g.wins / g.count) * 100, count: g.count }))
    .sort((a, b) => b.rate - a.rate);

  if (!groups.length) {
    toggleChart(canvas, empty, `No decided trades tagged with a ${field} yet.`);
    return;
  }

  toggleChart(canvas, empty, null);
  rateBarChart(canvas, {
    labels: groups.map((g) => g.key),
    values: groups.map((g) => Math.round(g.rate)),
    counts: groups.map((g) => g.count),
    slot,
  });
}

function toggleChart(canvas, empty, message) {
  canvas.hidden = Boolean(message);
  empty.hidden = !message;
  if (message) empty.textContent = message;
}

/* ------------------------------------------------------------------ setup -- */

function renderAll() {
  renderStats();
  renderTable();
  renderCharts();
  renderCalendar();
  renderAccountBar();
}

/* ------------------------------------------------------ the account modal -- */

function openAccountModal(account = null) {
  refs.accountForm.reset();
  showBanner(refs.accountError, null);
  state.editingAccount = account?.id ?? null;

  refs.accountModalTitle.textContent = account ? 'Edit account' : 'New account';
  refs.accountSubmit.textContent = account ? 'Save account' : 'Create account';
  refs.accountStatusField.hidden = !account;
  refs.accountNoteField.hidden = !account;
  refs.accountDelete.hidden = !account;

  if (account) {
    refs.accountName.value = account.name;
    refs.accountBalance.value = account.starting_balance ?? '';
    refs.accountTarget.value = account.profit_target ?? '';
    refs.accountMaxDD.value = account.max_drawdown ?? '';
    refs.accountDailyDD.value = account.daily_drawdown ?? '';
    refs.accountStatus.value = account.status;
    refs.accountNote.value = account.status_note ?? '';
  }

  refs.accountModal.showModal();
  refs.accountName.focus();
}

/**
 * Flips a number field between positive and negative.
 *
 * The mobile numeric keypads have no minus key — `inputmode="decimal"` gives a
 * decimal point and nothing else — so a losing trade could not be typed at all
 * on a phone. This is the sign, as a button.
 *
 * An empty field becomes "-0", which reads oddly for a moment but leaves the
 * caret in a field that is already negative, so typing 250 gives -250.
 */
export function flipSign(value) {
  const raw = String(value ?? '').trim();
  if (raw === '' || raw === '-') return raw === '-' ? '' : '-0';
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return String(-n);
}

function toggleSign(input, { onChange } = {}) {
  input.value = flipSign(input.value);
  input.focus();
  // Put the caret at the end so typing continues the number.
  const end = input.value.length;
  try { input.setSelectionRange(end, end); } catch { /* number inputs may refuse */ }
  onChange?.();
}

/** Blank means "no limit", so an empty field must stay null rather than zero. */
const optionalNumber = (input) => {
  const raw = input.value.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

async function submitAccount(event) {
  event.preventDefault();
  showBanner(refs.accountError, null);

  const name = refs.accountName.value.trim();
  const balance = Number(refs.accountBalance.value);

  if (!name) {
    showBanner(refs.accountError, 'Give the account a name.');
    refs.accountName.focus();
    return;
  }
  if (!Number.isFinite(balance)) {
    showBanner(refs.accountError, 'Enter the starting balance.');
    refs.accountBalance.focus();
    return;
  }

  const values = {
    name,
    starting_balance: balance,
    profit_target: optionalNumber(refs.accountTarget),
    max_drawdown: optionalNumber(refs.accountMaxDD),
    daily_drawdown: optionalNumber(refs.accountDailyDD),
  };

  const editing = state.editingAccount;
  setBusy(refs.accountSubmit, true, 'Saving…');
  try {
    let saved;
    if (editing) {
      const previous = state.accounts.find((a) => a.id === editing);
      const statusChanged = previous && previous.status !== refs.accountStatus.value;
      saved = await updateAccount(editing, {
        ...values,
        status: refs.accountStatus.value,
        status_note: refs.accountNote.value.trim() || null,
        ...(statusChanged ? { status_changed_at: new Date().toISOString() } : {}),
      });
      // The limits may have moved; an old dismissal shouldn't hide a new breach.
      clearDismissals(editing);
      const index = state.accounts.findIndex((a) => a.id === editing);
      state.accounts[index] = saved;
      if (state.account?.id === editing) state.account = saved;
    } else {
      saved = await createAccount(state.profile.id, values);
      state.accounts.push(saved);
    }

    refs.accountModal.close();
    toast(editing ? 'Account saved.' : `${name} created.`, { type: 'success' });
    await switchAccount(saved.id);
  } catch (error) {
    showBanner(refs.accountError, error.message);
  } finally {
    setBusy(refs.accountSubmit, false);
  }
}

async function removeAccount() {
  const account = state.accounts.find((a) => a.id === state.editingAccount);
  if (!account) return;

  const count = state.trades.length;
  if (!window.confirm(
    `Delete ${account.name}? Its ${count} trade${count === 1 ? '' : 's'} and its rules go too. This can't be undone.`,
  )) return;

  try {
    await deleteAccount(account.id);
    state.accounts = state.accounts.filter((a) => a.id !== account.id);
    refs.accountModal.close();
    toast(`${account.name} deleted.`, { type: 'success' });

    const next = pickAccount(state.accounts, null);
    if (next) {
      await switchAccount(next.id);
    } else {
      state.account = null;
      state.trades = [];
      state.rules = [];
      saveSelectedAccountId(state.profile.id, null);
      renderRules();
      renderAll();
    }
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

export async function initTradingPage() {
  await requireSession();
  const profile = await requireActiveProfile();
  state.profile = profile;
  applyProfileTheme(profile.id);
  mountGreeting(profile);
  // Trades are always entered and stored in dollars.
  initMoney(profile, 'trading');

  document.body.prepend(
    topbar({
      profile,
      current: 'trading.html',
      onSwitchProfile: () => goTo(PICKER_PAGE),
      onSignOut: signOut,
      // Display only: re-read the same numbers through the new currency.
      onCurrencyChange: () => {
        labelAmountFields();
        renderAll();
      },
    }),
  );

  refs = {
    form: document.getElementById('trade-form'),
    formError: document.getElementById('trade-error'),
    date: document.getElementById('date'),
    instrument: document.getElementById('instrument'),
    direction: document.getElementById('direction'),
    session: document.getElementById('session'),
    setup: document.getElementById('setup'),
    emotion: document.getElementById('emotion'),
    entry: document.getElementById('entry'),
    exit: document.getElementById('exit'),
    stop: document.getElementById('stop'),
    target: document.getElementById('target'),
    size: document.getElementById('size'),
    rr: document.getElementById('rr'),
    pnl: document.getElementById('pnl'),
    pnlSign: document.getElementById('pnl-sign'),
    pnlCurrency: document.getElementById('pnl-currency'),
    outcome: document.getElementById('outcome'),
    recalc: document.getElementById('recalc'),
    notes: document.getElementById('notes'),
    screenshot: document.getElementById('screenshot'),
    submit: document.getElementById('trade-submit'),
    accountSelect: document.getElementById('account-select'),
    accountPill: document.getElementById('account-pill'),
    accountEdit: document.getElementById('account-edit'),
    accountSummary: document.getElementById('account-summary'),
    accountAlert: document.getElementById('account-alert'),
    accountAlertText: document.getElementById('account-alert-text'),
    accountModal: document.getElementById('account-modal'),
    accountModalTitle: document.getElementById('account-modal-title'),
    accountForm: document.getElementById('account-form'),
    accountError: document.getElementById('account-error'),
    accountName: document.getElementById('account-name'),
    accountBalance: document.getElementById('account-balance'),
    accountTarget: document.getElementById('account-target'),
    accountMaxDD: document.getElementById('account-maxdd'),
    accountDailyDD: document.getElementById('account-dailydd'),
    accountStatus: document.getElementById('account-status'),
    accountStatusField: document.getElementById('account-status-field'),
    accountNote: document.getElementById('account-note'),
    accountNoteField: document.getElementById('account-note-field'),
    accountSubmit: document.getElementById('account-submit'),
    accountDelete: document.getElementById('account-delete'),
    rulesList: document.getElementById('rules-list'),
    ruleForm: document.getElementById('rule-form'),
    ruleInput: document.getElementById('rule-input'),
    ruleCount: document.getElementById('rule-count'),
    stats: document.getElementById('stats'),
    table: document.getElementById('trade-table'),
    filterBar: document.getElementById('filter-bar'),
    equity: document.getElementById('equity-chart'),
    equityEmpty: document.getElementById('equity-empty'),
    equityTotal: document.getElementById('equity-total'),
    equityMode: document.getElementById('equity-mode'),
    calMonth: document.getElementById('cal-month'),
    calGrid: document.getElementById('cal-grid'),
    calSummary: document.getElementById('cal-summary'),
    calPrev: document.getElementById('cal-prev'),
    calNext: document.getElementById('cal-next'),
    pnlChart: document.getElementById('pnl-chart'),
    pnlEmpty: document.getElementById('pnl-empty'),
    setupChart: document.getElementById('setup-chart'),
    setupEmpty: document.getElementById('setup-empty'),
    sessionChart: document.getElementById('session-chart'),
    sessionEmpty: document.getElementById('session-empty'),
    emotionChart: document.getElementById('emotion-chart'),
    emotionEmpty: document.getElementById('emotion-empty'),
  };

  document.getElementById('profile-name').textContent = profile.name;
  labelAmountFields();

  // The lists are editable per profile in Settings; a profile that hasn't
  // touched them gets the seeds. A failure here must not take the page down —
  // you can still log a trade against the defaults.
  let lists = { instrument: INSTRUMENTS, session: SESSIONS, setup: SETUPS, emotion: EMOTIONS };
  try {
    lists = await loadOptions(profile.id);
  } catch (error) {
    toast(`${error.message} Using the default lists.`, { type: 'error' });
  }
  state.lists = lists;

  fillSelect(refs.instrument, lists.instrument, { placeholder: 'Choose one' });
  fillSelect(refs.direction, DIRECTIONS);
  fillSelect(refs.session, lists.session, { placeholder: 'Not set' });
  fillSelect(refs.setup, lists.setup, { placeholder: 'Not set' });
  fillSelect(refs.emotion, lists.emotion, { placeholder: 'Not set' });

  fillSelect(document.getElementById('filter-instrument'), lists.instrument, { placeholder: 'Any instrument' });
  fillSelect(document.getElementById('filter-direction'), DIRECTIONS, { placeholder: 'Any direction' });
  fillSelect(document.getElementById('filter-session'), lists.session, { placeholder: 'Any session' });
  fillSelect(document.getElementById('filter-setup'), lists.setup, { placeholder: 'Any setup' });
  fillSelect(document.getElementById('filter-emotion'), lists.emotion, { placeholder: 'Any emotion' });
  fillSelect(document.getElementById('filter-outcome'), OUTCOMES, { placeholder: 'Any outcome' });

  refs.date.value = todayISO();
  refs.direction.value = 'long';

  for (const status of ACCOUNT_STATUSES) {
    refs.accountStatus.append(el('option', { value: status.value, text: status.label }));
  }

  refs.table.append(skeletonList(4, 'skeleton--text'));
  refs.rulesList.append(skeletonList(2, 'skeleton--text'));

  try {
    state.accounts = await listAccounts(profile.id);
    state.account = pickAccount(state.accounts, loadSelectedAccountId(profile.id));
    if (state.account) saveSelectedAccountId(profile.id, state.account.id);

    [state.trades, state.rules] = await Promise.all([fetchTrades(), fetchRules()]);
  } catch (error) {
    clear(refs.table).append(
      emptyState({
        title: 'Couldn’t load your trades',
        body: error.message,
        actionLabel: 'Try again',
        onAction: () => window.location.reload(),
      }),
    );
    return;
  }

  renderRules();
  recalculate();
  renderAll();
  wireControls();
}

function wireControls() {
  refs.form.addEventListener('submit', submitTrade);
  document.getElementById('trade-reset').addEventListener('click', resetForm);

  for (const field of [refs.entry, refs.exit, refs.stop, refs.target, refs.size, refs.direction]) {
    field.addEventListener('input', recalculate);
    field.addEventListener('change', recalculate);
  }

  // A typed R:R or P&L sticks until you ask for the calculation back.
  for (const field of [refs.rr, refs.pnl]) {
    field.addEventListener('input', () => {
      field.dataset.manual = 'true';
      recalculate();
    });
  }
  refs.recalc.addEventListener('click', () => {
    delete refs.rr.dataset.manual;
    delete refs.pnl.dataset.manual;
    recalculate();
  });

  // Flipping the sign is a manual edit, so it sticks like a typed one does.
  refs.pnlSign.addEventListener('click', () => {
    toggleSign(refs.pnl, () => {
      refs.pnl.dataset.manual = 'true';
      recalculate();
    });
  });

  refs.ruleForm.addEventListener('submit', addRule);

  refs.filterBar.addEventListener('change', (event) => {
    const key = event.target.dataset.filter;
    if (!key) return;
    state.filters[key] = event.target.value;
    renderAll();
  });
  document.getElementById('clear-filters').addEventListener('click', clearFilters);

  refs.calPrev.addEventListener('click', () => shiftMonth(-1));
  refs.calNext.addEventListener('click', () => shiftMonth(1));

  refs.equityMode.addEventListener('click', (event) => {
    const button = event.target.closest('[data-equity-mode]');
    if (!button) return;
    if (button.dataset.equityMode === 'percent' && !hasBaseline(state.account)) {
      toast('Set a starting balance on this account to see returns as a percentage.', { type: 'error' });
      return;
    }
    state.equityMode = button.dataset.equityMode;
    for (const b of refs.equityMode.querySelectorAll('[data-equity-mode]')) {
      b.setAttribute('aria-pressed', String(b === button));
    }
    renderCharts();
  });

  refs.accountSelect.addEventListener('change', () => {
    const value = refs.accountSelect.value;
    if (value === '__new') {
      // Put the select back before opening: cancelling must not strand it.
      refs.accountSelect.value = state.account?.id ?? '';
      openAccountModal();
      return;
    }
    switchAccount(value);
  });

  refs.accountEdit.addEventListener('click', () => {
    if (state.account) openAccountModal(state.account);
  });

  refs.accountForm.addEventListener('submit', submitAccount);
  refs.accountDelete.addEventListener('click', removeAccount);
  document.getElementById('account-cancel').addEventListener('click', () => refs.accountModal.close());
  document.getElementById('account-close').addEventListener('click', () => refs.accountModal.close());

  document.getElementById('alert-confirm').addEventListener('click', applySuggestedStatus);
  document.getElementById('alert-dismiss').addEventListener('click', () => {
    if (state.account && state.pendingStatus) dismiss(state.account.id, state.pendingStatus);
    refs.accountAlert.hidden = true;
  });

  for (const button of document.querySelectorAll('[data-grouping]')) {
    button.addEventListener('click', () => {
      state.grouping = button.dataset.grouping;
      for (const b of document.querySelectorAll('[data-grouping]')) {
        b.setAttribute('aria-pressed', String(b === button));
      }
      renderCharts();
    });
  }
}
