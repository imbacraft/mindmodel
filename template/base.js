// toc highlight
const links = [...document.querySelectorAll('#toc a')];
// Phone contents sheet: open from the bar, close on a pick, the backdrop or Escape.
const sheet = $('#sheet'), mbar = $('#mbar'), scrim = $('#scrim');
const setSheet = (open) => { sheet.classList.toggle('open', open); scrim.hidden = !open; mbar.setAttribute('aria-expanded', open); if (open) sheet.querySelector('a.on, a')?.focus({ focusVisible: false }); };
mbar.addEventListener('click', () => setSheet(!sheet.classList.contains('open')));
scrim.addEventListener('click', () => setSheet(false));
addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet.classList.contains('open')) { setSheet(false); mbar.focus(); } });
links.forEach((a, i) => a.addEventListener('click', () => setSheet(false)));
const showCurrent = (a) => { $('#mbar-num').textContent = links.indexOf(a) + 1; $('#mbar-label').textContent = a.textContent; };
showCurrent(links[0]);
const io = new IntersectionObserver((es) => es.forEach((en) => { if (en.isIntersecting) links.forEach((a) => { const on = a.getAttribute('href') === `#${en.target.id}`; a.classList.toggle('on', on); if (on) showCurrent(a); }); }), { rootMargin: '-40% 0px -55% 0px' });
document.querySelectorAll('main section').forEach((s) => io.observe(s));

// tools
if (WEB) $('label.linkmode').hidden = true;
const lm = $('#linkmode'); lm.value = linkMode;
lm.addEventListener('change', () => { linkMode = lm.value; store.set('mindmodel.links', linkMode); location.reload(); });
const savedTheme = store.get('mindmodel.theme', ''); if (savedTheme) document.documentElement.dataset.theme = savedTheme;
// The button shows the theme you'll switch to: a moon in light mode, a sun in dark mode.
const isDark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
const syncTheme = () => { const d = isDark(), label = `Switch to ${d ? 'light' : 'dark'} theme`; document.documentElement.classList.toggle('is-dark', d); $('#theme').setAttribute('aria-label', label); $('#theme').title = label; };
syncTheme(); matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncTheme);
$('#theme').addEventListener('click', () => {
  document.documentElement.dataset.theme = isDark() ? 'light' : 'dark'; store.set('mindmodel.theme', document.documentElement.dataset.theme); syncTheme();
});
document.title = `mindmodel · ${M.project.name}`;
})();
