/**
 * Sign in / sign out, the session guard, and redirect logic.
 * Every page imports this first: no session, no page.
 */

import { supabase } from './supabase.js?v=7';
import { initTheme } from './ui.js?v=7';

const LOGIN_PAGE = 'index.html';
const PICKER_PAGE = 'profiles.html';
const DEFAULT_PAGE = 'habits.html';

/** True on the login page, where "no session" is the expected state. */
function onLoginPage() {
  const path = window.location.pathname;
  return path.endsWith('/') || path.endsWith(`/${LOGIN_PAGE}`) || path === `/${LOGIN_PAGE}`;
}

/** Reveals the page once the guard has decided. See base.css [data-booting]. */
export function reveal() {
  delete document.documentElement.dataset.booting;
}

export async function getSession() {
  const { data, error } = await supabase.auth.getSession();
  if (error) return null;
  return data.session;
}

export async function getUser() {
  const session = await getSession();
  return session?.user ?? null;
}

/**
 * Guard for every protected page. Resolves with the session, or navigates to
 * the login page and never resolves — callers can treat the resolution as
 * proof that someone is signed in.
 */
export async function requireSession() {
  const session = await getSession();
  if (!session) {
    goTo(LOGIN_PAGE, { returnTo: true });
    return new Promise(() => {});
  }
  watchSignOut();
  initTheme();
  reveal();
  return session;
}

/** Guard for the login page: already signed in means straight through. */
export async function redirectIfSignedIn() {
  const session = await getSession();
  initTheme();
  if (session) {
    goTo(returnTarget() || PICKER_PAGE);
    return new Promise(() => {});
  }
  reveal();
  return null;
}

/**
 * Sign in with email and password. Throws an Error whose message is already
 * written for a person — the caller shows it as-is.
 */
export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });

  if (error) throw new Error(authMessage(error));
  return data.session;
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  // A failed sign-out still means the local session is gone; get out either way.
  if (error) console.warn('Sign-out reported an error:', error.message);
  sessionStorage.clear();
  goTo(LOGIN_PAGE);
}

/**
 * Supabase deliberately does not say which half of the pair was wrong, so we
 * cannot honestly distinguish "no such email" from "wrong password". The copy
 * names both and points at the fix rather than blaming one of them.
 */
function authMessage(error) {
  const code = error.code || '';
  const message = (error.message || '').toLowerCase();

  if (code === 'invalid_credentials' || message.includes('invalid login credentials')) {
    return 'That email and password don’t match. Check for a typo and try again.';
  }
  if (code === 'email_not_confirmed' || message.includes('not confirmed')) {
    return 'This account hasn’t been confirmed yet. Ask the owner to confirm it in Settings.';
  }
  if (code === 'over_request_rate_limit' || error.status === 429) {
    return 'Too many attempts. Wait a minute, then try again.';
  }
  if (code === 'user_banned') {
    return 'This account is disabled. Ask the owner to re-enable it in Settings.';
  }
  if (message.includes('failed to fetch')) {
    return 'Can’t reach the server. Check your connection and try again.';
  }
  return error.message || 'Sign-in failed. Try again.';
}

/**
 * If the session ends in another tab, or a refresh token is rejected, the
 * open pages must not sit there showing stale private data.
 */
let watching = false;
function watchSignOut() {
  if (watching) return;
  watching = true;
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT' && !onLoginPage()) {
      sessionStorage.clear();
      goTo(LOGIN_PAGE);
    }
  });
}

/* ------------------------------------------------------------ navigation -- */

/** Relative navigation, so the app works from a GitHub Pages subpath. */
export function goTo(page, { returnTo = false } = {}) {
  const target = new URL(page, window.location.href);
  if (returnTo && !onLoginPage()) {
    target.searchParams.set('next', window.location.pathname.split('/').pop());
  }
  window.location.replace(target.href);
}

/** Where to land after signing in, if the guard bounced us here. */
function returnTarget() {
  const next = new URLSearchParams(window.location.search).get('next');
  // Only ever a same-directory page name — never an arbitrary URL.
  return next && /^[a-z-]+\.html$/.test(next) ? next : null;
}

export { LOGIN_PAGE, PICKER_PAGE, DEFAULT_PAGE };
