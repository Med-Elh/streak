/**
 * Online status.
 *
 * Every profile keeps its `last_seen` fresh — once on load, then every two
 * minutes while the app is open — so the other profiles can see an honest
 * picture of who's around. Opting out (showing your online status = false)
 * hides the dot and the label for you; the heartbeat still runs because
 * Supabase RLS doesn't care about UI prefs.
 *
 * The strip in the top bar shows one presence pill per *other* profile whose
 * show_online_status is true: a compact avatar with a green dot and an
 * "Active 3h ago" label. Nothing here is secret — it's the same data the
 * competition board already shares.
 */

import { supabase, describeError } from './supabase.js?v=39';
import { listProfiles } from './profiles.js?v=39';

/* ---------------------------------------------------------------- timing -- */

const HEARTBEAT_MS   = 2 * 60 * 1000;   // refresh our own last_seen
const STRIP_REFRESH  = 30 * 1000;       // re-check others' dots
const ONLINE_WINDOW  = 2 * 60 * 1000;   // "seen in the last 2 minutes"

/* ------------------------------------------------------------- helpers -- */

/** True when `last_seen` falls inside the online window. */
export function isOnline(lastSeen) {
  if (!lastSeen) return false;
  const seen = new Date(lastSeen);
  return Number.isFinite(seen.valueOf()) && Date.now() - seen.valueOf() <= ONLINE_WINDOW;
}

/**
 * "Active 3h ago" from a timestamp, rounded to the most useful unit.
 * Callers should use isOnline() for the dot — this is for the label only.
 */
export function presenceLabel(lastSeen) {
  if (!lastSeen) return 'Never seen';
  const seen = new Date(lastSeen);
  if (!Number.isFinite(seen.valueOf())) return 'Seen recently';
  const minutes = Math.max(0, Math.round((Date.now() - seen.valueOf()) / 60_000));
  if (minutes < 60)  return `Active ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24)    return `Active ${hours}h ago`;
  return `Active ${Math.round(hours / 24)}d ago`;
}

/* ----------------------------------------------------------- heartbeat -- */

/**
 * Touch the active profile's last_seen once now, then every HEARTBEAT_MS.
 * Fires a single toast on the first connection failure, then stays quiet
 * until the connection returns — a heartbeat that spams the screen every
 * two minutes while offline would be worse than useless.
 */
export function startPresenceHeartbeat(profileId, toastFn) {
  let ok = true;

  async function beat() {
    try {
      await supabase
        .from('profiles')
        .update({ last_seen: new Date().toISOString() })
        .eq('id', profileId);
      ok = true;
    } catch (error) {
      if (ok) {
        ok = false;
        toastFn?.(describeError(error, "Couldn\u2019t update your online status."), { type: 'error', duration: 3000 });
      }
    }
  }

  beat();
  setInterval(beat, HEARTBEAT_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') beat();
  });
}

/* ---------------------------------------------------------------- strip -- */

/** Minimal DOM helpers that mirror ui.js signatures, avoiding a circular import. */
function h(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') node.setAttribute('style', v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'text') node.textContent = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(c));
  }
  return node;
}

function clearNode(node) { while (node.firstChild) node.firstChild.remove(); return node; }
function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[parts.length - 1][0];
}

function pill(profile) {
  const online = isOnline(profile.last_seen);
  const label = online ? 'Online now' : presenceLabel(profile.last_seen);

  return h('span', {
    class: `presence-chip${online ? ' presence-chip--online' : ''}`,
    title: `${profile.name} \u2014 ${label}`,
  }, [
    h('span', { class: 'presence-chip__avatar' }, [
      h('span', {
        class: 'avatar avatar--sm',
        style: `--avatar: ${profile.avatar_color}`,
        'aria-hidden': 'true',
        text: initials(profile.name),
      }),
      h('span', { class: 'presence-chip__dot', 'aria-hidden': 'true' }),
    ]),
    h('span', { class: 'presence-chip__info' }, [
      h('span', { class: 'presence-chip__name', text: profile.name }),
      h('span', { class: 'presence-chip__label', text: label }),
    ]),
  ]);
}

/**
 * Mounts the presence strip inside `host` (a `.topbar-presence` div).
 * Fetches profiles once, then re-renders on a timer and on tab focus.
 * The strip is hidden when there are no other profiles to show.
 */
export function initPresenceStrip(host, activeProfile) {
  let stopped = false;
  let lastOk = true;

  async function render() {
    if (stopped) return;
    try {
      const profiles = await listProfiles();
      const others = profiles.filter(
        (p) => p.id !== activeProfile.id && p.show_online_status,
      );
      clearNode(host);
      host.hidden = others.length === 0;
      for (const other of others) host.append(pill(other));
      lastOk = true;
    } catch {
      host.hidden = true;
      lastOk = false;
    }
  }

  render();
  setInterval(() => { if (document.visibilityState === 'visible') render(); }, STRIP_REFRESH);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') render(); });
}
