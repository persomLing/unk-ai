(() => {
  const toc = document.querySelector('.toc');
  const disclosure = toc.querySelector('.toc-disclosure');
  const summary = toc.querySelector('.toc-toggle');
  const currentTitle = toc.querySelector('.toc-current');
  const menu = toc.querySelector('.toc-menu');
  const mobile = window.matchMedia('(max-width: 850px)');
  const chapters = [...toc.querySelectorAll('nav a')].map(link => ({
    link,
    heading: document.getElementById(link.hash.slice(1)),
  }));
  if (!chapters.length) return;

  let activeLink = null;
  let activationOffset = 0;
  let frame = 0;

  function keepActiveLinkVisible() {
    if (!activeLink || !disclosure.open) return;
    const scrollArea = mobile.matches ? menu : toc;
    const area = scrollArea.getBoundingClientRect();
    const link = activeLink.getBoundingClientRect();
    if (link.top < area.top || link.bottom > area.bottom) {
      scrollArea.scrollTop += link.top - area.top - (area.height - link.height) / 2;
    }
  }

  function updateLocation() {
    frame = 0;
    let nextLink = null;
    for (const { link, heading } of chapters) {
      if (heading.getBoundingClientRect().top > activationOffset) break;
      nextLink = link;
    }
    if (nextLink === activeLink) return;
    activeLink?.removeAttribute('aria-current');
    activeLink = nextLink;
    activeLink?.setAttribute('aria-current', 'location');
    currentTitle.textContent = activeLink?.textContent || '';
    keepActiveLinkVisible();
  }

  function scheduleLocationUpdate() {
    if (!frame) frame = window.requestAnimationFrame(updateLocation);
  }

  function measureViewport() {
    const padding = getComputedStyle(document.documentElement).scrollPaddingTop;
    const margin = getComputedStyle(chapters[0].heading).scrollMarginTop;
    activationOffset = (parseFloat(padding) || 0) + (parseFloat(margin) || 0) + 20;
    scheduleLocationUpdate();
  }

  function syncLayout() {
    disclosure.open = !mobile.matches;
    measureViewport();
  }

  disclosure.addEventListener('toggle', keepActiveLinkVisible);
  disclosure.addEventListener('click', event => {
    if (mobile.matches && event.target.closest('a[href^="#"]')) disclosure.open = false;
  });
  document.addEventListener('pointerdown', event => {
    if (mobile.matches && disclosure.open && !toc.contains(event.target)) disclosure.open = false;
  });
  toc.addEventListener('keydown', event => {
    if (mobile.matches && disclosure.open && event.key === 'Escape') {
      event.preventDefault();
      disclosure.open = false;
      summary.focus({ preventScroll: true });
    }
  });
  window.addEventListener('scroll', scheduleLocationUpdate, { passive: true });
  window.addEventListener('hashchange', scheduleLocationUpdate);
  window.addEventListener('resize', measureViewport);
  window.addEventListener('load', scheduleLocationUpdate, { once: true });
  mobile.addEventListener('change', syncLayout);
  document.documentElement.classList.add('toc-ready');
  syncLayout();
})();
