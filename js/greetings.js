/**
 * The line under the page heading.
 *
 * Two styles: 'neutral' says hello and gets out of the way, 'warm' is written
 * for someone you like. Which one a profile gets is that profile's setting, so
 * the app can talk to two people differently without either of them choosing
 * for the other.
 *
 * Lines live in the `greetings` table and are editable in Settings, so the
 * seeded set is a starting point rather than the whole vocabulary.
 */

import { supabase, describeError } from './supabase.js?v=29';

const LAST_KEY = 'streak.last_greeting';
const SESSION_KEY = 'streak.greeting';

export const GREETING_STYLES = [
  { value: 'neutral', label: 'Neutral' },
  { value: 'warm', label: 'Warm' },
];

export const PERIODS = [
  { value: 'morning', label: 'Morning' },
  { value: 'afternoon', label: 'Afternoon' },
  { value: 'evening', label: 'Evening' },
  { value: 'any', label: 'Any time' },
];

/** Morning until noon, afternoon until six, evening after that. */
export function periodOf(date = new Date()) {
  const hour = date.getHours();
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/**
 * Not the same line as last time. If the only candidate is the one we just
 * showed, showing it again beats showing nothing.
 */
export function pickGreeting(rows, lastId) {
  if (!rows.length) return null;
  const fresh = rows.filter((r) => r.id !== lastId);
  const pool = fresh.length ? fresh : rows;
  return pool[Math.floor(Math.random() * pool.length)];
}

/** `{name}` is the only placeholder; anything else is left as written. */
export function renderGreeting(body, name) {
  return String(body ?? '').replaceAll('{name}', name ?? '');
}

export async function fetchGreetings(style, period) {
  const { data, error } = await supabase
    .from('greetings')
    .select('id, style, period, body')
    .eq('style', style)
    .in('period', [period, 'any']);
  if (error) throw new Error(describeError(error, 'Couldn’t load greetings.'));
  return data ?? [];
}

/** Every line for a style, for the Settings editor. */
export async function listGreetings() {
  const { data, error } = await supabase
    .from('greetings')
    .select('id, style, period, body')
    .order('style', { ascending: true })
    .order('period', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load greetings.'));
  return data ?? [];
}

export async function createGreeting(values) {
  const { data, error } = await supabase
    .from('greetings')
    .insert(values)
    .select('id, style, period, body')
    .single();
  if (error) throw new Error(describeError(error, 'Couldn’t add that greeting.'));
  return data;
}

export async function updateGreeting(id, values) {
  const { error } = await supabase.from('greetings').update(values).eq('id', id);
  if (error) throw new Error(describeError(error, 'Couldn’t save that greeting.'));
}

export async function deleteGreeting(id) {
  const { error } = await supabase.from('greetings').delete().eq('id', id);
  if (error) throw new Error(describeError(error, 'Couldn’t remove that greeting.'));
}

/**
 * Chosen once per session, per profile, per part of the day — so walking
 * between pages doesn't reshuffle it, but coming back later does.
 */
export function sessionKey(profileId, period) {
  return `${SESSION_KEY}.${profileId}.${period}`;
}

export async function greetingFor(profile) {
  const period = periodOf();
  const cached = sessionStorage.getItem(sessionKey(profile.id, period));
  if (cached) return cached;

  const style = profile.greeting_style === 'warm' ? 'warm' : 'neutral';
  const rows = await fetchGreetings(style, period);
  const pick = pickGreeting(rows, localStorage.getItem(`${LAST_KEY}.${profile.id}`));
  if (!pick) return null;

  localStorage.setItem(`${LAST_KEY}.${profile.id}`, pick.id);
  const line = renderGreeting(pick.body, profile.name);
  sessionStorage.setItem(sessionKey(profile.id, period), line);
  return line;
}

/**
 * Drops the line under the page heading. Silent on failure — a missing
 * greeting is not worth an error message on top of someone's morning.
 */
export async function mountGreeting(profile) {
  const head = document.querySelector('.page-head > div');
  if (!head || !profile) return;

  try {
    const line = await greetingFor(profile);
    if (!line) return;
    const p = document.createElement('p');
    p.className = 'greeting';
    p.textContent = line;
    head.append(p);
  } catch {
    /* No greeting is better than an error where a greeting should be. */
  }
}
