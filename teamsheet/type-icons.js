/* ============================================================================
   Type-icon extraction (tools/teamsheet/type-icons.js)

   Each panel header carries a right-aligned row of small square icons:
   [gender?] [type1] [type2?]. Measured across the ground-truth fixtures, the
   type pair alone uniquely identifies the mon in 54/54 slots given a 10-mon
   roster — so these icons, not the sprite, are the primary species signal.

   They are also the easiest thing on the sheet to read: flat blocks of solid
   color at a fixed position, with no fine detail to lose. That is what makes
   them survive the moire, keystone and JPEG artifacts that defeated silhouette
   matching on photographed screens.
   ============================================================================ */

// Panel-relative window holding the icon row. Right edge stops short of the
// moves column, whose move-type icons look just like icons.
const TYPE_ICON_WIN = { x0: 0.34, x1: 0.58, y0: 0.02, y1: 0.30 };
const TYPE_ICON_STRIP_W = 320;   // working width; icons land around 40px square here

function typeIconStripCanvas(img, panel, scale) {
  const px = panel.x / scale, py = panel.y / scale;
  const pw = panel.w / scale, ph = panel.h / scale;
  const sw = (TYPE_ICON_WIN.x1 - TYPE_ICON_WIN.x0) * pw, sh = (TYPE_ICON_WIN.y1 - TYPE_ICON_WIN.y0) * ph;
  const h = Math.max(8, Math.round(TYPE_ICON_STRIP_W * sh / sw));
  const cv = document.createElement('canvas');
  cv.width = TYPE_ICON_STRIP_W; cv.height = h;
  cv.getContext('2d', { willReadFrequently: true })
    .drawImage(img, px + TYPE_ICON_WIN.x0 * pw, py + TYPE_ICON_WIN.y0 * ph, sw, sh, 0, 0, cv.width, h);
  return cv;
}

/* Type icons are found as blocks that differ from the header's purple, NOT by
   saturation: the Normal-type icon is grey and the Steel/Ice icons are pale,
   so a saturation threshold silently drops them. The background is estimated
   as the strip's modal color, which is safe because the header pill is by far
   the largest flat region in the window. */
function extractTypeIcons(img, panel, scale) {
  const cv = typeIconStripCanvas(img, panel, scale);
  const w = cv.width, h = cv.height;
  const data = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;

  const bucket = new Map();
  const key = (r, g, b) => ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
  for (let p = 0; p < data.length; p += 4) {
    const k = key(data[p], data[p + 1], data[p + 2]);
    bucket.set(k, (bucket.get(k) || 0) + 1);
  }
  let bgKey = 0, bgN = -1;
  for (const [k, n] of bucket) if (n > bgN) { bgN = n; bgKey = k; }
  const bg = [((bgKey >> 8) & 15) * 16 + 8, ((bgKey >> 4) & 15) * 16 + 8, (bgKey & 15) * 16 + 8];

  /* Do not lower this to try to rescue washed-out photos. Measured: at 42 the
     icons merge into each other and into the header shading, every blob fails
     the shape filter below, and detection collapses from 39/54 slots to 4/54.
     The failure mode here is fusion, not omission. */
  const fg = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < fg.length; i++, p += 4) {
    const d = Math.abs(data[p] - bg[0]) + Math.abs(data[p + 1] - bg[1]) + Math.abs(data[p + 2] - bg[2]);
    if (d > 70) fg[i] = 1;
  }

  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h), out = [];
  for (let s = 0; s < fg.length; s++) {
    if (!fg[s] || seen[s]) continue;
    let sp = 0, area = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    const members = [];
    stack[sp++] = s; seen[s] = 1;
    while (sp > 0) {
      const i = stack[--sp], x = i % w, y = (i / w) | 0;
      area++; members.push(i);
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0     && fg[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && fg[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0     && fg[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
      if (y < h - 1 && fg[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    // Type icons are near-square and occupy most of the strip's height; nickname
    // glyphs bleeding in from the left are smaller and the wrong shape.
    if (bh < h * 0.45 || bh > h * 1.02) continue;
    if (bw / bh < 0.65 || bw / bh > 1.5) continue;
    if (area < bw * bh * 0.5) continue;

    /* Icon color = median of its pixels after dropping the glyph. The glyph is
       near-white or near-black and would drag a mean toward grey; a median over
       the remaining body is stable even when the icon is only ~20px across. */
    const rs = [], gs = [], bs = [];
    for (const i of members) {
      const p = i * 4, R = data[p], G = data[p + 1], B = data[p + 2];
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      if (mx > 235 && mn > 200) continue;      // glyph highlight
      if (mx < 45) continue;                   // glyph shadow / outline
      rs.push(R); gs.push(G); bs.push(B);
    }
    if (rs.length < 12) continue;
    const med = a => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
    out.push({ x: x0, w: bw, h: bh, color: [med(rs), med(gs), med(bs)] });
  }
  out.sort((a, b) => a.x - b.x);
  return out;
}

/* Rejected alternative: sampling fixed positions instead of finding blobs.

   The icon row is right-aligned and evenly spaced, so reading a patch at each
   predicted center looked immune to the blur that costs blob detection its
   icons on photographed screens. Measured, it is worse — 16/54 slots against
   39/54 — because the predicted centers are not stable: keystone shifts the
   whole header, moving icon centers by 15px+ between fixtures, and the patches
   land between icons and return header purple. Detection has to follow the
   icons rather than assume where they are. */

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TYPE_ICON_WIN, extractTypeIcons };
}
