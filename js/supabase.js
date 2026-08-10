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
 * Turns any Supabase/PostgREST failure into a sentence a person can act on.
 * Callers pass a fallback describing the operation ("Couldn't load profiles").
 */
export function describeError(error, fallback = 'Something failed and we could not tell why.') {
  if (!error) return fallback;

  // Thrown by fetch itself when the network or the project is unreachable.
  if (error.message === 'Failed to fetch' || error.name === 'TypeError') {
    return 'Can’t reach the server. Check your connection and try again.';
  }

  switch (error.code) {
    case '23505':
      return 'That already exists. Pick a different name.';
    case '23503':
      return 'That references something which no longer exists. Reload and try again.';
    case '23514':
      return 'Some of those values aren’t allowed. Check the form and try again.';
    case '42703':
      return 'The database is missing a column this version of the app expects. Run the latest migration in the Supabase SQL editor.';
    case '42501':
    case 'PGRST301':
      return 'You don’t have access to that.';
    case 'PGRST116':
      return 'That record no longer exists.';
    default:
      return error.message || fallback;
  }
}
