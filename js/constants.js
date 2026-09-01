/**
 * Dropdown option lists. Nothing in a page hardcodes an option — it comes from
 * here. These are seed values; Settings will make them editable, at which point
 * these become the defaults a fresh profile starts with.
 *
 * `value` is what goes in the database, `label` is what a person reads. For the
 * free-text columns (session, setup, emotion, instrument) the two are the same;
 * for direction and outcome the database has a check constraint expecting
 * lowercase, so the split matters.
 */

export const INSTRUMENTS = [
  'XAUUSD', 'EURUSD', 'GBPUSD', 'USDJPY',
  'NAS100', 'US30', 'SPX500', 'BTCUSD', 'ETHUSD',
];

export const SESSIONS = [
  'Asian', 'London', 'New York AM', 'New York PM', 'Overlap',
];

export const SETUPS = [
  'Breakout', 'Reversal', 'Trend continuation', 'Range',
  'Liquidity sweep', 'Order block', 'Fair value gap', 'News',
];

export const EMOTIONS = [
  'Calm', 'Confident', 'Impatient', 'Fearful',
  'Greedy', 'Revenge', 'FOMO', 'Bored',
];

export const DIRECTIONS = [
  { value: 'long', label: 'Long' },
  { value: 'short', label: 'Short' },
];

export const OUTCOMES = [
  { value: 'win', label: 'Win' },
  { value: 'loss', label: 'Loss' },
  { value: 'breakeven', label: 'Breakeven' },
];

export const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

export const OBJECTIVE_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'achieved', label: 'Achieved' },
  { value: 'abandoned', label: 'Abandoned' },
];

/** Units an objective can be counted in. Free text is allowed too. */
export const OBJECTIVE_UNITS = [
  'trades', 'days', 'sessions', 'pages', 'hours', 'MAD', 'USD', '%',
];

/**
 * Feelings, in the order they appear on the grid: the settled ones first, then
 * the harder ones. Colours are existing semantic tokens rather than new hexes,
 * so every feeling follows the theme without a second palette to maintain.
 */
export const FEELINGS = [
  { value: 'Calm', icon: '🌿', token: '--series-2', tone: 'good' },
  { value: 'Content', icon: '🙂', token: '--series-3', tone: 'good' },
  { value: 'Energised', icon: '⚡', token: '--accent', tone: 'good' },
  { value: 'Grateful', icon: '🌻', token: '--series-4', tone: 'good' },
  { value: 'Tired', icon: '🌙', token: '--neutral', tone: 'difficult' },
  { value: 'Anxious', icon: '🌀', token: '--series-5', tone: 'difficult' },
  { value: 'Overwhelmed', icon: '🌊', token: '--info', tone: 'difficult' },
  { value: 'Frustrated', icon: '💢', token: '--negative', tone: 'difficult' },
  { value: 'Sad', icon: '🌧️', token: '--series-6', tone: 'difficult' },
  { value: 'Restless', icon: '🦋', token: '--warning', tone: 'difficult' },
];

export const INTENSITY_LABELS = ['Barely', 'A little', 'Moderately', 'Strongly', 'Completely'];

export function feeling(value) {
  return FEELINGS.find((f) => f.value === value) ?? null;
}

/* -------------------------------------------------------------- editable -- */

/**
 * The four trading lists are editable per profile, in `profile_options`. The
 * arrays above are the seed: a profile with no rows of a given kind falls back
 * to them rather than showing an empty select, so a fresh profile works before
 * anyone has been to Settings.
 */
export const OPTION_KINDS = [
  { kind: 'instrument', label: 'Instruments', seed: INSTRUMENTS },
  { kind: 'session', label: 'Sessions', seed: SESSIONS },
  { kind: 'setup', label: 'Setups', seed: SETUPS },
  { kind: 'emotion', label: 'Emotions', seed: EMOTIONS },
];

export function seedFor(kind) {
  return OPTION_KINDS.find((k) => k.kind === kind)?.seed ?? [];
}

/**
 * Every list for a profile, custom rows where they exist and seeds where they
 * don't. One query for all four kinds.
 */
export async function loadOptions(profileId) {
  const { supabase, describeError } = await import('./supabase.js?v=29');

  const { data, error } = await supabase
    .from('profile_options')
    .select('kind, value')
    .eq('profile_id', profileId)
    .order('sort_order', { ascending: true })
    .order('value', { ascending: true });

  if (error) throw new Error(describeError(error, 'Couldn’t load your option lists.'));

  const lists = {};
  for (const { kind, seed } of OPTION_KINDS) {
    const custom = (data ?? []).filter((row) => row.kind === kind).map((row) => row.value);
    lists[kind] = custom.length ? custom : seed;
  }
  return lists;
}

/** Normalises a plain string list into the { value, label } shape. */
export function options(list) {
  return list.map((item) => (typeof item === 'string' ? { value: item, label: item } : item));
}

export function labelFor(list, value) {
  return options(list).find((o) => o.value === value)?.label ?? value ?? '—';
}
