/**
 * Trading accounts: several named journals per profile, each with its own
 * balance, its own limits and its own status.
 *
 * The evaluation rules below are pure and exported, because they decide whether
 * an account is passed or blown — and that is not something to leave sitting
 * inside a render function where it can't be checked.
 *
 * Nothing here ever writes a status on its own. `evaluate()` returns what it
 * thinks and why; a person confirms it.
 */

import { supabase, describeError } from './supabase.js?v=14';

const ACTIVE_KEY = 'streak.active_account';
const DISMISSED_KEY = 'streak.dismissed_status';

export const ACCOUNT_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'passed', label: 'Passed' },
  { value: 'breached', label: 'Breached' },
  { value: 'archived', label: 'Archived' },
];

export const OPEN_STATUSES = ['active'];
export const CLOSED_STATUSES = ['passed', 'breached', 'archived'];

/* ------------------------------------------------------------------ rules -- */

/**
 * Null means "no limit set", and it has to stay null all the way through:
 * Number(null) is 0, which would turn an unconfigured max drawdown into a
 * drawdown limit of zero and breach the account on its first losing trade.
 */
const num = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Everything the header and the banner need, derived from the trades. */
export function evaluate(account, trades, today) {
  const starting = num(account?.starting_balance) ?? 0;
  const target = num(account?.profit_target);
  const maxDrawdown = num(account?.max_drawdown);
  const dailyLimit = num(account?.daily_drawdown);

  const netPnl = trades.reduce((sum, t) => sum + (num(t.pnl) ?? 0), 0);
  const balance = starting + netPnl;

  const dayPnl = today
    ? trades.filter((t) => t.date === today).reduce((sum, t) => sum + (num(t.pnl) ?? 0), 0)
    : 0;

  // The floor an account may not close below, and how much room is left to it.
  const floor = maxDrawdown === null ? null : starting - maxDrawdown;
  const roomLeft = floor === null ? null : balance - floor;

  const hitTarget = target !== null && target > 0 && netPnl >= target;
  const hitFloor = floor !== null && balance <= floor;
  // A daily limit is a loss limit, so only a losing day can trip it.
  const hitDaily = dailyLimit !== null && dailyLimit > 0 && dayPnl <= -dailyLimit;

  let suggested = null;
  let reason = null;

  // Breaches win over passes: an account that blew up on the way to its target
  // is blown, and reporting the happier of the two would be a lie.
  if (hitFloor) {
    suggested = 'breached';
    reason = 'This account breached its max drawdown';
  } else if (hitDaily) {
    suggested = 'breached';
    reason = 'This account breached its daily loss limit';
  } else if (hitTarget) {
    suggested = 'passed';
    reason = 'This account hit its profit target';
  }

  return {
    starting,
    balance,
    netPnl,
    dayPnl,
    target,
    floor,
    roomLeft,
    maxDrawdown,
    dailyLimit,
    // Progress toward the target, 0–100. No target means no bar.
    targetPercent: target && target > 0
      ? Math.min(Math.max((netPnl / target) * 100, 0), 100)
      : null,
    // How much of the allowed drawdown is still unspent, 0–100.
    drawdownPercent: maxDrawdown && maxDrawdown > 0
      ? Math.min(Math.max((roomLeft / maxDrawdown) * 100, 0), 100)
      : null,
    // Only an account still running can be newly passed or breached.
    suggested: account?.status === 'active' ? suggested : null,
    reason: account?.status === 'active' ? reason : null,
  };
}

/**
 * Percentages need something to be a percentage *of*. A starting balance of
 * zero — the column default — is not a baseline, it's an unanswered question,
 * so everything derived from it is withheld rather than shown as 0%.
 */
export function hasBaseline(account) {
  const n = Number(account?.starting_balance);
  return Number.isFinite(n) && n > 0;
}

/**
 * An amount as a percentage of the account's starting balance, or null.
 * `num()` is reused rather than a bare Number() so an unset P&L stays unset
 * instead of becoming a confident 0.00%.
 */
export function percentOf(amount, account) {
  if (!hasBaseline(account)) return null;
  const n = num(amount);
  if (n === null) return null;
  return (n / Number(account.starting_balance)) * 100;
}

/** Open accounts first, then the closed ones, each group by name. */
export function groupAccounts(accounts) {
  const open = accounts.filter((a) => OPEN_STATUSES.includes(a.status));
  const closed = accounts.filter((a) => CLOSED_STATUSES.includes(a.status));
  const byName = (a, b) => a.name.localeCompare(b.name);
  return { open: open.sort(byName), closed: closed.sort(byName) };
}

/* ------------------------------------------------------------------- data -- */

const COLUMNS = `id, profile_id, name, starting_balance, currency, status,
  profit_target, max_drawdown, daily_drawdown, status_changed_at, status_note, created_at`;

export async function listAccounts(profileId) {
  const { data, error } = await supabase
    .from('trading_accounts')
    .select(COLUMNS)
    .eq('profile_id', profileId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load your accounts.'));
  return data ?? [];
}

export async function createAccount(profileId, values) {
  const { data, error } = await supabase
    .from('trading_accounts')
    .insert({ profile_id: profileId, ...values })
    .select(COLUMNS)
    .single();
  if (error) {
    throw new Error(error.code === '23505'
      ? 'You already have an account with that name.'
      : describeError(error, 'Couldn’t create that account.'));
  }
  return data;
}

export async function updateAccount(id, values) {
  const { data, error } = await supabase
    .from('trading_accounts')
    .update(values)
    .eq('id', id)
    .select(COLUMNS)
    .single();
  if (error) {
    throw new Error(error.code === '23505'
      ? 'You already have an account with that name.'
      : describeError(error, 'Couldn’t save that account.'));
  }
  return data;
}

/** Status changes are stamped and can carry a note — this is an audit trail. */
export async function setStatus(id, status, note = null) {
  return updateAccount(id, {
    status,
    status_changed_at: new Date().toISOString(),
    status_note: note,
  });
}

export async function deleteAccount(id) {
  const { error } = await supabase.from('trading_accounts').delete().eq('id', id);
  if (error) throw new Error(describeError(error, 'Couldn’t delete that account.'));
}

/* -------------------------------------------------------------- selection -- */

/* Which account you were last looking at is a pointer, not data. */
export function loadSelectedAccountId(profileId) {
  return localStorage.getItem(`${ACTIVE_KEY}.${profileId}`);
}

export function saveSelectedAccountId(profileId, accountId) {
  if (accountId) localStorage.setItem(`${ACTIVE_KEY}.${profileId}`, accountId);
  else localStorage.removeItem(`${ACTIVE_KEY}.${profileId}`);
}

/**
 * The account to open on: the remembered one if it still exists, else the first
 * open account, else whatever there is.
 */
export function pickAccount(accounts, rememberedId) {
  if (!accounts.length) return null;
  return accounts.find((a) => a.id === rememberedId)
    ?? groupAccounts(accounts).open[0]
    ?? accounts[0];
}

/* A dismissed suggestion stays dismissed until the situation changes. */
export function dismissalKey(accountId, suggested) {
  return `${DISMISSED_KEY}.${accountId}.${suggested}`;
}

export function isDismissed(accountId, suggested) {
  return localStorage.getItem(dismissalKey(accountId, suggested)) === '1';
}

export function dismiss(accountId, suggested) {
  localStorage.setItem(dismissalKey(accountId, suggested), '1');
}

export function clearDismissals(accountId) {
  for (const status of ['passed', 'breached']) {
    localStorage.removeItem(dismissalKey(accountId, status));
  }
}
