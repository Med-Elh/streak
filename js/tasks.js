/**
 * Tasks & Objectives: the short list and the long one.
 *
 * Tasks are throwaway — typed fast, ticked, gone. Objectives are the opposite:
 * one number crawling toward another over weeks, which is why they get the ring
 * and the deadline rather than a checkbox.
 */

import { supabase, describeError } from './supabase.js?v=29';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=29';
import { requireActiveProfile } from './profiles.js?v=29';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy, showBanner,
  statRing, formatDate, todayISO, beat,
  applyProfileTheme,
} from './ui.js?v=29';
import { PRIORITIES, OBJECTIVE_STATUSES, OBJECTIVE_UNITS, options, labelFor } from './constants.js?v=29';

import { mountGreeting } from './greetings.js?v=29';

const state = {
  profile: null,
  tasks: [],
  objectives: [],
  filter: 'all',      // 'all' | 'today' | 'overdue' | 'done'
  editingObjective: null,
};

let refs = {};

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

/* ----------------------------------------------------------- render tasks -- */

function renderTasks() {
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
    el('div', { class: 'task-card__actions' }, el('button', {
      class: 'btn btn--ghost btn--sm',
      type: 'button',
      text: 'Delete',
      'aria-label': `Delete ${task.title}`,
      onclick: () => removeTask(task),
    })),
  );

  return card;
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
  try {
    const { error } = await supabase.from('tasks').delete().eq('id', task.id);
    if (error) throw new Error(describeError(error, 'Couldn’t delete that task.'));

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
}
