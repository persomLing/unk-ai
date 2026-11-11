/** In-page section navigation; the form remains mounted while moving between sections. */
export function installSettingsNavigation(doc) {
  const win = doc.defaultView;
  const links = [...doc.querySelectorAll('[data-settings-nav]')];
  const sections = links.map(link => doc.getElementById(link.hash.slice(1)));
  let frame = null;
  function update() {
    frame = null;
    let active = sections.findIndex(section => section && section.getBoundingClientRect().bottom > 150);
    if (win.innerHeight + win.scrollY >= doc.documentElement.scrollHeight - 4) active = sections.length - 1;
    links.forEach((link, index) => {
      link.classList.toggle('is-active', index === active);
      if (index === active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  const schedule = () => { if (frame === null) frame = win.requestAnimationFrame(update); };
  win.addEventListener('scroll', schedule, { passive: true });
  win.addEventListener('resize', schedule);
  update();
  return { dispose() { win.cancelAnimationFrame(frame); win.removeEventListener('scroll', schedule); win.removeEventListener('resize', schedule); } };
}
