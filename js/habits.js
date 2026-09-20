/**
 * Habits: today's check-ins, streaks, the competition board, and the charts.
 *
 * Streak rules, decided here and used everywhere:
 *  - A habit is done on a date if a habit_entries row exists with completed.
 *  - A habit's current streak counts back from today, or from yesterday if
 *    today isn't ticked yet — the day isn't over, so an untouched today should
 *    not read as a broken streak.
 *  - A profile's overall streak (what the board ranks on) counts a day in which
 *    at least one habit was done. Requiring all of them punishes adding a habit.
 */

import { supabase, describeError } from './supabase.js?v=41';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=41';
import { listProfiles, requireActiveProfile } from './profiles.js?v=41';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy, showBanner,
  todayISO, formatDate, initials, beat,
  prefersReducedMotion, applyProfileTheme,
} from './ui.js?v=41';
import { completionChart } from './charts.js?v=41';

const DAY = 86400000;
/** Streaks can run long; a year of history is plenty to walk back through. */
const HISTORY_DAYS = 365;
/* The streak hero's subtitle, picked from today's progress. All the copy lives
   here — logic elsewhere only picks a stage — so a message tweak is a data
   edit, never a code edit. The ladder runs "nothing yet" to "all done", with
   the end-of-day states checked before the percentage thresholds:
   0 left, 1 left, exactly one done, then 25/50/75%, then the plain count. */
const HERO_LINES = {
  none: 'Add a habit and the count starts tonight.',
  left: (remaining) => `${remaining} habit${remaining === 1 ? '' : 's'} left today to keep it going.`,
  started: 'Good start. Keep that going.',
  warming: "You're warming up.",
  halfway: "Halfway. Don't stop now.",
  almost: 'Almost there. Finish what you started.',
  oneLeft: 'One left. Make it count.',
  allDone: "That's the streak. See you tomorrow.",
};

/** Today's hero subtitle for a given (done, total). */
function todaySubtitle(done, total) {
  if (total === 0) return HERO_LINES.none;
  const remaining = total - done;
  if (remaining === 0) return HERO_LINES.allDone;
  if (remaining === 1) return HERO_LINES.oneLeft;
  if (done === 1) return HERO_LINES.started;
  const share = done / total;
  if (share >= 0.75) return HERO_LINES.almost;
  if (share >= 0.5) return HERO_LINES.halfway;
  if (share >= 0.25) return HERO_LINES.warming;
  return HERO_LINES.left(remaining);
}

import { mountGreeting } from './greetings.js?v=41';

const state = {
  profile: null,
  profiles: [],
  habits: [],        // every profile's active habits
  entries: [],       // { habit_id, date } for completed entries in the window
  filters: { profileId: 'all', habitId: 'all', days: 30 },
  editingHabit: null,
  lastHeroStreak: 0,
  mode: 'solo',      // 'solo' | 'comparison'
};

/* --------------------------------------------------------------- helpers -- */

const iso = (date) => date.toISOString().slice(0, 10);
const shiftDays = (isoDate, delta) => iso(new Date(new Date(`${isoDate}T12:00:00`).getTime() + delta * DAY));

/** Profile colours are assigned by position in the profile list, never by rank. */
function colorIndexFor(profileId) {
  return state.profiles.findIndex((p) => p.id === profileId);
}

function doneSet(habitIds) {
  const wanted = new Set(habitIds);
  const byDate = new Map();
  for (const entry of state.entries) {
    if (!wanted.has(entry.habit_id)) continue;
    if (!byDate.has(entry.date)) byDate.set(entry.date, new Set());
    byDate.get(entry.date).add(entry.habit_id);
  }
  return byDate;
}

/** Consecutive days ending today, or yesterday if today is still untouched. */
function currentStreak(dates) {
  const today = todayISO();
  let cursor = dates.has(today) ? today : shiftDays(today, -1);
  let streak = 0;
  while (dates.has(cursor)) {
    streak += 1;
    cursor = shiftDays(cursor, -1);
  }
  return streak;
}

function habitStreak(habitId) {
  const dates = new Set(state.entries.filter((e) => e.habit_id === habitId).map((e) => e.date));
  return currentStreak(dates);
}

function profileStreak(profileId) {
  const ids = new Set(state.habits.filter((h) => h.profile_id === profileId).map((h) => h.id));
  const dates = new Set(state.entries.filter((e) => ids.has(e.habit_id)).map((e) => e.date));
  return currentStreak(dates);
}

function lastSevenDays(habitId) {
  const dates = new Set(state.entries.filter((e) => e.habit_id === habitId).map((e) => e.date));
  const today = todayISO();
  return Array.from({ length: 7 }, (_, i) => dates.has(shiftDays(today, i - 6)));
}

/* ------------------------------------------------------------------ data -- */

async function loadAll() {
  const [profiles, habits] = await Promise.all([listProfiles(), fetchHabits()]);
  state.profiles = profiles;
  state.habits = habits;
  state.entries = habits.length ? await fetchEntries(habits.map((h) => h.id)) : [];
}

/**
 * Archived habits come back too. Their check-ins still count toward the days
 * they were ticked — archiving stops a habit going forward, it doesn't rewrite
 * what already happened.
 */
async function fetchHabits() {
  const { data, error } = await supabase
    .from('habits')
    .select('id, profile_id, name, icon, target_per_week, active')
    .order('created_at', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load habits.'));
  return data ?? [];
}

const activeHabits = (profileId) =>
  state.habits.filter((h) => h.profile_id === profileId && h.active);

const archivedHabits = (profileId) =>
  state.habits.filter((h) => h.profile_id === profileId && !h.active);

/** Is this habit ticked today, right now? Read at click time rather than
    captured when the card was built: cards now outlive their own state, since
    a tick updates the card in place instead of replacing it. */
const isDoneToday = (habitId) =>
  state.entries.some((e) => e.habit_id === habitId && e.date === todayISO());

/** How many of the profile's active habits still need a tick today. */
function remainingToday() {
  const mine = activeHabits(state.profile.id);
  const today = todayISO();
  const done = doneSet(mine.map((h) => h.id)).get(today) ?? new Set();
  return mine.length - done.size;
}

async function fetchEntries(habitIds) {
  const { data, error } = await supabase
    .from('habit_entries')
    .select('habit_id, date')
    .in('habit_id', habitIds)
    .eq('completed', true)
    .gte('date', shiftDays(todayISO(), -HISTORY_DAYS))
    .order('date', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load check-ins.'));
  return data ?? [];
}

/** Local state only. The streak, the dots and the grid all read from this. */
function applyTick(habit, done) {
  const date = todayISO();
  if (done) state.entries.push({ habit_id: habit.id, date });
  else state.entries = state.entries.filter((e) => !(e.habit_id === habit.id && e.date === date));
}

/** The write. Throws with a sentence the caller can show. */
async function persistTick(habit, done) {
  const date = todayISO();
  if (done) {
    const { error } = await supabase
      .from('habit_entries')
      .upsert({ habit_id: habit.id, date, completed: true }, { onConflict: 'habit_id,date' });
    if (error) throw new Error(describeError(error, `Couldn’t tick ${habit.name}.`));
  } else {
    const { error } = await supabase
      .from('habit_entries')
      .delete()
      .eq('habit_id', habit.id)
      .eq('date', date);
    if (error) throw new Error(describeError(error, `Couldn’t untick ${habit.name}.`));
  }
}

/* ---------------------------------------------------------------- render -- */

/** The ring fills over a month; a longer streak keeps it full and glowing. */
const RING_TARGET = 30;

function renderHero(mount) {
  const streak = profileStreak(state.profile.id);
  const mine = activeHabits(state.profile.id);
  const today = todayISO();
  const done = doneSet(mine.map((h) => h.id)).get(today) ?? new Set();

  const circumference = 2 * Math.PI * 74;
  const ratio = Math.min(streak / RING_TARGET, 1);

  clear(mount);
  const hero = el('div', { class: 'streak-hero', dataset: { count: String(streak) } });

  const dial = el('div', { class: 'streak-hero__dial' });
  dial.innerHTML = `
    <svg viewBox="0 0 168 168" aria-hidden="true">
      <defs>
        <linearGradient id="streak-hero-gradient" x1="0" y1="1" x2="0.4" y2="0">
          <stop offset="0%" stop-color="var(--flame-to)" />
          <stop offset="100%" stop-color="var(--flame-from)" />
        </linearGradient>
      </defs>
      <circle class="streak-hero__track" cx="84" cy="84" r="74" />
      <circle class="streak-hero__arc" cx="84" cy="84" r="74"
        stroke-dasharray="${circumference.toFixed(1)}"
        stroke-dashoffset="${(circumference * (1 - ratio)).toFixed(1)}" />
    </svg>`;
  dial.append(el('div', { class: 'streak-hero__inner' }, [
    el('span', { class: 'streak-hero__count', text: String(streak) }),
    el('span', { class: 'streak-hero__unit', text: streak === 1 ? 'day' : 'days' }),
  ]));

  hero.append(dial, el('div', { class: 'streak-hero__body' }, [
    el('p', { class: 'eyebrow', text: 'Current streak' }),
    el('h2', {
      class: 'streak-hero__title',
      text: streak === 0
        ? 'Today is day one.'
        : streak === 1
          ? 'One day down.'
          : `${streak} days and counting.`,
    }),
    el('p', {
      class: 'streak-hero__line',
      text: todaySubtitle(done.size, mine.length),
    }),
  ]));

  mount.append(hero);
  refs.hero = hero;
}

/** Live progress. The mountain is the only visual read — the percentage ring
    that used to sit here is gone — so this writes the off-screen live region
    that keeps the count spoken, moves the climber, and keeps the hero's
    subtitle on the same numbers. Re-renders with every state change. */
function renderTodayProgress(mount, climb = null) {
  const mine = activeHabits(state.profile.id);
  if (!mine.length) {
    mount.hidden = true;
    if (climb) climb.hidden = true;
    return;
  }
  mount.hidden = false;

  const today = todayISO();
  const done = doneSet(mine.map((h) => h.id)).get(today) ?? new Set();
  const total = mine.length;

  // The spoken read. A full sentence, because a live region is heard out of
  // context — "3 of 5" alone tells you nothing about what was counted.
  mount.textContent =
    `${done.size} of ${total} habit${total === 1 ? '' : 's'} done today.`;

  if (climb) renderClimb(climb, done.size, total);

  // The hero's today line reads the same numbers, so the two never disagree.
  const line = refs.hero && refs.hero.querySelector('.streak-hero__line');
  if (line) updateHeroLine(line, done.size, total);
}

/** Swap the hero subtitle's text, fading the new line in (skipped entirely
    under prefers-reduced-motion — the copy simply replaces itself there).
    The class is restarted so consecutive changes each get their own fade. */
function updateHeroLine(line, done, total) {
  const text = todaySubtitle(done, total);
  if (line.textContent === text) return;
  line.textContent = text;
  if (prefersReducedMotion()) return;
  line.classList.remove('is-refreshing');
  void line.offsetWidth; // restart the fade from opacity 0
  line.classList.add('is-refreshing');
}

/* ------------------------------------------------------------- the climb -- */

/**
 * The route up the mountain, base to summit, in the scene's 400×200 user
 * units. Both the dotted path and the climber's position are written from this
 * one array — pointAt walks it by length rather than by index, so a step is
 * always exactly one habit however many habits there are. Three habits land on
 * thirds of the route, seven on sevenths, and adding one re-spaces the whole
 * climb rather than stranding the figure between waypoints.
 */
const CLIMB_PATH = [
  { x: 40, y: 178 },
  { x: 92, y: 152 },
  { x: 136, y: 136 },
  { x: 180, y: 112 },
  { x: 218, y: 98 },
  { x: 254, y: 78 },
  { x: 276, y: 60 },
  { x: 294, y: 34 },
];

/** The apex, where the flag stands and the burst goes off. */
const CLIMB_PEAK = { x: 300, y: 26 };

/** The scene's own coordinate space, used to turn user units into pixels when
    placing the speech bubble over the rendered SVG. */
const CLIMB_VIEWBOX = { w: 400, h: 200 };

/* What the climber says, addressed to whoever is signed in. Same shape as
   HERO_LINES and the same voice — active, sentence case, no exclamation
   marks — so a wording change stays a data edit. He is encouraging, not
   congratulatory: the streak is the reward, he's just company on the way up. */
const CLIMB_LINES = {
  greet:   (name) => `Ready when you are, ${name}.`,
  first:   () => 'That’s one. Keep going.',
  warming: () => 'Good pace.',
  halfway: () => 'Halfway up.',
  almost:  () => 'Almost there.',
  oneLeft: (name) => `One more, ${name}.`,
  allDone: () => 'Summit. See you tomorrow.',
  down:    () => 'Back down a step. No rush.',
};

/** The line for a given progress, mirroring todaySubtitle's ladder. */
function climbLine(done, total, { greeting = false, descending = false } = {}) {
  const name = state.profile?.name ?? 'you';
  if (greeting) return CLIMB_LINES.greet(name);
  if (descending) return CLIMB_LINES.down();
  if (done === 0) return CLIMB_LINES.greet(name);

  const remaining = total - done;
  if (remaining === 0) return CLIMB_LINES.allDone();
  if (remaining === 1) return CLIMB_LINES.oneLeft(name);
  if (done === 1) return CLIMB_LINES.first();

  const share = done / total;
  if (share >= 0.75) return CLIMB_LINES.almost();
  if (share >= 0.5) return CLIMB_LINES.halfway();
  return CLIMB_LINES.warming();
}

/** How long a line stays up before it fades. */
const SAY_MS = 3200;
let sayTimer = null;
let climbTimer = null;

/* Base durations, in step with the CSS. --climb-tempo scales all of them from
   one place, so JS reads the token rather than keeping its own copy of the
   pace — change the token and the timers follow. */
const CLIMB_BASE = { travel: 600, cheer: 900, heart: 1400, burst: 520 };

/** The tempo multiplier, read from CSS so there is only ever one of it. */
function climbTempo() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--climb-tempo');
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

const travelMs = () => CLIMB_BASE.travel * climbTempo();
const cheerMs = () => CLIMB_BASE.cheer * climbTempo();

/* A travel is superseded the moment another one starts, so each gets a token
   and only the current one is allowed to finish. Without it, ticking twice
   quickly would fire two celebrations for one arrival. */
let travelToken = 0;

/** easeOutBack, from easings.net. Going up, the overshoot *is* the bounce on
    arrival — no second keyframe, and nothing to cancel if the next tick lands
    mid-climb. */
const CLIMB_EASE_UP = 'cubic-bezier(0.34, 1.56, 0.64, 1)';

/** Burst colours, all from the token set — the profile's accent plus the two
    flame tones the week dots already use. */
const BURST_COLOURS = ['--profile-accent', '--flame-from', '--flame-to'];

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Last rendered position, so a move can tell which way it's going and the
    summit can tell a fresh arrival from a re-render that was already there.
    `point` is kept so a resize can re-place the bubble without a move. */
const climbState = { t: null, complete: false, point: null };

/** The point a fraction `t` of the way along the route, measured by distance
    so uneven waypoint spacing doesn't make some habits count for more. */
function pointAt(t) {
  // A non-finite fraction would become translate(NaNpx, NaNpx) and take the
  // climber off the scene entirely; the base is the honest fallback.
  const clamped = Number.isFinite(t) ? Math.min(Math.max(t, 0), 1) : 0;

  const spans = [];
  let total = 0;
  for (let i = 1; i < CLIMB_PATH.length; i += 1) {
    const a = CLIMB_PATH[i - 1];
    const b = CLIMB_PATH[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    spans.push({ a, b, length });
    total += length;
  }
  if (!total) return CLIMB_PATH[0];

  let travelled = clamped * total;
  for (let i = 0; i < spans.length; i += 1) {
    const span = spans[i];
    const last = i === spans.length - 1;
    if (travelled <= span.length || last) {
      // Clamped because float drift can leave a hair more distance than the
      // final span is long.
      const k = span.length ? Math.min(travelled / span.length, 1) : 1;
      return {
        x: span.a.x + (span.b.x - span.a.x) * k,
        y: span.a.y + (span.b.y - span.a.y) * k,
      };
    }
    travelled -= span.length;
  }
  return CLIMB_PATH[CLIMB_PATH.length - 1];
}

/** Moves the climber to done/total along the route, plants the flag at the
    top, and fires the burst on arrival. Called from renderTodayProgress, so it
    reads exactly the numbers the ring card and the hero line are reading. */
function renderClimb(climb, done, total) {
  if (!total) {
    climb.hidden = true;
    return;
  }
  climb.hidden = false;

  const route = climb.querySelector('.climb__route');
  if (route && !route.getAttribute('d')) {
    route.setAttribute('d', CLIMB_PATH.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '));
  }

  const climber = climb.querySelector('.climb__climber');
  if (!climber) return;

  const t = done / total;
  const complete = done === total;
  const first = climbState.t === null;
  const moved = !first && t !== climbState.t;
  const ascending = !first && t > climbState.t;
  const arrived = complete && !first && !climbState.complete;
  const point = pointAt(t);

  // Only climbing gets the overshoot. Coming back down is a correction, and
  // the first paint is just the page arriving — neither should celebrate.
  climber.style.setProperty('--climb-ease', ascending ? CLIMB_EASE_UP : 'var(--ease-out)');
  climber.style.transform = `translate(${point.x.toFixed(2)}px, ${point.y.toFixed(2)}px)`;

  climb.dataset.complete = String(complete);

  if (moved) speak(climbLine(done, total, { descending: !ascending }), point);

  climbState.t = t;
  climbState.complete = complete;
  climbState.point = point;
  climbState.ascending = ascending;
  climbState.arrived = arrived;

  // Everything that happens *on getting there* — the landing, the cheer, the
  // kiss, the summit burst — is deferred to the end of the travel, so it plays
  // where he lands rather than over him while he is still on his way.
  if (moved) beginTravel();
}

/** Starts a travel: limbs go, and the arrival is scheduled. */
function beginTravel() {
  const token = ++travelToken;

  if (prefersReducedMotion()) {
    finishTravel(token);
    return;
  }

  setClimbing(true);
  clearTimeout(climbTimer);
  // transitionend normally ends it; this is the fallback for a transition that
  // never fires at all (a backgrounded tab, a move of zero distance).
  climbTimer = setTimeout(() => finishTravel(token), travelMs() + 140);
}

/** The arrival. Runs once per travel, for the newest travel only. */
function finishTravel(token) {
  if (token !== travelToken) return;

  clearTimeout(climbTimer);
  setClimbing(false);

  // Coming back down is a correction. Celebrating it would read the day wrong.
  if (!climbState.ascending) return;

  if (climbState.arrived && refs.climb) fireSummitBurst(refs.climb);
  // Topping out is worth more than a step, so it gets a handful of kisses
  // rather than one.
  celebrateStep(climbState.arrived ? 4 : 1);
}

/**
 * The celebration for a finished step: a hop with squash and stretch, both
 * arms up, then a kiss blown from the hand. The hearts are released at the
 * point in the keyframe where his hand leaves his face — 78% — so the gesture
 * and the thing it produces actually line up.
 */
function celebrateStep(hearts) {
  if (prefersReducedMotion()) return;

  for (const figure of document.querySelectorAll('.climb__figure')) {
    restartClass(figure, 'is-cheering', 'climb-jump', cheerMs() + 400);
  }
  setTimeout(() => releaseHearts(hearts), cheerMs() * 0.78);
}

/** A small heart, drawn around its own centre so it can be placed anywhere. */
const HEART_PATH = 'M 0 3.4 C -4.4 0.2 -4.2 -3 -2.1 -3.7 C -0.8 -4.1 0 -3.2 0 -2.3'
  + ' C 0 -3.2 0.8 -4.1 2.1 -3.7 C 4.2 -3 4.4 0.2 0 3.4 Z';

/** Scales the heart up from the size the raw path draws at. */
const HEART_SCALE = 1.5;

/**
 * Where his hand is at the moment the kiss leaves it. The shoulder sits 18
 * above his feet, and at the 78% frame the front arm is rotated -40° from
 * rest, which puts the hand very nearly level with the shoulder and 10 out to
 * the side. Worked out from the keyframe rather than eyeballed, so the hearts
 * actually leave the hand instead of near it.
 */
const HEART_HAND = { x: 10, y: -18.5 };

/** Kisses, leaving from his hand and drifting up and away. */
function releaseHearts(count) {
  const climb = refs.climb;
  if (!climb || climb.hidden || prefersReducedMotion()) return;

  const layer = climb.querySelector('.climb__hearts');
  const point = climbState.point;
  if (!layer || !point) return;

  const made = [];
  const tempo = climbTempo();

  for (let i = 0; i < count; i += 1) {
    // The position has to live on a wrapper, not on the heart. The heart's own
    // transform is what the keyframes animate, and a CSS transform beats the
    // presentation attribute outright — setting both put every heart at the
    // scene's origin, flying out of the top-left corner instead of his hand.
    const anchor = document.createElementNS(SVG_NS, 'g');
    anchor.setAttribute(
      'transform',
      `translate(${(point.x + HEART_HAND.x).toFixed(1)} ${(point.y + HEART_HAND.y).toFixed(1)})`
      + ` scale(${HEART_SCALE})`,
    );

    const heart = document.createElementNS(SVG_NS, 'path');
    heart.setAttribute('class', 'climb__heart');
    heart.setAttribute('d', HEART_PATH);
    // Drift is in the wrapper's space, so it scales with the heart and the
    // kisses keep the same spread relative to him however big they are.
    // Biased sideways rather than straight up: the speech bubble sits directly
    // over his head and draws on top of the scene, so hearts that rise
    // vertically disappear into it just as they become visible.
    heart.style.setProperty('--heart-x', `${(9 + Math.random() * 13).toFixed(1)}px`);
    heart.style.setProperty('--heart-y', `${(-11 - Math.random() * 11).toFixed(1)}px`);
    heart.style.setProperty(
      '--heart-duration',
      `${Math.round((CLIMB_BASE.heart + Math.random() * 400) * tempo)}ms`,
    );
    heart.style.animationDelay = `${Math.round(i * 110 * tempo)}ms`;
    heart.addEventListener('animationend', () => anchor.remove(), { once: true });

    anchor.append(heart);
    made.push(anchor);
    layer.append(anchor);
  }

  const longest = (CLIMB_BASE.heart + 400 + (count * 110)) * tempo + 200;
  setTimeout(() => { for (const anchor of made) anchor.remove(); }, longest);
}

/** Runs the limb cycle on every figure on the page — the scene's and the
    dock's — so the two never disagree about what he's doing. */
function setClimbing(on) {
  for (const figure of document.querySelectorAll('.climb__figure')) {
    figure.classList.toggle('is-climbing', on);
  }
}

function wave() {
  if (prefersReducedMotion()) return;
  const cap = (1100 * climbTempo()) + 300;
  for (const figure of document.querySelectorAll('.climb__figure')) {
    restartClass(figure, 'is-waving', 'climb-wave', cap);
  }
}

/** Shows a line over his head and takes it away again. */
function speak(text, point) {
  clearTimeout(sayTimer);

  const { say } = refs;
  if (!say) return;

  say.textContent = text;
  if (point) positionSay(say, point);
  say.dataset.shown = 'true';

  sayTimer = setTimeout(() => { say.dataset.shown = 'false'; }, SAY_MS);
}

/**
 * Puts the bubble's tail on the climber. Everything is measured off the
 * scene's rendered width, so it lands correctly at any size, and the bubble is
 * nudged back inside the scene when centring it would hang off an edge — the
 * tail keeps pointing at him when that happens, which is the whole job.
 */
function positionSay(say, point) {
  const scene = refs.climb?.querySelector('.climb__scene');
  if (!scene) return;

  const width = scene.getBoundingClientRect().width;
  if (!width) return;

  const scale = width / CLIMB_VIEWBOX.w;
  const x = point.x * scale;
  const y = point.y * scale;
  // Clear his head (about 26 user units above his feet), then the tail.
  const lift = (26 * scale) + 10;

  const half = say.offsetWidth / 2;
  const margin = 6;
  const centre = Math.min(Math.max(x, half + margin), Math.max(width - half - margin, half + margin));

  say.style.translate = `calc(${centre.toFixed(1)}px - 50%) calc(${(y - lift).toFixed(1)}px - 100%)`;

  const tail = half ? (((x - (centre - half)) / (half * 2)) * 100) : 50;
  say.style.setProperty('--tail-x', `${Math.min(Math.max(tail, 8), 92).toFixed(1)}%`);
}

/** The greeting, once per page load: he notices you before you've done
    anything. Delayed so it lands after the page has settled rather than
    competing with it. */
function greetFromClimber() {
  if (!refs.climb || refs.climb.hidden) return;

  const mine = activeHabits(state.profile.id);
  if (!mine.length) return;

  const done = doneSet(mine.map((h) => h.id)).get(todayISO()) ?? new Set();
  speak(
    climbLine(done.size, mine.length, { greeting: true }),
    climbState.point ?? pointAt(0),
  );
  wave();
}

/** Twelve circles thrown out from the apex, each removing itself when it ends.
    Building fresh nodes per burst means no keyframe is ever restarted on an
    element that is still mid-flight. */
function fireSummitBurst(climb) {
  if (prefersReducedMotion()) return;

  const layer = climb.querySelector('.climb__burst');
  if (!layer) return;

  const made = [];
  const tempo = climbTempo();
  for (let i = 0; i < 12; i += 1) {
    const angle = ((Math.PI * 2 * i) / 12) + (Math.random() * 0.3);
    const reach = 26 + Math.random() * 20;

    const particle = document.createElementNS(SVG_NS, 'circle');
    particle.setAttribute('class', 'climb__particle');
    particle.setAttribute('cx', String(CLIMB_PEAK.x));
    particle.setAttribute('cy', String(CLIMB_PEAK.y));
    particle.setAttribute('r', (1.6 + Math.random() * 1.6).toFixed(2));
    particle.style.setProperty('--burst-x', `${(Math.cos(angle) * reach).toFixed(1)}px`);
    // Biased upward: sparks off a summit go up before anything else.
    particle.style.setProperty('--burst-y', `${((Math.sin(angle) * reach) - 10).toFixed(1)}px`);
    particle.style.setProperty(
      '--burst-duration',
      `${Math.round((CLIMB_BASE.burst + Math.random() * 260) * tempo)}ms`,
    );
    particle.style.fill = `var(${BURST_COLOURS[i % BURST_COLOURS.length]}, var(--accent))`;
    particle.addEventListener('animationend', () => particle.remove(), { once: true });

    made.push(particle);
    layer.append(particle);
  }

  // Safety net for a missed event (a backgrounded tab, say). Only this burst's
  // own particles, so a quick untick-and-retick can't sweep away the next one.
  setTimeout(() => { for (const particle of made) particle.remove(); }, 900 * tempo);
}

/* ------------------------------------------------------------ celebration -- */

// Confetti colours: the accent orange plus two complementary tones already in
// the token set (blue --info, green --positive). All UI tokens, never raw hex.
const CONFETTI_COLOURS = ['--accent', '--info', '--positive'];

/** The all-done celebration: confetti plus a bottom-centre toast. Both skip
    under prefers-reduced-motion — the count and progress line carry the
    information there. */
function celebrateAllDone() {
  if (prefersReducedMotion()) return;
  fireConfetti();
  showCelebrationToast();
}

/** 35 DOM particles appended to <body> inside a fixed burst layer, spread
    randomly across the viewport width, falling from the top with rotation.
    Each particle removes itself when its animation ends via animationend;
    the burst layer is a safety net in case an event is missed. */
function fireConfetti() {
  const burst = el('div', { class: 'confetti-burst', 'aria-hidden': 'true' });

  for (let i = 0; i < 35; i += 1) {
    const particle = el('div', { class: 'confetti-particle' });
    particle.style.left = `${(Math.random() * 100).toFixed(2)}%`;
    particle.style.setProperty('--drift', `${(Math.random() * 240 - 120).toFixed(1)}px`);
    particle.style.setProperty('--fall', `${(60 + Math.random() * 45).toFixed(1)}vh`);
    particle.style.setProperty('--spin', `${(360 + Math.random() * 720).toFixed(1)}deg`);
    particle.style.setProperty('--fall-duration', `${(1.8 + Math.random() * 0.8).toFixed(2)}s`);
    particle.style.width = `${(8 + Math.random() * 5).toFixed(1)}px`;
    particle.style.height = `${(11 + Math.random() * 5).toFixed(1)}px`;
    particle.style.background = `var(${CONFETTI_COLOURS[i % CONFETTI_COLOURS.length]})`;
    particle.addEventListener('animationend', () => particle.remove(), { once: true });
    burst.append(particle);
  }

  document.body.append(burst);
  // Longest fall is ~2.6s; whatever is left of the burst goes away after that.
  setTimeout(() => burst.remove(), 2800);
}

/** All-done toast: fixed bottom-centre, styled by the shared .toast rule plus
    the .celebration-toast position. Visible 3s, then fades out and removes
    itself. */
function showCelebrationToast() {
  const node = el('div', { class: 'toast toast--success celebration-toast' }, [
    el('span', { text: 'Streak alive 🔥 — all done today.' }),
  ]);
  document.body.append(node);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    node.dataset.leaving = 'true';
    node.addEventListener('animationend', () => node.remove(), { once: true });
    // If the leave animation is suppressed the event never fires, so guarantee
    // removal as a fallback.
    setTimeout(() => node.remove(), 400);
  };
  timer = setTimeout(dismiss, 3000);
}

function renderToday(mount) {
  const mine = activeHabits(state.profile.id);
  clear(mount);

  if (!mine.length) {
    mount.append(archivedHabits(state.profile.id).length
      ? invite({
          emoji: '📦',
          title: 'Nothing being tracked',
          body: 'Everything here is archived. Restore one below, or start something new.',
          action: 'Add a habit',
        })
      : invite({
          emoji: '🔥',
          title: 'Light the first one',
          body: 'Pick one small thing you want to do every day. Tick it tonight and the streak starts at one — that is the whole trick.',
          action: 'Add your first habit',
        }));
    return;
  }

  const today = todayISO();
  const done = doneSet(mine.map((h) => h.id)).get(today) ?? new Set();

  const grid = el('div', { class: 'habit-grid' });
  for (const habit of mine) grid.append(habitCard(habit, done.has(habit.id)));
  mount.append(grid);
}

function invite({ emoji, title, body, action }) {
  return el('div', { class: 'invite' }, [
    el('span', { class: 'invite__flame', 'aria-hidden': 'true', text: emoji }),
    el('p', { class: 'invite__title', text: title }),
    el('p', { text: body }),
    el('button', {
      class: 'btn btn--primary btn--lg',
      type: 'button',
      text: action,
      onclick: () => openHabitModal(),
    }),
  ]);
}

const DOW_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** "Mobile" means the same thing here and in CSS: everything under the
    max-width: 768px media block. Cards are shaped by it, so each crossing
    gets a fresh render (see initHabitsPage). */
const MOBILE_QUERY = window.matchMedia('(max-width: 768px)');
const isMobile = () => MOBILE_QUERY.matches;

/** Habit cards folded open on mobile. Kept outside render so a check-in —
    which rebuilds every card — doesn't snap an open row shut. */
const expandedHabitIds = new Set();

function habitCard(habit, isDone) {
  const streak = habitStreak(habit.id);
  const today = todayISO();
  const dates = new Set(state.entries.filter((e) => e.habit_id === habit.id).map((e) => e.date));

  const card = el('div', {
    class: 'habit-card',
    // The id lets a re-render find this card again to celebrate on it.
    dataset: { id: habit.id, done: String(isDone), streak: String(streak) },
  });

  // Re-applies the small-screen fold after every rebuild.
  if (isMobile() && expandedHabitIds.has(habit.id)) {
    card.classList.add('is-expanded');
  }

  const tick = el('button', {
    class: 'habit-tick',
    type: 'button',
    'aria-pressed': String(isDone),
    'aria-label': isDone ? `Untick ${habit.name} for today` : `Tick ${habit.name} for today`,
  }, [
    el('span', { class: 'habit-tick__mark', 'aria-hidden': 'true', text: '✓' }),
    el('span', { text: isDone ? 'Done today' : 'Mark done today' }),
  ]);

  tick.addEventListener('click', () => onTick(habit, isDoneToday(habit.id)));

  card.append(
    el('div', { class: 'habit-card__top' }, [
      el('span', {
        class: 'habit-card__icon',
        'aria-hidden': 'true',
        text: habit.icon || '🔥',
      }),
      el('div', { class: 'habit-card__meta' }, [
        el('p', { class: 'habit-card__name', text: habit.name }),
        el('p', { class: 'habit-card__target', text: `${habit.target_per_week}× a week` }),
      ]),
      el('div', { class: 'habit-card__streak' }, [
        el('span', { class: 'habit-card__streak-num', text: String(streak) }),
        el('span', { class: 'habit-card__streak-unit', text: streak === 1 ? 'day' : 'days' }),
      ]),
      cardMenu(habit),
    ]),
    tick,
    weekDots(dates, today),
    contributionGrid(habit, dates, today),
  );

  // Small screens fold the week and year grids behind a chevron. The button
  // only exists on mobile, so the desktop card keeps its exact DOM shape.
  if (isMobile()) {
    const open = card.classList.contains('is-expanded');
    const chevron = el('button', {
      class: 'habit-card__chevron',
      type: 'button',
      'aria-expanded': String(open),
      'aria-label': open
        ? `Hide ${habit.name}'s past week and year`
        : `Show ${habit.name}'s past week and year`,
    }, [
      el('span', { class: 'habit-card__chevron-icon', 'aria-hidden': 'true', text: '▾' }),
    ]);

    chevron.addEventListener('click', () => {
      const nowOpen = card.classList.toggle('is-expanded');
      if (nowOpen) expandedHabitIds.add(habit.id);
      else expandedHabitIds.delete(habit.id);
      chevron.setAttribute('aria-expanded', String(nowOpen));
    });

    card.append(chevron);
  }

  return card;
}

/* Only one menu is open at a time, so the last one closes itself. */
let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  openMenu.panel.remove();
  openMenu.button.setAttribute('aria-expanded', 'false');
  openMenu = null;
}

document.addEventListener('click', (event) => {
  if (openMenu && !openMenu.wrap.contains(event.target)) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && openMenu) {
    const { button } = openMenu;
    closeMenu();
    button.focus();
  }
});

/**
 * The ⋯ menu in a card's top-right. Managing a habit is rare next to ticking
 * it, so it stays folded away rather than competing with the thing you came
 * here to do.
 */
function cardMenu(habit) {
  const wrap = el('div', { class: 'card-menu' });

  const button = el('button', {
    class: 'card-menu__button',
    type: 'button',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
    'aria-label': `Manage ${habit.name}`,
    title: `Manage ${habit.name}`,
    text: '⋯',
  });

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    const wasOpen = openMenu?.button === button;
    closeMenu();
    if (wasOpen) return;

    const panel = el('div', { class: 'card-menu__panel', role: 'menu' }, [
      menuItem('Edit', `Edit ${habit.name}`, () => openHabitModal(habit)),
      menuItem('Archive', `Archive ${habit.name}`, () => setArchived(habit, true)),
      menuItem('Delete', `Delete ${habit.name}`, () => removeHabit(habit), 'is-danger'),
    ]);

    wrap.append(panel);
    button.setAttribute('aria-expanded', 'true');
    openMenu = { wrap, button, panel };
    panel.querySelector('button')?.focus();
  });

  wrap.append(button);
  return wrap;
}

function menuItem(label, description, action, modifier = '') {
  return el('button', {
    class: `card-menu__item ${modifier}`,
    type: 'button',
    role: 'menuitem',
    text: label,
    'aria-label': description,
    onclick: () => {
      closeMenu();
      action();
    },
  });
}

/** The check animation: a scale pop, added only after the Supabase write lands
    (so it reads as "saved", not "clicked") and removed once the keyframe ends.
    Never runs for unchecking. The listener checks the animation name because
    the card is a long-lived node now — streak-pulse and card-lift bubble their
    own animationend events up through it. */
function announceCompletion(habitId) {
  if (prefersReducedMotion()) return;

  const card = refs.today.querySelector(`[data-id="${habitId}"]`);
  if (!card) return;

  restartClass(card, 'is-completing', 'habit-complete-scale');
}

/** The card-lift on a day the streak actually grew. */
function celebrateCard(card) {
  if (prefersReducedMotion()) return;
  restartClass(card, 'is-celebrating', 'card-lift');
}

/** One pulse on a number that just went up. */
function pulseStreak(node) {
  if (prefersReducedMotion()) return;
  restartClass(node, 'is-pulsing', 'streak-pulse');
}

/* One safety timer per element per class, so a late net from an earlier run
   can never strip the class off a run that has only just started. */
const restartTimers = new WeakMap();

/**
 * Plays a one-shot keyframe class from the start, whatever state the element
 * was in. Cards and counters are no longer rebuilt between ticks, so a class
 * left on from last time would simply not replay — hence the remove, the
 * forced reflow, and the tidy-up when the named animation ends.
 *
 * The name check matters now that cards are long-lived: streak-pulse and
 * habit-complete-scale both bubble their animationend up through the card, and
 * either one would otherwise clear the other's class early.
 */
function restartClass(node, className, animationName, maxMs = 1000) {
  const timers = restartTimers.get(node) ?? {};
  restartTimers.set(node, timers);
  clearTimeout(timers[className]);

  node.classList.remove(className);
  void node.offsetWidth; // forces the restart
  node.classList.add(className);

  // Called with an event by the listeners, and bare by the safety net below.
  const settle = (event) => {
    if (event && event.animationName !== animationName) return;
    clearTimeout(timers[className]);
    node.classList.remove(className);
    node.removeEventListener('animationend', settle);
    node.removeEventListener('animationcancel', settle);
  };

  node.addEventListener('animationend', settle);
  node.addEventListener('animationcancel', settle);
  // In a backgrounded tab the events may never arrive; the class must not
  // linger on an element that now survives every re-render.
  timers[className] = setTimeout(settle, maxMs);
}

/**
 * Updates a card that is already on screen instead of replacing it.
 *
 * This is the whole reason the tick no longer calls renderToday: the
 * completion choreography — the accent rail wiping down, the tint coming up,
 * the ripple under the check, the name stepping aside — is built from CSS
 * transitions, and a transition can only run on an element that was already
 * there. A rebuilt card mounts in its finished state and never moves.
 */
function syncHabitCard(habit) {
  const card = refs.today.querySelector(`[data-id="${habit.id}"]`);
  // No card means the list shape changed under us; a full render is correct.
  if (!card) {
    renderToday(refs.today);
    return;
  }

  const today = todayISO();
  const dates = new Set(state.entries.filter((e) => e.habit_id === habit.id).map((e) => e.date));
  const isDone = dates.has(today);
  const streak = habitStreak(habit.id);
  const grew = streak > Number(card.dataset.streak);

  card.dataset.done = String(isDone);
  card.dataset.streak = String(streak);

  const tick = card.querySelector('.habit-tick');
  tick.setAttribute('aria-pressed', String(isDone));
  tick.setAttribute(
    'aria-label',
    isDone ? `Untick ${habit.name} for today` : `Tick ${habit.name} for today`,
  );
  tick.querySelector('span:last-child').textContent = isDone ? 'Done today' : 'Mark done today';

  const number = card.querySelector('.habit-card__streak-num');
  number.textContent = String(streak);
  card.querySelector('.habit-card__streak-unit').textContent = streak === 1 ? 'day' : 'days';
  if (grew) pulseStreak(number);

  // Today is the last column, and the only one a tick can move.
  const dot = card.querySelector('.week-dots')?.lastElementChild;
  if (dot) {
    dot.dataset.done = String(isDone);
    dot.title = `${formatDate(today)} — ${isDone ? 'done' : 'not done'}`;
  }

  // The year grid shades by run length, so a single day changing can restage
  // the cells around it. Cheaper to rebuild than to patch, and nothing in it
  // animates, so replacing the subtree costs no motion.
  card.querySelector('.contrib')?.replaceWith(contributionGrid(habit, dates, today));
}

/**
 * The tick takes a moment on purpose. Ticking is the one thing this app is for,
 * so it gets a beat of acknowledgement before the page rearranges itself.
 */
async function onTick(habit, wasDone) {
  const extending = !wasDone;
  const before = state.lastHeroStreak;

  // Everything the tick affects — the hero count and ring, the climber, the
  // seven-day dots, the contribution grid, the board — reads from
  // state.entries, so changing it here means the whole page moves on this
  // frame rather than after the write.
  applyTick(habit, extending);

  const allDone = extending && remainingToday() === 0;

  // Render before celebrating, so the pop happens on the new count rather than
  // over the old one that is about to be replaced.
  renderAfterTick(habit);

  // The last habit of the day gets the confetti and celebration toast.
  if (allDone) celebrateAllDone();

  if (extending && profileStreak(state.profile.id) > before) {
    refs.hero?.classList.add('is-celebrating');
    const card = refs.today.querySelector(`[data-id="${habit.id}"]`);
    if (card) celebrateCard(card);
    await beat(520);
  }

  // Every tick keeps its own two-line notice — except the all-done tick, whose
  // celebration toast already says what matters.
  if (!allDone) {
    toast(wasDone ? `${habit.name} unticked.` : `${habit.name} done today.`, {
      type: 'success',
      duration: 2200,
    });
  }

  try {
    await persistTick(habit, extending);
  } catch (error) {
    applyTick(habit, wasDone);   // put it back exactly as it was
    renderAfterTick(habit);      // and animate it back, rather than snapping
    toast(error.message, { type: 'error' });
    return;
  }

  // Completion feedback only once the write has landed, and only for the act of
  // completing — unchecking stays instant and quiet.
  if (extending) announceCompletion(habit.id);
}

function weekDots(dates, today) {
  const row = el('div', { class: 'week-dots', role: 'group', 'aria-label': 'Last seven days' });
  for (let i = 6; i >= 0; i -= 1) {
    const date = shiftDays(today, -i);
    const done = dates.has(date);
    // Monday-first initials, aligned to the real weekday of each column.
    const dow = (new Date(`${date}T12:00:00`).getDay() + 6) % 7;
    row.append(el('div', {
      class: 'week-dot',
      dataset: { done: String(done), today: String(date === today) },
      title: `${formatDate(date)} — ${done ? 'done' : 'not done'}`,
    }, [
      el('span', { class: 'week-dot__mark' }),
      el('span', { class: 'week-dot__label', text: DOW_INITIALS[dow] }),
    ]));
  }
  return row;
}

/**
 * A year of check-ins. A single habit is only ever done or not, so intensity
 * comes from the length of the run each day belonged to — a long streak reads
 * darker than a scattering of one-off days, which is the thing worth seeing.
 */
function contributionGrid(habit, dates, today) {
  const wrap = el('div', { class: 'contrib' });
  const grid = el('div', {
    class: 'contrib__grid',
    role: 'img',
    'aria-label': `${dates.size} check-ins for ${habit.name} in the last year`,
  });

  // Start on the Monday on or before a year ago, so columns are whole weeks.
  const start = shiftDays(today, -363);
  const startDow = (new Date(`${start}T12:00:00`).getDay() + 6) % 7;
  const first = shiftDays(start, -startDow);

  let run = 0;
  const levels = new Map();
  for (let i = 0; i < 371; i += 1) {
    const date = shiftDays(first, i);
    if (dates.has(date)) {
      run += 1;
      levels.set(date, run >= 21 ? 4 : run >= 7 ? 3 : run >= 3 ? 2 : 1);
    } else {
      run = 0;
    }
  }

  for (let i = 0; i < 371; i += 1) {
    const date = shiftDays(first, i);
    if (date > today) break;
    const level = levels.get(date) ?? 0;
    grid.append(el('div', {
      class: 'contrib__cell',
      dataset: { level: String(level) },
      title: `${formatDate(date)} — ${level ? 'done' : 'not done'}`,
    }));
  }

  wrap.append(
    el('div', { class: 'contrib__scroll' }, grid),
    el('div', { class: 'contrib__legend' }, [
      el('span', { text: 'Less' }),
      ...[0, 1, 2, 3, 4].map((level) =>
        el('span', { class: 'contrib__cell', dataset: { level: String(level) } })),
      el('span', { text: 'More' }),
    ]),
  );
  return wrap;
}

/**
 * Archived habits keep their history and stay out of the way. Restoring one
 * picks up exactly where it left off — the entries never went anywhere.
 */
function renderArchived(mount) {
  const archived = archivedHabits(state.profile.id);
  clear(mount);
  if (!archived.length) return;

  const group = el('details', { class: 'collapse' }, [
    el('summary', {}, [
      el('span', { text: 'Archived' }),
      el('span', { class: 'collapse__count', text: String(archived.length) }),
    ]),
  ]);

  for (const habit of archived) {
    group.append(el('div', { class: 'habit-row habit-row--archived' }, [
      el('span', { class: 'habit-row__body' }, [
        el('span', { class: 'habit-row__name' }, [
          habit.icon ? el('span', { 'aria-hidden': 'true', text: habit.icon }) : null,
          el('span', { text: habit.name }),
        ]),
        el('span', {
          class: 'habit-row__meta',
          text: `${entryCount(habit.id)} check-in${entryCount(habit.id) === 1 ? '' : 's'} kept`,
        }),
      ]),
      el('div', { class: 'habit-actions' }, [
        el('button', {
          class: 'btn btn--secondary btn--sm',
          type: 'button',
          text: 'Restore',
          'aria-label': `Restore ${habit.name}`,
          onclick: () => setArchived(habit, false),
        }),
        el('button', {
          class: 'btn btn--danger btn--sm',
          type: 'button',
          text: 'Delete',
          'aria-label': `Delete ${habit.name}`,
          onclick: () => removeHabit(habit),
        }),
      ]),
    ]));
  }

  mount.append(group);
}

function entryCount(habitId) {
  return state.entries.filter((e) => e.habit_id === habitId).length;
}

/* ------------------------------------------------------------- management -- */

async function setArchived(habit, archived) {
  try {
    const { error } = await supabase
      .from('habits')
      .update({ active: !archived })
      .eq('id', habit.id);
    if (error) throw new Error(describeError(error, `Couldn’t ${archived ? 'archive' : 'restore'} that habit.`));

    habit.active = !archived;
    toast(
      archived
        ? `${habit.name} archived. Its history is kept.`
        : `${habit.name} restored.`,
      { type: 'success' },
    );
    renderAll();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

/**
 * Deleting cascades to habit_entries in the database, so the confirm has to say
 * so plainly — the streak is the point of the app, and this is the one action
 * that destroys one.
 */
async function removeHabit(habit) {
  if (!window.confirm(`Delete ${habit.name}? Its check-in history goes too.`)) return;

  try {
    const { error } = await supabase.from('habits').delete().eq('id', habit.id);
    if (error) throw new Error(describeError(error, 'Couldn’t delete that habit.'));

    state.habits = state.habits.filter((h) => h.id !== habit.id);
    state.entries = state.entries.filter((e) => e.habit_id !== habit.id);
    toast(`${habit.name} deleted.`, { type: 'success' });
    refreshHabitFilter();
    renderAll();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

function renderBoard(mount) {
  clear(mount);

  const ranked = state.profiles
    .map((p) => ({ profile: p, streak: profileStreak(p.id) }))
    .sort((a, b) => b.streak - a.streak || a.profile.name.localeCompare(b.profile.name));

  if (!ranked.length) {
    mount.append(el('p', { class: 'muted', text: 'No profiles to rank yet.' }));
    return;
  }

  // Only a non-zero streak can lead, and a tie means nobody is ahead.
  const top = ranked[0]?.streak ?? 0;
  const leaders = ranked.filter((r) => r.streak === top && top > 0);
  const soleLeader = leaders.length === 1 ? leaders[0].profile.id : null;

  const board = el('div', { class: 'scoreboard' });
  ranked.forEach((row, index) => {
    const isLeader = row.profile.id === soleLeader;
    board.append(
      el('div', {
        class: `score-row${isLeader ? ' score-row--leader' : ''}`,
        dataset: { me: String(row.profile.id === state.profile.id) },
      }, [
        el('span', { class: 'score-row__rank', text: String(index + 1) }),
        el('span', {
          class: 'avatar',
          style: `--avatar: ${row.profile.avatar_color}`,
          'aria-hidden': 'true',
          text: initials(row.profile.name),
        }),
        el('span', { class: 'score-row__name', text: row.profile.name }),
        isLeader
          ? el('span', { class: 'score-row__crown', title: 'Longest streak', text: '👑' })
          : null,
        el('span', { class: 'score-row__streak' }, [
          el('b', { text: String(row.streak) }),
          el('span', { text: row.streak === 1 ? 'day' : 'days' }),
        ]),
      ]),
    );
  });
  mount.append(board);
}

/**
 * Completion rate per day: habits done that day over habits held that day.
 * Held is measured as "active now" — a habit deleted last week is not counted
 * retroactively, which keeps the line readable at the cost of a little history.
 */
function seriesFor(profileId, dates) {
  const habitIds = state.habits
    .filter((h) => h.profile_id === profileId)
    .filter((h) => state.filters.habitId === 'all' || h.id === state.filters.habitId)
    .map((h) => h.id);

  if (!habitIds.length) return null;

  const byDate = doneSet(habitIds);
  return dates.map((date) => {
    const hit = byDate.get(date)?.size ?? 0;
    return Math.round((hit / habitIds.length) * 100);
  });
}

function renderChart(canvas, emptyMount) {
  const days = state.filters.days;
  const today = todayISO();
  const dates = Array.from({ length: days }, (_, i) => shiftDays(today, i - days + 1));
  const labels = dates.map((d) => formatDate(d, { day: 'numeric', month: 'short' }));

  const wanted = state.mode === 'comparison'
    ? state.profiles
    : state.profiles.filter((p) => p.id === (state.filters.profileId === 'all'
        ? state.profile.id
        : state.filters.profileId));

  const series = wanted
    .map((p) => {
      const points = seriesFor(p.id, dates);
      return points && { id: p.id, label: p.name, points, colorIndex: colorIndexFor(p.id) };
    })
    .filter(Boolean);

  if (!series.length) {
    canvas.hidden = true;
    emptyMount.hidden = false;
    emptyMount.textContent = 'Nothing to chart yet. Tick a habit and it shows up here.';
    return;
  }

  canvas.hidden = false;
  emptyMount.hidden = true;
  completionChart(canvas, { labels, series });
}

/* ----------------------------------------------------------------- setup -- */

let refs = {};

function renderAll() {
  renderHero(refs.hero0);
  renderTodayProgress(refs.progress, refs.climb);
  // Remembered so the next tick can tell whether the streak actually grew.
  state.lastHeroStreak = profileStreak(state.profile.id);
  renderToday(refs.today);
  renderArchived(refs.archived);
  renderBoard(refs.board);
  renderChart(refs.canvas, refs.chartEmpty);
}

/**
 * The post-tick render. Identical to renderAll except for the habit list,
 * where the one card that changed is updated in place so its transitions can
 * actually run — see syncHabitCard. Archived habits can't change on a tick, so
 * that list is left alone.
 */
function renderAfterTick(habit) {
  renderHero(refs.hero0);
  renderTodayProgress(refs.progress, refs.climb);
  state.lastHeroStreak = profileStreak(state.profile.id);
  syncHabitCard(habit);
  renderBoard(refs.board);
  renderChart(refs.canvas, refs.chartEmpty);
}

/** One modal for both jobs: `habit` present means edit, absent means add. */
function openHabitModal(habit = null) {
  refs.habitForm.reset();
  showBanner(refs.habitError, null);

  state.editingHabit = habit?.id ?? null;
  refs.habitTitle.textContent = habit ? 'Edit habit' : 'Add a habit';
  refs.habitSubmit.textContent = habit ? 'Save changes' : 'Add habit';

  if (habit) {
    refs.habitName.value = habit.name;
    refs.habitIcon.value = habit.icon ?? '';
    refs.habitTarget.value = String(habit.target_per_week);
  }

  refs.habitModal.showModal();
  refs.habitName.focus();
  refs.habitName.select();
}

/* ------------------------------------------------------------------ accent -- */

/* Per-profile accent for the habit surfaces (the ring arc, the card tint, the
   check, the filled check). Keyed the same way the greetings are — a
   case-insensitive contains() — so "aya", "aya …", "mohamed" all resolve the
   obvious way. The pair rides <body> inline variables that the CSS reads at
   every screen size. Unknown names remove the variables and everything falls
   back to var(--accent). */
const PROFILE_ACCENTS = new Map([
  // Rose pink, matched to the gift-site palette.
  ['aya', { color: '#D4788A', rgb: '212 120 138' }],
  // Periwinkle blue, the other fixed-profile hue.
  ['mohamed', { color: '#9AA7D8', rgb: '154 167 216' }],
]);

/** Sets --profile-accent (and its rgb triplet, space-separated like the
    tokens) on <body> for the given profile name. */
function applyProfileAccent(name) {
  const entry = [...PROFILE_ACCENTS].find(([key]) =>
    String(name ?? '').toLowerCase().includes(key));
  const accent = entry ? entry[1] : null;

  if (accent) {
    document.body.style.setProperty('--profile-accent', accent.color);
    document.body.style.setProperty('--profile-accent-rgb', accent.rgb);
  } else {
    document.body.style.removeProperty('--profile-accent');
    document.body.style.removeProperty('--profile-accent-rgb');
  }
}

export async function initHabitsPage() {
  await requireSession();
  const profile = await requireActiveProfile();
  state.profile = profile;
  applyProfileTheme(profile.id);
  // The habit surfaces take their hue from whoever is signed in.
  applyProfileAccent(profile.name);
  mountGreeting(profile);

  document.body.prepend(
    topbar({
      profile,
      current: 'habits.html',
      onSwitchProfile: () => goTo(PICKER_PAGE),
      onSignOut: signOut,
    }),
  );

  refs = {
    hero0: document.getElementById('streak-hero'),
    progress: document.getElementById('today-progress'),
    climb: document.getElementById('climb'),
    say: document.getElementById('climb-say'),
    today: document.getElementById('today-list'),
    archived: document.getElementById('archived-list'),
    habitTitle: document.getElementById('habit-title'),
    board: document.getElementById('board'),
    canvas: document.getElementById('completion-chart'),
    chartEmpty: document.getElementById('chart-empty'),
    filterProfile: document.getElementById('filter-profile'),
    filterHabit: document.getElementById('filter-habit'),
    filterRange: document.getElementById('filter-range'),
    modeSolo: document.getElementById('mode-solo'),
    modeComparison: document.getElementById('mode-comparison'),
    habitModal: document.getElementById('habit-modal'),
    habitForm: document.getElementById('habit-form'),
    habitError: document.getElementById('habit-error'),
    habitName: document.getElementById('habit-name'),
    habitIcon: document.getElementById('habit-icon'),
    habitTarget: document.getElementById('habit-target'),
    habitSubmit: document.getElementById('habit-submit'),
  };

  document.getElementById('profile-name').textContent = profile.name;
  refs.today.append(skeletonList(3, 'skeleton--text'));

  try {
    await loadAll();
  } catch (error) {
    clear(refs.today).append(
      emptyState({
        title: 'Couldn’t load habits',
        body: error.message,
        actionLabel: 'Try again',
        onAction: () => window.location.reload(),
      }),
    );
    return;
  }

  populateFilters();
  renderAll();
  wireControls();
  wireClimb();

  // Crossing the mobile breakpoint swaps which progress read and card shape
  // are in use (the chevron only exists on small screens), so each crossing
  // gets a fresh render rather than live CSS tweaks.
  MOBILE_QUERY.addEventListener('change', renderAll);
}

function populateFilters() {
  clear(refs.filterProfile).append(
    el('option', { value: 'all', text: 'Everyone' }),
    ...state.profiles.map((p) => el('option', { value: p.id, text: p.name })),
  );
  refs.filterProfile.value = state.profile.id;
  state.filters.profileId = state.profile.id;

  refreshHabitFilter();
}

function refreshHabitFilter() {
  // Archived habits stay out of the filter: you can't chart what isn't running.
  const scope = state.filters.profileId === 'all'
    ? state.habits.filter((h) => h.active)
    : state.habits.filter((h) => h.profile_id === state.filters.profileId && h.active);

  clear(refs.filterHabit).append(
    el('option', { value: 'all', text: 'All habits' }),
    ...scope.map((h) => el('option', { value: h.id, text: h.name })),
  );
  refs.filterHabit.value = 'all';
  state.filters.habitId = 'all';
}

/**
 * The climber's own wiring: stop the limbs when he stops moving, and keep the
 * bubble over his head when the scene changes size.
 *
 * There used to be a docked pill here that appeared once the scene scrolled
 * away. The scene is pinned under the top bar now, so it never scrolls away and
 * the pill could never fire — two mechanisms for one job, one of them dead.
 */
function wireClimb() {
  const { climb, say } = refs;
  if (!climb) return;

  const climber = climb.querySelector('.climb__climber');
  const scene = climb.querySelector('.climb__scene');

  // The real end of a travel: the limbs stop here and the celebration starts.
  climber?.addEventListener('transitionend', (event) => {
    if (event.propertyName !== 'transform') return;
    finishTravel(travelToken);
  });

  // A resize is not a move, so the bubble is re-placed without the travel
  // curve it would otherwise inherit.
  if (scene && say && 'ResizeObserver' in window) {
    new ResizeObserver(() => {
      if (say.dataset.shown !== 'true' || !climbState.point) return;
      say.style.transition = 'none';
      positionSay(say, climbState.point);
      void say.offsetWidth;
      say.style.transition = '';
    }).observe(scene);
  }

  // He notices you a beat after the page settles.
  setTimeout(greetFromClimber, 900);
}

function wireControls() {
  refs.filterProfile.addEventListener('change', () => {
    state.filters.profileId = refs.filterProfile.value;
    refreshHabitFilter();
    renderChart(refs.canvas, refs.chartEmpty);
  });

  refs.filterHabit.addEventListener('change', () => {
    state.filters.habitId = refs.filterHabit.value;
    renderChart(refs.canvas, refs.chartEmpty);
  });

  refs.filterRange.addEventListener('change', () => {
    state.filters.days = Number(refs.filterRange.value);
    renderChart(refs.canvas, refs.chartEmpty);
  });

  const setMode = (mode) => {
    state.mode = mode;
    refs.modeSolo.setAttribute('aria-pressed', String(mode === 'solo'));
    refs.modeComparison.setAttribute('aria-pressed', String(mode === 'comparison'));
    renderChart(refs.canvas, refs.chartEmpty);
  };
  refs.modeSolo.addEventListener('click', () => setMode('solo'));
  refs.modeComparison.addEventListener('click', () => setMode('comparison'));

  document.getElementById('add-habit').addEventListener('click', openHabitModal);
  document.getElementById('habit-cancel').addEventListener('click', () => refs.habitModal.close());
  document.getElementById('habit-close').addEventListener('click', () => refs.habitModal.close());

  refs.habitForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    showBanner(refs.habitError, null);

    const name = refs.habitName.value.trim();
    if (!name) {
      showBanner(refs.habitError, 'Give the habit a name.');
      refs.habitName.focus();
      return;
    }

    const editing = state.editingHabit;
    const values = {
      name,
      icon: refs.habitIcon.value.trim() || null,
      target_per_week: Number(refs.habitTarget.value),
    };

    setBusy(refs.habitSubmit, true, editing ? 'Saving…' : 'Adding…');
    try {
      const query = editing
        ? supabase.from('habits').update(values).eq('id', editing)
        : supabase.from('habits').insert({ profile_id: state.profile.id, ...values });

      const { data, error } = await query
        .select('id, profile_id, name, icon, target_per_week, active')
        .single();

      if (error) {
        showBanner(
          refs.habitError,
          error.code === '23505'
            ? 'This profile already has a habit with that name.'
            : describeError(error, `Couldn’t ${editing ? 'save' : 'add'} that habit.`),
        );
        return;
      }

      if (editing) Object.assign(state.habits.find((h) => h.id === editing), data);
      else state.habits.push(data);

      refs.habitModal.close();
      state.editingHabit = null;
      toast(editing ? `${name} updated.` : `${name} added.`, { type: 'success' });
      refreshHabitFilter();
      renderAll();
    } catch (error) {
      showBanner(refs.habitError, error.message);
    } finally {
      setBusy(refs.habitSubmit, false);
    }
  });
}
