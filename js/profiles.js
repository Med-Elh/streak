/**
 * Profile CRUD and active-profile state.
 *
 * There is one account, and every profile in the table belongs to it. A profile
 * is whose data you are working on, not who you are allowed to be — signing in
 * gives you all of them.
 *
 * "Active profile" is a pointer, not data: the id is remembered in localStorage
 * so a reload or a second tab doesn't send you back to the picker, and it is
 * re-read from the database on every page load. If the row is gone, the pointer
 * is dropped and the picker takes over. Supabase stays the source of truth.
 */

import { supabase, describeError } from './supabase.js?v=29';
import { goTo, PICKER_PAGE } from './auth.js?v=29';

const ACTIVE_KEY = 'streak.active_profile';

let activeProfile = null;

/* ----------------------------------------------------------------- read -- */

/** Every profile in the app — what the picker and the competition board show. */
export async function listProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, avatar_color, exchange_rate, greeting_style, created_at')
    .order('created_at', { ascending: true });

  if (error) throw new Error(describeError(error, 'Couldn’t load profiles.'));
  return data ?? [];
}

export async function getProfile(id) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, name, avatar_color, exchange_rate, greeting_style, created_at')
    .eq('id', id)
    .maybeSingle();

  if (error) throw new Error(describeError(error, 'Couldn’t load that profile.'));
  return data;
}

/* ---------------------------------------------------------------- write -- */

export async function createProfile({ name, avatarColor }) {
  const { data, error } = await supabase
    .from('profiles')
    .insert({ name: name.trim(), avatar_color: avatarColor })
    .select('id, name, avatar_color, exchange_rate, greeting_style, created_at')
    .single();

  if (error) {
    if (error.code === '23505') throw new Error('There’s already a profile with that name.');
    throw new Error(describeError(error, 'Couldn’t create that profile.'));
  }
  return data;
}

export async function renameProfile(id, name) {
  const { error } = await supabase
    .from('profiles')
    .update({ name: name.trim() })
    .eq('id', id);
  if (error) throw new Error(describeError(error, 'Couldn’t rename that profile.'));
  if (activeProfile?.id === id) activeProfile.name = name.trim();
}

export async function recolorProfile(id, avatarColor) {
  const { error } = await supabase
    .from('profiles')
    .update({ avatar_color: avatarColor })
    .eq('id', id);
  if (error) throw new Error(describeError(error, 'Couldn’t change that colour.'));
  if (activeProfile?.id === id) activeProfile.avatar_color = avatarColor;
}

/**
 * The manual exchange rate, in MAD per 1 USD. There is no base-currency setting
 * any more: trading is USD and finances is MAD, fixed per section, so the only
 * thing left to configure is the rate between them.
 */
export async function updateCurrency(id, { exchangeRate }) {
  const { data, error } = await supabase
    .from('profiles')
    .update({ exchange_rate: exchangeRate })
    .eq('id', id)
    .select('id, name, avatar_color, exchange_rate, greeting_style, created_at')
    .single();

  if (error) throw new Error(describeError(error, 'Couldn’t save the currency settings.'));
  if (activeProfile?.id === id) Object.assign(activeProfile, data);
  return data;
}

/** Which voice the app uses for this person. */
export async function updateGreetingStyle(id, greetingStyle) {
  const { error } = await supabase
    .from('profiles')
    .update({ greeting_style: greetingStyle })
    .eq('id', id);
  if (error) throw new Error(describeError(error, 'Couldn’t save the greeting style.'));
  if (activeProfile?.id === id) activeProfile.greeting_style = greetingStyle;
}

/** Cascades to that profile's habits, finances and trades. */
export async function deleteProfile(id) {
  const { error } = await supabase.from('profiles').delete().eq('id', id);
  if (error) throw new Error(describeError(error, 'Couldn’t remove that profile.'));
  if (getActiveProfileId() === id) clearActiveProfile();
}

/* --------------------------------------------------------------- active -- */

export function getActiveProfileId() {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveProfile(profile) {
  activeProfile = profile;
  localStorage.setItem(ACTIVE_KEY, profile.id);
}

export function clearActiveProfile() {
  activeProfile = null;
  localStorage.removeItem(ACTIVE_KEY);
}

/** The active profile as loaded this page, or null if we haven't resolved one. */
export function activeProfileSync() {
  return activeProfile;
}

/** Resolves the pointer against the database. Null if the row is gone. */
export async function loadActiveProfile() {
  if (activeProfile) return activeProfile;

  const id = getActiveProfileId();
  if (!id) return null;

  const profile = await getProfile(id);
  if (!profile) {
    clearActiveProfile();
    return null;
  }

  activeProfile = profile;
  return profile;
}

/**
 * Guard for every section page: sends you to the picker if no profile is
 * chosen, and otherwise resolves with it.
 */
export async function requireActiveProfile() {
  const profile = await loadActiveProfile();
  if (!profile) {
    goTo(PICKER_PAGE);
    return new Promise(() => {});
  }
  return profile;
}
