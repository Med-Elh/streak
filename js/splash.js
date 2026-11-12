/**
 * The opening splash on phones: "Streak" rises in letter by letter, the dot
 * drops onto the end of it, the streak line draws underneath, and the whole
 * thing fades into the app.
 *
 * A classic script loaded synchronously in <head>, not a module: modules are
 * deferred, so the page would paint once before the splash existed.
 *
 * It plays once per launch, not once per page. Opening the app walks
 * index → profiles → habits in quick succession, and restarting on each would
 * stutter three times. So the first page notes when it started (in
 * sessionStorage, which a fresh launch of the home-screen app starts empty)
 * and every page after it draws the splash with a negative animation-delay,
 * picking the same animation up where the previous page left it.
 *
 * The timings live in components.css; TOTAL here must match the end of the
 * splash-out animation there.
 */
(function () {
  var KEY = 'streak.splash';
  var TOTAL = 1900;
  var root = document.documentElement;

  // The last theme used here, before the first paint, so a dark-mode user
  // doesn't get a light splash. ui.js initTheme() applies the same key later.
  try {
    var theme = localStorage.getItem('streak.theme');
    if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
  } catch (e) { /* Storage blocked: the OS theme applies, as it would anyway. */ }

  var standalone = navigator.standalone === true
    || window.matchMedia('(display-mode: standalone)').matches;
  var phone = standalone || window.matchMedia('(pointer: coarse) and (max-width: 820px)').matches;
  if (!phone) return;

  // Same gate as every other animation in the app (see base.css "motion").
  if (root.getAttribute('data-motion') === 'system'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var now = Date.now();
  var started;
  try {
    var saved = sessionStorage.getItem(KEY);
    if (saved === null) {
      started = now;
      sessionStorage.setItem(KEY, String(now));
    } else {
      started = Number(saved); // 'done' → NaN → no splash
    }
  } catch (e) {
    // Without storage every page in the redirect chain would replay it from
    // the start. No splash is better than three.
    return;
  }

  var elapsed = now - started;
  // Not worth drawing for the last few frames of the fade.
  if (!(elapsed >= 0 && elapsed < TOTAL - 150)) return;

  var letters = '';
  var word = 'Streak';
  for (var i = 0; i < word.length; i++) {
    letters += '<span class="splash__letter" style="--i:' + i + '">' + word[i] + '</span>';
  }

  var splash = document.createElement('div');
  splash.className = 'splash';
  splash.setAttribute('aria-hidden', 'true');
  splash.style.setProperty('--splash-at', -elapsed + 'ms');
  splash.innerHTML =
    '<span class="splash__word">' + letters
    + '<span class="splash__dot"><span class="splash__dot-fall">.</span></span>'
    + '<span class="splash__line"></span></span>';

  // On <html> rather than <body>: <body> doesn't exist yet, and it stays
  // visibility:hidden while [data-booting] anyway.
  root.appendChild(splash);

  var timer = setTimeout(finish, TOTAL - elapsed + 50);

  function finish() {
    clearTimeout(timer);
    removeEventListener('keydown', skip, true);
    if (splash.parentNode) splash.parentNode.removeChild(splash);
  }

  function skip() {
    if (splash.dataset.skipped) return;
    splash.dataset.skipped = 'true';
    try { sessionStorage.setItem(KEY, 'done'); } catch (e) { /* finish() still runs */ }
    // Let the next tap reach the page while it fades.
    splash.style.pointerEvents = 'none';
    if (!splash.animate) return finish();
    var from = getComputedStyle(splash).opacity;
    splash.animate([{ opacity: from }, { opacity: 0 }], {
      duration: 160,
      easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', // --ease-out
      fill: 'forwards',
    }).onfinish = finish;
  }

  splash.addEventListener('pointerdown', skip);
  addEventListener('keydown', skip, true);
})();
