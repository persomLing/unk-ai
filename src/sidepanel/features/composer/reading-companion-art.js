// Original layered artwork. All coordinates are in a 168 × 116 design space.
export const COMPANION_GESTURES = Object.freeze({ shy: 1700, notice: 1350, bookmark: 1400, turnPage: 980 });

export function createCompanionPainter(canvas, hitArea) {
  const g = canvas.getContext('2d');
  if (!g) return null;
  const paths = new Map();
  const hitPaths = new Map();
  const drawnContours = new Set();
  hitArea.setAttribute('viewBox', `0 0 ${canvas.width} ${canvas.height}`);
  hitArea.setAttribute('preserveAspectRatio', 'none');
  hitArea.setAttribute('stroke-linecap', 'round');
  hitArea.setAttribute('stroke-linejoin', 'round');
  const ink = '#363345',
    hair = '#343a52',
    skin = '#ffe2c9',
    blush = '#eda898';
  function path(points, fill, stroke = ink, width = 1.5) {
    if (!paths.has(points)) paths.set(points, new Path2D(points));
    const p = paths.get(points);
    if (fill) {
      g.fillStyle = fill;
      g.fill(p);
    }
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = width;
      g.stroke(p);
    }
  }
  // Share the painted outlines with native SVG hit testing so empty canvas pixels pass input through.
  function contour(points, fill, stroke = ink, width = 1.5) {
    path(points, fill, stroke, width);
    let node = hitPaths.get(points);
    if (!node) {
      node = hitArea.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
      node.setAttribute('d', points);
      node.setAttribute('fill', fill ? 'transparent' : 'none');
      node.setAttribute('stroke', stroke ? 'transparent' : 'none');
      node.setAttribute('stroke-width', width);
      hitArea.append(node);
      hitPaths.set(points, node);
    }
    const transform = g.getTransform().toString();
    if (node.getAttribute('transform') !== transform) node.setAttribute('transform', transform);
    if (node.hasAttribute('display')) node.removeAttribute('display');
    drawnContours.add(points);
  }
  function oval(x, y, rx, ry, fill, angle = 0, stroke = null, width = 1.2) {
    g.beginPath();
    g.ellipse(x, y, rx, ry, angle, 0, Math.PI * 2);
    if (fill) {
      g.fillStyle = fill;
      g.fill();
    }
    if (stroke) {
      g.strokeStyle = stroke;
      g.lineWidth = width;
      g.stroke();
    }
  }
  const clamp = (v, low, high) => Math.max(low, Math.min(high, v));
  const easePulse = (t) => Math.sin(Math.PI * clamp(t, 0, 1)) ** 2;
  function smooth(value) {
    const t = clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }
  function envelope(age, start, peak, release, end) {
    return smooth((age - start) / (peak - start)) * (1 - smooth((age - release) / (end - release)));
  }
  function liftedCover(amount) {
    if (amount < 0.002) return;
    g.save();
    g.translate(81, 105);
    g.scale(1, amount);
    contour('M-57 -4 L-58 -30 Q-36 -35 -1 -29 Q26 -36 54 -32 L56 -5 Q26 -6 0 -1 Q-28 -7 -57 -4Z', '#80b5a1', ink, 1.5);
    contour('M-58 -30 Q-33 -36 -1 -30 Q23 -37 54 -32 L54 -29 Q26 -33 -1 -26 Q-31 -32 -57 -27Z', '#fff1d4', ink, 1);
    path('M-1 -26 L0 -3 M-53 -24 L-52 -10 M5 -25 Q26 -30 48 -26', null, '#548575', 1);
    oval(28, -17, 4.1, 3.6, '#eed6a2', -0.3);
    oval(28, -17, 7, 1.7, null, -0.45, '#fbe9c1', 1);
    contour(
      'M-39 -30 Q-39 -35 -36 -35 Q-34 -36 -33 -32 Q-32 -37 -29 -36 Q-27 -36 -26 -31 Q-24 -34 -22 -33 Q-20 -32 -21 -28 Q-29 -25 -38 -27Z',
      skin,
      ink,
      1,
    );
    contour(
      'M22 -30 Q22 -35 25 -35 Q27 -35 28 -32 Q29 -37 32 -36 Q34 -36 35 -32 Q37 -35 39 -33 Q41 -32 40 -29 Q32 -26 23 -27Z',
      skin,
      ink,
      1,
    );
    g.restore();
  }
  function turningLeaf(progress) {
    if (progress <= 0 || progress >= 1) return;
    const t = smooth(progress),
      reach = 53 * Math.cos(Math.PI * t),
      arch = 33 * Math.sin(Math.PI * t);
    g.save();
    g.translate(81, 104);
    g.globalAlpha = envelope(t, 0, 0.09, 0.93, 1);
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(reach * 0.55, -arch - 7, reach, -arch * 0.72 - 3);
    g.lineTo(reach + 1, -arch * 0.72 + 4);
    g.quadraticCurveTo(reach * 0.5, -arch + 2, 0, 4);
    g.closePath();
    g.fillStyle = t < 0.5 ? '#fff2d5' : '#f3dfbb';
    g.fill();
    g.lineWidth = 1.3;
    g.strokeStyle = '#8f7963';
    g.stroke();
    g.beginPath();
    g.moveTo(reach * 0.22, -arch * 0.42);
    g.quadraticCurveTo(reach * 0.6, -arch - 2, reach * 0.86, -arch * 0.75);
    g.lineWidth = 0.85;
    g.strokeStyle = '#c1ac88';
    g.stroke();
    g.restore();
  }
  function eye(x, y, close, dx, dy) {
    g.save();
    g.translate(x, y);
    g.scale(1, Math.max(0.09, 1 - close));
    oval(0, 0, 7.1, 8.2, '#fff6e7', 0, ink, 1.2);
    oval(dx, dy + 0.5, 4.85, 6.6, '#754f40');
    oval(dx + 0.2, dy + 2.8, 3.35, 3.2, '#c69760');
    oval(dx, dy - 0.4, 2.65, 4, '#352f3c');
    oval(dx - 1.1, dy - 3.3, 1.6, 1.7, '#fff9e9');
    oval(dx + 2.1, dy + 2.5, 0.75, 0.8, '#fff6ce');
    path('M-8 -3 Q-5 -10 1 -8 Q5 -8 7 -4', null, ink, 1.85);
    g.restore();
    if (close > 0.62) {
      g.save();
      g.translate(x, y);
      path('M-7 1 Q0 -5 7 0', null, ink, 1.85);
      g.restore();
    }
  }
  return function paint({ now, pose, since, blinkStart, selectionGaze }) {
    drawnContours.clear();
    g.setTransform(canvas.width / 168, 0, 0, canvas.height / 116, 0, 0);
    g.clearRect(0, 0, 168, 116);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const shyAge = now - since.shy;
    const shy = envelope(shyAge, 50, 380, 1110, 1660);
    const flush = envelope(shyAge, 35, 300, 1170, 1700);
    const surprise = easePulse(shyAge / 230);
    const peek = envelope(shyAge, 720, 980, 1190, 1570);
    const lift = envelope(shyAge, 170, 520, 1110, 1550);
    const pageAge = now - since.turnPage,
      page = envelope(pageAge, 0, 170, 620, 980) * (1 - shy);
    const mark = envelope(now - since.bookmark, 0, 320, 940, 1400) * (1 - shy) * (1 - page);
    const notice = envelope(now - since.notice, 0, 300, 760, 1350) * (1 - flush) * (1 - page) * (1 - mark) * (1 - pose.curious);
    const blinking = blinkStart ? easePulse((now - blinkStart) / 155) : 0;
    const close = Math.max(blinking * (1 - flush), 0.64 * shy * (1 - peek), easePulse((shyAge - 175) / 210));
    const q = pose.curious * (1 - shy) * (1 - page) * (1 - mark);
    const dx =
      pose.x * (1 - notice) * (1 - page) * (1 - mark) * (1 - shy) + selectionGaze.x * mark - 0.5 * page + shy * (1 - 1.75 * peek);
    const dy =
      pose.y * (1 - notice) * (1 - page) * (1 - mark) * (1 - shy) +
      selectionGaze.y * mark -
      0.95 * page +
      shy * (0.95 - 1.15 * peek);
    // Book cover, paper leaves, cloth bookmark.
    contour(
      'M12 105 Q12 102 19 102 L138 101 Q145 102 148 107 L147 112 Q146 114 140 114 L18 114 Q11 113 12 105Z',
      '#7ea99c',
      ink,
      1.7,
    );
    path('M18 106 Q46 108 140 105 L140 111 Q77 114 19 111Z', '#f7e6c6', null);
    path('M16 105 Q70 107 141 104 M19 109 Q55 111 79 109', null, '#9e8d77', 0.9);
    g.save();
    g.translate(42 + 17 * mark, 106 - mark * 2);
    g.rotate(-0.25 * mark);
    contour('M-4 -1 L5 -1 L4 8 L0 6 L-4 9Z', '#d6a670', ink, 0.8);
    g.restore();
    // Blouse and sailor collar behind the face.
    contour('M45 103 Q46 84 61 78 Q73 74 91 78 Q112 78 124 90 Q132 94 140 103 Q118 107 96 104 L60 105Z', '#f5ebd6', ink, 2);
    path('M51 86 Q63 76 76 78 Q85 83 91 81 Q104 78 113 85 L97 98 L79 91 L67 97Z', '#83aea0', ink, 1.3);
    path('M56 85 Q61 89 67 92 M99 93 L108 86', null, '#c8ddc9', 1.4);
    path('M73 93 Q75 89 80 90 Q85 89 89 93 L83 97 L85 102 L79 100 L76 103 L76 96Z', '#416a68', ink, 1);
    g.save();
    g.translate(83, 79);
    g.translate(
      -3 * q + 4 * shy - 1.5 * notice - 2 * mark,
      -5 * q + 10.5 * shy - 3.5 * peek - 2.5 * surprise - 2 * notice + 2 * mark - 2.5 * page,
    );
    g.rotate(((dx * 2.2 - q * 5 + shy * 8 - notice * 10 - mark * 4 - page * 3) * Math.PI) / 180);
    g.translate(-83, -79);
    // Rear bob, loose waves and soft reflected highlights.
    contour(
      'M42 83 Q28 83 36 69 Q30 45 45 28 Q59 11 85 14 Q111 9 124 30 Q132 39 129 56 Q135 66 141 68 Q139 75 131 75 Q139 82 145 79 Q140 93 125 91 Q122 99 110 96 Q99 96 91 86 L57 83 Q44 94 35 89Z',
      hair,
      ink,
      2.3,
    );
    path('M113 75 Q126 77 129 67 M115 84 Q127 89 134 80 M42 70 Q40 82 34 83', null, '#626179', 1.55);
    // Exposed neck and warm reflected shadow under the chin.
    path('M75 75 L75 84 Q83 90 88 82 L88 74Z', '#edbba9', ink, 1);
    oval(42.5, 61, 5.3, 7.5, '#efc0ac', -0.25, ink, 1.2);
    oval(115.5, 59, 5.6, 7.4, '#efc0ac', 0.25, ink, 1.2);
    path('M43 46 Q51 25 81 24 Q106 25 116 46 L113 66 Q108 82 86 86 Q62 86 49 72 Q43 64 43 46Z', skin, ink, 1.8);
    oval(55, 68, 6.2, 2.9, '#f3b8a9', 0.1);
    oval(101, 68, 6.5, 2.9, '#f3b8a9', -0.15);
    path('M51 69 l1 -2 M54 70 l1 -2 M101 70 l1 -2 M104 69 l1 -2', null, blush, 0.85);
    if (flush > 0.002) {
      g.save();
      g.globalAlpha = flush * 0.85;
      oval(55, 68, 8.8, 4.3, '#ef9290', 0.12);
      oval(101, 67, 9, 4.3, '#ef9290', -0.13);
      path('M49 69 l2 -3 M53 70 l2 -3 M57 70 l2 -3 M96 69 l2 -3 M100 69 l2 -3 M104 68 l2 -3', null, '#d46f71', 1.2);
      g.restore();
    }
    g.save();
    g.translate(0, -q * 1.7 - notice * 1.8 - surprise * 2 + shy * 0.8);
    path('M55 48 Q61 44 66 46 M88 46 Q94 43 101 47', null, '#765451', 1.6);
    g.restore();
    eye(61, 57.8, close, dx * 2.05, dy * 1.45);
    eye(94.5, 57, close, dx * 2.05, dy * 1.45);
    path('M77 64 q-1 2 1 2', null, '#c18f82', 1);
    if (surprise > 0.42) oval(77, 73, 1.8, 2.3, '#ca8c80', 0, ink, 0.8);
    else if (shy > 0.35) path('M74 72 Q76 73.5 78 72 Q79 73 80 72', null, '#a86b63', 1.25);
    else path('M74 72 Q77 74.5 81 71.1', null, '#9c655f', 1.35);
    // Asymmetric fringe with an outlined forelock.
    contour(
      'M40 61 Q32 48 42 32 Q49 18 66 15 Q81 10 93 16 Q111 14 121 32 Q126 44 119 64 Q117 77 110 83 Q113 71 111 60 Q107 53 109 43 Q98 45 91 33 Q85 42 75 45 Q82 38 80 31 Q68 46 59 48 Q60 43 61 39 Q54 46 47 48 L46 62 Q45 72 40 76 Q42 67 40 61Z',
      hair,
      ink,
      2,
    );
    path('M46 37 Q53 23 69 21 M83 19 Q91 17 98 21 M111 29 Q117 34 117 41', null, '#727087', 1.7);
    path('M53 30 Q61 23 68 23 M96 25 Q102 29 103 33 M48 49 Q45 60 45 63', null, '#535970', 1);
    contour('M72 17 Q63 6 72 4 Q85 1 89 9 Q83 5 79 8 Q76 11 79 15', null, ink, 1.8);
    // Mint Saturn pin is the same identifying mark as the app icon.
    oval(111, 41, 6.4, 5.8, '#8ec8b7', -0.45, ink, 1.2);
    oval(111, 41, 10.7, 2.9, null, -0.48, '#e9c07d', 2);
    oval(109.5, 38.3, 1.4, 1.1, '#e4f2db');
    path('M122 48 l1 -3 l1 3 l2 1 l-2 1 l-1 2 l-1 -2 l-2 -1Z', '#f4d295', null);
    g.restore();
    // Sleeves and two hands remain planted on the book as the head turns.
    contour('M49 87 Q44 88 40 93 Q34 101 42 103 L61 103 Q64 101 62 97 L57 92Z', '#f6ecd7', ink, 1.6);
    contour('M113 86 Q123 86 129 97 Q129 103 123 104 L101 104 Q97 101 101 95Z', '#f6ecd7', ink, 1.6);
    path('M58 93 L65 97 L62 103 L55 102 Q57 99 58 93Z M102 93 Q106 97 106 103 L99 103 L96 98Z', '#7fae9e', ink, 1.1);
    if (mark > 0.002) {
      g.save();
      g.translate(42 + 17 * mark, 106 - mark * 2);
      g.rotate(-0.25 * mark);
      g.scale(1, mark);
      contour('M-4 0 Q-9 -9 -6 -21 L3 -20 Q0 -8 5 0Z', '#e5b675', ink, 1);
      path('M-4 -17 l4 1 M-4 -14 l3 1', null, '#a27954', 1);
      g.restore();
    }
    path('M61 98 Q65 93 69 94 L76 98 Q78 100 75 102 Q66 104 61 102Z', '#ffdec7', ink, 1.2);
    path('M100 98 Q92 93 89 95 Q82 97 80 100 Q80 103 85 103 L98 103Z', '#ffdec7', ink, 1.2);
    path('M67 100 l4 1 M91 100 l-4 1 M45 97 l7 2 M116 97 l6 -2', null, '#c5a699', 0.9);
    turningLeaf(pageAge / COMPANION_GESTURES.turnPage);
    liftedCover(lift);
    for (const [points, node] of hitPaths) {
      if (!drawnContours.has(points) && !node.hasAttribute('display')) node.setAttribute('display', 'none');
    }
  };
}
