/**
 * Settings: profiles, the editable option lists, finance categories, currency
 * and appearance.
 *
 * Everything here is a small list with the same shape — read, add, rename,
 * delete — so it's built from one editable-list component rather than four
 * near-identical ones.
 */

import { supabase, describeError } from './supabase.js?v=25';
import { requireSession, signOut, goTo, PICKER_PAGE } from './auth.js?v=25';
import {
  requireActiveProfile, listProfiles, createProfile, renameProfile,
  recolorProfile, deleteProfile, updateCurrency, setActiveProfile, updateGreetingStyle,
} from './profiles.js?v=25';
import {
  el, clear, toast, topbar, emptyState, skeletonList, setBusy, showBanner,
  initials, initMoney, setMoneyContext, moneyContext, formatMoney, useCurrency, swatchPicker,
  setTheme, effectiveTheme, currentTheme, applyProfileTheme,
} from './ui.js?v=25';
import { OPTION_KINDS, seedFor } from './constants.js?v=25';
import { categoryColor, seriesColor } from './charts.js?v=25';

import {
  mountGreeting, sessionKey, listGreetings, createGreeting, updateGreeting,
  deleteGreeting, GREETING_STYLES, PERIODS,
} from './greetings.js?v=25';

const state = {
  profile: null,
  profiles: [],
  options: {},        // kind → [{ id, value }] of custom rows only
  categories: [],
  palette: [],        // the six chart slots — categories are charted
  avatarPalette: [],  // the eight avatar colours — profiles are not
  greetings: [],
  greetingStyle: 'neutral',
};

let refs = {};

/* ---------------------------------------------------------------- helper -- */

/**
 * Wraps a write so no failure can end as a silent no-op: the caller gets false,
 * the person gets a toast that says what didn't happen.
 */
async function guard(fallback, run) {
  try {
    return await run();
  } catch (error) {
    toast(error.message || fallback, { type: 'error' });
    return false;
  }
}

/** One row of an editable list: the value, a rename field, a delete button. */
function listRow({ label, onRename, onDelete, swatch }) {
  const input = el('input', {
    class: 'input input--inline',
    value: label,
    'aria-label': `Rename ${label}`,
  });

  const commit = async () => {
    const next = input.value.trim();
    if (!next || next === label) {
      input.value = label;
      return;
    }
    if (!(await onRename(next))) input.value = label;
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); input.blur(); }
    if (event.key === 'Escape') { input.value = label; input.blur(); }
  });

  return el('div', { class: 'edit-row' }, [
    swatch ?? null,
    input,
    el('button', {
      class: 'btn btn--danger btn--sm',
      type: 'button',
      text: 'Delete',
      'aria-label': `Delete ${label}`,
      onclick: onDelete,
    }),
  ]);
}

/* -------------------------------------------------------------- profiles -- */

async function renderProfiles() {
  clear(refs.profileList);

  if (!state.profiles.length) {
    refs.profileList.append(emptyState({
      title: 'No profiles yet',
      body: 'A profile holds one person’s habits, tasks, finances and trades.',
      actionLabel: 'Add a profile',
      onAction: () => refs.profileName.focus(),
    }));
    return;
  }

  for (const profile of state.profiles) {
    const isActive = profile.id === state.profile.id;

    const swatch = el('button', {
      class: 'avatar avatar--sm',
      type: 'button',
      style: `--avatar: ${profile.avatar_color}`,
      title: 'Change colour',
      'aria-label': `Change colour for ${profile.name}`,
      text: initials(profile.name),
      onclick: () => cycleColour(profile),
    });

    const row = listRow({
      label: profile.name,
      swatch,
      onRename: (next) => guard('Couldn’t rename that profile.', async () => {
        await renameProfile(profile.id, next);
        profile.name = next;
        if (isActive) refs.profileHeading.textContent = next;
        toast('Profile renamed.', { type: 'success', duration: 2000 });
        return true;
      }),
      onDelete: () => removeProfile(profile),
    });

    // How the app talks to this person, set per profile so two people sharing
    // one login don't have to share one tone of voice.
    const style = el('select', { class: 'select select--inline', 'aria-label': `Greeting style for ${profile.name}` });
    for (const option of GREETING_STYLES) {
      style.append(el('option', { value: option.value, text: option.label }));
    }
    style.value = profile.greeting_style === 'warm' ? 'warm' : 'neutral';
    style.addEventListener('change', () => saveGreetingStyle(profile, style));
    row.append(style);

    if (isActive) row.append(el('span', { class: 'chip chip--accent', text: 'Active' }));
    refs.profileList.append(row);
  }
}

async function saveGreetingStyle(profile, select) {
  await guard('Couldn’t change the greeting style.', async () => {
    await updateGreetingStyle(profile.id, select.value);
    profile.greeting_style = select.value;
    // The line for this session was picked under the old style.
    for (const period of ['morning', 'afternoon', 'evening']) {
      sessionStorage.removeItem(sessionKey(profile.id, period));
    }
    toast('Greeting style saved.', { type: 'success', duration: 2000 });
    return true;
  });
}

/* -------------------------------------------------------------- greetings -- */

function renderGreetings() {
  clear(refs.greetingList);

  const rows = state.greetings.filter((g) => g.style === state.greetingStyle);
  if (!rows.length) {
    refs.greetingList.append(emptyState({
      title: 'No lines for this style',
      body: 'Add one below. Use {name} where the profile name should go.',
    }));
    return;
  }

  for (const greeting of rows) {
    const row = listRow({
      label: greeting.body,
      onRename: (next) => guard('Couldn’t save that greeting.', async () => {
        await updateGreeting(greeting.id, { body: next });
        greeting.body = next;
        toast('Greeting saved.', { type: 'success', duration: 2000 });
        return true;
      }),
      onDelete: () => removeGreeting(greeting),
    });
    row.append(el('span', {
      class: 'chip',
      text: PERIODS.find((p) => p.value === greeting.period)?.label ?? greeting.period,
    }));
    refs.greetingList.append(row);
  }
}

async function removeGreeting(greeting) {
  await guard('Couldn’t remove that greeting.', async () => {
    await deleteGreeting(greeting.id);
    state.greetings = state.greetings.filter((g) => g.id !== greeting.id);
    toast('Greeting removed.', { type: 'success', duration: 2000 });
    renderGreetings();
    return true;
  });
}

async function addGreeting(event) {
  event.preventDefault();
  const body = refs.greetingBody.value.trim();
  if (!body) {
    refs.greetingBody.focus();
    return;
  }

  await guard('Couldn’t add that greeting.', async () => {
    const created = await createGreeting({
      style: state.greetingStyle,
      period: refs.greetingPeriod.value,
      body,
    });
    state.greetings.push(created);
    refs.greetingBody.value = '';
    toast('Greeting added.', { type: 'success', duration: 2000 });
    renderGreetings();
    return true;
  });
}

/** Avatars cycle rather than open a picker — eight options, one target. */
async function cycleColour(profile) {
  const index = state.avatarPalette.indexOf(profile.avatar_color);
  const next = state.avatarPalette[(index + 1) % state.avatarPalette.length];

  await guard('Couldn’t change that colour.', async () => {
    await recolorProfile(profile.id, next);
    profile.avatar_color = next;
    await renderProfiles();
    return true;
  });
}

async function removeProfile(profile) {
  if (state.profiles.length === 1) {
    toast('This is the only profile. Add another before removing this one.', { type: 'error' });
    return;
  }
  if (!window.confirm(
    `Delete ${profile.name}? Their habits, tasks, finances and trades go with them. This can't be undone.`,
  )) return;

  await guard('Couldn’t remove that profile.', async () => {
    await deleteProfile(profile.id);
    state.profiles = state.profiles.filter((p) => p.id !== profile.id);
    toast(`${profile.name} removed.`, { type: 'success' });

    // Deleting the profile you're using leaves nothing to work on.
    if (profile.id === state.profile.id) {
      goTo(PICKER_PAGE);
      return true;
    }
    await renderProfiles();
    return true;
  });
}

async function addProfile(event) {
  event.preventDefault();
  showBanner(refs.profileError, null);

  const name = refs.profileName.value.trim();
  if (!name) {
    showBanner(refs.profileError, 'Give the profile a name.');
    refs.profileName.focus();
    return;
  }

  setBusy(refs.profileSubmit, true, 'Adding…');
  try {
    const colour = state.avatarPalette[state.profiles.length % state.avatarPalette.length];
    const profile = await createProfile({ name, avatarColor: colour });
    state.profiles.push(profile);
    refs.profileName.value = '';
    toast(`${name} added.`, { type: 'success' });
    await renderProfiles();
  } catch (error) {
    showBanner(refs.profileError, error.message);
  } finally {
    setBusy(refs.profileSubmit, false);
  }
}

/* --------------------------------------------------------- option lists -- */

function renderOptions() {
  clear(refs.optionLists);

  for (const { kind, label } of OPTION_KINDS) {
    const rows = state.options[kind] ?? [];
    const usingSeed = rows.length === 0;

    const list = el('div', { class: 'edit-list' });

    if (usingSeed) {
      // A profile that has never edited a list still needs to see what's in it.
      list.append(el('p', { class: 'hint', text: 'Using the defaults. Add one to start your own list.' }));
      for (const value of seedFor(kind)) {
        list.append(el('div', { class: 'edit-row edit-row--muted' }, [
          el('span', { class: 'edit-row__label', text: value }),
          el('span', { class: 'chip', text: 'Default' }),
        ]));
      }
    } else {
      for (const row of rows) {
        list.append(listRow({
          label: row.value,
          onRename: (next) => guard('Couldn’t rename that option.', async () => {
            const { error } = await supabase
              .from('profile_options')
              .update({ value: next })
              .eq('id', row.id);
            if (error) throw new Error(describeError(error, 'Couldn’t rename that option.'));
            row.value = next;
            toast('Option renamed.', { type: 'success', duration: 2000 });
            return true;
          }),
          onDelete: () => removeOption(kind, row),
        }));
      }
    }

    const form = el('form', { class: 'quick-add' });
    const input = el('input', {
      class: 'input quick-add__title',
      maxlength: '40',
      placeholder: `Add to ${label.toLowerCase()}`,
      'aria-label': `Add to ${label}`,
      autocomplete: 'off',
    });
    form.append(input, el('button', { class: 'btn btn--secondary', type: 'submit', text: 'Add' }));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      addOption(kind, input);
    });

    refs.optionLists.append(el('div', { class: 'settings-block' }, [
      el('h3', { class: 'card__title', text: label }),
      list,
      form,
    ]));
  }
}

/**
 * The first custom value has to carry the defaults with it — otherwise adding
 * one instrument would silently delete the other nine from every dropdown.
 */
async function addOption(kind, input) {
  const value = input.value.trim();
  if (!value) return;

  const existing = state.options[kind] ?? [];
  const rows = existing.length
    ? [{ profile_id: state.profile.id, kind, value, sort_order: existing.length }]
    : [...seedFor(kind), value].map((v, i) => ({
        profile_id: state.profile.id, kind, value: v, sort_order: i,
      }));

  await guard('Couldn’t add that option.', async () => {
    const { data, error } = await supabase
      .from('profile_options')
      .insert(rows)
      .select('id, kind, value');

    if (error) {
      throw new Error(error.code === '23505'
        ? 'That option is already on the list.'
        : describeError(error, 'Couldn’t add that option.'));
    }

    state.options[kind] = [...existing, ...data];
    input.value = '';
    toast(`${value} added.`, { type: 'success', duration: 2000 });
    renderOptions();
    return true;
  });
}

async function removeOption(kind, row) {
  await guard('Couldn’t remove that option.', async () => {
    const { error } = await supabase.from('profile_options').delete().eq('id', row.id);
    if (error) throw new Error(describeError(error, 'Couldn’t remove that option.'));

    state.options[kind] = state.options[kind].filter((r) => r.id !== row.id);
    toast('Option removed.', { type: 'success', duration: 2000 });
    renderOptions();
    return true;
  });
}

/* ----------------------------------------------------- finance categories -- */

function renderCategories() {
  clear(refs.categoryList);

  if (!state.categories.length) {
    refs.categoryList.append(emptyState({
      title: 'No categories yet',
      body: 'Categories sort your money in and out. Add the first one below.',
    }));
    return;
  }

  state.categories.forEach((category, index) => {
    // Same resolver the doughnut uses, so a swatch here matches its slice there.
    const current = categoryColor(category, index % 6);

    const swatch = el('button', {
      class: 'legend__dot legend__dot--lg legend__dot--button',
      type: 'button',
      style: `background: ${current}`,
      title: 'Change colour',
      'aria-label': `Change the colour of ${category.name}`,
      'aria-expanded': 'false',
      onclick: () => togglePicker(category, current, swatch),
    });

    const row = listRow({
      label: category.name,
      swatch,
      onRename: (next) => guard('Couldn’t rename that category.', async () => {
        const { error } = await supabase
          .from('finance_categories')
          .update({ name: next })
          .eq('id', category.id);
        if (error) {
          throw new Error(error.code === '23505'
            ? 'You already have a category with that name.'
            : describeError(error, 'Couldn’t rename that category.'));
        }
        category.name = next;
        toast('Category renamed.', { type: 'success', duration: 2000 });
        return true;
      }),
      onDelete: () => removeCategory(category),
    });

    row.append(el('span', {
      class: `chip ${category.kind === 'income' ? 'chip--win' : ''}`,
      text: category.kind === 'income' ? 'In' : 'Out',
    }));
    refs.categoryList.append(row);
  });
}

/**
 * The picker opens under the row it belongs to rather than in a dialog: it's a
 * six-way choice, and a modal for that is more ceremony than the decision needs.
 */
function togglePicker(category, current, swatch) {
  const row = swatch.closest('.edit-row');
  const existing = row.nextElementSibling;

  if (existing?.classList.contains('swatch-drawer')) {
    existing.remove();
    swatch.setAttribute('aria-expanded', 'false');
    return;
  }

  const picker = swatchPicker({
    colors: state.palette,
    value: current,
    label: `Colour for ${category.name}`,
    onPick: (color) => saveCategoryColour(category, color),
  });

  swatch.setAttribute('aria-expanded', 'true');
  row.after(el('div', { class: 'swatch-drawer' }, picker));
  picker.querySelector('.swatch')?.focus();
}

async function saveCategoryColour(category, color) {
  await guard('Couldn’t change that colour.', async () => {
    const { error } = await supabase
      .from('finance_categories')
      .update({ color })
      .eq('id', category.id);
    if (error) throw new Error(describeError(error, 'Couldn’t change that colour.'));

    category.color = color;
    toast('Colour changed.', { type: 'success', duration: 2000 });
    renderCategories();
    return true;
  });
}

async function removeCategory(category) {
  if (!window.confirm(
    `Delete ${category.name}? Entries filed under it stay, but lose their category.`,
  )) return;

  await guard('Couldn’t remove that category.', async () => {
    const { error } = await supabase.from('finance_categories').delete().eq('id', category.id);
    if (error) throw new Error(describeError(error, 'Couldn’t remove that category.'));
    state.categories = state.categories.filter((c) => c.id !== category.id);
    toast('Category removed.', { type: 'success', duration: 2000 });
    renderCategories();
    return true;
  });
}

async function addCategory(event) {
  event.preventDefault();
  const name = refs.categoryName.value.trim();
  if (!name) {
    refs.categoryName.focus();
    return;
  }

  await guard('Couldn’t add that category.', async () => {
    const { data, error } = await supabase
      .from('finance_categories')
      .insert({
        profile_id: state.profile.id,
        name,
        kind: refs.categoryKind.value,
        color: refs.categoryColour.selected(),
      })
      .select('id, name, kind, color')
      .single();

    if (error) {
      throw new Error(error.code === '23505'
        ? 'You already have a category with that name.'
        : describeError(error, 'Couldn’t add that category.'));
    }

    state.categories.push(data);
    refs.categoryName.value = '';
    // Move the default on, so a run of new categories doesn't come out one colour.
    refs.categoryColour.select(state.palette[state.categories.length % state.palette.length]);
    toast(`${name} added.`, { type: 'success', duration: 2000 });
    renderCategories();
    return true;
  });
}

/* -------------------------------------------------------------- currency -- */

/**
 * Shows the rate working in both directions as it's typed, through the same
 * helpers the pages use — so what it promises here is what they'll print.
 */
function renderRatePreview() {
  const rate = Number(refs.rate.value);
  if (!Number.isFinite(rate) || rate <= 0) {
    refs.preview.textContent = 'Enter a rate above zero.';
    return;
  }

  const saved = moneyContext();

  useCurrency('trading');
  setMoneyContext({ display: 'MAD', rate });
  const tradeInMAD = formatMoney(100);

  useCurrency('finances');
  setMoneyContext({ display: 'USD', rate });
  const spendInUSD = formatMoney(100);

  useCurrency(saved.section);
  setMoneyContext({ display: saved.display, rate: saved.rate });

  refs.preview.textContent =
    `A $100 trade shows as ${tradeInMAD} · 100 MAD of spending shows as ${spendInUSD}`;
}

async function saveCurrency(event) {
  event.preventDefault();
  showBanner(refs.currencyError, null);

  const rate = Number(refs.rate.value);
  if (!Number.isFinite(rate) || rate <= 0) {
    showBanner(refs.currencyError, 'The exchange rate has to be a number above zero.');
    refs.rate.focus();
    return;
  }

  setBusy(refs.currencySubmit, true, 'Saving…');
  try {
    const updated = await updateCurrency(state.profile.id, { exchangeRate: rate });
    state.profile = updated;
    setActiveProfile(updated);
    setMoneyContext({ rate: Number(updated.exchange_rate) });
    toast('Exchange rate saved.', { type: 'success' });
    renderRatePreview();
  } catch (error) {
    showBanner(refs.currencyError, error.message);
  } finally {
    setBusy(refs.currencySubmit, false);
  }
}

/* ------------------------------------------------------------ appearance -- */

function renderTheme() {
  const active = currentTheme();
  for (const button of refs.themeGroup.querySelectorAll('[data-theme-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.themeChoice === active));
  }
  refs.themeNote.textContent = active === 'system'
    ? `Following your device, which is ${effectiveTheme()} right now.`
    : `Always ${active}, on this profile.`;
}

/* ----------------------------------------------------------------- setup -- */

export async function initSettingsPage() {
  await requireSession();
  const profile = await requireActiveProfile();
  state.profile = profile;
  initMoney(profile);
  applyProfileTheme(profile.id);
  mountGreeting(profile);

  document.body.prepend(topbar({
    profile,
    current: 'settings.html',
    onSwitchProfile: () => goTo(PICKER_PAGE),
    onSignOut: signOut,
    // The segmented control below is showing the same setting — keep it honest
    // when the top-bar icon changes it out from under it.
    onThemeChange: () => renderTheme(),
  }));

  refs = {
    profileHeading: document.getElementById('profile-name'),
    profileList: document.getElementById('profile-list'),
    profileForm: document.getElementById('profile-form'),
    profileError: document.getElementById('profile-error'),
    profileName: document.getElementById('profile-name-input'),
    profileSubmit: document.getElementById('profile-submit'),
    optionLists: document.getElementById('option-lists'),
    categoryList: document.getElementById('category-list'),
    categoryForm: document.getElementById('category-form'),
    categoryName: document.getElementById('category-name'),
    categoryKind: document.getElementById('category-kind'),
    currencyForm: document.getElementById('currency-form'),
    currencyError: document.getElementById('currency-error'),
    rate: document.getElementById('exchange-rate'),
    currencySubmit: document.getElementById('currency-submit'),
    preview: document.getElementById('rate-preview'),
    greetingList: document.getElementById('greeting-list'),
    greetingForm: document.getElementById('greeting-form'),
    greetingBody: document.getElementById('greeting-body'),
    greetingPeriod: document.getElementById('greeting-period'),
    greetingStyleFilter: document.getElementById('greeting-style-filter'),
    themeGroup: document.getElementById('theme-group'),
    themeNote: document.getElementById('theme-note'),
  };

  refs.profileHeading.textContent = profile.name;
  refs.rate.value = moneyContext().rate;
  renderRatePreview();
  renderTheme();

  const styles = getComputedStyle(document.documentElement);
  state.avatarPalette = Array.from({ length: 8 }, (_, i) =>
    styles.getPropertyValue(`--avatar-${i + 1}`).trim()).filter(Boolean);

  // Categories are charted, so they draw from the validated chart slots rather
  // than the avatar palette.
  state.palette = Array.from({ length: 6 }, (_, i) => seriesColor(i));

  refs.categoryColour = swatchPicker({
    colors: state.palette,
    value: state.palette[0],
    label: 'Category colour',
  });
  document.getElementById('category-colour').append(refs.categoryColour);

  refs.profileList.append(skeletonList(2, 'skeleton--text'));
  refs.categoryList.append(skeletonList(2, 'skeleton--text'));
  refs.optionLists.append(skeletonList(2, 'skeleton--card'));

  try {
    const [profiles, optionRows, categories, greetings] = await Promise.all([
      listProfiles(),
      fetchOptions(),
      fetchCategories(),
      listGreetings(),
    ]);
    state.profiles = profiles;
    state.categories = categories;
    state.greetings = greetings;
    state.options = {};
    for (const { kind } of OPTION_KINDS) {
      state.options[kind] = optionRows.filter((row) => row.kind === kind);
    }
  } catch (error) {
    for (const node of [refs.profileList, refs.categoryList, refs.optionLists]) {
      clear(node).append(emptyState({
        title: 'Couldn’t load settings',
        body: error.message,
        actionLabel: 'Try again',
        onAction: () => window.location.reload(),
      }));
    }
    return;
  }

  clear(refs.optionLists);
  for (const option of GREETING_STYLES) {
    refs.greetingStyleFilter.append(el('option', { value: option.value, text: option.label }));
  }
  for (const period of PERIODS) {
    refs.greetingPeriod.append(el('option', { value: period.value, text: period.label }));
  }

  await renderProfiles();
  renderOptions();
  renderCategories();
  renderGreetings();
  wireControls();
}

async function fetchOptions() {
  const { data, error } = await supabase
    .from('profile_options')
    .select('id, kind, value')
    .eq('profile_id', state.profile.id)
    .order('sort_order', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load your option lists.'));
  return data ?? [];
}

async function fetchCategories() {
  const { data, error } = await supabase
    .from('finance_categories')
    .select('id, name, kind, color')
    .eq('profile_id', state.profile.id)
    .order('kind', { ascending: true })
    .order('name', { ascending: true });
  if (error) throw new Error(describeError(error, 'Couldn’t load your categories.'));
  return data ?? [];
}

function wireControls() {
  refs.profileForm.addEventListener('submit', addProfile);
  refs.greetingForm.addEventListener('submit', addGreeting);
  refs.greetingStyleFilter.addEventListener('change', () => {
    state.greetingStyle = refs.greetingStyleFilter.value;
    renderGreetings();
  });
  refs.categoryForm.addEventListener('submit', addCategory);
  refs.currencyForm.addEventListener('submit', saveCurrency);
  refs.rate.addEventListener('input', renderRatePreview);

  refs.themeGroup.addEventListener('click', (event) => {
    const button = event.target.closest('[data-theme-choice]');
    if (!button) return;
    setTheme(button.dataset.themeChoice, state.profile.id);
    renderTheme();
  });
}
