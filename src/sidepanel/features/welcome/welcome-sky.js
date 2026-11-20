const STAR_COLORS = ['#70d6cc', '#82b9ff', '#b39bff', '#f0a8cb', '#efc276', '#91dda8'];

export function welcomeStars(random = Math.random) {
  return Array.from({ length: 30 }, (_, index) => {
    const band = Math.floor(index / 10);
    const x = (index % 10) * 9 + 2 + random() * 5;
    const y = band * 32 + 3 + random() * 30;
    return {
      x,
      y,
      size: 4 + random() * 4,
      duration: 13 + random() * 16,
      delay: -random() * 26,
      dx: (random() < .5 ? -1 : 1) * (9 + random() * 17),
      dy: (random() < .5 ? -1 : 1) * (8 + random() * 16),
      opacity: .48 + random() * .4,
      blur: random() * .7,
      color: STAR_COLORS[index % STAR_COLORS.length],
    };
  });
}

export function mountWelcomeSky(container) {
  const stars = welcomeStars().map(({ x, y, size, duration, delay, dx, dy, opacity, blur, color }) => {
    const star = container.ownerDocument.createElement('span');
    star.className = 'welcome-star';
    Object.entries({ x: `${x}%`, y: `${y}%`, size: `${size}px`, duration: `${duration}s`, delay: `${delay}s`, dx: `${dx}px`, dy: `${dy}px`, opacity, blur: `${blur}px`, color })
      .forEach(([name, value]) => star.style.setProperty(`--star-${name}`, value));
    return star;
  });
  container.replaceChildren(...stars);
}
