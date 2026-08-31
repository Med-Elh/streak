/**
 * Supabase client — the single place the project URL and key are written.
 * Nothing else in the codebase constructs a client.
 *
 * The key below is the publishable (anon) key. It is meant to ship to the
 * browser: it identifies the project, it does not grant anything. Every real
 * restriction lives in the RLS policies, never in this file and never in JS.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = 'https://hknopmndznwtbfpkvpws.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Ny_I-RjHkME2rHYwc_lg7Q_HyTiguVn';

export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    // No magic links or OAuth redirects — sign-in is email + password only,
    // so there is never a session to recover from the URL fragment.
    detectSessionInUrl: false,
    storageKey: 'streak.auth',
  },
  global: {
    headers: { 'x-client-info': 'streak-web' },
  },
});

/**
 * The constraint or column Postgres named in a failure, or null.
 *
 * Postgres puts it in quotes in the message — `violates check constraint
 * "backtest_sessions_risk_mode_check"` — and that name is the single most
 * useful fact in the whole error, so it is worth digging out rather than
 * flattening into a generic sentence.
 */
export function constraintOf(error) {
  const text = `${error?.message ?? ''} ${error?.details ?? ''}`;

  // The name always follows the word "constraint", quoted or bare. Everything
  // else quoted in the message is the relation, and returning that names the
  // table on every failure while looking like an answer — so when the name is
  // genuinely absent, return null and let the caller say it doesn't know.
  // The bare-name pattern demands lowercase and an underscore. Without that it
  // matches the first word of an appended `details` string — "violates
  // not-null constraint" + "Failing row contains…" reads as a constraint
  // called "Failing".
  const patterns = [
    /constraint "([^"]+)"/i,
    /constraint ([a-z0-9]+_[a-z0-9_]+)/,
    /violates "?([a-z0-9_]+_(?:check|key|fkey))"?/i,
  ];

  for (const pattern of patterns) {
    const hit = text.match(pattern);
    if (hit) return hit[1];
  }
  return null;
}

/** The table a failure is about, which is a different question. */
export function relationOf(error) {
  const named = `${error?.message ?? ''}`.match(/relation "([^"]+)"/);
  return named ? named[1] : null;
}

/**
 * An error flattened into something `JSON.stringify` will actually print.
 *
 * A thrown `Error` keeps `message` and `stack` on the prototype as
 * non-enumerable properties, so stringifying one straight yields `{}` — the
 * exact moment you most need to read it.
 */
export function plainError(error) {
  if (!error || typeof error !== 'object') return { value: String(error) };

  const out = { ...error };
  for (const key of ['name', 'message', 'code', 'details', 'hint', 'status', 'statusCode', 'stack']) {
    if (error[key] !== undefined && out[key] === undefined) out[key] = error[key];
  }
  return out;
}

/**
 * The column a not-null or undefined-column failure is about, or null.
 * PostgREST phrases these as `column "foo" of relation "bar"`.
 */
export function columnOf(error) {
  const named = `${error?.message ?? ''}`.match(/column "([^"]+)"/);
  return named ? named[1] : null;
}

/**
 * Turns any Supabase/PostgREST failure into a sentence a person can act on.
 * Callers pass a fallback describing the operation ("Couldn't load profiles").
 */
export function describeError(error, fallback = 'Something failed and we could not tell why.') {
  if (!error) return fallback;

  // Thrown by fetch itself when the network or the project is unreachable.
  if (error.message === 'Failed to fetch' || error.name === 'TypeError') {
    return 'Can’t reach the server. Check your connection and try again.';
  }

  const named = constraintOf(error);

  switch (error.code) {
    case '23505':
      return 'That already exists. Pick a different name.';
    case '23503':
      return 'That references something which no longer exists. Reload and try again.';
    case '23514':
      // Name the constraint. "Some values aren't allowed" sends you hunting
      // through the whole form; the constraint name says which rule broke.
      return named
        ? `The database rejected that: it breaks the rule “${named}”.`
        : 'The database rejected one of those values, without naming the rule. Open the browser console — the full error is logged there.';
    case '23502':
      return columnOf(error)
        ? `“${columnOf(error)}” can’t be empty.`
        : 'A required value is missing.';
    case '22P02':
      return 'One of those fields got the wrong kind of value — a number field was sent text, or a blank was sent where a number belongs.';
    case '42703':
      return columnOf(error)
        ? `The database has no “${columnOf(error)}” column yet. Run the latest migration in the Supabase SQL editor.`
        : 'The database is missing a column this version of the app expects. Run the latest migration in the Supabase SQL editor.';
    case '42501':
    case 'PGRST301':
      return 'You don’t have access to that.';
    case 'PGRST116':
      return 'That record no longer exists.';
    default:
      return error.message || fallback;
  }
}
