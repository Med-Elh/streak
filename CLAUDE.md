# Streak.

A private, multi-profile personal dashboard: habits, finances, and a trading journal in one app. Built as a static site (plain HTML/CSS/JS, no framework, no build step) with Supabase as the backend.

The name is always written **`Streak.`** — lowercase-sensitive, with the trailing period. Never "Streak", never "STREAK".

---

## 1. Core concept

One shared app, several **profiles**. A profile is a person (starts with two, more can be added at any time). Each profile has its own habits, its own finances, its own trades.

**One shared account.** Everyone signs in with the same email and password, then picks a profile. Profiles are not private from each other — anyone signed in sees everything, and switching profiles is a switch of *whose data you are working on*, not of what you are allowed to see. The privacy boundary is the login, and there is only one.

**Sections:**
1. **Habits** — daily check-ins, streaks, comparison and competition between profiles
2. **Tasks & Objectives** — a to-do list and longer-run goals with progress
3. **Finances** — income and expenses by category, monthly view
4. **Trading** — trade journal with structured fields and performance charts

---

## 2. Tech stack

| Layer | Choice |
|---|---|
| Frontend | Plain HTML5, CSS3, vanilla JS (ES modules) |
| Backend | Supabase (Postgres, Auth, Row Level Security) |
| Client lib | `@supabase/supabase-js` v2 via CDN ESM import |
| Charts | Chart.js via CDN |
| Hosting | GitHub Pages |

**Constraints:**
- No npm, no bundler, no framework. Everything must run by opening `index.html` on a static host.
- Only the Supabase **anon** key ships in the client. All real protection lives in RLS policies, never in JS.
- No `localStorage` for anything that matters — Supabase is the source of truth. Session persistence via the Supabase client's own storage is fine.

---

## 3. File structure

```
/
├── index.html              # Login
├── profiles.html           # Profile picker (post-login)
├── habits.html
├── tasks.html
├── plans.html
├── wellbeing.html
├── finances.html
├── trading.html
├── backtest.html
├── settings.html
├── sql/                    # Standalone migrations, run in the Supabase editor
├── css/
│   ├── tokens.css          # Design tokens only — colors, type, spacing, radii
│   ├── base.css            # Reset, typography, layout primitives
│   └── components.css      # Buttons, cards, tables, modals, forms, nav
├── js/
│   ├── supabase.js         # Client init, exported singleton
│   ├── auth.js             # Sign in/out, session guard, redirect logic
│   ├── profiles.js         # Profile CRUD, active-profile state
│   ├── presence.js         # Online status: heartbeat + top-bar strip
│   ├── chat.js             # Chat icon, panel, polling, mark-as-read
│   ├── habits.js
│   ├── tasks.js
│   ├── plans.js
│   ├── wellbeing.js
│   ├── accounts.js
│   ├── finances.js
│   ├── trading.js
│   ├── backtest.js
│   ├── settings.js
│   ├── greetings.js        # The line under each page heading
│   ├── charts.js           # All Chart.js config in one place
│   ├── constants.js        # Dropdown option lists (sessions, setups, emotions…)
│   └── ui.js               # Shared helpers: modal, toast, empty state, format
└── assets/
```

**Rules:**
- One JS module per section. No cross-imports between section modules — shared logic goes in `ui.js` or `constants.js`.
- Every page imports `auth.js` first and redirects to `index.html` if there's no session.
- Never hardcode a dropdown option inside a page — it comes from `constants.js`.

---

## 4. Data model

```sql
-- profiles: one row per person. Not tied to an auth user — there is only one
-- account, and every profile in the table belongs to it.
profiles (
  id            uuid pk,
  name          text,
  avatar_color  text,
  exchange_rate numeric,   -- manual, MAD per 1 USD. Display only, never applied on save.
  last_seen     timestamptz,          -- presence heartbeat, written every 2 min
  show_online_status boolean default true,  -- top-bar dot/label shown to others
  chat_enabled  boolean default true, -- top-bar chat icon for this profile
  created_at    timestamptz
)

-- messages: one-to-one chat between profiles. No attachments, no editing.
messages (
  id           uuid pk default gen_random_uuid(),
  sender_id    uuid not null references profiles(id) on delete cascade,
  recipient_id uuid not null references profiles(id) on delete cascade,
  body         text not null check (length(btrim(body)) between 1 and 2000),
  read_at      timestamptz,
  created_at   timestamptz not null default now()
)

habits (
  id, profile_id, name, icon, target_per_week int,
  active boolean, created_at
)

habit_entries (
  id, habit_id, date date, completed boolean,
  unique (habit_id, date)
)

tasks (
  id, profile_id, title text, notes text,
  due_date date, priority text check (priority in ('low','medium','high')),
  done boolean, completed_at timestamptz, created_at
)

objectives (
  id, profile_id, title text, notes text,
  target_value numeric, current_value numeric, unit text,
  deadline date, status text check (status in ('active','achieved','abandoned')),
  created_at
)

-- profile_options: the editable dropdown lists. A profile with no rows of a
-- given kind falls back to the seeds in constants.js.
profile_options (
  id, profile_id,
  kind text check (kind in ('instrument','session','setup','emotion')),
  value text, sort_order int, created_at,
  unique (profile_id, kind, value)
)

finance_categories (
  id, profile_id, name, kind text check (kind in ('income','expense')), color
)

finance_entries (
  id, profile_id, category_id, amount numeric,
  date date, note text
)

trades (
  id, profile_id,
  date date, instrument text, direction text,   -- 'long' | 'short'
  session text, setup text, emotion text,
  entry numeric, exit numeric, stop numeric, target numeric,
  rr numeric, pnl numeric, size numeric,
  outcome text,                                  -- 'win' | 'loss' | 'breakeven'
  notes text, screenshot_url text,
  created_at
)

trading_rules (
  id, profile_id, rule text, active boolean
)
```

**RLS is mandatory on every table**, and the policy is the same one everywhere:

- Signed in (`auth.role() = 'authenticated'`) → full read and write on every row.
- Not signed in → nothing at all.

One policy per table, `for all`, `to authenticated`, `using (true) with check (true)`. RLS is doing one job here: keeping the anon key from reading the database. It is not a per-profile boundary, because there isn't one.

---

## 5. Screens

### Login (`index.html`)
Email + password via `supabase.auth.signInWithPassword`. Single centered card. Error states are specific ("That password doesn't match this email"), never "Something went wrong". No sign-up link — there is one shared account, created once in the Supabase dashboard.

### Profile picker (`profiles.html`)
Grid of every profile in the app, shown after login. Selecting one sets the active profile and goes straight to Habits. An "Add profile" tile appears here.

### Habits
- Today view: list of the active profile's habits, tap to toggle done.
- Current streak per habit, and an overall current streak used for ranking.
- **Competition board**: every profile ranked by current streak length.
- **Filter bar**: by profile, by habit, by date range.
- **Charts**: completion rate over time; comparison mode (multiple profiles on one chart) vs. solo mode.

### Tasks & Objectives
Two halves on one page, both scoped to the active profile.

**Tasks** — a quick-add input at the top: type a title, press enter, it's on the list. A checkbox completes it, done items strike through and collapse into a "Done today" group at the bottom. Each row shows its due date and a coloured priority dot; overdue dates are red. Filter by all / today / overdue / done.

**Objectives** — cards, each with a title, a progress ring of current against target, the raw numbers under it ("12 / 30 trades"), and the deadline with days remaining. Editing an objective updates its current value. Achieved objectives move to a collapsed section.

### Finances
- Month selector at the top; everything below is scoped to that month.
- Add entry: amount, category, date, note.
- Summary: total in, total out, net.
- Charts: expenses by category (doughnut), monthly net across the year (bar).
- Categories are user-editable, each with its own color.

### Trading
The most detailed screen. Trade entry must be **fast and mostly click-based** — the only free-typed fields are numbers and the notes.

Log-trade form fields:
- Date, instrument *(select)*, direction *(long/short toggle)*
- Session *(select)*, setup *(select)*, emotion *(select)*
- Entry, exit, stop, target, size *(numeric)*
- R:R and P&L — auto-calculated from the numbers, manually overridable
- Outcome — derived from P&L
- Notes, optional screenshot URL

Views:
- **Trade table** — sortable, filterable by any of the select fields, with inline edit and delete.
- **Stats strip** — win rate, average R:R, total P&L, best/worst trade, profit factor.
- **Charts** — cumulative equity curve; P&L by day, by month, by year; win rate by setup; win rate by session; P&L distribution by emotion.
- **Rules** — a checklist of the profile's own trading rules, editable, shown alongside the log form as a pre-trade check.

### Settings
- **Profiles** — add, rename, recolor, remove.
- **Options** — edit the dropdown lists (instruments, setups, sessions, emotions) and finance categories.
- **Currency** — one field: the MAD-per-USD exchange rate, typed manually. There is no base-currency setting; each section's currency is fixed.
- **Chat & presence** — two toggles, per profile: "Show my online status" (whether your dot and last-seen show in the other profile's top bar) and "Enable chat" (whether your top bar shows the chat icon).
- **Appearance** — dark/light toggle, persisted per profile.

### Presence & chat (top bar, every section page)
- Every profile writes its own `last_seen` once on load and every 2 minutes while the app is open, and others' last-seen is re-read every 30 seconds.
- The top bar shows a presence pill per other profile whose `show_online_status` is true: avatar with a green dot when seen within the last 2 minutes, otherwise an "Active 3h ago" label.
- The chat icon (shown only when the active profile's `chat_enabled` is true) opens a panel that polls every 15 seconds, groups messages by day, sends on Enter, and marks received messages as read while the panel is open and visible. Sent messages show a live read receipt — a single tick until the recipient reads them, then a double tick with the read time. When more than one other profile exists, the panel tabs between conversations.

---

## 6. Dropdown option lists (`constants.js`)

Seed values — all user-editable from Settings:

- **Sessions:** Asian, London, New York AM, New York PM, Overlap
- **Directions:** Long, Short
- **Emotions:** Calm, Confident, Impatient, Fearful, Greedy, Revenge, FOMO, Bored
- **Setups:** Breakout, Reversal, Trend continuation, Range, Liquidity sweep, Order block, Fair value gap, News
- **Outcomes:** Win, Loss, Breakeven
- **Instruments:** XAUUSD, EURUSD, GBPUSD, USDJPY, NAS100, US30, SPX500, BTCUSD, ETHUSD

---

## 7. Design direction

Read `/mnt/skills/public/frontend-design/SKILL.md` conventions before writing any CSS: make deliberate, specific choices rather than reaching for defaults.

Non-negotiables for this project:
- **Dark and light modes both first-class**, toggled from Settings and persisted. Define every color as a token in `tokens.css` and flip via a `[data-theme]` attribute on `<html>`. No hardcoded hex outside `tokens.css`.
- **The streak is the signature.** The app is named after it — the streak counter should be the most visually considered element in the product, not a number in a corner.
- Type: pair a characterful display face with a clean body face, and use a tabular/monospaced face for all numbers (P&L, R:R, amounts, streak counts). Numbers must align in columns.
- Green/red for P&L is expected in a trading journal — keep it, but don't let it become the whole palette.
- Avoid the AI-default looks: cream + serif + terracotta; near-black + acid green; broadsheet hairline rules.

Quality floor, not negotiable: responsive to mobile, visible keyboard focus, `prefers-reduced-motion` respected, forms usable with keyboard only.

**Copy rules:** active voice, sentence case, plain verbs. Buttons say what happens ("Log trade", not "Submit"), and the confirmation matches the button ("Trade logged"). Errors say what went wrong and how to fix it. Empty states invite an action ("No trades yet. Log your first one." with the button right there), never just "No data".

---

## 8. Build order

1. Supabase project, schema, RLS policies. Confirm the anon key reads nothing before touching UI.
2. `tokens.css` + `base.css` + `components.css` — the design system first, so pages are assembled from it.
3. Auth: login → session guard → profile picker.
4. Habits (simplest section, proves the data flow end to end).
5. Finances.
6. Trading — table and form first, charts second.
7. Settings.
8. Pass over empty states, loading states, and error states across all pages.
9. Mobile pass.

---

## 9. Working conventions

- Ask before adding a dependency. The answer is usually no.
- Every Supabase call wrapped in try/catch, every failure surfaced as a toast — never a silent no-op or a bare `console.error`.
- Every list has a defined empty state and loading state before it ships.
- Currency: **one currency per section, fixed.** Trading is entered and stored in **USD**; finances in **MAD**. Neither form offers a choice, and nothing is converted on save. The top-bar toggle (Auto / MAD / USD) is display only — it converts on the fly and must never write to the database; "Auto" is the default and shows each section in its own currency. Every page calls `useCurrency('trading' | 'finances')` once, then formats through the `ui.js` helpers (`formatMoney`, `formatSignedMoney`, `compactMoney`, `compactNumber`), never a bare `Intl.NumberFormat`. The single stored rate means **MAD per 1 USD**.
- Dates: ISO `YYYY-MM-DD` in the database, localized on display.
- Never commit the Supabase URL/key inline in HTML — keep them in `js/supabase.js` only.
- Comment the *why*, not the *what*.
