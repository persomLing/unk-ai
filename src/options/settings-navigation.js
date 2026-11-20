/** In-page section navigation; the form remains mounted while moving between sections. */
export function installSettingsNavigation(doc) {
  const win = doc.defaultView;
  const content = doc.getElementById('settings-content');
  const links = [...doc.querySelectorAll('[data-settings-nav]')];
  const sections = links.map(link => doc.getElementById(link.hash.slice(1)));
  let frame = null, current = -1;
  function update() {
    frame = null;
    const bounds = content.getBoundingClientRect();
    const marker = bounds.top + Math.min(96, content.clientHeight * .22);
    let active = Math.max(0, sections.findLastIndex(section => section && section.getBoundingClientRect().top <= marker));
    if (content.scrollHeight > content.clientHeight && content.clientHeight + content.scrollTop >= content.scrollHeight - 4) active = sections.length - 1;
    if (active === current) return;
    current = active;
    links.forEach((link, index) => {
      if (index === active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }
  const schedule = () => { if (frame === null) frame = win.requestAnimationFrame(update); };
  content.addEventListener('scroll', schedule, { passive: true });
  win.addEventListener('resize', schedule);
  update();
  return {
    dispose() {
      if (frame !== null) win.cancelAnimationFrame(frame);
      content.removeEventListener('scroll', schedule);
      win.removeEventListener('resize', schedule);
    },
  };
}
