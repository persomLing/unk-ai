/** Convert a drag on a scaled preview into a rectangle in original image pixels. */
export function selectionToImageRect(start, end, display, image) {
  if (![display?.width, display?.height, image?.width, image?.height].every(value => Number.isFinite(value) && value > 0)) return null;
  if (![start?.x, start?.y, end?.x, end?.y].every(Number.isFinite)) return null;
  const left = Math.max(0, Math.min(display.width, Math.min(start.x, end.x)));
  const top = Math.max(0, Math.min(display.height, Math.min(start.y, end.y)));
  const right = Math.max(0, Math.min(display.width, Math.max(start.x, end.x)));
  const bottom = Math.max(0, Math.min(display.height, Math.max(start.y, end.y)));
  if (right - left < 4 || bottom - top < 4) return null;
  const x = Math.floor(left * image.width / display.width), y = Math.floor(top * image.height / display.height);
  return { x, y, width: Math.ceil(right * image.width / display.width) - x,
    height: Math.ceil(bottom * image.height / display.height) - y, coordinateSpace: 'image' };
}
