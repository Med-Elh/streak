/**
 * Chat between profiles.
 *
 * The icon lives in the top bar; the panel hangs off document.body. Every
 * 15 seconds the panel polls for new messages; when it's open and visible
 * the poll also marks received messages as read, which clears the badge.
 * Sent messages carry a receipt: a single tick until the recipient reads
 * them, then a double tick with the read time. Text only, no attachments.
 *
 * When the active profile's chat_enabled is false, or there are no other
 * profiles, the icon is hidden entirely.
 */

import { supabase, describeError } from './supabase.js?v=31';
import { listProfiles } from './profiles.js?v=31';
import { isOnline, presenceLabel } from './presence.js?v=31';

const POLL_MS = 15_000;
const FIELDS  = 'id, sender_id, recipient_id, body, read_at, created_at';

/* ---- data layer ---- */

async function fetchThread(meId, otherId) {
  const { data, error } = await supabase
    .from('messages')
    .select(FIELDS)
    .or(`and(sender_id.eq.${meId},recipient_id.eq.${otherId}),and(sender_id.eq.${otherId},recipient_id.eq.${meId})`)
    .order('created_at', { ascending: true });
  if (error) throw new Error(describeError(error, "Couldn\u2019t load messages."));
  return data ?? [];
}

async function unreadCount(recipientId) {
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', recipientId)
    .is('read_at', null);
  if (error) throw new Error(describeError(error, "Couldn\u2019t check for messages."));
  return count ?? 0;
}

async function markRead(meId, otherId) {
  const { error } = await supabase
    .from('messages')
    .update({ read_at: new Date().toISOString() })
    .eq('recipient_id', meId)
    .eq('sender_id', otherId)
    .is('read_at', null);
  if (error) throw new Error(describeError(error, "Couldn\u2019t mark messages as read."));
}

async function sendMessage({ senderId, recipientId, body }) {
  const { data, error } = await supabase
    .from('messages')
    .insert({ sender_id: senderId, recipient_id: recipientId, body: body.trim() })
    .select(FIELDS)
    .single();
  if (error) throw new Error(describeError(error, "Couldn\u2019t send that message."));
  return data;
}

/* ---- day helpers ---- */

function localDateKey(d) { return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; }

function dayLabel(iso) {
  const d = new Date(iso);
  const now = new Date();
  const key = localDateKey(d);
  if (key === localDateKey(now)) return 'Today';
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (key === localDateKey(yest)) return 'Yesterday';
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' })
    .format(new Date(`${d.getFullYear()}-${mm}-${dd}T12:00:00`));
}

function clockTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/* ---- main export ---- */

/**
 * Initialise chat for this profile. `ui` provides el/clear so the module
 * doesn't import ui.js (keeps the module graph one-directional).
 */
export function initChat({ host, profile, toastFn, ui }) {
  let timer;
  let stopped = false;
  let lastOk = true;

  const state = {
    open: false,
    visible: document.visibilityState === 'visible',
    activeId: null,
    others: [],
    messages: [],
    focusBottom: true,
  };

  /* ---- DOM ---- */

  const badge = ui.el('span', { class: 'chat-badge', hidden: true });
  const button = ui.el('button', {
    class: 'chat-button',
    type: 'button',
    'aria-label': 'Chat',
    'aria-expanded': 'false',
    title: 'Chat',
    onclick: () => (state.open ? close() : open()),
  });
  button.innerHTML = CHAT_SVG;
  button.append(badge);

  const threadEl = ui.el('div', { class: 'chat-panel__thread' });
  const composeInput = ui.el('textarea', {
    class: 'input chat-panel__compose-input',
    placeholder: 'Type a message…',
    rows: '1',
    maxlength: '2000',
    'aria-label': 'Message',
  });
  const composeHint = ui.el('span', { class: 'chat-panel__compose-hint', text: 'Enter to send' });
  const composeArea = ui.el('form', { class: 'chat-panel__compose', novalidate: '' }, [composeInput, composeHint]);
  composeArea.addEventListener('submit', (e) => { e.preventDefault(); send(); });

  const tabsEl = ui.el('div', { class: 'chat-panel__tabs', hidden: true });
  const panelAvatar = ui.el('span', { class: 'avatar avatar--sm chat-panel__avatar', 'aria-hidden': 'true' });
  const panelTitle = ui.el('span', { class: 'chat-panel__title' });
  const panelPresence = ui.el('span', { class: 'chat-panel__presence' });
  const panelHead = ui.el('div', { class: 'chat-panel__head' }, [
    ui.el('span', { class: 'chat-panel__who' }, [panelAvatar, ui.el('span', { class: 'chat-panel__head-text' }, [panelTitle, panelPresence])]),
    ui.el('button', {
      class: 'btn btn--icon chat-panel__close',
      type: 'button',
      'aria-label': 'Close chat',
      text: '×',
      onclick: close,
    }),
  ]);

  const panel = ui.el('section', {
    class: 'chat-panel',
    role: 'dialog',
    'aria-label': 'Chat',
    hidden: true,
  }, [panelHead, tabsEl, threadEl, composeArea]);
  /* ---- thread rendering ---- */

  function otherOf() {
    return state.others.find((o) => o.id === state.activeId) ?? null;
  }

  /* ---- read-receipt helper ---- */

  function readReceipt(msg) {
    const ticks = msg.read_at ? DOUBLE_TICK_SVG : SINGLE_TICK_SVG;
    const label  = msg.read_at ? `Read \u00a0${clockTime(msg.read_at)}` : 'Sent';
    const status = ui.el('span', {
      class: `chat-bubble__status${msg.read_at ? ' chat-bubble__status--read' : ''}`,
    });
    status.innerHTML = ticks;
    status.append(document.createTextNode(` ${label}`));
    return ui.el('span', { class: 'chat-bubble__meta' }, [
      ui.el('time', { class: 'chat-bubble__time', datetime: msg.created_at, text: clockTime(msg.created_at) }),
      status,
    ]);
  }

  /* ---- thread rendering ---- */

  function renderThread() {
    ui.clear(threadEl);
    const other = otherOf();
    if (!state.messages.length) {
      threadEl.append(
        ui.el('div', { class: 'chat-panel__empty' }, [
          ui.el('p', { class: 'chat-panel__empty-title', text: `No messages with ${other?.name ?? 'them'} yet` }),
          ui.el('p', { class: 'chat-panel__empty-body', text: 'Text only, no attachments — the first hello writes itself.' }),
        ]),
      );
      return;
    }
    let lastDay = null;
    for (const msg of state.messages) {
      const label = dayLabel(msg.created_at);
      if (label !== lastDay) {
        lastDay = label;
        threadEl.append(ui.el('div', { class: 'chat-day' }, ui.el('span', { text: label })));
      }
      const mine = msg.sender_id === profile.id;
      threadEl.append(ui.el('div', { class: `chat-bubble${mine ? ' chat-bubble--mine' : ''}` }, [
        ui.el('p', { class: 'chat-bubble__body', text: msg.body }),
        mine
          ? readReceipt(msg)
          : ui.el('time', { class: 'chat-bubble__time', datetime: msg.created_at, text: clockTime(msg.created_at) }),
      ]));
    }
  }

  function scrollThread() { threadEl.scrollTop = threadEl.scrollHeight; }

  /* ---- tabs (only when more than one other profile) ---- */

  function renderTabs() {
    ui.clear(tabsEl);
    if (state.others.length < 2) { tabsEl.hidden = true; return; }
    tabsEl.hidden = false;
    for (const other of state.others) {
      const active = other.id === state.activeId;
      tabsEl.append(ui.el('button', {
        class: `chat-tab${active ? ' chat-tab--active' : ''}`,
        type: 'button',
        text: other.name,
        'aria-pressed': String(active),
        onclick: () => switchTo(other.id),
      }));
    }
  }

  async function switchTo(otherId) {
    state.activeId = otherId;
    state.messages = [];
    const other = otherOf();
    if (other) setWho(other);
    renderTabs();
    renderThread();
    await refresh();
  }

  function presentText(other) {
    return isOnline(other.last_seen) ? 'Online now' : presenceLabel(other.last_seen);
  }

  function setWho(other) {
    panelAvatar.style = `--avatar: ${other.avatar_color}`;
    panelAvatar.textContent = ui.initials(other.name);
    panelTitle.textContent = other.name;
    panelPresence.textContent = presentText(other);
  }

  /* ---- badge ---- */

  function paintBadge(count) {
    if (!count) { badge.hidden = true; badge.textContent = ''; return; }
    badge.hidden = false;
    badge.textContent = count > 99 ? '99+' : String(count);
  }

  /* ---- refresh loop ---- */

  async function refresh() {
    if (stopped) return;
    try {
      const [count, thread] = await Promise.all([
        unreadCount(profile.id),
        state.open ? fetchThread(profile.id, state.activeId) : Promise.resolve(null),
      ]);
      paintBadge(count);
      if (state.open && thread) {
        // Only yank the view back to the bottom if the reader is already
        // there — reading old messages shouldn't keep fighting a poll.
        const nearBottom =
          threadEl.scrollHeight - threadEl.scrollTop - threadEl.clientHeight < 32;
        state.messages = thread;
        renderThread();
        if (state.focusBottom || nearBottom) scrollThread();
        state.focusBottom = false;
        if (state.visible) {
          await markRead(profile.id, state.activeId);
          // A different conversation may still have unread messages, so the
          // badge is re-counted rather than assumed to be zero.
          const remaining = await unreadCount(profile.id);
          paintBadge(remaining);
        }
      }
      lastOk = true;
    } catch (error) {
      if (lastOk) toastFn?.(error.message, { type: 'error' });
      lastOk = false;
    }
  }

  /* ---- open / close ---- */

  const ac = new AbortController();
  const globalListeners = { signal: ac.signal };

  function open() {
    if (!state.activeId) return;
    state.open = true;
    state.visible = document.visibilityState === 'visible';
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    state.focusBottom = true;
    refresh();
    composeInput.focus();
  }

  function close() {
    state.open = false;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.open) { e.stopPropagation(); close(); button.focus(); }
  }, globalListeners);
  document.addEventListener('visibilitychange', () => {
    state.visible = document.visibilityState === 'visible';
  }, globalListeners);

  /* ---- send ---- */

  async function send() {
    const body = composeInput.value.trim();
    if (!body) return;
    composeInput.value = '';
    try {
      const message = await sendMessage({ senderId: profile.id, recipientId: state.activeId, body });
      state.messages = [...state.messages, message];
      renderThread();
      scrollThread();
    } catch (error) {
      toastFn?.(error.message, { type: 'error' });
      composeInput.value = body;
    }
  }

  composeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  /* ---- bootstrap ---- */

  (async () => {
    try {
      const profiles = await listProfiles();
      state.others = profiles.filter((p) => p.id !== profile.id);
      if (!state.others.length) { host.hidden = true; return; }
      if (!profile.chat_enabled) { host.hidden = true; return; }
    } catch {
      host.hidden = true;
      toastFn?.(describeError(null, "Couldn\u2019t start chat."), { type: 'error' });
      return;
    }

    host.hidden = false;
    host.append(button);
    document.body.append(panel);
    state.activeId = state.others[0].id;
    setWho(state.others[0]);
    renderTabs();
    renderThread();
    refresh();
    timer = setInterval(refresh, POLL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') refresh();
    }, globalListeners);
  })();

  /* ---- teardown ---- */

  function stop() {
    stopped = true;
    clearInterval(timer);
    ac.abort();
    button.remove();
    panel.remove();
  }

  return { stop };
}

const CHAT_SVG = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
const SINGLE_TICK_SVG = `<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 8 7 12 13 4"/></svg>`;
const DOUBLE_TICK_SVG = `<svg viewBox="0 0 20 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 8 5 12 11 4"/><polyline points="6 8 10 12 16 4"/></svg>`;
