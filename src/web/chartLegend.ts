// Pure layout helper for chart legends (kept apart from the React components for unit tests).

/** Rows a plain (wrapping) legend needs for these names in `width` px; Infinity when unknown. */
export function legendRows(names: string[], width: number, textWidth: (s: string) => number): number {
  if (!width || !names.length) return names.length ? Infinity : 0;
  // as ECharts lays it out: icon 25 px + 5 px to the text, itemGap 8 px, padding 5 px on both sides
  const avail = width - 10;
  let rows = 1;
  let x = 0;
  for (const n of names) {
    const w = 30 + textWidth(n);
    if (x > 0 && x + w > avail) {
      rows++;
      x = 0;
    }
    x += w + 8;
  }
  return rows;
}

