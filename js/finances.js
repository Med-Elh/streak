/**
 * Finances: a month at a time, in and out by category.
 *
 * The month selector at the top scopes everything below it. The year's entries
 * are fetched in one query and filtered in memory, because the monthly-net bar
 * chart needs the whole year anyway and two round trips for one screen is one
 * too many.
 */

import { supabase, describeError } from './supabase.js?v=12';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=12';
import { requireActiveProfile } from './profiles.js?v=12';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy, showBanner,
  formatMoney, formatDate, todayISO, moneyContext, initMoney, swatchPicker,
  applyProfileTheme,
} from './ui.js?v=12';
import { categoryDoughnut, monthlyNetChart, seriesColor, categoryColor } from './charts.js?v=12';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Beyond six categories the palette is out of distinct hues, so the tail folds. */
const MAX_SLICES = 6;

import { mountGreeting } from './greetings.js?v=12';

const state = {
  profile: null,
  month: todayISO().slice(0, 7),   // 'YYYY-MM'
  categories: [],
  palette: [],                      // the six chart slots, resolved at init
  entries: [],                      // the whole selected year
};

let refs = {};

/* --------------------------------------------------------------- helpers -- */

const yearOf = (month) => month.slice(0, 4);
const inMonth = (entry, month) => entry.date.startsWith(month);

function categoryById(id) {
  return state.categories.find((c) => c.id === id) ?? null;
}

/** An entry with no category can't be classified, so it counts as spending. */
function kindOf(entry) {
  return categoryById(entry.category_id)?.kind ?? 'expense';
}

function totals(entries) {
  let income = 0;
  let expense = 0;
  for (const entry of entries) {
    const amount = Number(entry.amount);
    if (kindOf(entry) === 'income') income += amount;
    else expense += amount;
  }
  return { income, expense, net: income - expense };
}

/* ------------------------------------------------------------------ data -- */

async function fetchCategories() {
  const { data, error } = await supabase
    .from('finance_categories')
    .select('id, name, kind, color')
    .eq('profile_id', state.profile.id)
    .order('kind', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load categories.'));
  return data ?? [];
}

async function fetchYear(year) {
  const { data, error } = await supabase
    .from('finance_entries')
    .select('id, category_id, amount, date, note')
    .eq('profile_id', state.profile.id)
    .gte('date', `${year}-01-01`)
    .lte('date', `${year}-12-31`)
    .order('date', { ascending: false });
  if (error) throw new Error(describeError(error, 'Couldn’t load entries.'));
  return data ?? [];
}

/* ---------------------------------------------------------------- render -- */

function renderSummary() {
  const { income, expense, net } = totals(state.entries.filter((e) => inMonth(e, state.month)));

  clear(refs.summary).append(
    stat('In', income, 'num--positive'),
    stat('Out', expense, 'num--negative'),
    stat('Net', net, net >= 0 ? 'num--positive' : 'num--negative'),
  );
}

function stat(label, value, numClass) {
  return el('div', { class: 'stat' }, [
    el('span', { class: 'stat__label', text: label }),
    el('span', { class: `stat__value ${numClass}`, text: formatMoney(value) }),
  ]);
}

function renderEntries() {
  const rows = state.entries.filter((e) => inMonth(e, state.month));
  clear(refs.entries);

  if (!rows.length) {
    refs.entries.append(
      emptyState({
        title: 'Nothing logged this month',
        body: 'Add what came in and what went out, and the charts fill in.',
        actionLabel: 'Add the first entry',
        onAction: () => refs.amount.focus(),
      }),
    );
    return;
  }

  const table = el('table', { class: 'table' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Date' }),
      el('th', { text: 'Category' }),
      el('th', { text: 'Note' }),
      el('th', { class: 'align-right', text: 'Amount' }),
      el('th', { 'aria-label': 'Actions' }),
    ])),
  ]);

  const body = el('tbody');
  for (const entry of rows) {
    const category = categoryById(entry.category_id);
    const income = kindOf(entry) === 'income';
    body.append(el('tr', {}, [
      el('td', { text: formatDate(entry.date, { day: 'numeric', month: 'short' }) }),
      el('td', {}, el('span', {
        class: `chip ${income ? 'chip--win' : ''}`,
        text: category?.name ?? 'Uncategorised',
      })),
      el('td', { class: 'truncate', text: entry.note || '—' }),
      el('td', {
        class: `align-right num ${income ? 'num--positive' : 'num--negative'}`,
        text: `${income ? '+' : '−'}${formatMoney(entry.amount)}`,
      }),
      el('td', { class: 'align-right' }, el('button', {
        class: 'btn btn--ghost btn--sm',
        type: 'button',
        text: 'Delete',
        onclick: () => removeEntry(entry),
      })),
    ]));
  }
  table.append(body);
  refs.entries.append(el('div', { class: 'table-wrap' }, table));
}

function renderDoughnut() {
  const spend = new Map();
  for (const entry of state.entries.filter((e) => inMonth(e, state.month))) {
    if (kindOf(entry) === 'income') continue;
    const name = categoryById(entry.category_id)?.name ?? 'Uncategorised';
    spend.set(name, (spend.get(name) ?? 0) + Number(entry.amount));
  }

  const sorted = [...spend.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length) {
    refs.doughnut.hidden = true;
    refs.doughnutEmpty.hidden = false;
    refs.doughnutEmpty.textContent = 'No spending this month.';
    clear(refs.doughnutLegend);
    return;
  }

  const head = sorted.slice(0, MAX_SLICES);
  const tail = sorted.slice(MAX_SLICES);

  // Resolved once, here. The chart and the legend below it read the same
  // `color` off the same objects in the same order, so they cannot drift.
  const slices = head.map(([label, value]) => ({
    label,
    value,
    color: colorForCategoryName(label),
  }));

  if (tail.length) {
    slices.push({
      label: `Other (${tail.length})`,
      value: tail.reduce((sum, [, v]) => sum + v, 0),
      // "Other" is genuinely a remainder, so the neutral slot is the honest one.
      color: seriesColor(MAX_SLICES),
    });
  }

  refs.doughnut.hidden = false;
  refs.doughnutEmpty.hidden = true;
  categoryDoughnut(refs.doughnut, { slices });

  // Direct labels beside the chart: identity is never colour alone.
  clear(refs.doughnutLegend).append(
    ...slices.map((s) => el('span', { class: 'legend__item' }, [
      el('span', {
        class: 'legend__dot',
        style: `background: ${s.color}`,
        'aria-hidden': 'true',
      }),
      el('span', { text: `${s.label} · ${formatMoney(s.value)}` }),
    ])),
  );
}

/**
 * A category's stored colour, falling back to a palette slot keyed to its
 * position in the profile's category list — stable across months and filters,
 * unlike its rank in this month's spending.
 */
function colorForCategoryName(name) {
  const index = state.categories.findIndex((c) => c.name === name);
  if (index === -1) return seriesColor(MAX_SLICES);   // "Uncategorised"
  return categoryColor(state.categories[index], index % MAX_SLICES);
}

function renderYearChart() {
  const values = MONTHS.map((_, index) => {
    const month = `${yearOf(state.month)}-${String(index + 1).padStart(2, '0')}`;
    return totals(state.entries.filter((e) => inMonth(e, month))).net;
  });

  if (values.every((v) => v === 0)) {
    refs.yearChart.hidden = true;
    refs.yearEmpty.hidden = false;
    refs.yearEmpty.textContent = `Nothing logged in ${yearOf(state.month)} yet.`;
    return;
  }

  refs.yearChart.hidden = false;
  refs.yearEmpty.hidden = true;
  monthlyNetChart(refs.yearChart, { labels: MONTHS, values });
}

function renderCategoryOptions() {
  const previous = refs.category.value;
  clear(refs.category).append(
    el('option', { value: '', text: 'Choose a category', disabled: true, selected: true }),
    ...state.categories.map((c) =>
      el('option', { value: c.id, text: `${c.name} · ${c.kind === 'income' ? 'in' : 'out'}` }),
    ),
    el('option', { value: '__new', text: '+ New category' }),
  );
  if (previous && [...refs.category.options].some((o) => o.value === previous)) {
    refs.category.value = previous;
  }
}

function renderAll() {
  renderSummary();
  renderEntries();
  renderDoughnut();
  renderYearChart();
}

/**
 * Finances are in dirhams, full stop — there is no selector on this form. The
 * label says so permanently, and says it louder while the display is converted,
 * so nobody types dollars into a dirham field because the summary above them
 * happens to be showing dollars.
 */
function labelAmountField() {
  const { converted } = moneyContext();
  refs.amountCurrency.textContent = converted ? '(MAD — always entered in dirhams)' : '(MAD)';
}

/* ---------------------------------------------------------------- writes -- */

async function addEntry() {
  const amount = Number(refs.amount.value);
  const categoryId = refs.category.value;

  if (!Number.isFinite(amount) || amount <= 0) {
    showBanner(refs.formError, 'Enter an amount above zero.');
    refs.amount.focus();
    return;
  }
  if (!categoryId || categoryId === '__new') {
    showBanner(refs.formError, 'Pick a category for this entry.');
    refs.category.focus();
    return;
  }

  setBusy(refs.submit, true, 'Adding…');
  try {
    const { data, error } = await supabase
      .from('finance_entries')
      .insert({
        profile_id: state.profile.id,
        category_id: categoryId,
        amount: amount.toFixed(2),
        date: refs.date.value || todayISO(),
        note: refs.note.value.trim() || null,
      })
      .select('id, category_id, amount, date, note')
      .single();

    if (error) {
      showBanner(refs.formError, describeError(error, 'Couldn’t add that entry.'));
      return;
    }

    // Only keep it on screen if it belongs to the year we have loaded.
    if (data.date.startsWith(yearOf(state.month))) {
      state.entries.unshift(data);
      state.entries.sort((a, b) => b.date.localeCompare(a.date));
    }

    refs.amount.value = '';
    refs.note.value = '';
    showBanner(refs.formError, null);
    toast('Entry added.', { type: 'success' });
    renderAll();
    refs.amount.focus();
  } finally {
    setBusy(refs.submit, false);
  }
}

async function removeEntry(entry) {
  const { error } = await supabase.from('finance_entries').delete().eq('id', entry.id);
  if (error) {
    toast(describeError(error, 'Couldn’t delete that entry.'), { type: 'error' });
    return;
  }
  state.entries = state.entries.filter((e) => e.id !== entry.id);
  toast('Entry deleted.', { type: 'success', duration: 2500 });
  renderAll();
}

async function addCategory() {
  const name = refs.categoryName.value.trim();
  if (!name) {
    showBanner(refs.categoryError, 'Give the category a name.');
    refs.categoryName.focus();
    return;
  }

  setBusy(refs.categorySubmit, true, 'Adding…');
  try {
    const { data, error } = await supabase
      .from('finance_categories')
      .insert({
        profile_id: state.profile.id,
        name,
        kind: refs.categoryKind.value,
        // Whatever the picker is showing — which starts on the next free slot,
        // so the doughnut never has to guess even if you don't touch it.
        color: refs.colourPicker.selected(),
      })
      .select('id, name, kind, color')
      .single();

    if (error) {
      showBanner(
        refs.categoryError,
        error.code === '23505'
          ? 'You already have a category with that name.'
          : describeError(error, 'Couldn’t add that category.'),
      );
      return;
    }

    state.categories.push(data);
    state.categories.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    renderCategoryOptions();
    refs.category.value = data.id;
    refs.categoryModal.close();
    toast(`${name} added.`, { type: 'success' });
  } finally {
    setBusy(refs.categorySubmit, false);
  }
}

/* ----------------------------------------------------------------- setup -- */

export async function initFinancesPage() {
  await requireSession();
  const profile = await requireActiveProfile();
  state.profile = profile;
  applyProfileTheme(profile.id);
  mountGreeting(profile);
  // Finance amounts are always entered and stored in dirhams.
  initMoney(profile, 'finances');

  document.body.prepend(
    topbar({
      profile,
      current: 'finances.html',
      onSwitchProfile: () => goTo(PICKER_PAGE),
      onSignOut: signOut,
      // Display only: the same stored amounts, read through the new currency.
      onCurrencyChange: () => {
        labelAmountField();
        renderAll();
      },
    }),
  );

  refs = {
    month: document.getElementById('month'),
    summary: document.getElementById('summary'),
    entries: document.getElementById('entries'),
    doughnut: document.getElementById('category-chart'),
    doughnutEmpty: document.getElementById('category-empty'),
    doughnutLegend: document.getElementById('category-legend'),
    yearChart: document.getElementById('year-chart'),
    yearEmpty: document.getElementById('year-empty'),
    form: document.getElementById('entry-form'),
    formError: document.getElementById('entry-error'),
    amount: document.getElementById('amount'),
    amountCurrency: document.getElementById('amount-currency'),
    category: document.getElementById('category'),
    date: document.getElementById('date'),
    note: document.getElementById('note'),
    submit: document.getElementById('entry-submit'),
    categoryModal: document.getElementById('category-modal'),
    categoryForm: document.getElementById('category-form'),
    categoryError: document.getElementById('category-error'),
    categoryName: document.getElementById('category-name'),
    categoryKind: document.getElementById('category-kind'),
    categorySubmit: document.getElementById('category-submit'),
  };

  // The six validated chart slots — the same palette the doughnut draws from.
  state.palette = Array.from({ length: MAX_SLICES }, (_, i) => seriesColor(i));
  refs.colourPicker = swatchPicker({
    colors: state.palette,
    value: state.palette[0],
    label: 'Category colour',
  });
  document.getElementById('category-colour').append(refs.colourPicker);

  refs.month.value = state.month;
  refs.date.value = todayISO();
  document.getElementById('profile-name').textContent = profile.name;
  labelAmountField();

  refs.entries.append(skeletonList(3, 'skeleton--text'));

  try {
    [state.categories, state.entries] = await Promise.all([
      fetchCategories(),
      fetchYear(yearOf(state.month)),
    ]);
  } catch (error) {
    clear(refs.entries).append(
      emptyState({
        title: 'Couldn’t load this month',
        body: error.message,
        actionLabel: 'Try again',
        onAction: () => window.location.reload(),
      }),
    );
    return;
  }

  renderCategoryOptions();
  renderAll();
  wireControls();
}

function wireControls() {
  refs.month.addEventListener('change', async () => {
    const next = refs.month.value;
    if (!next) return;
    const yearChanged = yearOf(next) !== yearOf(state.month);
    state.month = next;

    if (yearChanged) {
      try {
        state.entries = await fetchYear(yearOf(next));
      } catch (error) {
        toast(error.message, { type: 'error' });
        return;
      }
    }
    renderAll();
  });

  refs.form.addEventListener('submit', (event) => {
    event.preventDefault();
    addEntry();
  });

  // "+ New category" is a select option rather than a second button: the field
  // you're already in is where you notice the category is missing.
  refs.category.addEventListener('change', () => {
    if (refs.category.value !== '__new') return;
    refs.category.value = '';
    refs.categoryForm.reset();
    showBanner(refs.categoryError, null);
    // Default to the next unused slot, so a category always arrives with a
    // sensible colour and the picker only has to be touched to override it.
    refs.colourPicker.select(seriesColor(state.categories.length % MAX_SLICES));
    refs.categoryModal.showModal();
    refs.categoryName.focus();
  });

  document.getElementById('category-cancel').addEventListener('click', () => refs.categoryModal.close());
  document.getElementById('category-close').addEventListener('click', () => refs.categoryModal.close());
  refs.categoryForm.addEventListener('submit', (event) => {
    event.preventDefault();
    addCategory();
  });
}
