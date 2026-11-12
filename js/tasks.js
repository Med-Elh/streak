/**
 * Tasks & Objectives: the short list and the long one.
 *
 * Tasks are throwaway — typed fast, ticked, gone. Objectives are the opposite:
 * one number crawling toward another over weeks, which is why they get the ring
 * and the deadline rather than a checkbox.
 */

import { supabase, describeError } from './supabase.js?v=44';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=44';
import { requireActiveProfile } from './profiles.js?v=44';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy, showBanner,
  statRing, formatDate, todayISO, beat,
  applyProfileTheme,
} from './ui.js?v=44';
import { PRIORITIES, OBJECTIVE_STATUSES, OBJECTIVE_UNITS, options, labelFor } from './constants.js?v=44';

import { mountGreeting } from './greetings.js?v=44';

const state = {
  profile: null,
  tasks: [],
  objectives: [],
  filter: 'all',      // 'all' | 'today' | 'overdue' | 'done'
  editingObjective: null,
  notes: [],          // task_audio rows for this profile's tasks
  notesReady: false,  // false until they load; the mic stays hidden if they can't
  urls: new Map(),    // storage path → { url, expires }, signed URLs for playback
  recording: null,    // { taskId, phase: 'starting' | 'recording' | 'saving', … }
  peaksColumn: true,  // false until the waveform migration has been run
  peaks: new Map(),   // note id → bar heights decoded this visit, for notes saved without them
  positions: new Map(), // note id → ms, where each note not currently loaded was left
  downloads: new Map(), // note id → File, fetched but not yet handed to the share sheet
  speed: 1,
};

let refs = {};

/* ----------------------------------------------------------- voice notes -- */

const AUDIO_BUCKET = 'task-audio';
export const MAX_RECORDING_MS = 2 * 60 * 1000;
/* A tap on the mic followed straight away by a tap on stop is a mistake, not
   a note. Anything shorter than this is dropped rather than saved. */
const MIN_RECORDING_MS = 700;
const SIGNED_URL_SECONDS = 60 * 60;

/*
 * In order of preference. AAC in mp4 comes first even where webm is available
 * because it is the one format every browser can play back: a note recorded on
 * a laptop has to play on the iPhone, and older iOS Safari can't decode webm.
 * iPhone Safari only offers mp4, so it lands on the first two either way.
 */
const RECORDING_TYPES = [
  'audio/mp4;codecs=mp4a.40.2',
  'audio/mp4',
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

const EXTENSIONS = {
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

/* PostgREST's "no such table": the voice-notes migration hasn't been run. */
const MISSING_TABLE = new Set(['42P01', 'PGRST205']);
/* …and "no such column": the waveform one hasn't. */
const MISSING_COLUMN = new Set(['42703', 'PGRST204']);

/* Bars in a waveform. Enough to show the shape of speech, few enough to stay
   at least 2px wide with a gap on a phone. */
export const PEAK_COUNT = 40;
const SEEK_STEP_MS = 5000;
export const SPEEDS = [1, 1.5, 2];
/* Per viewer and per visit, like WhatsApp: a convenience, not data. */
const SPEED_KEY = 'streak.voice_speed';

const NOTE_COLUMNS = 'id, task_id, path, mime_type, duration_ms, created_at';

/** The first type this browser's MediaRecorder will produce, or '' to let it choose. */
export function pickRecordingType(isSupported = (type) => window.MediaRecorder?.isTypeSupported?.(type)) {
  for (const type of RECORDING_TYPES) {
    try {
      if (isSupported(type)) return type;
    } catch {
      /* Some builds throw instead of answering false. */
    }
  }
  return '';
}

/**
 * 'audio/mp4;codecs=mp4a.40.2' → 'audio/mp4'. The bucket's allow-list is
 * matched against the bare type, and an empty one (Safari has reported '' for
 * recorder.mimeType) is what iPhones actually record.
 */
export function baseMimeType(type) {
  return String(type ?? '').split(';')[0].trim().toLowerCase() || 'audio/mp4';
}

export function extensionFor(type) {
  return EXTENSIONS[baseMimeType(type)] ?? 'audio';
}

/** 42_400 → '0:42'. Minutes are never padded; two minutes is the ceiling. */
export function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * Bar heights (0–100) from decoded channel data: the RMS of each slice, scaled
 * so the loudest bar is 100. RMS rather than the peak sample, because a single
 * click would otherwise flatten everything else; and every few samples is
 * plenty for a picture 40 bars wide.
 */
export function peaksFromChannels(channels, count = PEAK_COUNT) {
  const length = channels[0]?.length ?? 0;
  if (!length || !count) return null;

  const slice = length / count;
  const raw = [];
  for (let bar = 0; bar < count; bar++) {
    const start = Math.floor(bar * slice);
    const end = Math.max(start + 1, Math.floor((bar + 1) * slice));
    const step = Math.max(1, Math.floor((end - start) / 400));
    let sum = 0;
    let n = 0;
    for (const data of channels) {
      for (let i = start; i < end && i < length; i += step) {
        sum += data[i] * data[i];
        n++;
      }
    }
    raw.push(n ? Math.sqrt(sum / n) : 0);
  }

  const max = Math.max(...raw);
  return raw.map((v) => (max > 0 ? Math.round((v / max) * 100) : 0));
}

/** Any stored list of heights, stretched or squeezed to `count` bars. */
export function resamplePeaks(peaks, count = PEAK_COUNT) {
  if (!Array.isArray(peaks) || !peaks.length) return null;
  if (peaks.length === count) return peaks.map(clampPeak);
  return Array.from({ length: count }, (_, i) => clampPeak(peaks[Math.floor((i * peaks.length) / count)]));
}

function clampPeak(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
}

/* One decoder for the page. Offline, because a live AudioContext can take
   over the phone's audio session just by existing. */
let decoder = null;
function decodingContext() {
  if (decoder) return decoder;
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (Offline) {
    try {
      decoder = new Offline(1, 1, 44100);
      return decoder;
    } catch { /* Fall through to a live one. */ }
  }
  const Live = window.AudioContext || window.webkitAudioContext;
  decoder = Live ? new Live() : null;
  return decoder;
}

async function peaksFromBlob(blob) {
  const context = decodingContext();
  if (!context) throw new Error('Web Audio isn’t available.');
  const bytes = await blob.arrayBuffer();
  // Older Safari only has the callback form, and never returns a promise.
  const buffer = await new Promise((resolve, reject) => {
    const result = context.decodeAudioData(bytes, resolve, reject);
    result?.then?.(resolve, reject);
  });
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return peaksFromChannels(channels);
}

/**
 * "Call the bank – voice note 2026-11-12 14.05.m4a". Characters Windows, macOS
 * or iOS Files refuse are dropped, and leading dots too, so it can't become a
 * hidden file.
 */
export function voiceNoteFileName(title, createdAt, mime) {
  const clean = String(title ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim() || 'Task';

  const date = new Date(createdAt);
  let stamp = '';
  if (!Number.isNaN(date.getTime())) {
    const pad = (n) => String(n).padStart(2, '0');
    stamp = ` ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + ` ${pad(date.getHours())}.${pad(date.getMinutes())}`;
  }
  return `${clean} – voice note${stamp}.${extensionFor(mime)}`;
}

export function nextSpeed(speed) {
  const index = SPEEDS.indexOf(speed);
  return SPEEDS[(index + 1) % SPEEDS.length];
}

export function speedLabel(speed) {
  return `${speed}×`;
}

function savedSpeed() {
  try {
    const value = Number(sessionStorage.getItem(SPEED_KEY));
    return SPEEDS.includes(value) ? value : 1;
  } catch {
    return 1;
  }
}

function spokenDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms) / 1000) || 0);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  const parts = [];
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s || !m) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}

function notesFor(taskId) {
  return state.notes.filter((n) => n.task_id === taskId);
}

/** Storage failures arrive as plain messages; the common ones get a fix attached. */
function storageMessage(error, fallback) {
  const text = String(error?.message ?? '');
  if (/bucket not found/i.test(text)) {
    return 'The task-audio storage bucket doesn’t exist yet. Run the latest migration in the Supabase SQL editor.';
  }
  if (/row-level security|unauthori[sz]ed|403/i.test(text)) {
    return 'Storage refused that. Run the latest migration in the Supabase SQL editor to add the task-audio policies.';
  }
  if (/mime type/i.test(text)) {
    return 'Storage doesn’t accept this browser’s audio format. Run the latest migration to update the bucket’s allowed types.';
  }
  if (/maximum allowed size|too large|payload/i.test(text)) {
    return 'That recording is larger than the 5 MB the bucket allows.';
  }
  return describeError(error, fallback);
}

/* ----------------------------------------------------------------- logic -- */
/* Pure, exported, and tested — the date arithmetic is where this kind of page
   usually goes quietly wrong. */

export function isOverdue(task, today = todayISO()) {
  return Boolean(!task.done && task.due_date && task.due_date < today);
}

export function isDueToday(task, today = todayISO()) {
  return Boolean(!task.done && task.due_date === today);
}

/** Whole days from today to `date`. Negative once it's in the past. */
export function daysUntil(date, today = todayISO()) {
  if (!date) return null;
  const ms = new Date(`${date}T12:00:00`) - new Date(`${today}T12:00:00`);
  return Math.round(ms / 86400000);
}

export function filterTasks(tasks, filter, today = todayISO()) {
  switch (filter) {
    case 'today':
      return tasks.filter((t) => isDueToday(t, today));
    case 'overdue':
      return tasks.filter((t) => isOverdue(t, today));
    case 'done':
      return tasks.filter((t) => t.done);
    default:
      return tasks.filter((t) => !t.done);
  }
}

/** Done today, for the group at the bottom. Older completions stay out of the way. */
export function completedToday(tasks, today = todayISO()) {
  return tasks.filter((t) => t.done && String(t.completed_at ?? '').slice(0, 10) === today);
}

/**
 * Open tasks sort by urgency: overdue first, then soonest due, then higher
 * priority, then newest. Undated tasks sink below dated ones rather than
 * sorting as if they were due in 1970.
 */
const PRIORITY_RANK = { high: 0, medium: 1, low: 2 };

export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    if (Boolean(a.due_date) !== Boolean(b.due_date)) return a.due_date ? -1 : 1;
    if (a.due_date && b.due_date && a.due_date !== b.due_date) {
      return a.due_date.localeCompare(b.due_date);
    }
    const rank = (PRIORITY_RANK[a.priority] ?? 1) - (PRIORITY_RANK[b.priority] ?? 1);
    if (rank) return rank;
    return String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
  });
}

/** Percent of target reached, clamped — an overshoot is still a full ring. */
export function progressPercent(current, target) {
  const c = Number(current);
  const t = Number(target);
  if (!Number.isFinite(c) || !Number.isFinite(t) || t <= 0) return 0;
  return Math.min(Math.max((c / t) * 100, 0), 100);
}

/** Numbers as written under the ring: "12 / 30 trades". */
export function progressLabel(objective) {
  const current = trimNumber(objective.current_value ?? 0);
  const target = trimNumber(objective.target_value ?? 0);
  return `${current} / ${target}${objective.unit ? ` ${objective.unit}` : ''}`;
}

function trimNumber(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** The deadline line, and how alarmed it should look. */
export function deadlineText(objective, today = todayISO()) {
  if (!objective.deadline) return { text: 'No deadline', tone: '' };

  const days = daysUntil(objective.deadline, today);
  const on = formatDate(objective.deadline, { day: 'numeric', month: 'short' });

  if (objective.status === 'achieved') return { text: `Target ${on}`, tone: '' };
  if (days < 0) return { text: `${on} · ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`, tone: 'past' };
  if (days === 0) return { text: `${on} · due today`, tone: 'soon' };
  return {
    text: `${on} · ${days} day${days === 1 ? '' : 's'} left`,
    tone: days <= 7 ? 'soon' : '',
  };
}

/* ------------------------------------------------------------------ data -- */

async function fetchTasks() {
  const { data, error } = await supabase
    .from('tasks')
    .select('id, title, notes, due_date, priority, done, completed_at, created_at')
    .eq('profile_id', state.profile.id)
    .order('created_at', { ascending: false });
  if (error) throw new Error(describeError(error, 'Couldn’t load your tasks.'));
  return data ?? [];
}

async function fetchObjectives() {
  const { data, error } = await supabase
    .from('objectives')
    .select('id, title, notes, target_value, current_value, unit, deadline, status, created_at')
    .eq('profile_id', state.profile.id)
    .order('created_at', { ascending: false });
  if (error) throw new Error(describeError(error, 'Couldn’t load your objectives.'));
  return data ?? [];
}

/** Every voice note on this profile's tasks, in one query through the join. */
async function fetchNotes() {
  const query = (columns) => supabase
    .from('task_audio')
    .select(`${columns}, tasks!inner(profile_id)`)
    .eq('tasks.profile_id', state.profile.id)
    .order('created_at', { ascending: true });

  let { data, error } = await query(`${NOTE_COLUMNS}, peaks`);
  // The site goes live on push and the SQL is run by hand afterwards: until
  // the waveform migration is in, notes still load, just without peaks.
  if (error && MISSING_COLUMN.has(error.code)) {
    state.peaksColumn = false;
    ({ data, error } = await query(NOTE_COLUMNS));
  }

  if (error) {
    if (MISSING_TABLE.has(error.code)) {
      throw new Error('Voice notes need the latest migration. Run it in the Supabase SQL editor, then reload.');
    }
    throw new Error(describeError(error, 'Couldn’t load your voice notes.'));
  }
  return (data ?? []).map(({ tasks, ...note }) => note);
}

function freshUrl(path) {
  const entry = state.urls.get(path);
  return entry && entry.expires > Date.now() ? entry.url : null;
}

/**
 * Signed ahead of time, in one batch, because iPhone Safari only lets audio
 * start inside the tap that asked for it. Awaiting a network round trip
 * between the tap and play() is exactly what makes it refuse.
 */
async function signUrls(paths) {
  const missing = [...new Set(paths)].filter((p) => !freshUrl(p));
  if (!missing.length) return;

  const { data, error } = await supabase.storage
    .from(AUDIO_BUCKET)
    .createSignedUrls(missing, SIGNED_URL_SECONDS);
  if (error) throw new Error(storageMessage(error, 'Couldn’t get your voice notes ready to play.'));

  // A minute's margin so a URL never expires between the tap and the request.
  const expires = Date.now() + (SIGNED_URL_SECONDS - 60) * 1000;
  for (const row of data ?? []) {
    if (row.signedUrl && !row.error) state.urls.set(row.path, { url: row.signedUrl, expires });
  }
}

/* ----------------------------------------------------------- render tasks -- */

function renderTasks() {
  // The waveform under a finger is about to be replaced; its drag goes with it.
  drag = null;
  const open = sortTasks(filterTasks(state.tasks, state.filter));
  clear(refs.taskList);

  if (!open.length) {
    refs.taskList.append(emptyState(emptyTaskState()));
  } else {
    const list = el('div', { class: 'task-list' });
    for (const task of open) list.append(taskRow(task));
    refs.taskList.append(list);
  }

  // The "Done today" group only makes sense while you're looking at open work.
  clear(refs.taskDone);
  if (state.filter !== 'done') {
    const done = completedToday(state.tasks);
    if (done.length) {
      const group = el('details', { class: 'collapse' }, [
        el('summary', {}, [
          el('span', { text: 'Done today' }),
          el('span', { class: 'collapse__count', text: String(done.length) }),
        ]),
      ]);
      for (const task of done) group.append(taskRow(task));
      refs.taskDone.append(group);
    }
  }

  renderTodayProgress();
  refs.taskCount.textContent = `${state.tasks.filter((t) => !t.done).length} open`;
}

function emptyTaskState() {
  switch (state.filter) {
    case 'today':
      return { title: 'Nothing due today', body: 'A clear day. Add something if you want one.' };
    case 'overdue':
      return { title: 'Nothing overdue', body: 'Everything with a date is still ahead of you.' };
    case 'done':
      return { title: 'Nothing finished yet', body: 'Tick something off and it shows up here.' };
    default:
      return {
        title: 'No tasks yet',
        body: 'Type one in the box above and press enter.',
        actionLabel: 'Add a task',
        onAction: () => refs.quickTitle.focus(),
      };
  }
}

function taskRow(task) {
  const overdue = isOverdue(task);
  const priority = labelFor(PRIORITIES, task.priority);

  const card = el('div', {
    class: 'task-card',
    dataset: {
      taskId: task.id,
      done: String(task.done),
      priority: task.priority,
      overdue: String(overdue),
    },
  });

  const checkbox = el('input', {
    type: 'checkbox',
    checked: task.done,
    'aria-label': task.done ? `Reopen ${task.title}` : `Complete ${task.title}`,
  });
  checkbox.addEventListener('change', () => toggleTask(task, checkbox.checked, checkbox, card));

  card.append(
    checkbox,
    el('div', { class: 'task-card__body' }, [
      el('span', { class: 'task-card__title', text: task.title }),
      task.notes ? el('span', { class: 'task-card__notes', text: task.notes }) : null,
      el('span', { class: 'task-card__meta' }, [
        // The colour on the edge is repeated as a word, so it never carries the
        // meaning by itself.
        el('span', { text: `${priority} priority` }),
        task.due_date
          ? (overdue
              ? el('span', {
                  class: 'chip chip--overdue',
                  text: `Overdue · ${formatDate(task.due_date, { day: 'numeric', month: 'short' })}`,
                })
              : el('span', {
                  text: `Due ${formatDate(task.due_date, { day: 'numeric', month: 'short' })}`,
                }))
          : null,
      ]),
    ]),
    el('div', { class: 'task-card__actions' }, [
      state.notesReady ? micButton(task) : null,
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        text: 'Delete',
        'aria-label': `Delete ${task.title}`,
        onclick: () => removeTask(task),
      }),
    ]),
  );

  // Notes and the recorder get a row of their own under the title, rather
  // than sharing the title's column: on a phone that column is ~130px once
  // the checkbox and buttons have their share, too narrow for either.
  const recording = state.recording?.taskId === task.id;
  const notes = voiceNotes(task);
  if (notes || recording) {
    card.append(el('div', { class: 'task-card__extras' }, [
      notes,
      recording ? recorderPanel() : null,
    ]));
  }

  if (recording) card.dataset.recording = 'true';
  return card;
}

const MIC_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true">
  <rect x="9" y="3" width="6" height="11" rx="3" />
  <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" fill="none" stroke="currentColor"
    stroke-width="1.9" stroke-linecap="round" />
</svg>`;

const PLAY_SVG = '<svg class="voice-note__glyph voice-note__glyph--play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>';
const PAUSE_SVG = '<svg class="voice-note__glyph voice-note__glyph--pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1.2"/><rect x="13.5" y="5" width="4" height="14" rx="1.2"/></svg>';

function micButton(task) {
  const busyElsewhere = Boolean(state.recording && state.recording.taskId !== task.id);
  const button = el('button', {
    class: 'btn btn--icon btn--sm mic-button',
    type: 'button',
    'aria-label': `Record a voice note for ${task.title}`,
    title: 'Record a voice note',
    disabled: busyElsewhere || state.recording?.taskId === task.id,
    onclick: () => startRecording(task),
  });
  button.innerHTML = MIC_SVG;
  return button;
}

function voiceNotes(task) {
  const notes = notesFor(task.id);
  if (!notes.length) return null;
  return el('ul', { class: 'voice-notes', 'aria-label': 'Voice notes' }, notes.map((note) => noteChip(note, task)));
}

const DOWNLOAD_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9"
  stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 4.5v10.5M7.5 10.5 12 15l4.5-4.5M5.5 19.5h13" />
</svg>`;

const DELETE_SVG = `
<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9"
  stroke-linecap="round">
  <path d="M7 7l10 10M17 7 7 17" />
</svg>`;

/**
 * A voice message the way WhatsApp draws one: play, the waveform you can drag
 * along, the time under it, and the speed pill. Download and delete sit
 * outside the bubble, because they act on the file rather than the playback.
 */
function noteChip(note, task) {
  const title = task?.title ?? 'this task';

  const play = el('button', {
    class: 'voice-note__play',
    type: 'button',
    onclick: () => togglePlayback(note),
  });
  play.innerHTML = `${PLAY_SVG}${PAUSE_SVG}`;

  const wave = el('div', {
    class: 'voice-note__wave',
    role: 'slider',
    tabindex: '0',
    'aria-label': `Position in voice note on ${title}`,
    'aria-valuemin': '0',
    'aria-valuemax': String(Math.round(noteLength(note) / 1000)),
    'aria-valuenow': '0',
  }, [
    // The track clips the moving head: translated, its box reaches past the
    // waveform, and unclipped that would widen the page on a phone.
    el('span', { class: 'voice-note__track' }, [
      el('span', { class: 'voice-note__bars' }),
      el('span', { class: 'voice-note__bars voice-note__bars--played', 'aria-hidden': 'true' }),
      el('span', { class: 'voice-note__head', 'aria-hidden': 'true' }, el('span', { class: 'voice-note__knob' })),
    ]),
  ]);
  drawBars(wave, note);
  wireScrubbing(wave, note);

  const download = el('button', {
    class: 'voice-note__tool voice-note__tool--download',
    type: 'button',
    'aria-label': `Download voice note on ${title}`,
    title: 'Download voice note',
    onclick: (event) => downloadNote(note, event.currentTarget),
  });
  download.innerHTML = DOWNLOAD_SVG;

  const remove = el('button', {
    class: 'voice-note__tool voice-note__tool--delete',
    type: 'button',
    'aria-label': `Delete voice note on ${title}`,
    title: 'Delete voice note',
    onclick: () => removeNote(note),
  });
  remove.innerHTML = DELETE_SVG;

  const chip = el('li', { class: 'voice-note', dataset: { noteId: note.id } }, [
    el('div', { class: 'voice-note__bubble' }, [
      play,
      wave,
      el('span', { class: 'voice-note__time', 'aria-hidden': 'true' }),
      el('button', {
        class: 'voice-note__speed',
        type: 'button',
        onclick: cycleSpeed,
      }),
    ]),
    el('div', { class: 'voice-note__tools' }, [download, remove]),
  ]);

  paintChip(chip, note);
  return chip;
}

/** Saved peaks, or decoded this visit, or — until then or if decoding fails — even placeholders. */
function peaksFor(note) {
  return resamplePeaks(note.peaks) ?? resamplePeaks(state.peaks.get(note.id));
}

/* Both layers get the same bars; the accent one on top is clipped to the
   played part, so filling is one property on one element per frame. */
function drawBars(wave, note) {
  const heights = peaksFor(note);
  wave.dataset.placeholder = String(!heights);
  for (const layer of wave.querySelectorAll('.voice-note__bars')) {
    clear(layer);
    for (let i = 0; i < PEAK_COUNT; i++) {
      // A floor, so silence still reads as a bar rather than a gap.
      const height = heights ? 14 + heights[i] * 0.86 : 34;
      layer.append(el('span', { class: 'voice-note__bar', style: `height: ${height.toFixed(1)}%` }));
    }
  }
}

function redrawBars(noteId) {
  const note = state.notes.find((n) => n.id === noteId);
  const wave = chipFor(noteId)?.querySelector('.voice-note__wave');
  if (note && wave) drawBars(wave, note);
}

function chipFor(noteId) {
  return [...document.querySelectorAll('.voice-note')].find((chip) => chip.dataset.noteId === noteId) ?? null;
}

/** The recorder, in place of nothing, inside the card it is recording for. */
function recorderPanel() {
  const rec = state.recording;

  if (rec.phase === 'saving') {
    return el('div', { class: 'recorder recorder--saving', role: 'status' }, [
      el('span', { class: 'btn__spinner', 'aria-hidden': 'true' }),
      el('span', { text: 'Saving voice note…' }),
    ]);
  }

  if (rec.phase === 'starting') {
    return el('div', { class: 'recorder', role: 'status' }, [
      el('span', { class: 'recorder__label', text: 'Waiting for the microphone…' }),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        text: 'Cancel',
        onclick: () => stopRecording({ cancel: true }),
      }),
    ]);
  }

  const elapsed = rec.startedAt ? performance.now() - rec.startedAt : 0;
  return el('div', { class: 'recorder', role: 'group', 'aria-label': 'Recording a voice note' }, [
    el('span', { class: 'recorder__dot', 'aria-hidden': 'true' }),
    el('span', { class: 'recorder__clock' }, [
      el('span', { class: 'recorder__time', text: formatDuration(Math.floor(elapsed / 1000) * 1000) }),
      el('span', { class: 'recorder__cap', text: ` / ${formatDuration(MAX_RECORDING_MS)}` }),
    ]),
    el('span', { class: 'recorder__track', 'aria-hidden': 'true' },
      el('span', { class: 'recorder__fill', style: `width: ${(elapsed / MAX_RECORDING_MS) * 100}%` })),
    el('span', { class: 'recorder__buttons' }, [
      el('button', {
        class: 'btn btn--primary btn--sm',
        type: 'button',
        text: 'Stop and save',
        onclick: () => stopRecording(),
      }),
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        text: 'Discard',
        onclick: () => stopRecording({ cancel: true }),
      }),
    ]),
  ]);
}

/** "3 of 7 done today" — the thing you actually want to know at a glance. */
function renderTodayProgress() {
  const today = todayISO();
  const dueToday = state.tasks.filter((t) => !t.done && t.due_date === today);
  const doneToday = completedToday(state.tasks, today);
  const total = dueToday.length + doneToday.length;

  clear(refs.todayProgress);
  if (!total) {
    refs.todayProgress.hidden = true;
    return;
  }

  const percent = Math.round((doneToday.length / total) * 100);
  refs.todayProgress.hidden = false;
  refs.todayProgress.dataset.complete = String(doneToday.length === total);

  refs.todayProgress.append(
    el('div', { class: 'today-progress__head' }, [
      el('span', { class: 'today-progress__count' }, [
        el('b', { text: String(doneToday.length) }),
        el('span', { text: ` of ${total} done today` }),
      ]),
      el('span', {
        class: 'today-progress__note',
        text: doneToday.length === total ? 'All clear' : `${total - doneToday.length} to go`,
      }),
    ]),
    el('div', {
      class: 'today-progress__track',
      role: 'progressbar',
      'aria-valuenow': String(percent),
      'aria-valuemin': '0',
      'aria-valuemax': '100',
      'aria-label': 'Tasks done today',
    }, el('span', { class: 'today-progress__fill', style: `width: ${percent}%` })),
  );
}

/* ------------------------------------------------------ render objectives -- */

function renderObjectives() {
  const active = state.objectives.filter((o) => o.status === 'active');
  const closed = state.objectives.filter((o) => o.status !== 'active');

  clear(refs.objectiveList);
  if (!active.length) {
    refs.objectiveList.append(
      emptyState({
        title: 'No objectives yet',
        body: 'Set something you want to be true in a month — a number to reach, and a date to reach it by.',
        actionLabel: 'Add an objective',
        onAction: openObjectiveModal,
      }),
    );
  } else {
    const grid = el('div', { class: 'objective-grid' });
    for (const objective of active) grid.append(objectiveCard(objective));
    refs.objectiveList.append(grid);
  }

  clear(refs.objectiveClosed);
  if (closed.length) {
    const group = el('details', { class: 'collapse' }, [
      el('summary', {}, [
        el('span', { text: 'Achieved and abandoned' }),
        el('span', { class: 'collapse__count', text: String(closed.length) }),
      ]),
    ]);
    const grid = el('div', { class: 'objective-grid' });
    for (const objective of closed) grid.append(objectiveCard(objective));
    group.append(grid);
    refs.objectiveClosed.append(group);
  }
}

function objectiveCard(objective) {
  const percent = progressPercent(objective.current_value, objective.target_value);
  const achieved = objective.status === 'achieved';
  const deadline = deadlineText(objective);
  const editing = state.editingObjective === objective.id;

  // The ring warms as the target comes into reach, and goes green on arrival.
  const nearing = !achieved && percent >= 75;
  const modifier = achieved || percent >= 100 ? ' objective-card--done'
    : nearing ? ' objective-card--near' : '';

  const card = el('div', {
    class: `objective-card${achieved ? ' objective-card--achieved' : ''}${modifier}`,
  }, [
    el('span', { class: 'objective-card__title', text: objective.title }),
    statRing({
      value: percent,
      max: 100,
      display: `${Math.round(percent)}%`,
      label: achieved ? 'Achieved' : 'Progress',
      tone: achieved || percent >= 100 ? 'positive' : 'accent',
      size: 'lg',
    }),
    el('span', { class: 'objective-card__numbers', text: progressLabel(objective) }),
    el('span', {
      class: `objective-card__deadline${deadline.tone ? ` objective-card__deadline--${deadline.tone}` : ''}`,
      text: deadline.text,
    }),
    objective.notes ? el('span', { class: 'hint', text: objective.notes }) : null,
  ]);

  if (editing) {
    const input = el('input', {
      class: 'input input--num',
      type: 'number',
      step: 'any',
      value: objective.current_value ?? 0,
      'aria-label': `Current value for ${objective.title}`,
    });
    const save = el('button', {
      class: 'btn btn--primary btn--sm',
      type: 'button',
      text: 'Save',
      onclick: () => updateProgress(objective, input.value, save),
    });
    card.append(el('div', { class: 'objective-card__edit' }, [
      input,
      save,
      el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        text: 'Cancel',
        onclick: () => { state.editingObjective = null; renderObjectives(); },
      }),
    ]));
    queueMicrotask(() => input.select());
  } else {
    card.append(el('div', { class: 'objective-card__actions' }, [
      objective.status === 'active'
        ? el('button', {
            class: 'btn btn--secondary btn--sm',
            type: 'button',
            text: 'Update',
            onclick: () => { state.editingObjective = objective.id; renderObjectives(); },
          })
        : el('button', {
            class: 'btn btn--secondary btn--sm',
            type: 'button',
            text: 'Reopen',
            onclick: () => setStatus(objective, 'active'),
          }),
      objective.status === 'active'
        ? el('button', {
            class: 'btn btn--ghost btn--sm',
            type: 'button',
            text: 'Abandon',
            onclick: () => setStatus(objective, 'abandoned'),
          })
        : null,
      el('button', {
        class: 'btn btn--danger btn--sm',
        type: 'button',
        text: 'Delete',
        onclick: () => removeObjective(objective),
      }),
    ]));
  }

  return card;
}

/* -------------------------------------------------------------- recording -- */

function micError(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Microphone access is blocked. Allow it for this site in your browser settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No microphone found. Connect one and try again.';
    case 'NotReadableError':
      return 'Another app is using the microphone. Close it and try again.';
    default:
      return `Couldn’t start the microphone${error?.message ? `: ${error.message}` : '.'}`;
  }
}

function focusIn(taskId, selector) {
  const card = [...document.querySelectorAll('.task-card')].find((c) => c.dataset.taskId === taskId);
  card?.querySelector(selector)?.focus();
}

async function startRecording(task) {
  if (state.recording) {
    toast('Finish the voice note you’re recording first.', { type: 'info' });
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    toast('This browser can’t record audio. Open Streak. in Safari or Chrome and try again.', { type: 'error' });
    return;
  }

  stopPlayback();

  // Claimed before the permission prompt, so a second tap can't open a second one.
  const rec = { taskId: task.id, phase: 'starting', chunks: [] };
  state.recording = rec;
  renderTasks();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    if (state.recording === rec) state.recording = null;
    renderTasks();
    toast(micError(error), { type: 'error' });
    return;
  }

  // Discarded while the prompt was up.
  if (state.recording !== rec) {
    stream.getTracks().forEach((t) => t.stop());
    return;
  }

  const type = pickRecordingType();
  let recorder;
  try {
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  } catch (error) {
    stream.getTracks().forEach((t) => t.stop());
    state.recording = null;
    renderTasks();
    toast(`Couldn’t start recording on this device${error?.message ? `: ${error.message}` : '.'}`, { type: 'error' });
    return;
  }

  Object.assign(rec, { phase: 'recording', stream, recorder, type, task });
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data?.size) rec.chunks.push(event.data);
  });
  recorder.addEventListener('stop', () => finishRecording(rec));
  recorder.addEventListener('error', (event) => {
    rec.error = event.error?.message || 'the recorder stopped unexpectedly';
  });

  // No timeslice: one blob at the end. Safari's fragmented-mp4 chunks have
  // produced files that won't play back; a single final chunk always does.
  recorder.start();
  rec.startedAt = performance.now();
  rec.ticker = setInterval(() => tick(rec), 200);

  renderTasks();
  focusIn(task.id, '.recorder .btn--primary');
}

/** Moves the clock and the bar without re-rendering the list, and enforces the cap. */
function tick(rec) {
  const elapsed = performance.now() - rec.startedAt;
  if (elapsed >= MAX_RECORDING_MS) {
    stopRecording({ reason: 'cap' });
    return;
  }
  const panel = document.querySelector('.task-card[data-recording="true"] .recorder');
  if (!panel) return;
  const time = panel.querySelector('.recorder__time');
  const fill = panel.querySelector('.recorder__fill');
  if (time) time.textContent = formatDuration(Math.floor(elapsed / 1000) * 1000);
  if (fill) fill.style.width = `${Math.min(elapsed / MAX_RECORDING_MS, 1) * 100}%`;
}

function stopRecording({ cancel = false, reason } = {}) {
  const rec = state.recording;
  if (!rec) return;

  if (rec.phase === 'starting') {
    state.recording = null;
    renderTasks();
    return;
  }
  if (rec.phase !== 'recording') return;

  clearInterval(rec.ticker);
  rec.cancelled = cancel;
  rec.capped = reason === 'cap';
  rec.elapsed = Math.min(performance.now() - rec.startedAt, MAX_RECORDING_MS);
  rec.phase = cancel ? 'recording' : 'saving';

  // stop() flushes the last dataavailable, then fires 'stop' → finishRecording.
  if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  else finishRecording(rec);

  if (!cancel) renderTasks();
}

async function finishRecording(rec) {
  if (rec.finished) return;
  rec.finished = true;
  clearInterval(rec.ticker);
  // Releasing the tracks is what turns the browser's recording indicator off.
  rec.stream?.getTracks().forEach((t) => t.stop());

  // Stopped by the browser rather than by us — a call came in, the app was
  // backgrounded. Keep what was recorded rather than lose it.
  if (rec.elapsed === undefined) rec.elapsed = Math.min(performance.now() - rec.startedAt, MAX_RECORDING_MS);

  const done = (message, type = 'info') => {
    if (state.recording === rec) state.recording = null;
    renderTasks();
    focusIn(rec.taskId, '.mic-button');
    if (message) toast(message, { type });
  };

  if (rec.cancelled) return done('Voice note discarded.');
  if (rec.elapsed < MIN_RECORDING_MS) return done('That was too short to keep. Tap the mic and speak, then stop.');

  const mime = baseMimeType(rec.recorder.mimeType || rec.type || rec.chunks[0]?.type);
  const blob = new Blob(rec.chunks, { type: mime });
  if (!blob.size) {
    return done(`Nothing was recorded${rec.error ? ` (${rec.error})` : ''}. Try again.`, 'error');
  }

  rec.phase = 'saving';
  renderTasks();

  try {
    await saveNote(rec.task, blob, rec.elapsed);
    done(rec.capped ? 'Two minutes is the limit, so it stopped there. Voice note saved.' : 'Voice note saved.', 'success');
  } catch (error) {
    done(error.message, 'error');
  }
}

async function saveNote(task, blob, durationMs) {
  const mime = blob.type;
  const path = `${state.profile.id}/${task.id}/${crypto.randomUUID()}.${extensionFor(mime)}`;

  const { error: uploadError } = await supabase.storage
    .from(AUDIO_BUCKET)
    .upload(path, blob, { contentType: mime, cacheControl: '3600', upsert: false });
  if (uploadError) throw new Error(storageMessage(uploadError, 'Couldn’t upload that voice note.'));

  // Worked out once here, from the blob already in memory, so no one has to
  // download the file again just to draw it. A failed decode still saves the
  // note; it just gets placeholder bars.
  const peaks = await peaksFromBlob(blob).catch(() => null);

  const row = {
    task_id: task.id,
    path,
    mime_type: mime,
    duration_ms: Math.round(durationMs),
    size_bytes: blob.size,
  };
  const insert = (withPeaks) => supabase
    .from('task_audio')
    .insert(withPeaks ? { ...row, peaks } : row)
    .select(withPeaks ? `${NOTE_COLUMNS}, peaks` : NOTE_COLUMNS)
    .single();

  let { data, error } = await insert(state.peaksColumn);
  if (error && state.peaksColumn && MISSING_COLUMN.has(error.code)) {
    state.peaksColumn = false;
    ({ data, error } = await insert(false));
  }
  if (data && peaks && !data.peaks) state.peaks.set(data.id, peaks);

  if (error) {
    // A file with no row is invisible and undeletable from the app — take it back.
    await supabase.storage.from(AUDIO_BUCKET).remove([path]).catch(() => {});
    throw new Error(describeError(error, 'Couldn’t save that voice note.'));
  }

  state.notes.push(data);
  signUrls([path]).catch(() => { /* Signed again on first play. */ });
}

/* --------------------------------------------------------------- playback -- */

/*
 * One player for the whole page: starting a note stops whichever was playing.
 *
 * `startAt` is where a note picks up once it loads. The element can't seek
 * until it knows the file's length, so the jump waits for loadedmetadata, and
 * until then the waveform shows startAt rather than flicking back to zero.
 */
const player = { audio: null, noteId: null, startAt: null, frame: 0 };

/* The finger or mouse on a waveform right now: { noteId, pointerId, rect, ms }. */
let drag = null;

function audioElement() {
  if (player.audio) return player.audio;
  const audio = new Audio();
  audio.preload = 'none';
  audio.addEventListener('loadedmetadata', () => {
    if (player.startAt !== null) {
      audio.currentTime = player.startAt / 1000;
      player.startAt = null;
    }
    paintPlaying();
  });
  audio.addEventListener('play', () => {
    paintPlaying();
    followPlayback();
  });
  for (const event of ['pause', 'seeked', 'durationchange']) audio.addEventListener(event, paintPlaying);
  audio.addEventListener('ended', () => {
    audio.currentTime = 0;
    paintPlaying();
  });
  audio.addEventListener('error', onPlaybackError);
  player.audio = audio;
  return audio;
}

/* timeupdate fires about four times a second, which makes the fill step.
   A frame loop, only while something is playing, makes it glide. */
function followPlayback() {
  cancelAnimationFrame(player.frame);
  const step = () => {
    const audio = player.audio;
    if (!audio || audio.paused || audio.ended) {
      player.frame = 0;
      return;
    }
    const note = state.notes.find((n) => n.id === player.noteId);
    const chip = note && chipFor(note.id);
    if (chip) paintChip(chip, note);
    player.frame = requestAnimationFrame(step);
  };
  player.frame = requestAnimationFrame(step);
}

/* The measured length wins: Chrome's webm recordings report Infinity. */
function noteLength(note) {
  const stored = Number(note.duration_ms);
  if (stored > 0) return stored;
  const audio = player.audio;
  if (player.noteId === note.id && audio && Number.isFinite(audio.duration)) return audio.duration * 1000;
  return 0;
}

function positionOf(note) {
  if (drag?.noteId === note.id) return drag.ms;
  if (player.noteId === note.id && player.audio) return player.startAt ?? player.audio.currentTime * 1000;
  return state.positions.get(note.id) ?? 0;
}

/* Painted every frame while playing, so nothing is written that hasn't changed. */
function setText(node, value) {
  if (node && node.textContent !== value) node.textContent = value;
}
function setAttr(node, name, value) {
  if (node && node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function paintChip(chip, note) {
  const audio = player.audio;
  const active = player.noteId === note.id && audio;
  const playing = Boolean(active && !audio.paused && !audio.ended);
  const total = noteLength(note);
  const position = Math.max(0, total ? Math.min(positionOf(note), total) : 0);
  const fraction = total ? position / total : 0;
  const shown = Math.floor(position / 1000) * 1000;

  const status = playing ? 'playing' : (position > 0 ? 'paused' : 'idle');
  if (chip.dataset.state !== status) chip.dataset.state = status;
  const dragging = String(drag?.noteId === note.id);
  if (chip.dataset.dragging !== dragging) chip.dataset.dragging = dragging;

  // Transform on the head and clip on the played layer: both skip layout.
  // The head spans the waveform, so a percentage of its own width is a
  // percentage of the waveform's.
  const played = chip.querySelector('.voice-note__bars--played');
  const head = chip.querySelector('.voice-note__head');
  if (played) played.style.clipPath = `inset(0 ${((1 - fraction) * 100).toFixed(2)}% 0 0)`;
  if (head) head.style.transform = `translateX(${(fraction * 100).toFixed(2)}%)`;

  // The full length at rest, the position once it has one.
  setText(chip.querySelector('.voice-note__time'), formatDuration(status === 'idle' ? total : shown));

  const wave = chip.querySelector('.voice-note__wave');
  setAttr(wave, 'aria-valuemax', String(Math.round(total / 1000)));
  setAttr(wave, 'aria-valuenow', String(Math.floor(position / 1000)));
  setAttr(wave, 'aria-valuetext', `${spokenDuration(shown)} of ${spokenDuration(total)}`);

  setAttr(
    chip.querySelector('.voice-note__play'),
    'aria-label',
    playing ? 'Pause voice note' : `Play voice note, ${spokenDuration(total)}`,
  );

  const speed = chip.querySelector('.voice-note__speed');
  setText(speed, speedLabel(state.speed));
  setAttr(speed, 'aria-label', `Playback speed ${speedLabel(state.speed)}. Switch to ${speedLabel(nextSpeed(state.speed))}.`);
}

function paintPlaying() {
  for (const chip of document.querySelectorAll('.voice-note')) {
    const note = state.notes.find((n) => n.id === chip.dataset.noteId);
    if (note) paintChip(chip, note);
  }
}

/** Where the note being left was, so going back to it carries on from there. */
function rememberPosition() {
  if (!player.noteId || !player.audio) return;
  const ms = player.startAt ?? player.audio.currentTime * 1000;
  if (ms > 0) state.positions.set(player.noteId, ms);
  else state.positions.delete(player.noteId);
}

function stopPlayback() {
  if (!player.audio) return;
  player.audio.pause();
  rememberPosition();
  player.noteId = null;
  player.startAt = null;
  paintPlaying();
}

/* A new src resets playbackRate to the default, so both are set. */
function applySpeed(audio) {
  audio.defaultPlaybackRate = state.speed;
  audio.playbackRate = state.speed;
}

function cycleSpeed() {
  state.speed = nextSpeed(state.speed);
  try {
    sessionStorage.setItem(SPEED_KEY, String(state.speed));
  } catch {
    /* Storage blocked: the speed still holds until the page is left. */
  }
  if (player.audio) applySpeed(player.audio);
  paintPlaying();
}

function startAudio(audio) {
  audio.play().catch((error) => {
    if (error?.name === 'AbortError') return; // Superseded by another tap.
    if (error?.name === 'NotAllowedError') {
      toast('Tap play again to listen.', { type: 'info', duration: 3000 });
      return;
    }
    if (error?.name !== 'NotSupportedError') toast(`Couldn’t play that voice note: ${error.message}`, { type: 'error' });
  });
}

async function togglePlayback(note) {
  if (state.recording) {
    toast('Finish the recording before playing a note.', { type: 'info' });
    return;
  }

  const audio = audioElement();

  if (player.noteId === note.id && audio.src) {
    if (audio.paused) {
      applySpeed(audio);
      startAudio(audio);
    } else {
      audio.pause();
    }
    return;
  }

  let url = freshUrl(note.path);
  if (!url) {
    try {
      await signUrls([note.path]);
    } catch (error) {
      toast(error.message, { type: 'error' });
      return;
    }
    url = freshUrl(note.path);
    if (!url) {
      toast('That voice note’s file is missing from storage. Delete the note and record it again.', { type: 'error' });
      return;
    }
  }

  audio.pause();
  rememberPosition();

  // Picks up where it was dragged or left, unless that was the very end.
  const resumeAt = state.positions.get(note.id) ?? 0;
  state.positions.delete(note.id);
  player.noteId = note.id;
  player.startAt = resumeAt > 0 && resumeAt < noteLength(note) - 250 ? resumeAt : null;

  audio.src = url;
  applySpeed(audio);
  paintPlaying();
  startAudio(audio);
}

/**
 * The loaded note seeks; any other just remembers the spot, so dragging a note
 * you aren't listening to never interrupts the one you are.
 */
function seekTo(note, ms) {
  const total = noteLength(note);
  const target = Math.max(0, Math.min(ms, total));

  if (player.noteId === note.id && player.audio?.src) {
    if (player.startAt !== null || player.audio.readyState < 1) player.startAt = target;
    else player.audio.currentTime = target / 1000;
  } else if (target > 0) {
    state.positions.set(note.id, target);
  } else {
    state.positions.delete(note.id);
  }

  const chip = chipFor(note.id);
  if (chip) paintChip(chip, note);
}

/**
 * Drag or tap anywhere on the waveform. Pointer events cover a finger and a
 * mouse alike; touch-action: none in the CSS stops iPhone Safari from taking
 * the gesture for a scroll. The position follows the finger, and the audio
 * only jumps on release, so dragging doesn't stutter the sound.
 */
function wireScrubbing(wave, note) {
  const repaint = () => {
    const chip = wave.closest('.voice-note');
    if (chip) paintChip(chip, note);
  };
  const at = (event, rect) => {
    const fraction = rect.width ? (event.clientX - rect.left) / rect.width : 0;
    return Math.min(Math.max(fraction, 0), 1) * noteLength(note);
  };
  const mine = (event) => drag?.noteId === note.id && drag.pointerId === event.pointerId;

  wave.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!noteLength(note)) return;
    // No text selection, and no compatibility mouse events after the touch.
    event.preventDefault();
    wave.focus({ preventScroll: true });
    try {
      wave.setPointerCapture(event.pointerId);
    } catch {
      /* Capture is a nicety: without it the drag ends at the edge. */
    }
    const rect = wave.getBoundingClientRect();
    drag = { noteId: note.id, pointerId: event.pointerId, rect, ms: at(event, rect) };
    repaint();
  });

  wave.addEventListener('pointermove', (event) => {
    if (!mine(event)) return;
    drag.ms = at(event, drag.rect);
    repaint();
  });

  const release = (commit) => (event) => {
    if (!mine(event)) return;
    const { ms } = drag;
    drag = null;
    if (commit) seekTo(note, ms);
    else repaint();
  };
  wave.addEventListener('pointerup', release(true));
  wave.addEventListener('lostpointercapture', release(true));
  wave.addEventListener('pointercancel', release(false));

  wave.addEventListener('keydown', (event) => {
    const moves = { ArrowLeft: -SEEK_STEP_MS, ArrowDown: -SEEK_STEP_MS, ArrowRight: SEEK_STEP_MS, ArrowUp: SEEK_STEP_MS };
    let target;
    if (moves[event.key] !== undefined) target = positionOf(note) + moves[event.key];
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = noteLength(note);
    else return;
    event.preventDefault();
    seekTo(note, target);
  });
}

function onPlaybackError() {
  const note = state.notes.find((n) => n.id === player.noteId);
  if (!note) return;

  // Most likely an expired or revoked URL; the next tap signs a fresh one.
  state.urls.delete(note.path);
  player.audio.removeAttribute('src');
  player.noteId = null;
  player.startAt = null;
  paintPlaying();

  const playable = player.audio.canPlayType(note.mime_type);
  toast(
    playable
      ? 'Couldn’t play that voice note. Tap play to try again.'
      : `This browser can’t play ${extensionFor(note.mime_type)} audio. Open the note on the device that recorded it.`,
    { type: 'error' },
  );
}

/**
 * Notes saved before waveforms existed, or whose decode failed on the phone
 * that recorded them: fetched and decoded one at a time once the page is up,
 * and kept for this visit. A failure leaves the placeholder bars, which is the
 * defined fallback — the note plays and seeks exactly the same.
 */
async function decodeMissingPeaks() {
  for (const note of [...state.notes]) {
    if (resamplePeaks(note.peaks) || state.peaks.has(note.id)) continue;
    try {
      const { data, error } = await supabase.storage.from(AUDIO_BUCKET).download(note.path);
      if (error) throw error;
      state.peaks.set(note.id, await peaksFromBlob(data));
    } catch {
      state.peaks.set(note.id, null);
    }
    redrawBars(note.id);
  }
}

/* -------------------------------------------------------------- download -- */

/*
 * Phones get the share sheet, because a download link does nothing in the
 * home-screen app; it's also where iPhone's "Save to Files" lives. Computers
 * get an ordinary download.
 */
function wantsShareSheet() {
  return window.matchMedia('(pointer: coarse)').matches
    || window.matchMedia('(display-mode: standalone)').matches
    || navigator.standalone === true;
}

async function downloadNote(note, button) {
  // Fetched by an earlier tap whose permission to open the share sheet ran
  // out during the download: this tap is fresh, so hand it over now.
  const ready = state.downloads.get(note.id);
  if (ready) {
    await deliverFile(note, ready);
    return;
  }
  if (button.getAttribute('aria-busy') === 'true') return;

  button.setAttribute('aria-busy', 'true');
  button.disabled = true;
  let file;
  try {
    const { data, error } = await supabase.storage.from(AUDIO_BUCKET).download(note.path);
    if (error) throw new Error(storageMessage(error, 'Couldn’t download that voice note. Try again.'));
    const task = state.tasks.find((t) => t.id === note.task_id);
    const mime = baseMimeType(note.mime_type || data.type);
    file = new File([data], voiceNoteFileName(task?.title, note.created_at, mime), { type: mime });
  } catch (error) {
    toast(error.message || 'Couldn’t download that voice note. Try again.', { type: 'error' });
    return;
  } finally {
    button.removeAttribute('aria-busy');
    button.disabled = false;
  }

  await deliverFile(note, file);
}

async function deliverFile(note, file) {
  if (wantsShareSheet() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      state.downloads.delete(note.id);
    } catch (error) {
      if (error?.name === 'AbortError') {
        // Closed the sheet: nothing to say, and the file stays ready.
        state.downloads.set(note.id, file);
      } else if (error?.name === 'NotAllowedError') {
        // Safari only opens the sheet inside a tap, and the download took
        // that tap's window. The file is in memory now; the next tap is instant.
        state.downloads.set(note.id, file);
        toast('Voice note ready. Tap download again to save it.', { type: 'info' });
      } else {
        saveWithLink(file);
      }
    }
    return;
  }
  saveWithLink(file);
}

function saveWithLink(file) {
  const url = URL.createObjectURL(file);
  const link = el('a', { href: url, download: file.name, hidden: true });
  document.body.append(link);
  link.click();
  link.remove();
  // Long enough for the browser to start reading it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  toast('Voice note downloaded.', { type: 'success', duration: 2000 });
}

async function removeNote(note) {
  if (!window.confirm('Delete this voice note? This can’t be undone.')) return;
  if (player.noteId === note.id) stopPlayback();

  try {
    // File first: if the row delete then fails, deleting again still works,
    // because removing a file that's already gone is not an error.
    const { error: storageError } = await supabase.storage.from(AUDIO_BUCKET).remove([note.path]);
    if (storageError) throw new Error(storageMessage(storageError, 'Couldn’t delete that voice note.'));

    const { error } = await supabase.from('task_audio').delete().eq('id', note.id);
    if (error) throw new Error(describeError(error, 'Couldn’t delete that voice note.'));

    state.notes = state.notes.filter((n) => n.id !== note.id);
    state.urls.delete(note.path);
    state.positions.delete(note.id);
    state.peaks.delete(note.id);
    state.downloads.delete(note.id);
    renderTasks();
    toast('Voice note deleted.', { type: 'success', duration: 2000 });
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

/**
 * Paths read fresh from the database rather than from state: a note recorded
 * on the other phone since this page loaded must not survive its task.
 */
async function audioPathsFor(taskId) {
  const { data, error } = await supabase.from('task_audio').select('path').eq('task_id', taskId);
  if (error) {
    if (MISSING_TABLE.has(error.code)) return [];
    throw new Error(describeError(error, 'Couldn’t check this task for voice notes, so it was kept. Try again.'));
  }
  return (data ?? []).map((row) => row.path);
}

/* ---------------------------------------------------------------- writes -- */

async function addTask(event) {
  event.preventDefault();
  const title = refs.quickTitle.value.trim();
  if (!title) return;

  const payload = {
    profile_id: state.profile.id,
    title,
    priority: refs.quickPriority.value,
    due_date: refs.quickDue.value || null,
  };

  refs.quickTitle.disabled = true;
  try {
    const { data, error } = await supabase
      .from('tasks')
      .insert(payload)
      .select('id, title, notes, due_date, priority, done, completed_at, created_at')
      .single();

    if (error) {
      toast(describeError(error, 'Couldn’t add that task.'), { type: 'error' });
      return;
    }

    state.tasks.unshift(data);
    refs.quickTitle.value = '';
    refs.quickDue.value = '';
    // Priority stays put: a run of high-priority tasks is entered in a run.
    renderTasks();
  } finally {
    refs.quickTitle.disabled = false;
    refs.quickTitle.focus();
  }
}

/**
 * Completing runs as a small sequence: the rule draws across the title, the
 * card folds away, and only then does the list rearrange. Reopening is instant
 * — undoing something shouldn't make you wait through a victory lap.
 */
async function toggleTask(task, done, checkbox, card) {
  const live = state.tasks.find((t) => t.id === task.id);
  if (!live) return;

  const previous = { done: live.done, completed_at: live.completed_at };
  const patch = { done, completed_at: done ? new Date().toISOString() : null };

  // Local first: the counter, the "done today" group and the ordering all read
  // from state.tasks, so they move with the animation rather than after it.
  Object.assign(live, patch);

  if (done && card) {
    card.classList.add('is-completing');
    await beat(360);
    card.classList.add('is-collapsing');
    await beat(300);
  }

  renderTasks();
  if (done) toast(`${task.title} done.`, { type: 'success', duration: 2000 });

  try {
    const { error } = await supabase.from('tasks').update(patch).eq('id', live.id);
    if (error) throw new Error(describeError(error, 'Couldn’t update that task.'));
  } catch (error) {
    Object.assign(live, previous);
    renderTasks();
    toast(error.message, { type: 'error' });
  }
}

async function removeTask(task) {
  if (state.recording?.taskId === task.id) {
    toast('Stop the recording on this task before deleting it.', { type: 'info' });
    return;
  }

  const known = notesFor(task.id).length;
  if (known && !window.confirm(
    `Delete ${task.title} and its ${known === 1 ? 'voice note' : `${known} voice notes`}? This can't be undone.`,
  )) return;

  try {
    // The cascade removes the note rows but can't touch storage, so the files
    // go first — and if they can't, the task stays rather than orphan them.
    const paths = await audioPathsFor(task.id);
    if (paths.length) {
      if (notesFor(task.id).some((n) => n.id === player.noteId)) stopPlayback();
      const { error: storageError } = await supabase.storage.from(AUDIO_BUCKET).remove(paths);
      if (storageError) {
        throw new Error(storageMessage(storageError, 'Couldn’t delete this task’s voice notes, so the task was kept. Try again.'));
      }
    }

    const { error } = await supabase.from('tasks').delete().eq('id', task.id);
    if (error) throw new Error(describeError(error, 'Couldn’t delete that task.'));

    for (const path of paths) state.urls.delete(path);
    state.notes = state.notes.filter((n) => n.task_id !== task.id);
    state.tasks = state.tasks.filter((t) => t.id !== task.id);
    toast('Task deleted.', { type: 'success', duration: 2000 });
    renderTasks();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

/**
 * Updating the current value is the only edit an objective needs day to day.
 * Reaching the target marks it achieved on the spot — the whole point of
 * setting a number is that crossing it means something.
 */
async function updateProgress(objective, rawValue, button) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    toast('Enter a number of zero or more.', { type: 'error' });
    return;
  }

  const reached = Number(objective.target_value) > 0 && value >= Number(objective.target_value);
  const patch = { current_value: value };
  if (reached && objective.status === 'active') patch.status = 'achieved';

  setBusy(button, true, 'Saving…');
  try {
    const { data, error } = await supabase
      .from('objectives')
      .update(patch)
      .eq('id', objective.id)
      .select('id, title, notes, target_value, current_value, unit, deadline, status, created_at')
      .single();

    if (error) {
      toast(describeError(error, 'Couldn’t save that value.'), { type: 'error' });
      return;
    }

    Object.assign(state.objectives.find((o) => o.id === objective.id), data);
    state.editingObjective = null;
    toast(patch.status === 'achieved' ? `${objective.title} achieved.` : 'Progress saved.', {
      type: 'success',
    });
    renderObjectives();
  } finally {
    setBusy(button, false);
  }
}

async function setStatus(objective, status) {
  try {
    const { data, error } = await supabase
      .from('objectives')
      .update({ status })
      .eq('id', objective.id)
      .select('id, title, notes, target_value, current_value, unit, deadline, status, created_at')
      .single();

    if (error) throw new Error(describeError(error, 'Couldn’t change that objective.'));

    Object.assign(state.objectives.find((o) => o.id === objective.id), data);
    toast(
      status === 'active'
        ? 'Objective reopened.'
        : `Objective ${labelFor(OBJECTIVE_STATUSES, status).toLowerCase()}.`,
      { type: 'success', duration: 2500 },
    );
    renderObjectives();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

async function removeObjective(objective) {
  if (!window.confirm(`Delete ${objective.title}? This can't be undone.`)) return;

  try {
    const { error } = await supabase.from('objectives').delete().eq('id', objective.id);
    if (error) throw new Error(describeError(error, 'Couldn’t delete that objective.'));

    state.objectives = state.objectives.filter((o) => o.id !== objective.id);
    toast('Objective deleted.', { type: 'success', duration: 2000 });
    renderObjectives();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

async function createObjective(event) {
  event.preventDefault();
  showBanner(refs.objectiveError, null);

  const title = refs.objectiveTitle.value.trim();
  const target = Number(refs.objectiveTarget.value);

  if (!title) {
    showBanner(refs.objectiveError, 'Give the objective a title.');
    refs.objectiveTitle.focus();
    return;
  }
  if (!Number.isFinite(target) || target <= 0) {
    showBanner(refs.objectiveError, 'The target has to be a number above zero.');
    refs.objectiveTarget.focus();
    return;
  }

  setBusy(refs.objectiveSubmit, true, 'Adding…');
  try {
    const { data, error } = await supabase
      .from('objectives')
      .insert({
        profile_id: state.profile.id,
        title,
        notes: refs.objectiveNotes.value.trim() || null,
        target_value: target,
        current_value: Number(refs.objectiveCurrent.value) || 0,
        unit: refs.objectiveUnit.value.trim() || null,
        deadline: refs.objectiveDeadline.value || null,
      })
      .select('id, title, notes, target_value, current_value, unit, deadline, status, created_at')
      .single();

    if (error) {
      showBanner(refs.objectiveError, describeError(error, 'Couldn’t add that objective.'));
      return;
    }

    state.objectives.unshift(data);
    refs.objectiveModal.close();
    toast(`${title} added.`, { type: 'success' });
    renderObjectives();
  } finally {
    setBusy(refs.objectiveSubmit, false);
  }
}

function openObjectiveModal() {
  refs.objectiveForm.reset();
  showBanner(refs.objectiveError, null);
  refs.objectiveModal.showModal();
  refs.objectiveTitle.focus();
}

/* ----------------------------------------------------------------- setup -- */

export async function initTasksPage() {
  await requireSession();
  const profile = await requireActiveProfile();
  state.profile = profile;
  state.speed = savedSpeed();
  applyProfileTheme(profile.id);
  mountGreeting(profile);

  document.body.prepend(
    topbar({
      profile,
      current: 'tasks.html',
      onSwitchProfile: () => goTo(PICKER_PAGE),
      onSignOut: signOut,
    }),
  );

  refs = {
    quickForm: document.getElementById('quick-add'),
    quickTitle: document.getElementById('quick-title'),
    quickPriority: document.getElementById('quick-priority'),
    quickDue: document.getElementById('quick-due'),
    taskList: document.getElementById('task-list'),
    todayProgress: document.getElementById('today-progress'),
    taskDone: document.getElementById('task-done'),
    taskCount: document.getElementById('task-count'),
    filters: document.getElementById('task-filters'),
    objectiveList: document.getElementById('objective-list'),
    objectiveClosed: document.getElementById('objective-closed'),
    objectiveModal: document.getElementById('objective-modal'),
    objectiveForm: document.getElementById('objective-form'),
    objectiveError: document.getElementById('objective-error'),
    objectiveTitle: document.getElementById('objective-title-input'),
    objectiveTarget: document.getElementById('objective-target'),
    objectiveCurrent: document.getElementById('objective-current'),
    objectiveUnit: document.getElementById('objective-unit'),
    objectiveDeadline: document.getElementById('objective-deadline'),
    objectiveNotes: document.getElementById('objective-notes'),
    objectiveSubmit: document.getElementById('objective-submit'),
  };

  document.getElementById('profile-name').textContent = profile.name;

  for (const priority of options(PRIORITIES)) {
    refs.quickPriority.append(el('option', { value: priority.value, text: priority.label }));
  }
  refs.quickPriority.value = 'medium';

  for (const unit of OBJECTIVE_UNITS) {
    document.getElementById('unit-list').append(el('option', { value: unit }));
  }

  refs.taskList.append(skeletonList(3, 'skeleton--text'));
  refs.objectiveList.append(skeletonList(2, 'skeleton--card'));

  try {
    [state.tasks, state.objectives] = await Promise.all([fetchTasks(), fetchObjectives()]);
  } catch (error) {
    clear(refs.taskList).append(
      emptyState({
        title: 'Couldn’t load this page',
        body: error.message,
        actionLabel: 'Try again',
        onAction: () => window.location.reload(),
      }),
    );
    clear(refs.objectiveList);
    return;
  }

  renderTasks();
  renderObjectives();
  wireControls();
  loadNotes();
}

/**
 * After the list, not before it: voice notes are an extra, and a failure here
 * (most likely the migration not yet run) must not take the tasks down with it.
 */
async function loadNotes() {
  try {
    state.notes = await fetchNotes();
    state.notesReady = true;
    renderTasks();
  } catch (error) {
    toast(error.message, { type: 'error' });
    return;
  }

  try {
    await signUrls(state.notes.map((n) => n.path));
  } catch (error) {
    toast(error.message, { type: 'error' });
  }

  // Last, and only for notes that have no saved waveform.
  await decodeMissingPeaks();
}

function wireControls() {
  refs.quickForm.addEventListener('submit', addTask);

  refs.filters.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    state.filter = button.dataset.filter;
    for (const b of refs.filters.querySelectorAll('[data-filter]')) {
      b.setAttribute('aria-pressed', String(b === button));
    }
    renderTasks();
  });

  document.getElementById('add-objective').addEventListener('click', openObjectiveModal);
  document.getElementById('objective-cancel').addEventListener('click', () => refs.objectiveModal.close());
  document.getElementById('objective-close').addEventListener('click', () => refs.objectiveModal.close());
  refs.objectiveForm.addEventListener('submit', createObjective);

  // Leaving mid-recording must not leave the microphone open behind you.
  window.addEventListener('pagehide', () => {
    state.recording?.stream?.getTracks().forEach((t) => t.stop());
  });
}
