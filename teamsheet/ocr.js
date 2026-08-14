/* ============================================================================
   Text extraction from a teamsheet image (teamsheet/ocr.js)

   Reads nickname, ability, item and the four moves out of each panel. Species
   is NOT read here — it comes from the type icons, which are far more reliable
   than glyphs on a photographed screen (see species.js).

   Every field except the nickname is matched against a closed vocabulary, and
   that is what makes this usable at all: the raw OCR only has to get close.
   An ability is one of at most three the identified species can have; a move is
   one of ~60 in its learnset. "Ciose Combal" resolves to Close Combat because
   there is nothing else it could plausibly be.

   tesseract.js is lazy-loaded from jsdelivr on first use — about 3MB including
   the language data, so it must never load as part of the admin page's normal
   startup.
   ============================================================================ */

window.TeamsheetOCR = (function () {

  const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  let workerPromise = null;
  let poolPromise = null;

  /* Recognition cost is per LINE of text, not per call or per pixel: a sheet is
     36 short lines at ~20ms each. Batching them into one image left the total
     unchanged (773ms vs 764ms) and dropping the upscale from 3x to 2x saved only
     15%, because neither reduces the line count. Splitting the lines across
     workers does. Capped at 4 — beyond that the per-worker language-data load
     costs more than the parallelism returns, and the pool is created once and
     reused for every later import. */
  const POOL_SIZE = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4)));

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (window.Tesseract) return resolve();
      const el = document.createElement('script');
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error('Could not load the text-recognition library.'));
      document.head.appendChild(el);
    });
  }

  async function getWorker(onProgress) {
    if (!workerPromise) {
      workerPromise = (async () => {
        if (onProgress) onProgress('Loading text recognition…');
        await loadScript(TESSERACT_URL);
        const worker = await Tesseract.createWorker('eng');
        // Every region is one short line of a known-ish phrase; single-line mode
        // stops Tesseract trying to infer paragraph structure from one row.
        await worker.setParameters({
          tessedit_pageseg_mode: '7',
          tessedit_char_whitelist:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '-.:",
        });
        return worker;
      })();
    }
    return workerPromise;
  }

  /* Panel-relative crop windows, measured off the fixture contact sheets.
     The moves column is four evenly spaced rows down the right-hand side. */
  const FIELD_WIN = {
    /* Nickname starts further right than the other rows: the mon's icon
       overhangs the panel's top-left corner, and including its edge made
       Tesseract emit leading junk — "- shogun", ". Moley Cyrus", "EE Swampass".
       0.115 was too far: it clipped the first letter instead ("uff daddy",
       "isc Kitten", and "#1TripFan" lost its #). 0.10 keeps the glyph and lets
       cleanNickname() below deal with whatever sliver still bleeds in.
       It also runs wider, because long names were being clipped ("DEEZ RETURN:"),
       stopping just short of the right-aligned type icons. */
    nickname: { x0: 0.100, x1: 0.415, y0: 0.02, y1: 0.28 },
    ability:  { x0: 0.08, x1: 0.44, y0: 0.30, y1: 0.50 },
    item:     { x0: 0.11, x1: 0.50, y0: 0.52, y1: 0.75 },
  };
  const MOVE_X = { x0: 0.645, x1: 1.0 };
  const MOVE_Y0 = 0.095, MOVE_STEP = 0.2367, MOVE_H = 0.16;

  function moveWin(k) {
    return { x0: MOVE_X.x0, x1: MOVE_X.x1, y0: MOVE_Y0 + k * MOVE_STEP, y1: MOVE_Y0 + k * MOVE_STEP + MOVE_H };
  }

  /* Crop, upscale and binarise one region.

     Sheet text is near-white on mid-tone purple, which Tesseract handles poorly
     as-is: it expects dark glyphs on light ground. Thresholding on luminance and
     inverting gives it black-on-white. The threshold is relative to the region's
     own range so a washed-out photo binarises the same as a clean capture. */
  const OCR_SCALE = 2.5;

  function cropForOcr(img, panel, scale, win) {
    const px = panel.x / scale, py = panel.y / scale;
    const pw = panel.w / scale, ph = panel.h / scale;
    const sx = px + win.x0 * pw, sy = py + win.y0 * ph;
    const sw = (win.x1 - win.x0) * pw, sh = (win.y1 - win.y0) * ph;

    const cv = document.createElement('canvas');
    cv.width = Math.max(8, Math.round(sw * OCR_SCALE));
    cv.height = Math.max(8, Math.round(sh * OCR_SCALE));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, cv.width, cv.height);

    const d = ctx.getImageData(0, 0, cv.width, cv.height);
    const px2 = d.data;
    let lo = 255, hi = 0;
    const lum = new Float32Array(cv.width * cv.height);
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
      const v = 0.299 * px2[p] + 0.587 * px2[p + 1] + 0.114 * px2[p + 2];
      lum[i] = v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    // Text is the brightest content present; sit the cut high in the range so
    // the lavender panel body falls entirely on the background side.
    const cut = lo + (hi - lo) * 0.62;
    for (let i = 0, p = 0; i < lum.length; i++, p += 4) {
      const on = lum[i] >= cut ? 0 : 255;   // inverted: glyphs become black
      px2[p] = px2[p + 1] = px2[p + 2] = on;
      px2[p + 3] = 255;
    }
    ctx.putImageData(d, 0, 0);
    return cv;
  }

  // ---- fuzzy matching against a closed vocabulary ---------------------------

  function editDistance(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[n];
  }

  /* Best vocabulary entry for a raw OCR string, or null when nothing is close.
     The tolerance scales with length — a 20-character move name can absorb more
     misreads than a 4-character one before the match stops being meaningful. */
  function bestMatch(raw, vocabulary) {
    const key = tsNorm(raw);
    if (!key || !vocabulary.length) return null;
    let best = null, bestD = Infinity;
    for (const word of vocabulary) {
      const d = editDistance(key, tsNorm(word));
      if (d < bestD) { bestD = d; best = word; }
      if (d === 0) break;
    }
    const tolerance = Math.max(2, Math.floor(key.length * 0.34));
    return bestD <= tolerance ? { value: best, distance: bestD, exact: bestD === 0 } : null;
  }

  /* Batched recognition.

     Stacking the regions into one canvas was tried as a speed fix and is not
     one: 42 calls took 764ms and one batched call took 773ms, because Tesseract
     costs roughly 20ms per LINE of text regardless of how the lines are
     delivered. It is kept because it measurably improved ACCURACY — moves went
     from 93% to 97%, as surrounding context helps the LSTM — and because it is
     what makes splitting the work across a worker pool straightforward.

     Rows are laid out at known y offsets and results are mapped back by each
     line's vertical centre, not by order: a region that reads as blank produces
     no line at all, and positional mapping would shift every later field up. */
  const ROW_PAD = 14;

  function stackRegions(canvases) {
    const width = Math.max(...canvases.map(c => c.width)) + ROW_PAD * 2;
    const rows = [];
    let y = ROW_PAD;
    for (const c of canvases) {
      rows.push({ y0: y, y1: y + c.height, mid: y + c.height / 2 });
      y += c.height + ROW_PAD;
    }
    const out = document.createElement('canvas');
    out.width = width;
    out.height = y + ROW_PAD;
    const ctx = out.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    canvases.forEach((c, i) => ctx.drawImage(c, ROW_PAD, rows[i].y0));
    return { canvas: out, rows };
  }

  async function getPool(onProgress) {
    if (!poolPromise) {
      poolPromise = (async () => {
        const first = await getWorker(onProgress);
        if (POOL_SIZE < 2) return [first];
        const extra = await Promise.all(
          Array.from({ length: POOL_SIZE - 1 }, async () => {
            const w = await Tesseract.createWorker('eng');
            await w.setParameters({
              tessedit_pageseg_mode: '6',
              tessedit_char_whitelist:
                "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '-.:",
            });
            return w;
          })
        );
        return [first].concat(extra);
      })();
    }
    return poolPromise;
  }

  // Split the regions across the pool and recognise the chunks concurrently.
  async function recognizeMany(canvases, onProgress, charset, extraParams) {
    const pool = await getPool(onProgress);
    if (pool.length < 2 || canvases.length < 4) {
      return recognizeStack(pool[0], canvases, charset, extraParams);
    }
    const per = Math.ceil(canvases.length / pool.length);
    const chunks = [];
    for (let i = 0; i < canvases.length; i += per) chunks.push(canvases.slice(i, i + per));
    const parts = await Promise.all(chunks.map((c, i) => recognizeStack(pool[i], c, charset, extraParams)));
    return [].concat.apply([], parts);
  }

  const FIELD_CHARS =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '-.:";

  async function recognizeStack(worker, canvases, charset, extraParams) {
    const { canvas, rows } = stackRegions(canvases);
    // Uniform block, so Tesseract treats each stacked crop as its own line.
    await worker.setParameters(Object.assign({
      tessedit_pageseg_mode: '6',
      tessedit_char_whitelist: charset || FIELD_CHARS,
    }, extraParams || {}));
    const { data } = await worker.recognize(canvas, {}, { blocks: true });

    const lines = [];
    (data.blocks || []).forEach(b => (b.paragraphs || []).forEach(par =>
      (par.lines || []).forEach(l => lines.push(l))));

    const out = new Array(canvases.length).fill('');
    for (const line of lines) {
      const text = (line.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const mid = (line.bbox.y0 + line.bbox.y1) / 2;
      let bestI = -1, bestD = Infinity;
      rows.forEach((r, i) => {
        const d = Math.abs(r.mid - mid);
        if (d < bestD) { bestD = d; bestI = i; }
      });
      // Only accept a line that actually falls within its row's band.
      if (bestI >= 0 && mid >= rows[bestI].y0 - ROW_PAD && mid <= rows[bestI].y1 + ROW_PAD) {
        out[bestI] = out[bestI] ? out[bestI] + ' ' + text : text;
      }
    }
    return out;
  }

  /* Abilities are read FIRST and against the whole roster's abilities, not one
     mon's, because the caller uses them to decide the species. Narrowing the
     vocabulary to whatever the icons guessed creates a cascade: on one fixture
     Tesseract read "Speed Boost" perfectly, but the icons had mis-set that slot
     to Blastoise, so the only permitted answers were Torrent and Rain Dish and
     a correct read was thrown away. */
  async function readAbilities(img, panels, scale, rosterAbilities, onProgress) {
    if (onProgress) onProgress('Reading abilities…');
    const crops = panels.map(p => cropForOcr(img, p, scale, FIELD_WIN.ability));
    const texts = await recognizeMany(crops, onProgress);
    return texts.map(raw => {
      const m = bestMatch(raw, rosterAbilities);
      return { ability: m ? m.value : null, raw };
    });
  }

  /* Everything else, once the species is settled. `vocabFor(i)` can now safely
     narrow moves to that mon's learnset — a ~60-word dictionary instead of 937,
     which is what makes a smudged move name resolvable. */
  async function readDetails(img, panels, scale, vocabFor, onProgress) {
    if (onProgress) onProgress('Reading sheet text…');

    // One stack for the whole sheet: 36 regions, one recognise call.
    /* Nicknames are recognised separately from everything else because they need
       different character rules. Items, abilities and moves come from closed
       vocabularies, so a tight whitelist helps them; nicknames are player-chosen
       free text, and that same whitelist was silently deleting real characters —
       "#1TripFan" lost its #, "PlayW/MyWyrm" its slash, "Pika-WHY?1?" its
       question marks. */
    const nickCrops = panels.map(p => cropForOcr(img, p, scale, FIELD_WIN.nickname));
    const fieldCrops = [];
    panels.forEach(p => {
      fieldCrops.push(cropForOcr(img, p, scale, FIELD_WIN.item));
      for (let k = 0; k < 4; k++) fieldCrops.push(cropForOcr(img, p, scale, moveWin(k)));
    });

    const [nicks, texts] = await Promise.all([
      recognizeMany(nickCrops, onProgress, NICK_CHARS),
      recognizeMany(fieldCrops, onProgress),
    ]);

    return panels.map((p, i) => {
      const base = i * 5;
      const vocab = vocabFor(i);
      const out = { nickname: null, item: null, moves: [], raw: {} };

      out.raw.nickname = nicks[i];
      out.nickname = cleanNickname(nicks[i]);

      out.raw.item = texts[base];
      const it = bestMatch(out.raw.item, vocab.items);
      out.item = it ? it.value : null;

      out.raw.moves = [];
      for (let k = 0; k < 4; k++) {
        const rawMove = texts[base + 1 + k];
        out.raw.moves.push(rawMove);
        /* Narrow to the species' learnset first — that is what turns a smudged
           read into a confident answer. But fall back to the full move list when
           nothing fits, because the dex's learnsets have holes: Meowstic-M
           genuinely learns Imprison and pokemon.json omits it, so a correctly
           read move was being dropped for failing a check that was itself wrong.
           A real move matched loosely beats no move at all. */
        const mv = bestMatch(rawMove, vocab.moves) ||
                   bestMatch(rawMove, vocab.allMoves || vocab.moves);
        if (mv) out.moves.push(mv.value);
      }
      return out;
    });
  }

  /* Tried and rejected: disabling Tesseract's English dictionaries for this
     pass (load_system_dawg/load_freq_dawg = 0), on the theory that word bias was
     suppressing the punctuation players use. Measured identical — 86% either
     way, with the same five misses and the same lost glyphs. The dictionary is
     not what drops "/" from PlayW/MyWyrm or "#" from #1TripFan; the recogniser
     simply does not emit those shapes at this resolution. Widening the
     whitelist stopped them being deleted, but permitting a glyph does not make
     Tesseract predict it. */

  // Wide enough for the punctuation players actually use in nicknames.
  const NICK_CHARS =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 '\"!?#&*+/\\-.:_()[]";

  /* Strip leading debris left by the icon bleeding into the crop.

     Even with the window moved right, a sliver of sprite occasionally reads as a
     stray glyph or two before the name. Only isolated leading junk is removed —
     a short run of punctuation, or one or two stray letters followed by a space
     and a capital — so a legitimate "#1TripFan" or "-Pelippular" survives while
     ". Moley Cyrus" and "EE Swampass" do not. */
  function cleanNickname(raw) {
    let s = String(raw || '').trim();
    if (!s) return null;
    s = s.replace(/^[^A-Za-z0-9#@!?'"(\[]+/, '');       // leading punctuation run
    s = s.replace(/^(?:[A-Za-z]{1,3}[.,:;]|[A-Z]{2,3})\s+(?=[A-Z0-9#])/, '');
    s = s.replace(/[\s.,:;]+$/, '');
    return s.trim() || null;
  }

  return { readAbilities, readDetails, bestMatch, cropForOcr, FIELD_WIN, moveWin };
})();
