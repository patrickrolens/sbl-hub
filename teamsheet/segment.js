/* ============================================================================
   Teamsheet panel segmentation (tools/teamsheet/segment.js)

   Locates the six Pokemon panels in a Switch team-sheet image. Runs in the
   browser (canvas) and is loaded by both harness.html and, eventually,
   admin-matches.html — one code path, so what the fixture runner scores is
   exactly what ships.

   Fixed proportional cropping is not viable: of the nine reference sheets only
   two are clean 1920x1080. The rest are arbitrary crops, phone screenshots at
   2532x1170, and photos of a TV with real keystone distortion. So panels are
   found by color instead of position.
   ============================================================================ */

// Panels are a saturated blue-purple against a pale yellow/white background.
// Photographs shift hue and wash out saturation, so the thresholds are wide and
// the real filtering work is done by the geometry pass below.
const PANEL_HUE_MIN = 215, PANEL_HUE_MAX = 295;
const PANEL_SAT_MIN = 0.12, PANEL_VAL_MIN = 0.12, PANEL_VAL_MAX = 0.92;

// Work at a fixed small width. Segmentation only needs the panel rectangles —
// text and icons are cropped from the full-resolution source afterwards — and
// downscaling both speeds up the flood fill and suppresses the moire banding
// that photos of a screen pick up.
const WORK_W = 900;

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max === 0 ? 0 : d / max, max];
}

// Binary mask of "looks like panel purple", at WORK_W scale.
function panelMask(imageData, w, h) {
  const px = imageData.data, mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
    const [hue, sat, val] = rgbToHsv(px[p], px[p + 1], px[p + 2]);
    if (hue >= PANEL_HUE_MIN && hue <= PANEL_HUE_MAX &&
        sat >= PANEL_SAT_MIN && val >= PANEL_VAL_MIN && val <= PANEL_VAL_MAX) {
      mask[i] = 1;
    }
  }
  return mask;
}

// Iterative flood fill (recursion blows the stack on full-size regions).
function components(mask, w, h, minArea) {
  const seen = new Uint8Array(w * h), out = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < mask.length; s++) {
    if (!mask[s] || seen[s]) continue;
    let sp = 0, area = 0;
    let minX = w, maxX = 0, minY = h, maxY = 0;
    stack[sp++] = s; seen[s] = 1;
    while (sp > 0) {
      const i = stack[--sp], x = i % w, y = (i / w) | 0;
      area++;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (x > 0     && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0     && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
    }
    if (area >= minArea) {
      const bw = maxX - minX + 1, bh = maxY - minY + 1;
      out.push({ x: minX, y: minY, w: bw, h: bh, area, fill: area / (bw * bh), aspect: bw / bh });
    }
  }
  return out;
}

/* Panels are ~3.0-4.2:1 and mostly solid. The header bar (team name / player)
   is far wider and thinner, and the "Moves & More" / "Stats" tab pill is wider
   still, so aspect alone separates them from real panels. */
function isPanelShaped(c, imgW, imgH) {
  if (c.aspect < 2.3 || c.aspect > 5.2) return false;
  if (c.fill < 0.55) return false;
  if (c.w < imgW * 0.18 || c.w > imgW * 0.62) return false;
  if (c.h < imgH * 0.07 || c.h > imgH * 0.32) return false;
  return true;
}

/* Recover panels that flood-filled into one blob.

   On a blurred photo the gap between two vertically adjacent cards can close,
   fusing them into a single component roughly twice a panel's height — which
   then fails the aspect test and costs two panels, not one. Panels are uniform
   in size, so a reject whose width matches the accepted ones and whose height is
   an integer multiple of theirs is a stack, and splitting it into equal bands
   recovers the originals. Only runs when fewer than six panels were found. */
function splitMerged(accepted, rejected, imgW, imgH) {
  if (accepted.length >= 6) return [];
  if (!accepted.length) return splitMergedNoReference(rejected, imgW, imgH);
  const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
  const medW = med(accepted.map(c => c.w)), medH = med(accepted.map(c => c.h));
  const out = [];
  for (const c of rejected) {
    if (Math.abs(c.w - medW) > medW * 0.25) continue;
    const n = Math.round(c.h / medH);
    if (n < 2 || n > 3) continue;
    if (Math.abs(c.h - n * medH) > medH * 0.4) continue;
    if (c.fill < 0.6) continue;
    const band = c.h / n;
    for (let k = 0; k < n; k++) {
      out.push({ x: c.x, y: Math.round(c.y + k * band), w: c.w, h: Math.round(band),
                 area: c.area / n, fill: c.fill, aspect: c.w / band, split: true });
    }
  }
  return out;
}

/* Same recovery, for a photo where EVERY panel fused with its stack-mate —
   there is no correctly-shaped survivor left to size a split against (a
   90-degree phone photo of the whole sheet: two columns, and both merge into
   one blob each, so `accepted` is empty and the sibling-comparison approach
   above has nothing to compare to).

   Without a reference panel, a lone blob's band is ambiguous: at n=2 or n=3
   the resulting band can independently satisfy isPanelShaped (a 3-stack's
   half is still shaped enough to pass), so no single blob can pick its own n.
   What is not ambiguous is the total: this function is only reached when
   fewer than six panels exist, so the true split factor is whichever n makes
   (surviving panels + newly split ones) add up to six once applied to every
   blob it fits — in practice all fused blobs in one photo merge the same way,
   so this is decided once, globally, rather than guessed per blob. */
function splitMergedNoReference(rejected, imgW, imgH) {
  const cands = rejected.filter(c =>
    c.fill >= 0.6 && c.w >= imgW * 0.18 && c.w <= imgW * 0.62);
  if (!cands.length) return [];

  let bestN = 0, bestFits = [];
  for (const n of [2, 3]) {
    const fits = cands.filter(c => {
      const band = c.h / n;
      return isPanelShaped({ w: c.w, h: band, aspect: c.w / band, fill: c.fill }, imgW, imgH);
    });
    // Prefer whichever n lands the total panel count on six; a tie (both
    // candidate blobs happen to fit both factors) falls back to more blobs
    // splitting cleanly, since that is the stronger signal of the two.
    if (Math.abs(6 - fits.length * n) < Math.abs(6 - bestFits.length * bestN) ||
        (fits.length * n === bestFits.length * bestN && fits.length > bestFits.length)) {
      bestN = n; bestFits = fits;
    }
  }
  if (!bestFits.length) return [];

  const out = [];
  for (const c of bestFits) {
    const band = c.h / bestN;
    for (let k = 0; k < bestN; k++) {
      out.push({ x: c.x, y: Math.round(c.y + k * band), w: c.w, h: Math.round(band),
                 area: c.area / bestN, fill: c.fill, aspect: c.w / band, split: true });
    }
  }
  return out;
}

/* The sheet's own bounding box, for images where it does not fill the frame.

   isPanelShaped sizes a panel against the whole image, which assumes the sheet
   fills it. A phone screenshot letterboxed with black bars breaks that: the six
   panels are found as components, correctly shaped relative to each other, and
   every one is thrown out for being under 7% of the frame's height when it is
   27% of the sheet's. Re-measuring against the content instead of the frame
   costs nothing on an image that already fills its frame, because then the box
   is the frame. */
function contentBox(all, w, h) {
  // Only components large enough to be sheet furniture; a speck of glare in a
  // corner would otherwise stretch the box back out to the whole frame.
  const big = all.filter(c => c.w >= w * 0.10 && c.h >= h * 0.01);
  if (big.length < 3) return null;
  const x0 = Math.min(...big.map(c => c.x)), y0 = Math.min(...big.map(c => c.y));
  const x1 = Math.max(...big.map(c => c.x + c.w)), y1 = Math.max(...big.map(c => c.y + c.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* More shaped candidates than there are panels.

   A sheet carries other purple furniture — the "Moves & More" / "Stats" tab
   pill, an "Add a Mon" bar — and on one photo a pill landed inside the aspect
   and fill bounds and became a seventh panel, which failed the whole import
   because the pipeline wants exactly six. The six real panels are near-identical
   in size and the intruders are not (231x53 against a median 390x120), so
   keeping the six closest to the median size discards the furniture without
   needing to know what it was. */
function pickSix(cands) {
  if (cands.length <= 6) return cands;
  const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
  const mw = med(cands.map(c => c.w)), mh = med(cands.map(c => c.h));
  const off = c => Math.abs(c.w - mw) / mw + Math.abs(c.h - mh) / mh;
  return cands.slice().sort((a, b) => off(a) - off(b)).slice(0, 6);
}

/* Keep the six panels forming the 3x2 grid. Photos are keystoned, so rows are
   found by clustering on vertical center with a generous tolerance rather than
   by assuming equal spacing. */
function pickGrid(cands, imgH) {
  cands.sort((a, b) => (a.y + a.h / 2) - (b.y + b.h / 2));
  const rows = [], tol = imgH * 0.06;
  for (const c of cands) {
    const cy = c.y + c.h / 2;
    const row = rows.find(r => Math.abs(r.cy - cy) < tol);
    if (row) { row.items.push(c); row.cy = (row.cy * (row.items.length - 1) + cy) / row.items.length; }
    else rows.push({ cy, items: [c] });
  }
  rows.forEach(r => r.items.sort((a, b) => a.x - b.x));
  // Slot order on the sheet is column-major within a row: 1 2 / 3 4 / 5 6.
  const out = [];
  rows.forEach(r => r.items.forEach(it => out.push(it)));
  return { panels: out, rows: rows.length };
}

// scale = source px per work px, so callers can crop from the full-res original.
function segmentPanels(canvas, opts) {
  opts = opts || {};
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const w = canvas.width, h = canvas.height;
  const data = ctx.getImageData(0, 0, w, h);
  /* No morphological close. One was tried here to stop text and icons
     fragmenting a panel, and it is the reason segmentation once scored 0/9: at
     WORK_W the mask already comes out 85-92% solid (glyphs antialias into the
     purple), while a radius as small as 2 bridges the ~12px gutter between
     panels and flood-fills an entire column into one blob. Removing it took the
     suite to 9/9. Do not reintroduce it. */
  const mask = panelMask(data, w, h);
  let maskCoverage = 0;
  for (let i = 0; i < mask.length; i++) maskCoverage += mask[i];
  /* A letterboxed capture needs a smaller area floor to find its panels at all,
     so the flood fill keeps anything a panel could plausibly be and the shape
     test below does the discarding. */
  const all = components(mask, w, h, (w * h) * 0.0012);
  let refW = w, refH = h;
  let cands = all.filter(c => isPanelShaped(c, w, h));

  /* Nothing shaped like a panel against the frame, but the sheet may simply not
     fill the frame. Re-test against the content's own box, and keep the result
     only if it actually finds more — so an image that fills its frame, where the
     box IS the frame, is unaffected. */
  if (cands.length < 6) {
    const box = contentBox(all, w, h);
    if (box && (box.w < w * 0.92 || box.h < h * 0.92)) {
      const alt = all.filter(c => isPanelShaped(c, box.w, box.h));
      if (alt.length > cands.length) { cands = alt; refW = box.w; refH = box.h; }
    }
  }

  const recovered = splitMerged(cands, all.filter(c => !isPanelShaped(c, refW, refH)), refW, refH);
  if (recovered.length) cands = cands.concat(recovered);
  const grid = pickGrid(pickSix(cands), refH);
  return {
    panels: grid.panels, rows: grid.rows, candidates: cands.length,
    debug: { maskFrac: +(maskCoverage / (w * h)).toFixed(3), all },
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { segmentPanels, rgbToHsv };
