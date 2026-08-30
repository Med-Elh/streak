/**
 * Shared UI helpers: toasts, formatting, theme, small DOM utilities.
 * Section modules never import each other — anything they share lives here.
 */

const THEME_KEY = 'streak.theme';

/* ------------------------------------------------------------------ DOM -- */

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') node.setAttribute('style', value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') node.textContent = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

/* --------------------------------------------------------------- motion -- */

export function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Waits, unless the viewer has asked for less motion — in which case every
 * choreographed pause collapses to nothing and the result appears at once.
 * Animation should be a reward, never a toll on getting the thing done.
 */
export function beat(ms) {
  return new Promise((resolve) => setTimeout(resolve, prefersReducedMotion() ? 0 : ms));
}

/**
 * Counts a number up to its value. Instant when motion is reduced, and instant
 * for a value that hasn't moved — a stat that re-renders unchanged shouldn't
 * animate again.
 */
export function countUp(node, value, { duration = 650, format = (v) => String(Math.round(v)) } = {}) {
  const target = Number(value);
  if (!Number.isFinite(target)) {
    node.textContent = format(0);
    return;
  }
  if (prefersReducedMotion() || duration <= 0) {
    node.textContent = format(target);
    return;
  }

  const from = Number(node.dataset.value ?? 0);
  node.dataset.value = String(target);
  if (from === target) {
    node.textContent = format(target);
    return;
  }

  const start = performance.now();
  const step = (now) => {
    const t = Math.min((now - start) / duration, 1);
    // Ease out: fast at first, settling onto the number.
    const eased = 1 - (1 - t) ** 3;
    node.textContent = format(from + (target - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* --------------------------------------------------------------- toasts -- */

function toastRegion() {
  let region = document.querySelector('.toast-region');
  if (!region) {
    region = el('div', {
      class: 'toast-region',
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'false',
    });
    document.body.append(region);
  }
  return region;
}

/**
 * Every failed Supabase call ends here — no silent no-ops, no bare console
 * errors. `type` is 'success' | 'error' | 'info'.
 */
export function toast(message, { type = 'info', duration = 5000 } = {}) {
  const node = el('div', { class: `toast toast--${type}` }, [
    el('span', { text: message }),
    el('button', {
      class: 'toast__close',
      type: 'button',
      'aria-label': 'Dismiss',
      text: '×',
      onclick: () => dismiss(),
    }),
  ]);

  let timer;
  function dismiss() {
    clearTimeout(timer);
    node.dataset.leaving = 'true';
    node.addEventListener('animationend', () => node.remove(), { once: true });
    // If animations are suppressed the event never fires, so guarantee removal.
    setTimeout(() => node.remove(), 400);
  }

  toastRegion().append(node);
  // Errors stay put until dismissed; they usually need a decision.
  if (type !== 'error') timer = setTimeout(dismiss, duration);
  return dismiss;
}

/* ---------------------------------------------------------------- money -- */

/**
 * Currency is a display concern and nothing more.
 *
 * Every amount in the database is stored exactly as it was entered, in the
 * profile's *base* currency. The toggle in the top bar changes only what you
 * are looking at: the conversion happens here, on the way to the screen, and
 * nothing about it is ever written back.
 *
 * `rate` has one meaning everywhere, whichever way the base is set:
 * **how many MAD make one USD**. Fixing the direction once is what stops the
 * conversion being inverted in half the call sites.
 */

const CURRENCIES = {
  MAD: { locale: 'fr-MA', code: 'MAD', symbol: 'MAD' },
  USD: { locale: 'en-US', code: 'USD', symbol: '$' },
};

const DISPLAY_KEY = 'streak.display_currency';

/**
 * Each section has one fixed currency, decided by what it records rather than
 * by a preference. Trades are placed in dollars; the household spends dirhams.
 * Neither is selectable, so neither can be got wrong on the way in.
 */
export const SECTION_CURRENCY = {
  trading: 'USD',
  finances: 'MAD',
};

/**
 * `display` is 'native' — each section in its own currency, the default — or a
 * currency code pinned by the top-bar toggle. `base` is whichever section the
 * current page belongs to, set once by useCurrency().
 */
const money = { section: 'finances', base: 'MAD', display: 'native', rate: 10 };
const formatters = new Map();

function formatterFor(code) {
  if (!formatters.has(code)) {
    const currency = CURRENCIES[code] ?? CURRENCIES.MAD;
    formatters.set(code, new Intl.NumberFormat(currency.locale, {
      style: 'currency',
      currency: currency.code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }));
  }
  return formatters.get(code);
}

/** Called once per page: which section's numbers am I about to format? */
export function useCurrency(section) {
  if (SECTION_CURRENCY[section]) {
    money.section = section;
    money.base = SECTION_CURRENCY[section];
  }
  return moneyContext();
}

export function setMoneyContext({ display, rate }) {
  if (display === 'native' || CURRENCIES[display]) money.display = display;
  if (Number.isFinite(Number(rate)) && Number(rate) > 0) money.rate = Number(rate);
  return moneyContext();
}

/** What this page is actually printing: the pin, or the section's own currency. */
export function effectiveCurrency() {
  return money.display === 'native' ? money.base : money.display;
}

export function moneyContext() {
  return { ...money, showing: effectiveCurrency(), converted: isConverted() };
}

/** True when what's on screen is not what's in the database. */
export function isConverted() {
  return effectiveCurrency() !== money.base;
}

/**
 * Base-currency amount → display currency. Never the other way.
 * Null/undefined/'' are "no amount", not zero — Number(null) is 0, which would
 * quietly turn an unset P&L into a printed 0.00.
 */
export function convertAmount(amount) {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;

  const showing = effectiveCurrency();
  if (showing === money.base) return n;
  return showing === 'USD' ? n / money.rate : n * money.rate;
}

export function formatMoney(amount) {
  const value = convertAmount(amount);
  if (value === null) return '—';
  return formatterFor(effectiveCurrency()).format(value);
}

/** Signed amount for P&L columns: keeps the sign visible on wins. */
export function formatSignedMoney(amount) {
  const value = convertAmount(amount);
  if (value === null) return '—';
  return `${value > 0 ? '+' : ''}${formatterFor(effectiveCurrency()).format(value)}`;
}

/** Short form for axis ticks and calendar cells, where the full string won't fit. */
export function compactMoney(amount, { signed = false } = {}) {
  const value = convertAmount(amount);
  if (value === null) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : (signed && value > 0 ? '+' : '');
  const code = CURRENCIES[effectiveCurrency()].symbol;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k ${code}`;
  return `${sign}${Math.round(abs)} ${code}`;
}

/** Even shorter — no currency at all. For the calendar's small cells. */
export function compactNumber(amount, { signed = true } = {}) {
  const value = convertAmount(amount);
  if (value === null) return '—';
  const abs = Math.abs(value);
  const sign = value < 0 ? '−' : (signed && value > 0 ? '+' : '');
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
  return `${sign}${Math.round(abs)}`;
}

/**
 * A percentage. Currency-independent by definition — a ratio of two amounts in
 * the same currency is the same number whichever one you display them in, so
 * these never pass through the conversion helpers.
 */
export function formatPercent(value, { digits = 2, signed = false } = {}) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const n = Number(value);
  const sign = signed && n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
}

export function formattedRate() {
  return money.rate.toLocaleString(undefined, {
    minimumFractionDigits: 2, maximumFractionDigits: 4,
  });
}

/**
 * The line beside the toggle. On native it says which currency you're reading;
 * once converted it says what the figures went through to get there.
 */
export function rateNote() {
  if (!isConverted()) return `In ${money.base}, as entered`;
  return `Converted at 1 USD = ${formattedRate()} MAD`;
}

/* The display choice is a per-profile preference, not data — it lives in
   localStorage so that toggling it can never touch the database. */
export function loadDisplayCurrency(profileId) {
  const saved = localStorage.getItem(`${DISPLAY_KEY}.${profileId}`);
  return saved === 'native' || CURRENCIES[saved] ? saved : 'native';
}

export function saveDisplayCurrency(profileId, code) {
  if (code !== 'native' && !CURRENCIES[code]) return;
  localStorage.setItem(`${DISPLAY_KEY}.${profileId}`, code);
}

/**
 * Called once per page, as soon as the active profile is known. `section` fixes
 * which currency this page's stored amounts are in.
 */
export function initMoney(profile, section) {
  if (section) useCurrency(section);
  return setMoneyContext({
    rate: Number(profile.exchange_rate) || 10,
    display: loadDisplayCurrency(profile.id),
  });
}

export { CURRENCIES };

/* ------------------------------------------------------------ formatting -- */

export function signClass(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return 'num--muted';
  return n > 0 ? 'num--positive' : 'num--negative';
}

/** ISO 'YYYY-MM-DD' in the database, localised on display. */
export function formatDate(iso, options = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!iso) return '—';
  // Parsed as UTC-noon so a date-only string never slips a day across zones.
  const date = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(date.valueOf())) return iso;
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

/** Today as 'YYYY-MM-DD' in the viewer's own timezone, for date inputs. */
export function todayISO() {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60000;
  return new Date(now - offset).toISOString().slice(0, 10);
}

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2);
  return parts[0][0] + parts[parts.length - 1][0];
}

/* --------------------------------------------------------------- topbar -- */

const NAV = [
  ['habits.html', 'Habits'],
  ['tasks.html', 'Tasks'],
  ['plans.html', 'Plans'],
  ['wellbeing.html', 'Wellbeing'],
  ['finances.html', 'Finances'],
  ['trading.html', 'Trading'],
  ['backtest.html', 'Backtest'],
  ['settings.html', 'Settings'],
];

/**
 * The bar every section page wears. `current` is the file name of the page, so
 * it can mark itself. Sign-out is passed in rather than imported, so this file
 * never has to know about auth.js.
 */
export function topbar({
  profile, current, onSwitchProfile, onSignOut, onCurrencyChange, onThemeChange,
}) {
  return el('header', { class: 'topbar' }, [
    el('div', { class: 'topbar__inner' }, [
      el('a', { class: 'wordmark', href: 'profiles.html' }, [
        el('b', { text: 'Streak' }),
        el('i', { text: '.' }),
      ]),
      el(
        'nav',
        { class: 'nav', 'aria-label': 'Sections' },
        NAV.map(([href, label]) =>
          el('a', {
            href,
            text: label,
            'aria-current': href === current ? 'page' : null,
          }),
        ),
      ),
      el('div', { class: 'spacer' }),
      onCurrencyChange ? currencySwitch(profile, onCurrencyChange) : null,
      profile ? themeToggle(profile, onThemeChange) : null,
      profile
        ? el('button', {
            class: 'profile-chip',
            type: 'button',
            title: 'Switch profile',
            onclick: onSwitchProfile,
          }, [
            el('span', {
              class: 'avatar avatar--sm',
              style: `--avatar: ${profile.avatar_color}`,
              'aria-hidden': 'true',
              text: initials(profile.name),
            }),
            el('span', { class: 'profile-chip__name', text: profile.name }),
          ])
        : null,
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        text: 'Sign out',
        onclick: onSignOut,
      }),
    ]),
  ]);
}

/* Two icons in one button. Only the one for the theme you'd switch *to* is
   visible; the other is rotated out and faded. */
const SUN_MOON_SVG = `
<svg class="theme-toggle__icon theme-toggle__sun" viewBox="0 0 24 24" aria-hidden="true">
  <circle cx="12" cy="12" r="4.2" />
  <g stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none">
    <path d="M12 2.6v2.2M12 19.2v2.2M21.4 12h-2.2M4.8 12H2.6" />
    <path d="M18.6 5.4l-1.6 1.6M7 17l-1.6 1.6M18.6 18.6L17 17M7 7L5.4 5.4" />
  </g>
</svg>
<svg class="theme-toggle__icon theme-toggle__moon" viewBox="0 0 24 24" aria-hidden="true">
  <path d="M20.4 14.2A8.6 8.6 0 0 1 9.8 3.6a8.6 8.6 0 1 0 10.6 10.6Z" />
</svg>`;

/**
 * Sun/moon in the top bar. A two-way switch — Settings keeps the three-way
 * control, since "follow the device" isn't a state a single icon can express.
 * The choice is stored per profile, same key Settings writes.
 */
function themeToggle(profile, onChange) {
  const button = el('button', {
    class: 'btn btn--icon theme-toggle',
    type: 'button',
  });
  button.innerHTML = SUN_MOON_SVG;

  const paint = () => {
    const showing = effectiveTheme();
    button.dataset.themeState = showing;
    const next = showing === 'dark' ? 'light' : 'dark';
    button.setAttribute('aria-label', `Switch to ${next} theme`);
    button.setAttribute('title', `Switch to ${next} theme`);
  };

  button.addEventListener('click', () => {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    setTheme(next, profile.id);
    paint();
    onChange?.(next);
  });

  // Following the device and the device changes its mind — keep the icon honest.
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', () => { if (currentTheme() === 'system') paint(); });

  paint();
  return button;
}

/**
 * The display-currency toggle. Switching it re-reads every number on the page
 * through the money helpers — it writes nothing but a localStorage preference,
 * and the note underneath says which rate the figures went through.
 */
function currencySwitch(profile, onChange) {
  const note = el('span', { class: 'rate-note' });
  const group = el('div', {
    class: 'segmented segmented--sm',
    role: 'group',
    'aria-label': 'Display currency',
  });

  function paint() {
    const { display } = moneyContext();
    for (const button of group.children) {
      button.setAttribute('aria-pressed', String(button.dataset.currency === display));
    }
    note.textContent = rateNote();
  }

  // "Auto" is the default and needs to be visible as a choice — an unpressed
  // pair of buttons is a state nobody can find their way back to.
  const choices = [
    ['native', 'Auto', 'Each section in its own currency'],
    ['MAD', 'MAD', 'Everything in dirhams'],
    ['USD', 'USD', 'Everything in dollars'],
  ];

  for (const [value, label, hint] of choices) {
    group.append(el('button', {
      type: 'button',
      text: label,
      title: hint,
      dataset: { currency: value },
      onclick: () => {
        if (moneyContext().display === value) return;
        setMoneyContext({ display: value });
        saveDisplayCurrency(profile.id, value);
        paint();
        onChange(value);
      },
    }));
  }

  paint();
  return el('div', { class: 'currency-switch' }, [group, note]);
}

/**
 * A row of colour swatches. The caller supplies the palette — ui.js doesn't
 * import charts.js, and this way profiles and categories can draw from
 * different sets without the component knowing either of them.
 *
 * Colour alone never carries meaning here: each swatch is a real button with an
 * accessible name, and the chosen one is marked with aria-pressed rather than
 * only a ring.
 */
export function swatchPicker({ colors, value, onPick, label = 'Colour' }) {
  const group = el('div', { class: 'swatches', role: 'group', 'aria-label': label });
  let chosen = value ?? colors[0];

  const paint = () => {
    for (const button of group.children) {
      button.setAttribute('aria-pressed', String(button.dataset.color === chosen));
    }
  };

  colors.forEach((color, index) => {
    group.append(el('button', {
      class: 'swatch',
      type: 'button',
      style: `background-color: ${color}`,
      dataset: { color },
      'aria-label': `Colour ${index + 1}`,
      onclick: () => {
        chosen = color;
        paint();
        onPick?.(color);
      },
    }));
  });

  paint();
  group.selected = () => chosen;
  group.select = (color) => { chosen = color; paint(); };
  return group;
}

/* --------------------------------------------------------------- states -- */

export function setBusy(button, busy, busyLabel) {
  if (busy) {
    button.dataset.label = button.textContent;
    button.disabled = true;
    clear(button).append(
      el('span', { class: 'btn__spinner', 'aria-hidden': 'true' }),
      document.createTextNode(busyLabel || button.dataset.label),
    );
  } else {
    button.disabled = false;
    button.textContent = button.dataset.label || button.textContent;
    delete button.dataset.label;
  }
}

/** Empty states invite an action — never a bare "No data". */
export function emptyState({ title, body, actionLabel, onAction }) {
  return el('div', { class: 'empty' }, [
    el('p', { class: 'empty__title', text: title }),
    body ? el('p', { text: body }) : null,
    actionLabel
      ? el('button', {
          class: 'btn btn--primary',
          type: 'button',
          text: actionLabel,
          onclick: onAction,
        })
      : null,
  ]);
}

export function skeletonList(count = 3, className = 'skeleton--card') {
  return el(
    'div',
    { class: 'stack', 'aria-hidden': 'true' },
    Array.from({ length: count }, () => el('div', { class: `skeleton ${className}` })),
  );
}

/** Inline form-level message. Pass null to hide. */
export function showBanner(node, message, type = 'error') {
  if (!message) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  node.className = `banner banner--${type}`;
  node.textContent = message;
  node.hidden = false;
}

/* ---------------------------------------------------------------- theme -- */

/**
 * Theme is a display preference, not data, so it lives in localStorage and is
 * applied before paint. Settings will persist the per-profile choice in the
 * database and call setTheme() on profile switch.
 */
/**
 * Applied before the profile is known, from the last theme used on this device.
 * Without it a dark-theme profile flashes white while the session resolves.
 */
export function initTheme() {
  apply(localStorage.getItem(THEME_KEY));
}

/** Once the active profile is known, its own choice wins. */
export function applyProfileTheme(profileId) {
  const saved = localStorage.getItem(`${THEME_KEY}.${profileId}`);
  apply(saved ?? localStorage.getItem(THEME_KEY));
  return currentTheme();
}

function apply(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

/**
 * `profileId` makes the choice per profile, as Settings does. The global key is
 * kept in step as "last theme used here", purely to avoid the flash above.
 */
export function setTheme(theme, profileId) {
  apply(theme === 'system' ? null : theme);

  const keys = profileId ? [`${THEME_KEY}.${profileId}`, THEME_KEY] : [THEME_KEY];
  for (const key of keys) {
    if (theme === 'system') localStorage.removeItem(key);
    else localStorage.setItem(key, theme);
  }
}

export function currentTheme() {
  return document.documentElement.dataset.theme || 'system';
}

/** What the viewer is actually looking at — 'system' resolved against the OS. */
export function effectiveTheme() {
  const chosen = currentTheme();
  if (chosen !== 'system') return chosen;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/* ----------------------------------------------------------------- ring -- */

const RING_RADIUS = 42;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * A thick progress ring with the value inside it. For a single percentage or
 * total standing on its own — where a chart would be four axes of ceremony
 * around one number.
 *
 * `value` and `max` drive the arc; `display` is what's written in the middle
 * (defaults to a percentage). `tone` is 'accent' | 'positive' | 'negative'.
 */
export function statRing({ value, max = 100, display, label, tone = 'accent', size = 'md' }) {
  const ratio = max > 0 ? Math.min(Math.max(value / max, 0), 1) : 0;
  const offset = RING_CIRCUMFERENCE * (1 - ratio);

  const ring = el('div', {
    class: `ring ring--${size} ring--${tone}`,
    role: 'img',
    'aria-label': `${label ? `${label}: ` : ''}${display ?? `${Math.round(ratio * 100)}%`}`,
  });

  ring.innerHTML = `
    <svg viewBox="0 0 100 100" aria-hidden="true">
      <circle class="ring__track" cx="50" cy="50" r="${RING_RADIUS}" />
      <circle class="ring__arc" cx="50" cy="50" r="${RING_RADIUS}"
        stroke-dasharray="${RING_CIRCUMFERENCE.toFixed(2)}"
        stroke-dashoffset="${offset.toFixed(2)}" />
    </svg>`;

  ring.append(
    el('div', { class: 'ring__center' }, [
      el('span', { class: 'ring__value num', text: display ?? `${Math.round(ratio * 100)}%` }),
      label ? el('span', { class: 'ring__label', text: label }) : null,
    ]),
  );

  return ring;
}

/* --------------------------------------------------------------- flames -- */

/**
 * The streak mark. `days` is the current streak; `trail` is an optional array
 * of the last seven days as booleans, oldest first.
 */
export function streakMark(days, { unit = 'day streak', small = false, trail } = {}) {
  ensureFlameGradient();
  const node = el('div', {
    class: `streak${small ? ' streak--sm' : ''}`,
    dataset: { count: String(days) },
  }, [
    el('span', { class: 'streak__flame', 'aria-hidden': 'true' }),
    el('div', {}, [
      el('span', { class: 'streak__value num', text: String(days) }),
      el('span', { class: 'streak__unit', text: unit }),
    ]),
  ]);

  node.querySelector('.streak__flame').innerHTML = FLAME_SVG;

  if (trail) {
    node.append(
      el(
        'div',
        { class: 'streak-trail', 'aria-hidden': 'true' },
        trail.map((done) => el('span', { dataset: { done: String(Boolean(done)) } })),
      ),
    );
  }
  return node;
}

/* The gradient is defined once per document; every flame references it by id,
   so a page full of streak marks stays valid and repaints on a theme flip. */
function ensureFlameGradient() {
  if (document.getElementById('streak-flame-defs')) return;
  const defs = el('div', { id: 'streak-flame-defs', 'aria-hidden': 'true', hidden: true });
  defs.innerHTML = `
    <svg width="0" height="0">
      <linearGradient id="streak-flame-gradient" x1="0" y1="1" x2="0.3" y2="0">
        <stop offset="0%" stop-color="var(--flame-to)" />
        <stop offset="100%" stop-color="var(--flame-from)" />
      </linearGradient>
    </svg>`;
  document.body.append(defs);
}

const FLAME_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <path d="M12.9 1.4c.3 3-1.1 4.6-2.6 6.1C8.5 9.2 6.6 11 6.6 14.3A6.4 6.4 0 0 0 13 20.7a6.4 6.4 0 0 0 6.4-6.4c0-3.9-2.3-6.4-4.1-8.6-.9-1.1-1.7-2.2-2.4-4.3ZM12 22.6a3.6 3.6 0 0 1-3.6-3.6c0-1.8 1-2.8 1.9-3.7.7-.7 1.4-1.5 1.5-2.9.5 1 1 1.6 1.5 2.2 1 1.2 2.2 2.4 2.2 4.4A3.6 3.6 0 0 1 12 22.6Z"/>
</svg>`;
