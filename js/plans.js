/**
 * Plans: structured things you intend to do, broken into steps you tick off.
 *
 * Two views on one page — the list of plans, and one plan's roadmap. The
 * roadmap is the point: a line down the left that fills in accent colour as the
 * steps complete, so progress is a thing you watch happen rather than a number
 * you read.
 */

import { supabase, describeError } from './supabase.js?v=29';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=29';
import { requireActiveProfile } from './profiles.js?v=29';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy, showBanner,
  statRing, formatDate, todayISO, applyProfileTheme, beat,
} from './ui.js?v=29';
import { mountGreeting } from './greetings.js?v=29';

export const PLAN_STATUSES = [
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Completed' },
  { value: 'paused', label: 'Paused' },
  { value: 'archived', label: 'Archived' },
];

const OPEN = ['active', 'paused'];

const state = {
  profile: null,
  plans: [],
  planId: null,
  steps: [],
  expanded: new Set(),
  dragId: null,
};

let refs = {};

/* ----------------------------------------------------------------- logic -- */
/* Pure and exported: ordering and progress are where an outliner goes wrong. */

/** Done over total, counting sub-steps — a step is a step wherever it sits. */
export function planProgress(steps) {
  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  return { done, total, percent: total ? (done / total) * 100 : 0 };
}

export function daysLeft(date, today = todayISO()) {
  if (!date) return null;
  return Math.round((new Date(`${date}T12:00:00`) - new Date(`${today}T12:00:00`)) / 86400000);
}

/** The target-date line, and how loud it should be. */
export function targetText(plan, today = todayISO()) {
  if (!plan.target_date) return { text: 'No target date', tone: '' };
  const days = daysLeft(plan.target_date, today);
  const on = formatDate(plan.target_date, { day: 'numeric', month: 'short' });

  if (plan.status === 'completed') return { text: `Target was ${on}`, tone: '' };
  if (days < 0) return { text: `${on} · ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} over`, tone: 'past' };
  if (days === 0) return { text: `${on} · today`, tone: 'soon' };
  return { text: `${on} · ${days} day${days === 1 ? '' : 's'} left`, tone: days <= 7 ? 'soon' : '' };
}

/**
 * Flat rows into a two-level tree: top-level steps by position, each carrying
 * its own children by position. A child whose parent has gone is promoted
 * rather than dropped — an orphaned step is still work you meant to do.
 *
 * The root nodes are COPIES (they carry an added `children`), so never write
 * through a node this returns. Look the step up in `state.steps` by id and
 * mutate that — see findStep().
 */
export function buildTree(steps) {
  const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0)
    || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));

  const ids = new Set(steps.map((s) => s.id));
  const roots = steps.filter((s) => !s.parent_step_id || !ids.has(s.parent_step_id));
  const children = steps.filter((s) => s.parent_step_id && ids.has(s.parent_step_id));

  return roots.sort(byPosition).map((root) => ({
    ...root,
    children: children.filter((c) => c.parent_step_id === root.id).sort(byPosition),
  }));
}

/** Positions renumbered 0..n-1, so a reorder never leaves gaps or ties. */
export function reindex(list) {
  return list.map((step, index) => ({ id: step.id, position: index }));
}

/**
 * Moves `dragId` to sit where `overId` is, within one sibling list.
 * Returns the reordered ids, or null when the move changes nothing.
 */
export function moveWithin(ids, dragId, overId) {
  if (dragId === overId) return null;
  const from = ids.indexOf(dragId);
  const to = ids.indexOf(overId);
  if (from === -1 || to === -1) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, dragId);
  return next;
}

/* ------------------------------------------------------------------ data -- */

const PLAN_COLUMNS = 'id, profile_id, title, description, status, target_date, created_at';
const STEP_COLUMNS = 'id, plan_id, title, notes, position, done, completed_at, parent_step_id, created_at';

async function fetchPlans() {
  const { data, error } = await supabase
    .from('plans')
    .select(PLAN_COLUMNS)
    .eq('profile_id', state.profile.id)
    .order('created_at', { ascending: false });
  if (error) throw new Error(describeError(error, 'Couldn’t load your plans.'));
  return data ?? [];
}

async function fetchSteps(planId) {
  const { data, error } = await supabase
    .from('plan_steps')
    .select(STEP_COLUMNS)
    .eq('plan_id', planId)
    .order('position', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load the steps.'));
  return data ?? [];
}

/** Step counts for the list view, without pulling every step of every plan. */
async function fetchAllSteps(planIds) {
  if (!planIds.length) return [];
  const { data, error } = await supabase
    .from('plan_steps')
    .select('id, plan_id, done')
    .in('plan_id', planIds);
  if (error) throw new Error(describeError(error, 'Couldn’t load step counts.'));
  return data ?? [];
}

/* ------------------------------------------------------------- plans list -- */

function renderList() {
  refs.detail.hidden = true;
  refs.list.hidden = false;
  clear(refs.listBody);
  clear(refs.listClosed);

  const open = state.plans.filter((p) => OPEN.includes(p.status));
  const closed = state.plans.filter((p) => !OPEN.includes(p.status));

  if (!open.length && !closed.length) {
    refs.listBody.append(emptyState({
      title: 'No plans yet',
      body: 'A plan is something you mean to do, broken into steps you can tick off. Write the first one.',
      actionLabel: 'New plan',
      onAction: () => openPlanModal(),
    }));
    return;
  }

  if (open.length) {
    const grid = el('div', { class: 'plan-grid' });
    for (const plan of open) grid.append(planCard(plan));
    refs.listBody.append(grid);
  } else {
    refs.listBody.append(emptyState({
      title: 'Nothing active',
      body: 'Every plan is finished or shelved. Start another when you’re ready.',
      actionLabel: 'New plan',
      onAction: () => openPlanModal(),
    }));
  }

  if (closed.length) {
    const group = el('details', { class: 'collapse' }, [
      el('summary', {}, [
        el('span', { text: 'Completed and archived' }),
        el('span', { class: 'collapse__count', text: String(closed.length) }),
      ]),
    ]);
    const grid = el('div', { class: 'plan-grid' });
    for (const plan of closed) grid.append(planCard(plan));
    group.append(grid);
    refs.listClosed.append(group);
  }
}

function planCard(plan) {
  const counts = state.counts.get(plan.id) ?? { done: 0, total: 0 };
  const percent = counts.total ? (counts.done / counts.total) * 100 : 0;
  const target = targetText(plan);
  const done = plan.status === 'completed';

  return el('button', {
    class: `plan-card${done ? ' plan-card--done' : ''}`,
    type: 'button',
    onclick: () => openPlan(plan.id),
  }, [
    el('div', { class: 'plan-card__head' }, [
      el('span', { class: 'plan-card__title', text: plan.title }),
      statusPill(plan.status),
    ]),
    statRing({
      value: percent,
      max: 100,
      display: `${Math.round(percent)}%`,
      label: 'Steps',
      tone: done || percent >= 100 ? 'positive' : 'accent',
    }),
    el('span', {
      class: 'plan-card__count num',
      text: counts.total ? `${counts.done} / ${counts.total} steps` : 'No steps yet',
    }),
    el('span', {
      class: `plan-card__target${target.tone ? ` plan-card__target--${target.tone}` : ''}`,
      text: target.text,
    }),
  ]);
}

function statusPill(status) {
  const label = PLAN_STATUSES.find((s) => s.value === status)?.label ?? status;
  return el('span', { class: `pill pill--${status}`, text: label });
}

/* ------------------------------------------------------------ plan detail -- */

async function openPlan(planId) {
  state.planId = planId;
  window.location.hash = `plan-${planId}`;
  refs.list.hidden = true;
  refs.detail.hidden = false;
  clear(refs.roadmap).append(skeletonList(3, 'skeleton--text'));

  try {
    state.steps = await fetchSteps(planId);
  } catch (error) {
    clear(refs.roadmap).append(emptyState({ title: 'Couldn’t load this plan', body: error.message }));
    return;
  }
  renderDetail();
}

function currentPlan() {
  return state.plans.find((p) => p.id === state.planId) ?? null;
}

function renderDetail() {
  const plan = currentPlan();
  if (!plan) return renderList();

  const progress = planProgress(state.steps);
  const target = targetText(plan);

  refs.planTitle.value = plan.title;
  refs.planDescription.value = plan.description ?? '';
  refs.planTarget.value = plan.target_date ?? '';
  refs.planStatus.value = plan.status;

  clear(refs.planProgress).append(
    statRing({
      value: progress.percent,
      max: 100,
      display: `${Math.round(progress.percent)}%`,
      label: 'Complete',
      tone: progress.percent >= 100 ? 'positive' : 'accent',
      size: 'lg',
    }),
    el('div', { class: 'stack-sm' }, [
      el('span', {
        class: 'plan-detail__count num',
        text: progress.total ? `${progress.done} of ${progress.total} steps done` : 'No steps yet',
      }),
      el('span', {
        class: `plan-card__target${target.tone ? ` plan-card__target--${target.tone}` : ''}`,
        text: target.text,
      }),
    ]),
  );

  renderRoadmap();
}

function renderRoadmap() {
  const tree = buildTree(state.steps);
  const progress = planProgress(state.steps);
  clear(refs.roadmap);

  if (!tree.length) {
    refs.roadmap.append(emptyState({
      title: 'No steps yet',
      body: 'Break the plan into the first few things you actually have to do.',
      actionLabel: 'Add the first step',
      onAction: () => refs.stepInput.focus(),
    }));
    return;
  }

  const road = el('div', { class: 'roadmap' });
  // The line fills to the share of steps completed — this is the reward.
  road.append(el('span', {
    class: 'roadmap__fill',
    style: `height: ${progress.percent}%`,
    'aria-hidden': 'true',
  }));

  for (const step of tree) {
    road.append(stepCard(step, false));
    for (const child of step.children) road.append(stepCard(child, true));
  }
  refs.roadmap.append(road);
}

function stepCard(step, isChild) {
  const card = el('div', {
    class: `step${isChild ? ' step--child' : ''}${step.done ? ' step--done' : ''}`,
    dataset: { id: step.id, parent: step.parent_step_id ?? '' },
    draggable: 'true',
  });

  const checkbox = el('input', {
    type: 'checkbox',
    checked: step.done,
    'aria-label': step.done ? `Reopen ${step.title}` : `Complete ${step.title}`,
  });
  checkbox.addEventListener('change', () => toggleStep(step, checkbox.checked));

  const title = el('input', {
    class: 'step__title',
    value: step.title,
    'aria-label': `Rename ${step.title}`,
  });
  title.addEventListener('blur', () => renameStep(step, title));
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); title.blur(); }
    if (event.key === 'Escape') { title.value = step.title; title.blur(); }
  });

  const expanded = state.expanded.has(step.id);

  card.append(
    el('span', { class: 'step__marker', 'aria-hidden': 'true' }),
    el('div', { class: 'step__body' }, [
      el('div', { class: 'step__row' }, [checkbox, title]),
      expanded
        ? noteEditor(step)
        : (step.notes ? el('p', { class: 'step__notes', text: step.notes }) : null),
    ]),
    el('div', { class: 'step__actions' }, [
      iconButton('☰', `Reorder ${step.title}`, null, 'step__grip'),
      iconButton(expanded ? '▾' : '✎', expanded ? 'Hide notes' : `Notes for ${step.title}`, () => {
        if (expanded) state.expanded.delete(step.id);
        else state.expanded.add(step.id);
        renderRoadmap();
      }),
      isChild
        ? iconButton('⇤', `Outdent ${step.title}`, () => setParent(step, null))
        : iconButton('⇥', `Indent ${step.title} under the step above`, () => indent(step)),
      iconButton('↑', `Move ${step.title} up`, () => nudge(step, -1)),
      iconButton('↓', `Move ${step.title} down`, () => nudge(step, 1)),
      iconButton('×', `Delete ${step.title}`, () => removeStep(step), 'is-danger'),
    ]),
  );

  wireDrag(card, step);
  return card;
}

function iconButton(glyph, label, action, extra = '') {
  return el('button', {
    class: `step__action ${extra}`,
    type: 'button',
    text: glyph,
    title: label,
    'aria-label': label,
    onclick: action ?? undefined,
  });
}

function noteEditor(step) {
  const area = el('textarea', {
    class: 'textarea step__note-input',
    maxlength: '1000',
    placeholder: 'What this step involves.',
    'aria-label': `Notes for ${step.title}`,
  });
  area.value = step.notes ?? '';
  area.addEventListener('blur', () => saveStep(step, { notes: area.value.trim() || null }));
  return area;
}

/* ------------------------------------------------------------------ drag -- */

function wireDrag(card, step) {
  card.addEventListener('dragstart', (event) => {
    state.dragId = step.id;
    card.classList.add('is-dragging');
    event.dataTransfer.effectAllowed = 'move';
    // Firefox needs data set or the drag never starts.
    event.dataTransfer.setData('text/plain', step.id);
  });

  card.addEventListener('dragend', () => {
    state.dragId = null;
    card.classList.remove('is-dragging');
    for (const el2 of refs.roadmap.querySelectorAll('.is-over')) el2.classList.remove('is-over');
  });

  card.addEventListener('dragover', (event) => {
    if (!state.dragId || state.dragId === step.id) return;
    event.preventDefault();
    card.classList.add('is-over');
  });

  card.addEventListener('dragleave', () => card.classList.remove('is-over'));

  card.addEventListener('drop', (event) => {
    event.preventDefault();
    card.classList.remove('is-over');
    dropOn(step);
  });
}

/** Reordering only happens among siblings; nesting is the indent button's job. */
async function dropOn(target) {
  const dragged = state.steps.find((s) => s.id === state.dragId);
  if (!dragged || dragged.id === target.id) return;

  const dragParent = dragged.parent_step_id ?? null;
  const targetParent = target.parent_step_id ?? null;
  if (dragParent !== targetParent) {
    toast('Steps reorder within their own level. Use ⇥ and ⇤ to nest.', { type: 'info' });
    return;
  }

  const siblings = buildTree(state.steps)
    .flatMap((root) => (dragParent ? root.children : [root]))
    .filter((s) => (s.parent_step_id ?? null) === dragParent)
    .map((s) => s.id);

  const next = moveWithin(siblings, dragged.id, target.id);
  if (!next) return;
  await persistOrder(next);
}

async function nudge(step, delta) {
  const parent = step.parent_step_id ?? null;
  const siblings = state.steps
    .filter((s) => (s.parent_step_id ?? null) === parent)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((s) => s.id);

  const index = siblings.indexOf(step.id);
  const target = siblings[index + delta];
  if (!target) return;
  await persistOrder(moveWithin(siblings, step.id, target));
}

async function persistOrder(orderedIds) {
  const updates = reindex(orderedIds.map((id) => ({ id })));
  for (const update of updates) {
    const step = state.steps.find((s) => s.id === update.id);
    if (step) step.position = update.position;
  }
  renderRoadmap();

  try {
    await Promise.all(updates.map(({ id, position }) =>
      supabase.from('plan_steps').update({ position }).eq('id', id)));
  } catch (error) {
    toast(describeError(error, 'Couldn’t save the new order.'), { type: 'error' });
  }
}

/* ---------------------------------------------------------------- writes -- */

/** The one live copy of a step. Tree nodes are copies; this is the original. */
function findStep(id) {
  return state.steps.find((s) => s.id === id) ?? null;
}

/**
 * Optimistic: the ring, the spine and the strike-through all move on the same
 * frame as the click, and the database catches up afterwards. A failed save
 * puts the step back exactly as it was and says so.
 */
function toggleStep(step, done) {
  const live = findStep(step.id);
  if (!live) return;

  const previous = { done: live.done, completed_at: live.completed_at };
  const patch = { done, completed_at: done ? new Date().toISOString() : null };

  Object.assign(live, patch);
  renderDetail();

  supabase
    .from('plan_steps')
    .update(patch)
    .eq('id', live.id)
    .then(async ({ error }) => {
      if (error) throw new Error(describeError(error, 'Couldn’t update that step.'));
      await beat(220);
      await maybeComplete();
    })
    .catch((error) => {
      Object.assign(live, previous);
      renderDetail();
      toast(error.message, { type: 'error' });
    });
}

/** Every step ticked is an offer, not a decision. */
async function maybeComplete() {
  const plan = currentPlan();
  const { done, total } = planProgress(state.steps);
  if (!plan || plan.status !== 'active' || !total || done !== total) return;

  if (!window.confirm(`Every step of ${plan.title} is done. Mark the plan completed?`)) return;
  await savePlan({ status: 'completed' });
  toast(`${plan.title} completed.`, { type: 'success' });
}

async function renameStep(step, input) {
  const next = input.value.trim();
  if (!next || next === step.title) {
    input.value = step.title;
    return;
  }
  await saveStep(step, { title: next });
}

/** Same optimistic shape as ticking: show it, save it, put it back if it fails. */
async function saveStep(step, patch) {
  const live = findStep(step.id);
  if (!live) return;

  const previous = Object.fromEntries(Object.keys(patch).map((key) => [key, live[key]]));
  Object.assign(live, patch);
  renderDetail();

  try {
    const { error } = await supabase.from('plan_steps').update(patch).eq('id', live.id);
    if (error) throw new Error(describeError(error, 'Couldn’t save that step.'));
  } catch (error) {
    Object.assign(live, previous);
    renderDetail();
    toast(error.message, { type: 'error' });
  }
}

/** One level only: a step indents under the top-level step directly above it. */
async function indent(step) {
  const roots = buildTree(state.steps);
  const index = roots.findIndex((r) => r.id === step.id);
  if (index <= 0) {
    toast('The first step has nothing to sit under.', { type: 'info' });
    return;
  }
  if (roots[index].children.length) {
    toast('This step has sub-steps of its own, so it can’t become one.', { type: 'info' });
    return;
  }
  await setParent(step, roots[index - 1].id);
}

async function setParent(step, parentId) {
  await saveStep(step, { parent_step_id: parentId });
}

async function removeStep(step) {
  const children = state.steps.filter((s) => s.parent_step_id === step.id).length;
  const detail = children ? ` Its ${children} sub-step${children === 1 ? '' : 's'} go too.` : '';
  if (!window.confirm(`Delete "${step.title}"?${detail}`)) return;

  try {
    const { error } = await supabase.from('plan_steps').delete().eq('id', step.id);
    if (error) throw new Error(describeError(error, 'Couldn’t delete that step.'));
    state.steps = state.steps.filter((s) => s.id !== step.id && s.parent_step_id !== step.id);
    renderDetail();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

async function addStep(event) {
  event.preventDefault();
  const title = refs.stepInput.value.trim();
  if (!title) return;

  const roots = state.steps.filter((s) => !s.parent_step_id);
  try {
    const { data, error } = await supabase
      .from('plan_steps')
      .insert({ plan_id: state.planId, title, position: roots.length })
      .select(STEP_COLUMNS)
      .single();
    if (error) throw new Error(describeError(error, 'Couldn’t add that step.'));

    state.steps.push(data);
    refs.stepInput.value = '';
    renderDetail();
    refs.stepInput.focus();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

/** The plan's own fields save on blur, in place. */
async function savePlan(patch) {
  const plan = currentPlan();
  if (!plan) return;
  try {
    const { data, error } = await supabase
      .from('plans')
      .update(patch)
      .eq('id', plan.id)
      .select(PLAN_COLUMNS)
      .single();
    if (error) throw new Error(describeError(error, 'Couldn’t save this plan.'));
    Object.assign(plan, data);
    renderDetail();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

async function createPlan(event) {
  event.preventDefault();
  showBanner(refs.planError, null);

  const title = refs.newTitle.value.trim();
  if (!title) {
    showBanner(refs.planError, 'Give the plan a title.');
    refs.newTitle.focus();
    return;
  }

  setBusy(refs.planSubmit, true, 'Creating…');
  try {
    const { data, error } = await supabase
      .from('plans')
      .insert({
        profile_id: state.profile.id,
        title,
        description: refs.newDescription.value.trim() || null,
        target_date: refs.newTarget.value || null,
      })
      .select(PLAN_COLUMNS)
      .single();
    if (error) throw new Error(describeError(error, 'Couldn’t create that plan.'));

    state.plans.unshift(data);
    state.counts.set(data.id, { done: 0, total: 0 });
    refs.planModal.close();
    toast(`${title} created.`, { type: 'success' });
    await openPlan(data.id);
  } catch (error) {
    showBanner(refs.planError, error.message);
  } finally {
    setBusy(refs.planSubmit, false);
  }
}

async function removePlan() {
  const plan = currentPlan();
  if (!plan) return;
  if (!window.confirm(`Delete ${plan.title}? Its steps go too. This can't be undone.`)) return;

  try {
    const { error } = await supabase.from('plans').delete().eq('id', plan.id);
    if (error) throw new Error(describeError(error, 'Couldn’t delete that plan.'));
    state.plans = state.plans.filter((p) => p.id !== plan.id);
    toast(`${plan.title} deleted.`, { type: 'success' });
    backToList();
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

function openPlanModal() {
  refs.newForm.reset();
  showBanner(refs.planError, null);
  refs.planModal.showModal();
  refs.newTitle.focus();
}

async function backToList() {
  state.planId = null;
  window.location.hash = '';
  await refreshCounts();
  renderList();
}

async function refreshCounts() {
  try {
    const rows = await fetchAllSteps(state.plans.map((p) => p.id));
    state.counts = new Map();
    for (const plan of state.plans) {
      const mine = rows.filter((r) => r.plan_id === plan.id);
      state.counts.set(plan.id, { done: mine.filter((r) => r.done).length, total: mine.length });
    }
  } catch (error) {
    toast(error.message, { type: 'error' });
  }
}

/* ----------------------------------------------------------------- setup -- */

export async function initPlansPage() {
  await requireSession();
  const profile = await requireActiveProfile();
  state.profile = profile;
  state.counts = new Map();
  applyProfileTheme(profile.id);
  mountGreeting(profile);

  document.body.prepend(topbar({
    profile,
    current: 'plans.html',
    onSwitchProfile: () => goTo(PICKER_PAGE),
    onSignOut: signOut,
  }));

  refs = {
    list: document.getElementById('plan-list'),
    listBody: document.getElementById('plan-list-body'),
    listClosed: document.getElementById('plan-list-closed'),
    detail: document.getElementById('plan-detail'),
    planProgress: document.getElementById('plan-progress'),
    planTitle: document.getElementById('plan-title'),
    planDescription: document.getElementById('plan-description'),
    planTarget: document.getElementById('plan-target'),
    planStatus: document.getElementById('plan-status'),
    roadmap: document.getElementById('roadmap'),
    stepForm: document.getElementById('step-form'),
    stepInput: document.getElementById('step-input'),
    planModal: document.getElementById('plan-modal'),
    newForm: document.getElementById('new-plan-form'),
    planError: document.getElementById('plan-error'),
    newTitle: document.getElementById('new-title'),
    newDescription: document.getElementById('new-description'),
    newTarget: document.getElementById('new-target'),
    planSubmit: document.getElementById('plan-submit'),
  };

  document.getElementById('profile-name').textContent = profile.name;
  for (const status of PLAN_STATUSES) {
    refs.planStatus.append(el('option', { value: status.value, text: status.label }));
  }

  refs.listBody.append(skeletonList(2, 'skeleton--card'));

  try {
    state.plans = await fetchPlans();
    await refreshCounts();
  } catch (error) {
    clear(refs.listBody).append(emptyState({
      title: 'Couldn’t load your plans',
      body: error.message,
      actionLabel: 'Try again',
      onAction: () => window.location.reload(),
    }));
    return;
  }

  const fromHash = window.location.hash.replace('#plan-', '');
  if (fromHash && state.plans.some((p) => p.id === fromHash)) await openPlan(fromHash);
  else renderList();

  wireControls();
}

function wireControls() {
  document.getElementById('new-plan').addEventListener('click', openPlanModal);
  document.getElementById('plan-cancel').addEventListener('click', () => refs.planModal.close());
  document.getElementById('plan-close').addEventListener('click', () => refs.planModal.close());
  document.getElementById('back-to-plans').addEventListener('click', backToList);
  document.getElementById('delete-plan').addEventListener('click', removePlan);

  refs.newForm.addEventListener('submit', createPlan);
  refs.stepForm.addEventListener('submit', addStep);

  refs.planTitle.addEventListener('blur', () => {
    const next = refs.planTitle.value.trim();
    if (next && next !== currentPlan()?.title) savePlan({ title: next });
    else refs.planTitle.value = currentPlan()?.title ?? '';
  });
  refs.planDescription.addEventListener('blur', () =>
    savePlan({ description: refs.planDescription.value.trim() || null }));
  refs.planTarget.addEventListener('change', () =>
    savePlan({ target_date: refs.planTarget.value || null }));
  refs.planStatus.addEventListener('change', () => savePlan({ status: refs.planStatus.value }));
}
