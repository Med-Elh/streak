# Streak.

A private, multi-profile personal dashboard: habits, finances, and a trading journal in one app. Built as a static site (plain HTML/CSS/JS, no framework, no build step) with Supabase as the backend.

The name is always written **`Streak.`** — lowercase-sensitive, with the trailing period. Never "Streak", never "STREAK".

---

## 1. Core concept

One shared app, several **profiles**. A profile is a person (starts with two, more can be added at any time). Each profile has its own habits, its own finances, its own trades.

**One shared account.** Everyone signs in with the same email and password, then picks a profile. Profiles are not private from each other — anyone signed in sees everything, and switching profiles is a switch of *whose data you are working on*, not of what you are allowed to see. The privacy boundary is the login, and there is only one.

**Sections:**
1. **Habits** — daily check-ins, streaks, comparison and competition between profiles
2. **Tasks & Objectives** — a to-do list (with voice notes) and longer-run goals with progress
3. **Planner** — a week at a glance, and each day split into hours with timed events
4. **Finances** — income and expenses by category, monthly view
5. **Trading** — trade journal with structured fields and performance charts

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
├── planner.html
├── plans.html
├── wellbeing.html
├── finances.html
├── trading.html
├── backtest.html
├── settings.html
├── manifest.json           # Installable app (Add to Home Screen): name, icons, colours
├── sw.js                   # Service worker: network first, offline fallback only. Never caches Supabase
├── sql/                    # Standalone migrations, run in the Supabase editor
├── css/
│   ├── tokens.css          # Design tokens only — colors, type, spacing, radii
│   ├── base.css            # Reset, typography, layout primitives
│   └── components.css      # Buttons, cards, tables, modals, forms, nav
├── js/
│   ├── splash.js           # Opening splash on phones. Classic script in <head>, not a module
│   ├── supabase.js         # Client init, exported singleton
│   ├── auth.js             # Sign in/out, session guard, redirect logic
│   ├── profiles.js         # Profile CRUD, active-profile state
│   ├── presence.js         # Online status: heartbeat + top-bar strip
│   ├── chat.js             # Chat icon, panel, polling, mark-as-read
│   ├── habits.js
│   ├── tasks.js            # Tasks, objectives, voice notes (recorder, waveform player, download)
│   ├── planner.js          # Week strip + hour-by-hour day, planner_events
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
└── assets/                 # App icons (icon-192/512, maskable, apple-touch, favicon)
```

**Rules:**
- One JS module per section. No cross-imports between section modules — shared logic goes in `ui.js` or `constants.js`.
- Every page `<head>` carries the same installable-app block right under `<title>` (manifest, icons, theme-color, `js/splash.js`, service worker). A new page copies it. `splash.js` must stay a plain synchronous `<script>`, not a module, so it runs before the first paint. Those theme-color hex values are the one allowed exception to the tokens-only colour rule, because the browser reads them before CSS loads.
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
  can_clear_chats boolean default false, -- owner-only: may clear whole conversations from both sides
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

-- task_audio: voice notes on a task. The file lives in the private
-- `task-audio` storage bucket at {profile_id}/{task_id}/{uuid}.{m4a|webm},
-- read through signed URLs. Rows cascade with their task; the files do not
-- (Supabase won't delete storage objects from SQL), so the app removes the
-- files first whenever a note, a task or a profile is deleted.
task_audio (
  id uuid pk, task_id uuid references tasks(id) on delete cascade,
  path text unique, mime_type text,           -- bare type: 'audio/mp4' | 'audio/webm'
  duration_ms int check (duration_ms between 0 and 125000),  -- measured while recording
  size_bytes int,
  peaks smallint[],   -- waveform bar heights 0–100 (~40), decoded once when recorded.
                      -- Nullable: older notes are decoded on the fly, or get placeholder bars
  created_at
)

-- planner_events: timed blocks on a day. end_time may be 24:00 (until midnight).
-- color is a key from EVENT_COLOURS in constants.js, never a hex.
planner_events (
  id uuid pk, profile_id uuid references profiles(id) on delete cascade,
  title text check (length(btrim(title)) between 1 and 120),
  date date, start_time time, end_time time check (end_time > start_time),
  color text default 'ember', created_at
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

Storage follows the same rule: the `task-audio` bucket is private (5 MB per file, audio types only) with one `for all to authenticated` policy on `storage.objects` scoped by `bucket_id = 'task-audio'`.

---

## 5. Screens

### Opening splash (`js/splash.js`, phones only)
When the app is opened as the installed home-screen app, or on a touch screen under 820px, a ~1.9s splash plays over the page: "Streak" rises in letter by letter, the accent dot drops in with a small bounce, the streak line draws left to right under the word, then it all fades out. Colours and type come from tokens only (`--bg`, `--text`, `--accent`, `--font-display`), and the last-used theme (`localStorage 'streak.theme'`) is applied before the first paint so dark mode gets a dark splash.
- It plays once per launch, not once per page. The first page stores its start time in sessionStorage (`streak.splash`), and pages opened during the index → profiles → habits redirect continue the same animation with a negative `animation-delay` instead of restarting it.
- A tap (or any key) skips it for the rest of the launch. It doesn't play when `data-motion="system"` is set and reduced motion is on, the same rule as every other animation.
- It hangs off `<html>`, not `<body>`, because `<body>` doesn't exist yet when it runs and is `visibility: hidden` while `[data-booting]`.

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

**Voice notes** — every task card has a mic button. Tapping it records (MediaRecorder; AAC-in-mp4 preferred because every browser, iPhone Safari included, can play it back, webm as the fallback) with a live timer and bar against the **2-minute cap**, where it stops and saves on its own. "Stop and save" uploads to the `task-audio` bucket and writes a `task_audio` row; "Discard" keeps nothing. A task can carry several.

Each note is drawn like a chat-app voice message: play/pause, a waveform of thin bars that fills with the accent as it plays, the time under it (total length at rest, the position once it has one), and a speed pill (1× → 1.5× → 2×, remembered for the session in sessionStorage). The waveform is a slider: drag or tap anywhere on it with a finger or the mouse (pointer events, `touch-action: none`), with a round knob at the position; ←/→ move 5 seconds, Home/End jump to the ends. Dragging a note that isn't playing only moves its position. One note plays at a time, and a note you leave keeps its place. Bar heights come from `task_audio.peaks`, decoded with Web Audio when the note is recorded; notes without them are decoded once per visit, and if decoding fails they get even placeholder bars and still play and seek the same. On a phone-width list the note becomes one bubble with time, speed, download and delete on a row under the waveform; every target is at least 44px.

**Download** sits next to delete. It fetches the file with `storage.download()` and names it `<task title> – voice note YYYY-MM-DD HH.MM.<m4a|webm>`, without the characters file systems refuse. On phones it opens the share sheet (`navigator.share` with the file), because a download link does nothing in the home-screen app and "Save to Files" lives there. If the tap's permission ran out during the download (`NotAllowedError`), the file is kept in memory and the toast asks for one more tap. Cancelling the sheet is silent. On computers it is an ordinary download. Deleting a note, a task, or a whole profile removes the files from storage before the rows, and if the files can't be removed the delete stops. Signed URLs are fetched in one batch on load, because iPhone Safari only starts audio inside the tap that asked for it.

**Objectives** — cards, each with a title, a progress ring of current against target, the raw numbers under it ("12 / 30 trades"), and the deadline with days remaining. Editing an objective updates its current value. Achieved objectives move to a collapsed section.

### Planner (`planner.html`)
Scoped to the active profile. Built phone-first.
- **Week strip** at the top: Monday to Sunday, ‹ › to move a week (or swipe sideways on the strip, or ←/→ to walk the days), a "Today" button whenever you're elsewhere. Today is in the accent colour; the open day is filled. Narrow screens show a coloured dot per event and a ring for tasks due; wide screens name the first three events.
- **Day view** below: the open day split into 24 hour rows in its own scroller, opened at the current hour (today), the first event, or 7am. Tapping an empty hour adds an event there (the lower half of an hour starts on the half hour); tapping an event opens it to edit or delete. Overlapping events sit side by side in columns. A line marks the current time on today.
- **Event modal**: title, date, start, end, colour (six keys mapped to the chart series tokens, so both themes work). Moving the start keeps the length; an end of 00:00 means until midnight and is stored as 24:00. Moving an event to another day follows it there.
- **Tasks due that day** are listed above the hours, read-only apart from the tick, which completes the task exactly as on the Tasks page.
- The open day is kept in the URL (`?date=YYYY-MM-DD`), not localStorage.

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
- Profiles whose `can_clear_chats` is true (the owner, flagged in SQL — currently `mohamed`) also get a trash button in the panel header. It asks for confirmation, then deletes the whole conversation with that profile in both directions — the other side sees an empty thread on its next poll.

---

## 6. Dropdown option lists (`constants.js`)

Seed values — all user-editable from Settings:

- **Sessions:** Asian, London, New York AM, New York PM, Overlap
- **Directions:** Long, Short
- **Emotions:** Calm, Confident, Impatient, Fearful, Greedy, Revenge, FOMO, Bored
- **Setups:** Breakout, Reversal, Trend continuation, Range, Liquidity sweep, Order block, Fair value gap, News
- **Outcomes:** Win, Loss, Breakeven
- **Instruments:** XAUUSD, EURUSD, GBPUSD, USDJPY, NAS100, US30, SPX500, BTCUSD, ETHUSD
- **Event colours** (planner, fixed): Ember, Teal, Green, Lilac, Violet, Brick — stored as lowercase keys, drawn with `--series-1`…`--series-6`

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
