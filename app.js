/* ================================================================
   KDPEasy A+ Image Fitter — app.js
   Single classic script, IIFE-wrapped. No modules, no fetch, no CDN:
   everything must run by double-clicking index.html over file://.

   Based on KDPEasy Margin Fixer. What is the same: image loading with
   EXIF handling, the stepped (high-quality) downscale, border analysis,
   Auto/White/Solid/Blur fill, busy state, "Saved!" toast, click-to-open
   tooltips. What is different: sizes come from presets.js (A+ image
   slots, in pixels), cropping is allowed (Fill the frame), output size
   is Sharp/Minimum, the file must stay under KDP's 3 MB limit, and
   several slots can be exported together as a ZIP.

   The only things this tool does to a picture: scale it, crop it, and
   place it on a background. It never redraws or AI-modifies anything.
   ================================================================ */
(function () {
  'use strict';

  /* ---- 1. CONSTANTS & PRESETS ---- */

  var DPI = 300;                       // KDP asks for 300 DPI (written into the file)
  var SHARP_FACTOR = 2;                // "Sharp" = 2x KDP's minimum size

  // KDP says "JPG or PNG, max 3 MB". 2.9 MB (counted as 2,900,000 bytes, which
  // is stricter than either way of counting a "MB") is the safe line we aim under.
  var MAX_FILE_BYTES = 2.9 * 1000 * 1000;
  var KDP_LIMIT_TEXT = '3 MB';

  // JPG quality tried in this order until the file fits under MAX_FILE_BYTES.
  var JPEG_QUALITIES = [0.92, 0.88, 0.84, 0.80, 0.75];

  var ZOOM_MIN = 1;                    // 100% = the biggest frame that fits inside the picture
  var ZOOM_MAX = 4;
  var VARIANCE_THRESHOLD = 900;        // ~30 std-dev per channel (border analysis)
  var NEAR_WHITE_CUTOFF = 250;         // per channel
  var WORK_LONG_EDGE = 1000;           // border-analysis working copy cap
  var BIG_FILE_BYTES = 50 * 1024 * 1024;
  var SIZE_DEBOUNCE_MS = 350;          // wait this long after a change before measuring file size
  var WIDE_FRAME_RATIO = 1.8;          // frames wider than this stack the two previews vertically

  var UNCONFIRMED_TEXT = "We have not double-checked this size in KDP's editor yet. Tell us if it is different.";

  var MODE_HINTS = {
    fill: 'Your picture covers the whole frame. Drag the frame in the preview to choose what stays — the dimmed edges are cut off. KDP crops to the slot shape anyway.',
    fit:  'Your whole picture stays visible. The leftover space around it is filled in.'
  };

  var FILL_HINTS = {
    auto:  'Looks at the edge of your picture and chooses White, Solid, or Blur.',
    white: 'Clean white space. Best for line art and drawings on white.',
    solid: 'Fills with the average color from your picture’s edge.',
    blur:  'Stretches and blurs your picture behind itself. Best for full-color art.'
  };

  var SIZE_HINTS = {
    sharp: 'Twice KDP’s minimum, so it stays crisp. If your picture can’t fill that without stretching, we use the biggest size it can (never below the minimum).',
    min:   'Exactly KDP’s minimum size. The smallest file.'
  };

  var FORMAT_HINTS = {
    auto: 'PNG when it fits under KDP’s ' + KDP_LIMIT_TEXT + ' limit, otherwise a high-quality JPG.',
    png:  'Sharpest, but a detailed picture can go over KDP’s ' + KDP_LIMIT_TEXT + ' limit.',
    jpg:  'Smaller files. We only lower the quality as far as needed to stay under ' + KDP_LIMIT_TEXT + '.'
  };

  // The module list lives in presets.js so it can be fixed without touching this
  // file. Anything malformed is skipped rather than breaking the whole tool.
  var PRESETS = sanitizePresets(window.APLUS_PRESETS);

  function sanitizePresets(list) {
    var out = [];
    if (!Array.isArray(list)) return out;
    list.forEach(function (p, pi) {
      if (!p || typeof p.name !== 'string' || !Array.isArray(p.slots)) return;
      var slots = [];
      p.slots.forEach(function (s, si) {
        var w = Math.round(Number(s && s.w)), h = Math.round(Number(s && s.h));
        if (!(w > 0) || !(h > 0)) return;
        slots.push({
          slug:  String((s.slug || ('image-' + (si + 1)))).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
          label: String(s.label || ('Image ' + (si + 1))),
          w: w, h: h
        });
      });
      if (!slots.length) return;
      out.push({
        slug:  String((p.slug || ('module-' + (pi + 1)))).toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
        name:  p.name,
        confirmed: p.confirmed === true,
        note:  typeof p.note === 'string' ? p.note : '',
        slots: slots
      });
    });
    return out;
  }

  /* ---- 2. STATE ---- */

  var state = {
    presetIndex: 0,
    slots: [],              // one entry per image slot of the chosen module (see makeSlot)
    active: 0,              // which slot the preview shows
    pickSlot: 0,            // which slot the file picker is loading into
    mode: 'fill',           // 'fill' (cover + crop) | 'fit' (whole picture + background)
    fill: 'auto',           // Fit mode only: auto | white | solid | blur
    customSolidColor: null, // hex string when the user picked their own color
    size: 'sharp',          // 'sharp' | 'min'
    format: 'auto',         // 'auto' | 'png' | 'jpg'
    pendingBig: null,
    rendering: false
  };

  var imgCounter = 0;      // gives every loaded picture its own id (used in cache keys)
  var el = {};             // cached DOM references, filled in section 11
  var previewRaf = 0;
  var cropRaf = 0;
  var sizeTimer = 0;
  var sizeJob = 0;         // bumped to cancel an in-flight file-size job
  var resizeDebounce = 0;
  var toastTimer = 0;

  function makeSlot(def) {
    return {
      def: def,            // { slug, label, w, h } from presets.js
      source: null,        // upright, opaque (white-flattened) canvas of the picture
      fileName: '', fileSize: 0, hasAlpha: false,
      imgId: 0,
      analysis: null,      // border analysis, cached per picture
      pyramid: null,       // cached half-size copies for stepped downscaling
      cx: 0, cy: 0,        // Fill mode: centre of the crop frame, in source pixels
      zoom: 1,             // Fill mode: 1 = biggest frame, 2 = frame half as wide
      encoded: null,       // last finished file { key, type, bytes, ... }
      pending: null,       // file being made right now { key, promise }
      ui: null,            // DOM nodes of this slot's row in Step 2
      thumbId: -1
    };
  }

  function activeSlot() { return state.slots[state.active]; }
  function currentPreset() { return PRESETS[state.presetIndex]; }
  function hasSource(slot) { return !!slot.source; }
  function anySource() { return state.slots.some(hasSource); }

  /* -- small helpers -- */

  function $(id) { return document.getElementById(id); }

  function newCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  function smooth(ctx) {
    ctx.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
  }

  // Fill-white-first: every surface the picture is drawn on starts white, so a
  // transparent PNG never carries alpha (or black) into analysis or export.
  function whiteCtx(canvas) {
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    smooth(ctx);
    return ctx;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function gcd(a, b) {
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }

  // File sizes are shown the same way we count them against the limit (1 MB = 1,000,000 bytes).
  function fmtBytes(b) {
    if (b < 1000 * 1000) return Math.max(1, Math.round(b / 1000)) + ' KB';
    return (b / (1000 * 1000)).toFixed(2) + ' MB';
  }

  function bytesToMB(b) { return (b / (1024 * 1024)).toFixed(1); }

  function toHex(n) {
    var s = Math.max(0, Math.min(255, Math.round(n))).toString(16);
    return s.length === 1 ? '0' + s : s;
  }

  function px(w, h) { return w + ' × ' + h + ' px'; }

  function typeLabel(t) { return t === 'jpg' ? 'JPG' : 'PNG'; }

  /* ---- 3. EXIF ORIENTATION ---- */

  // Minimal EXIF reader: finds tag 0x0112 (Orientation) in IFD0. Returns 1..8,
  // defaulting to 1 for PNGs, EXIF-less JPEGs and anything unparseable.
  function readOrientation(buf) {
    var view = new DataView(buf);
    var len = view.byteLength;
    if (len < 4 || view.getUint16(0, false) !== 0xFFD8) return 1;   // not a JPEG

    var offset = 2;
    while (offset + 4 <= len) {
      var marker = view.getUint16(offset, false);
      if ((marker & 0xFF00) !== 0xFF00) break;
      if (marker === 0xFFD8 || (marker >= 0xFFD0 && marker <= 0xFFD9)) { offset += 2; continue; }
      offset += 2;
      var size = view.getUint16(offset, false);
      if (marker === 0xFFE1) {
        if (offset + 10 > len) break;
        if (view.getUint32(offset + 2, false) !== 0x45786966) {      // "Exif"
          offset += size; continue;
        }
        var tiff = offset + 8;                                       // skip "Exif\0\0"
        if (tiff + 8 > len) return 1;
        var little = view.getUint16(tiff, false) === 0x4949;         // "II" / "MM"
        var dir = tiff + view.getUint32(tiff + 4, little);
        if (dir + 2 > len) return 1;
        var count = view.getUint16(dir, little);
        for (var i = 0; i < count; i++) {
          var entry = dir + 2 + i * 12;
          if (entry + 12 > len) break;
          if (view.getUint16(entry, little) === 0x0112) {
            var v = view.getUint16(entry + 8, little);
            return (v >= 1 && v <= 8) ? v : 1;
          }
        }
        return 1;
      }
      if (marker === 0xFFDA) break;                                  // start of scan
      offset += size;
    }
    return 1;
  }

  // Produces the upright source canvas. For 5-8 width/height are swapped.
  function applyOrientation(img, w, h, o) {
    var swap = (o >= 5 && o <= 8);
    var canvas = newCanvas(swap ? h : w, swap ? w : h);
    var ctx = whiteCtx(canvas);
    switch (o) {
      case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;               // flip horizontal
      case 3: ctx.transform(-1, 0, 0, -1, w, h); break;              // rotate 180
      case 4: ctx.transform(1, 0, 0, -1, 0, h); break;               // flip vertical
      case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;                // transpose
      case 6: ctx.transform(0, 1, -1, 0, h, 0); break;               // rotate 90 CW
      case 7: ctx.transform(0, -1, -1, 0, h, w); break;              // transverse
      case 8: ctx.transform(0, -1, 1, 0, 0, w); break;               // rotate 270 CW
      default: break;                                                // 1: none
    }
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
  }

  /* ---- 4. IMAGE LOADING ---- */

  function isSupportedType(file) {
    if (file.type === 'image/png' || file.type === 'image/jpeg') return true;
    return /\.(png|jpe?g)$/i.test(file.name || '');
  }

  function isPngFile(file) {
    return file.type === 'image/png' || /\.png$/i.test(file.name || '');
  }

  // Does this PNG have see-through areas? Only used for a friendly note: the
  // tool flattens transparency onto white, exactly like Margin Fixer.
  function detectAlpha(img, w, h) {
    try {
      var s = Math.min(1, 256 / Math.max(w, h));
      var c = newCanvas(w * s, h * s);
      var ctx = c.getContext('2d');          // NOT whiteCtx: we want to see the alpha
      ctx.drawImage(img, 0, 0, c.width, c.height);
      var d = ctx.getImageData(0, 0, c.width, c.height).data;
      for (var i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    } catch (e) { /* unreadable: just say no */ }
    return false;
  }

  // Loads dropped/picked files into slots, one after the other.
  // startIndex = the slot the first file goes into; more files fill the next slots.
  function handleFiles(list, startIndex) {
    if (!list || !list.length) return;
    var items = [];
    var notice = '';
    Array.prototype.forEach.call(list, function (file, j) {
      var idx = startIndex + j;
      if (idx >= state.slots.length) {
        notice = 'This module has ' + state.slots.length + (state.slots.length === 1 ? ' image slot' : ' image slots') +
                 ', so the extra pictures were skipped.';
        return;
      }
      if (!isSupportedType(file)) {
        notice = "That file type isn't supported. Please use a PNG or JPG image.";
        return;
      }
      items.push({ file: file, index: idx });
    });

    var big = items.filter(function (it) { return it.file.size > BIG_FILE_BYTES; });
    var normal = items.filter(function (it) { return it.file.size <= BIG_FILE_BYTES; });
    if (!normal.length && !big.length) {
      if (notice) showBanner(notice);
      return;
    }

    loadItems(normal).then(function (failures) {
      if (big.length) {
        state.pendingBig = big;
        showBanner('That image is very large (' + bytesToMB(big[0].file.size) +
                   ' MB) and may be slow to process. Continue anyway?', 'Continue', function () {
          var queue = state.pendingBig;
          state.pendingBig = null;
          if (queue) loadItems(queue);
        });
      } else if (notice && !failures) {
        showBanner(notice);
      }
    });
  }

  // Decodes the items in order and then updates the whole UI once.
  // Resolves with the number of files that could not be opened.
  function loadItems(items) {
    var failures = 0;
    var loaded = [];
    var wasEmpty = {};
    items.forEach(function (it) {
      var s = state.slots[it.index];
      wasEmpty[it.index] = !!s && !s.source;
    });

    var chain = Promise.resolve();
    items.forEach(function (it) {
      chain = chain.then(function () {
        return decodeUpright(it.file).then(function (canvas) {
          var slot = state.slots[it.index];
          if (!slot) return;                   // the module was changed while decoding
          setSlotImage(slot, canvas, it.file);
          loaded.push(it.index);
        }, function () {
          failures++;
          showBanner("We couldn't open that image. It may be damaged — try re-saving it and uploading again.");
        });
      });
    });

    return chain.then(function () {
      if (loaded.length) {
        if (!failures) el.bannerHost.innerHTML = '';
        if (loaded.length === 1) {
          // One picture into an empty slot: move on to the next empty slot, if any.
          var i = loaded[0];
          var next = -1;
          if (wasEmpty[i]) {
            for (var k = i + 1; k < state.slots.length; k++) {
              if (!state.slots[k].source) { next = k; break; }
            }
          }
          state.active = next >= 0 ? next : i;
        } else {
          state.active = loaded[0];
        }
        refreshAll();
      }
      return failures;
    });
  }

  function setSlotImage(slot, canvas, file) {
    // A solid color picked for an old picture would be stale (only when this is the only picture).
    var others = state.slots.some(function (s) { return s !== slot && s.source; });
    if (!others) state.customSolidColor = null;

    slot.source = canvas;
    slot.fileName = file.name || 'image.png';
    slot.fileSize = file.size;
    slot.hasAlpha = !!canvas.hasAlpha;
    slot.imgId = ++imgCounter;
    slot.analysis = null;                    // caches are per picture
    slot.pyramid = null;
    slot.encoded = null;
    slot.pending = null;
    resetCrop(slot);
  }

  // A 2x1 JPEG carrying EXIF Orientation=6 (rotate 90 CW). A browser that
  // applies EXIF by itself reads it back as 1x2. We probe ONCE so that we
  //  - never rotate a picture the browser has already rotated (double rotation), and
  //  - never trust an `imageOrientation` option an old Safari silently ignores.
  var PROBE_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD50ooor8MP9Uz/2Q==';
  var orientProbe = null;

  function probeOrientationSupport() {
    if (orientProbe) return orientProbe;
    orientProbe = new Promise(function (resolve) {
      // Safe defaults if the probe cannot run: modern browsers auto-rotate <img>.
      var result = { imgAuto: true, bitmapOk: typeof createImageBitmap === 'function' };
      var settled = false;
      function finish() { if (!settled) { settled = true; resolve(result); } }
      setTimeout(finish, 1500);
      try {
        var bin = atob(PROBE_JPEG), bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var blob = new Blob([bytes], { type: 'image/jpeg' });
        var img = new Image();
        img.onload = function () {
          result.imgAuto = img.naturalWidth < img.naturalHeight;
          if (typeof createImageBitmap !== 'function') { result.bitmapOk = false; finish(); return; }
          try {
            createImageBitmap(blob, { imageOrientation: 'from-image' }).then(function (bm) {
              result.bitmapOk = bm.width < bm.height;
              if (bm.close) bm.close();
              finish();
            }, function () { result.bitmapOk = false; finish(); });
          } catch (e) { result.bitmapOk = false; finish(); }
        };
        img.onerror = finish;
        img.src = 'data:image/jpeg;base64,' + PROBE_JPEG;
      } catch (e) { finish(); }
    });
    return orientProbe;
  }

  // Primary path: createImageBitmap with orientation handling (only if the
  // probe proved the browser honours it). Fallback: decode via <img> and, only
  // if the browser does not auto-rotate, apply EXIF by hand.
  function decodeUpright(file) {
    return probeOrientationSupport().then(function (sup) {
      return new Promise(function (resolve, reject) {
        if (sup.bitmapOk) {
          var p;
          try {
            p = createImageBitmap(file, { imageOrientation: 'from-image' });
          } catch (e) {
            p = null;
          }
          if (p && typeof p.then === 'function') {
            p.then(function (bitmap) {
              var c = newCanvas(bitmap.width, bitmap.height);
              whiteCtx(c).drawImage(bitmap, 0, 0);
              c.hasAlpha = isPngFile(file) && detectAlpha(bitmap, bitmap.width, bitmap.height);
              if (bitmap.close) bitmap.close();
              resolve(c);
            }).catch(function () { decodeFallback(file, sup).then(resolve, reject); });
            return;
          }
        }
        decodeFallback(file, sup).then(resolve, reject);
      });
    });
  }

  function decodeFallback(file, sup) {
    // Browser already rotated the <img> -> treat as orientation 1 (no double rotation).
    var orientationP = (sup && sup.imgAuto) ? Promise.resolve(1) : readOrientationFromFile(file);
    return orientationP.then(function (orientation) {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          try {
            var c = applyOrientation(img, img.naturalWidth, img.naturalHeight, orientation);
            c.hasAlpha = isPngFile(file) && detectAlpha(img, img.naturalWidth, img.naturalHeight);
            resolve(c);
          } catch (e) {
            reject(e);
          } finally {
            URL.revokeObjectURL(url);
          }
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode')); };
        img.src = url;
      });
    });
  }

  function readOrientationFromFile(file) {
    return new Promise(function (resolve) {
      if (file.type !== 'image/jpeg' && !/\.jpe?g$/i.test(file.name || '')) { resolve(1); return; }
      var slice = file.slice(0, 128 * 1024);
      var reader = new FileReader();
      reader.onload = function () {
        var o = 1;
        try { o = readOrientation(reader.result); } catch (e) { o = 1; }
        resolve(o);
      };
      reader.onerror = function () { resolve(1); };
      reader.readAsArrayBuffer(slice);
    });
  }

  /* ---- 5. BORDER ANALYSIS ---- */

  // Only used by "Fit inside" (Auto / Solid fill). Runs on a downscaled working
  // copy for speed. Result is cached per picture.
  function analyzeBorder(source) {
    var longEdge = Math.max(source.width, source.height);
    var s = Math.min(1, WORK_LONG_EDGE / longEdge);
    var w = Math.max(1, Math.round(source.width * s));
    var h = Math.max(1, Math.round(source.height * s));

    var work = newCanvas(w, h);
    var wctx = whiteCtx(work);               // white first: transparency reads as white
    wctx.drawImage(source, 0, 0, w, h);

    var data;
    try {
      data = wctx.getImageData(0, 0, w, h).data;
    } catch (e) {
      return { variance: 0, r: 255, g: 255, b: 255, decision: 'white', color: '#ffffff' };
    }

    var band = Math.max(1, Math.round(Math.min(w, h) / 50));
    var sum = [0, 0, 0], sumSq = [0, 0, 0], n = 0;

    function take(x, y) {
      var i = (y * w + x) * 4;
      for (var c = 0; c < 3; c++) {
        var v = data[i + c];
        sum[c] += v;
        sumSq[c] += v * v;
      }
      n++;
    }

    // Simple non-deduped ring walk: corner pixels fall in two strips and are
    // counted twice. That does not materially change a mean/variance of a
    // border band, and keeps this loop trivial to read.
    var x, y;
    for (y = 0; y < band && y < h; y++) for (x = 0; x < w; x++) take(x, y);                 // top
    for (y = Math.max(0, h - band); y < h; y++) for (x = 0; x < w; x++) take(x, y);         // bottom
    for (x = 0; x < band && x < w; x++) for (y = 0; y < h; y++) take(x, y);                 // left
    for (x = Math.max(0, w - band); x < w; x++) for (y = 0; y < h; y++) take(x, y);         // right

    if (!n) n = 1;
    var mean = [sum[0] / n, sum[1] / n, sum[2] / n];
    var varc = [
      (sumSq[0] / n) - mean[0] * mean[0],
      (sumSq[1] / n) - mean[1] * mean[1],
      (sumSq[2] / n) - mean[2] * mean[2]
    ];
    var variance = (varc[0] + varc[1] + varc[2]) / 3;

    var decision;
    if (variance < VARIANCE_THRESHOLD) {
      decision = (mean[0] >= NEAR_WHITE_CUTOFF &&
                  mean[1] >= NEAR_WHITE_CUTOFF &&
                  mean[2] >= NEAR_WHITE_CUTOFF) ? 'white' : 'solid';
    } else {
      decision = 'blur';
    }

    return {
      variance: variance,
      r: mean[0], g: mean[1], b: mean[2],
      decision: decision,
      color: '#' + toHex(mean[0]) + toHex(mean[1]) + toHex(mean[2])
    };
  }

  function getAnalysis(slot) {
    if (!slot.source) return null;
    if (!slot.analysis) slot.analysis = analyzeBorder(slot.source);
    return slot.analysis;
  }

  // The fill actually used by Fit mode (resolves 'auto').
  function effectiveFill(slot) {
    if (state.fill !== 'auto') return state.fill;
    var a = getAnalysis(slot);
    return a ? a.decision : 'white';
  }

  // Snap-to-white: a near-white border prints as a faint visible rectangle on an
  // otherwise pure-white page. Applies to auto-solid and explicit solid.
  function solidColor(slot) {
    if (state.customSolidColor) return state.customSolidColor;
    var a = getAnalysis(slot);
    if (!a) return '#ffffff';
    if (a.r >= NEAR_WHITE_CUTOFF && a.g >= NEAR_WHITE_CUTOFF && a.b >= NEAR_WHITE_CUTOFF) {
      return '#ffffff';
    }
    return a.color;
  }

  /* ---- 6. GEOMETRY / OUTPUT SIZE ---- */

  // Fill mode, zoom 100%: the biggest rectangle of the slot's shape that fits
  // inside the picture. Returned as a width in source pixels.
  function baseCropWidth(slot) {
    var src = slot.source;
    return Math.min(src.width, src.height * slot.def.w / slot.def.h);
  }

  // How many pixels of the PICTURE span the width of the finished frame?
  // This is the picture's real resolution in the result, and everything about
  // "can it fill 2x?" is decided by it.
  //   Fill: the crop frame's width (zooming in shrinks it).
  //   Fit : the frame is wide enough to hold the whole picture at 1:1.
  function frameSourceWidth(slot) {
    var src = slot.source;
    if (state.mode === 'fill') return baseCropWidth(slot) / slot.zoom;
    return Math.max(src.width, src.height * slot.def.w / slot.def.h);
  }

  // ONE function decides the output size, used by the preview, the readout and
  // the export, so they can never disagree.
  //
  // The output must be EXACTLY the slot's shape in whole pixels. For 970x600 the
  // shape is 97:60, so the only valid widths are multiples of 97 (970, 1067 ... 1940).
  // "k" counts those steps: k = gcd(w,h) is the minimum, k = 2*gcd is 2x.
  function computeOutput(slot) {
    var d = slot.def;
    var g = gcd(d.w, d.h);
    var stepW = d.w / g, stepH = d.h / g;
    var avail = Math.floor(frameSourceWidth(slot) + 1e-6);    // whole source pixels across the frame
    var k = g;                                                // Minimum
    if (state.size === 'sharp') {
      k = clamp(Math.floor(avail / stepW), g, SHARP_FACTOR * g);   // never below min, never above 2x
    }
    return {
      w: k * stepW,
      h: k * stepH,
      avail: avail,
      isSharp: k === SHARP_FACTOR * g,
      level: avail >= SHARP_FACTOR * d.w ? 'ok' : (avail >= d.w ? 'warn' : 'bad')
    };
  }

  // Fill mode: the crop rectangle in source pixels (always exactly the slot's shape).
  function cropRect(slot) {
    var d = slot.def, src = slot.source;
    var w = baseCropWidth(slot) / slot.zoom;
    var h = w * d.h / d.w;
    if (h > src.height) { h = src.height; w = h * d.w / d.h; }   // guards float rounding
    return {
      x: clamp(slot.cx - w / 2, 0, Math.max(0, src.width - w)),
      y: clamp(slot.cy - h / 2, 0, Math.max(0, src.height - h)),
      w: w, h: h
    };
  }

  // Keeps the stored centre inside the picture so dragging past the edge never "winds up".
  function clampCenter(slot) {
    var c = cropRect(slot);
    slot.cx = c.x + c.w / 2;
    slot.cy = c.y + c.h / 2;
  }

  function resetCrop(slot) {
    slot.cx = slot.source ? slot.source.width / 2 : 0;
    slot.cy = slot.source ? slot.source.height / 2 : 0;
    slot.zoom = 1;
  }

  // Fit mode: where the whole picture sits inside a canvas of cw x ch.
  // Snapped to whole pixels so no faint seam shows between picture and fill.
  function fitRect(slot, cw, ch) {
    var src = slot.source;
    var f = Math.min(cw / src.width, ch / src.height);
    var pw = Math.round(src.width * f), ph = Math.round(src.height * f);
    if (Math.abs(pw - cw) <= 1) pw = cw;
    if (Math.abs(ph - ch) <= 1) ph = ch;
    pw = clamp(pw, 1, cw); ph = clamp(ph, 1, ch);
    return { x: Math.round((cw - pw) / 2), y: Math.round((ch - ph) / 2), w: pw, h: ph };
  }

  // Everything that changes the finished file, as one string. Used to know
  // whether a file we already made is still the right one.
  function settingsKey(slot) {
    var parts = [slot.imgId, state.mode, state.size, state.format];
    if (state.mode === 'fill') {
      parts.push(slot.cx.toFixed(1), slot.cy.toFixed(1), slot.zoom.toFixed(3));
    } else {
      parts.push(state.fill, effectiveFill(slot), solidColor(slot));
    }
    return parts.join('|');
  }

  /* ---- 7. RENDERING ---- */

  function supportsFilter(ctx) {
    if (typeof ctx.filter !== 'string') return false;
    ctx.filter = 'blur(2px)';
    var ok = ctx.filter !== 'none' && ctx.filter !== '';
    ctx.filter = 'none';
    return ok;
  }

  // Stepped downscale: a single big drawImage aliases fine detail badly. We keep
  // a chain of half-size copies of the picture (built on demand, cached per
  // picture) and draw from the one closest to the size we need.
  // `factor` = source pixels per output pixel (2 or more means "shrinking a lot").
  function pickLevel(slot, factor) {
    var src = slot.source;
    if (!slot.pyramid || slot.pyramid[0] !== src) slot.pyramid = [src];
    var levels = slot.pyramid;
    var i = 0;
    while (factor >= 2 && levels[i].width > 1 && levels[i].height > 1) {
      if (!levels[i + 1]) {
        var prev = levels[i];
        var nw = Math.max(1, Math.floor(prev.width / 2));
        var nh = Math.max(1, Math.floor(prev.height / 2));
        var step = newCanvas(nw, nh);
        whiteCtx(step).drawImage(prev, 0, 0, nw, nh);
        levels[i + 1] = step;
      }
      i++;
      factor /= 2;
    }
    return levels[i];
  }

  // Draws the source rectangle (sx,sy,sw,sh), given in ORIGINAL source pixels,
  // into the destination rectangle, using the best half-size copy.
  function drawSourceRect(ctx, slot, sx, sy, sw, sh, dx, dy, dw, dh) {
    smooth(ctx);
    var src = slot.source;
    var level = pickLevel(slot, Math.min(sw / dw, sh / dh));
    var kx = level.width / src.width, ky = level.height / src.height;
    ctx.drawImage(level, sx * kx, sy * ky, sw * kx, sh * ky, dx, dy, dw, dh);
  }

  // Fit mode only. This is a SECOND, cover-scaled copy of the picture used as
  // background. It is cropped and blurred; the sharp whole picture on top never is.
  function drawBlurBackground(ctx, slot, w, h, r) {
    var src = slot.source;
    var pad = r * 2;                          // real pixels past every edge, so a
    var tw = w + pad * 2;                     // canvas blur at the rim has something
    var th = h + pad * 2;                     // to sample and does not fade/darken
    var tmp = newCanvas(tw, th);
    var tctx = whiteCtx(tmp);

    var cover = Math.max(tmp.width / src.width, tmp.height / src.height);
    var dw = src.width * cover, dh = src.height * cover;
    tctx.drawImage(pickLevel(slot, 1 / cover), (tmp.width - dw) / 2, (tmp.height - dh) / 2, dw, dh);

    if (r >= 1 && supportsFilter(ctx)) {
      ctx.filter = 'blur(' + r + 'px)';
      ctx.drawImage(tmp, -pad, -pad);
      ctx.filter = 'none';
      return;
    }

    // Fallback (old Safari): downscale-then-upscale, twice.
    var shrink = Math.max(1, Math.round(r / 2));
    var sw = Math.max(1, Math.round(tmp.width / shrink));
    var sh = Math.max(1, Math.round(tmp.height / shrink));
    var cur = tmp;
    for (var i = 0; i < 2; i++) {
      var small = newCanvas(sw, sh);
      whiteCtx(small).drawImage(cur, 0, 0, sw, sh);
      var big = newCanvas(tmp.width, tmp.height);
      whiteCtx(big).drawImage(small, 0, 0, tmp.width, tmp.height);
      cur = big;
    }
    ctx.drawImage(cur, -pad, -pad);
  }

  // Draws the finished image into the canvas that `ctx` belongs to, at whatever
  // pixel size that canvas has. The preview uses a small canvas and the export a
  // full-size one, but both go through THIS function, so what you see is what
  // you get. Overlays (the crop frame) live on another canvas and are never drawn here.
  function renderSlot(ctx, slot) {
    var cw = ctx.canvas.width, ch = ctx.canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    smooth(ctx);

    if (!slot.source) { ctx.restore(); return; }

    if (state.mode === 'fill') {
      // Cover: the crop frame (always the slot's exact shape) fills the whole canvas.
      var c = cropRect(slot);
      drawSourceRect(ctx, slot, c.x, c.y, c.w, c.h, 0, 0, cw, ch);
    } else {
      // Contain: the whole picture, centred, on a background.
      var mode = effectiveFill(slot);
      if (mode === 'solid') {
        ctx.fillStyle = solidColor(slot);
        ctx.fillRect(0, 0, cw, ch);
      } else if (mode === 'blur') {
        drawBlurBackground(ctx, slot, cw, ch, Math.max(1, Math.round(0.03 * Math.max(cw, ch))));
      }
      // 'white' needs nothing further - the canvas is already pure white.
      var p = fitRect(slot, cw, ch);
      drawSourceRect(ctx, slot, 0, 0, slot.source.width, slot.source.height, p.x, p.y, p.w, p.h);
    }
    ctx.restore();
  }

  /* ---- 8. PREVIEW ---- */

  function schedulePreview() {
    if (previewRaf) return;
    previewRaf = requestAnimationFrame(function () {
      previewRaf = 0;
      renderAll();
    });
  }

  function renderAll() {
    renderStage();
    updateReadout();
    updateSlotRows();
    updateButtons();
  }

  function renderStage() {
    var slot = activeSlot();
    var has = !!slot.source;
    el.emptyState.hidden = has;
    el.emptyPrivacy.hidden = has;
    el.panes.hidden = !has;
    updateToolbarTitle();
    if (!has) {
      var multi = state.slots.length > 1;
      el.emptyHead.textContent = multi ? 'Drop your picture for “' + slot.def.label + '” here' : 'Drop your image here';
      el.emptySub.textContent = 'or click to browse — PNG or JPG';
      return;
    }

    var fill = state.mode === 'fill';
    el.paneAdjust.hidden = !fill;
    el.panes.classList.toggle('panes-stack', slot.def.w / slot.def.h >= WIDE_FRAME_RATIO);
    var out = computeOutput(slot);
    if (fill) renderAdjust(slot);
    renderResult(slot, out);
  }

  function updateToolbarTitle() {
    var slot = activeSlot(), p = currentPreset();
    var multi = state.slots.length > 1;
    el.previewTitle.textContent = multi
      ? slot.def.label + ' (' + (state.active + 1) + ' of ' + state.slots.length + ')'
      : p.name;
    var span = document.createElement('span');
    span.textContent = ' · minimum ' + px(slot.def.w, slot.def.h);
    el.previewTitle.appendChild(span);
  }

  // The left pane (Fill mode): the whole picture, with everything outside the
  // crop frame dimmed. The picture itself is drawn once and cached; dragging
  // only redraws the thin overlay on top.
  function renderAdjust(slot) {
    var src = slot.source;
    var box = el.adjustBox.getBoundingClientRect();
    var availW = Math.max(40, box.width - 2), availH = Math.max(40, box.height - 2);
    var fit = Math.min(availW / src.width, availH / src.height);
    var dispW = Math.max(1, Math.floor(src.width * fit));
    var dispH = Math.max(1, Math.floor(src.height * fit));
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cw = Math.max(1, Math.min(src.width, Math.round(dispW * dpr)));
    var ch = Math.max(1, Math.round(cw * src.height / src.width));

    el.adjustSheet.style.width = dispW + 'px';
    el.adjustSheet.style.height = dispH + 'px';

    var key = slot.imgId + '|' + cw + 'x' + ch;
    if (el.adjustCanvas.getAttribute('data-key') !== key) {
      el.adjustCanvas.width = cw;
      el.adjustCanvas.height = ch;
      var ctx = whiteCtx(el.adjustCanvas);
      drawSourceRect(ctx, slot, 0, 0, src.width, src.height, 0, 0, cw, ch);
      el.adjustCanvas.setAttribute('data-key', key);
    }
    if (el.adjustOverlay.width !== cw) el.adjustOverlay.width = cw;
    if (el.adjustOverlay.height !== ch) el.adjustOverlay.height = ch;
    drawOverlay(slot);
  }

  // The dimmed area + the frame outline. Preview-only: the export never calls this.
  function drawOverlay(slot) {
    var c = el.adjustOverlay;
    var ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    var crop = cropRect(slot);
    var f = c.width / slot.source.width;
    var cssW = el.adjustCanvas.getBoundingClientRect().width || c.width;
    var k = c.width / cssW;                              // canvas pixels per CSS pixel

    ctx.fillStyle = 'rgba(15,23,42,0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, c.width, c.height);
    ctx.rect(crop.x * f, crop.y * f, crop.w * f, crop.h * f);
    ctx.fill('evenodd');                                 // dim everything EXCEPT the frame

    ctx.setLineDash([]);
    ctx.lineWidth = 3 * k;                               // white under orange: readable on any picture
    ctx.strokeStyle = '#ffffff';
    ctx.strokeRect(crop.x * f, crop.y * f, crop.w * f, crop.h * f);
    ctx.lineWidth = 1.5 * k;
    ctx.strokeStyle = '#ea580c';
    ctx.strokeRect(crop.x * f, crop.y * f, crop.w * f, crop.h * f);
  }

  // The right pane: exactly what will be exported (at a smaller pixel size).
  function renderResult(slot, out) {
    var box = el.resultBox.getBoundingClientRect();
    var availW = Math.max(40, box.width - 2), availH = Math.max(40, box.height - 2);
    var fit = Math.min(availW / out.w, availH / out.h);
    var dispW = Math.max(1, Math.floor(out.w * fit));
    var dispH = Math.max(1, Math.floor(out.h * fit));
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var cw = Math.max(1, Math.min(out.w, Math.round(dispW * dpr)));
    var ch = Math.max(1, Math.round(cw * out.h / out.w));

    el.resultSheet.style.width = dispW + 'px';
    el.resultSheet.style.height = dispH + 'px';
    if (el.resultCanvas.width !== cw) el.resultCanvas.width = cw;
    if (el.resultCanvas.height !== ch) el.resultCanvas.height = ch;
    renderSlot(el.resultCanvas.getContext('2d'), slot);

    el.resultLabel.textContent = 'Result ';
    var span = document.createElement('span');
    span.textContent = '— ' + px(out.w, out.h);
    el.resultLabel.appendChild(span);
  }

  // While dragging, only the overlay and the (small) result are redrawn.
  function scheduleCropPreview() {
    scheduleSizes();
    if (cropRaf || previewRaf) return;
    cropRaf = requestAnimationFrame(function () {
      cropRaf = 0;
      var slot = activeSlot();
      if (!slot.source || state.mode !== 'fill') return;
      drawOverlay(slot);
      renderResult(slot, computeOutput(slot));
    });
  }

  /* ---- 9. FILE ENCODING (PNG / JPG, 300 DPI, 3 MB) AND ZIP ---- */

  var crcTable = null;

  function crc32(bytes) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  function concatBytes(parts) {
    var total = 0, i;
    for (i = 0; i < parts.length; i++) total += parts[i].length;
    var out = new Uint8Array(total), pos = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], pos); pos += parts[i].length; }
    return out;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob); else reject(new Error('toBlob'));
      }, type, quality);
    });
  }

  function blobToBytes(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsArrayBuffer(blob);
    });
  }

  // 300 DPI in a PNG = a "pHYs" chunk saying 11811 pixels per metre. Inserted
  // right after the header chunk (any pHYs the browser already wrote is dropped).
  function setPngDpi(bytes) {
    if (bytes.length < 33 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return bytes;   // not a PNG
    var ppm = Math.round(DPI / 0.0254);
    var chunk = new Uint8Array(21);
    var cv = new DataView(chunk.buffer);
    cv.setUint32(0, 9);                                  // data length
    chunk.set([0x70, 0x48, 0x59, 0x73], 4);              // "pHYs"
    cv.setUint32(8, ppm);                                // pixels per metre, X
    cv.setUint32(12, ppm);                               // pixels per metre, Y
    chunk[16] = 1;                                       // unit: metre
    cv.setUint32(17, crc32(chunk.subarray(4, 17)));      // CRC covers type + data

    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var parts = [bytes.subarray(0, 8)];
    var p = 8;
    while (p + 12 <= bytes.length) {
      var len = dv.getUint32(p);
      var type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      var end = p + 12 + len;
      if (end > bytes.length) { parts.push(bytes.subarray(p)); p = bytes.length; break; }
      if (type !== 'pHYs') parts.push(bytes.subarray(p, end));
      if (type === 'IHDR') parts.push(chunk);
      p = end;
    }
    return concatBytes(parts);
  }

  // 300 DPI in a JPG = the density fields of the JFIF header (units 1 = dots per inch).
  function setJpegDpi(bytes) {
    if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return bytes;    // not a JPEG
    var hasJfif = bytes[2] === 0xFF && bytes[3] === 0xE0 && bytes[6] === 0x4A &&
                  bytes[7] === 0x46 && bytes[8] === 0x49 && bytes[9] === 0x46 && bytes[10] === 0;
    if (hasJfif) {
      var out = bytes.slice();
      out[13] = 1;
      out[14] = DPI >> 8; out[15] = DPI & 255;
      out[16] = DPI >> 8; out[17] = DPI & 255;
      return out;
    }
    // No JFIF header (some browsers write only EXIF): add a small one right after the start marker.
    var seg = new Uint8Array([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01,
                              0x01, DPI >> 8, DPI & 255, DPI >> 8, DPI & 255, 0x00, 0x00]);
    return concatBytes([bytes.subarray(0, 2), seg, bytes.subarray(2)]);
  }

  // Makes the file for a finished canvas.
  //   png  : PNG only
  //   jpg  : JPG, lowering the quality step by step until it fits under the limit
  //   auto : PNG if it fits, otherwise the JPG loop
  // The canvas is always opaque (white underneath), so JPG never gets a black background.
  // Resolves { type, bytes, quality, over } - `over` means even the best try is over the limit.
  function encodeCanvas(canvas, format) {
    function tryPng() {
      return canvasToBlob(canvas, 'image/png').then(blobToBytes).then(function (b) {
        var bytes = setPngDpi(b);
        return { type: 'png', bytes: bytes, quality: null, over: bytes.length > MAX_FILE_BYTES };
      });
    }
    function tryJpg(i) {
      return canvasToBlob(canvas, 'image/jpeg', JPEG_QUALITIES[i]).then(blobToBytes).then(function (b) {
        var bytes = setJpegDpi(b);
        var res = { type: 'jpg', bytes: bytes, quality: JPEG_QUALITIES[i], over: bytes.length > MAX_FILE_BYTES };
        if (!res.over || i === JPEG_QUALITIES.length - 1) return res;
        return tryJpg(i + 1);
      });
    }
    if (format === 'png') return tryPng();
    if (format === 'jpg') return tryJpg(0);
    return tryPng().then(function (res) { return res.over ? tryJpg(0) : res; });
  }

  // Makes (or reuses) the finished file for one slot.
  function encodeSlot(slot) {
    var key = settingsKey(slot);
    if (slot.encoded && slot.encoded.key === key) return Promise.resolve(slot.encoded);
    if (slot.pending && slot.pending.key === key) return slot.pending.promise;

    var out = computeOutput(slot);
    var canvas = newCanvas(out.w, out.h);
    renderSlot(canvas.getContext('2d'), slot);           // the same render function as the preview
    var preset = currentPreset();

    var p = encodeCanvas(canvas, state.format).then(function (res) {
      res.key = key;
      res.w = out.w;
      res.h = out.h;
      res.name = 'aplus-' + preset.slug + '-' + slot.def.slug + '-' + out.w + 'x' + out.h + '.' + res.type;
      if (slot.pending && slot.pending.key === key) slot.pending = null;
      if (settingsKey(slot) === key) slot.encoded = res;   // otherwise the settings moved on: don't keep it
      return res;
    }, function (err) {
      if (slot.pending && slot.pending.key === key) slot.pending = null;
      throw err;
    });
    slot.pending = { key: key, promise: p };
    return p;
  }

  function encodedFor(slot) {
    return (slot.source && slot.encoded && slot.encoded.key === settingsKey(slot)) ? slot.encoded : null;
  }

  // After a change (and a short pause) measure the real file size of every
  // picture, active slot first. The same files are used when you press Download.
  function scheduleSizes() {
    clearTimeout(sizeTimer);
    sizeJob++;                                           // cancels any job still running
    updateFileQuality();
    sizeTimer = setTimeout(runSizeJob, SIZE_DEBOUNCE_MS);
  }

  function runSizeJob() {
    var token = ++sizeJob;
    var order = [];
    if (activeSlot().source) order.push(activeSlot());
    state.slots.forEach(function (s) { if (s.source && s !== activeSlot()) order.push(s); });

    (function next(i) {
      if (token !== sizeJob || i >= order.length) return;
      encodeSlot(order[i]).then(function () {
        if (token !== sizeJob) return;
        updateSlotRows();
        updateFileQuality();
        updateButtons();
        setTimeout(function () { next(i + 1); }, 0);     // let the page breathe between files
      }, function () { /* a failure here is reported when the user presses Download */ });
    })(0);
  }

  /* -- ZIP (store-only, written by hand) -- */

  function asciiBytes(s) {
    var u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0x7F;
    return u;
  }

  // files: [{ name, bytes }]. No compression ("stored"): PNG and JPG are already
  // compressed, so there is nothing to gain. Returns a Blob.
  function buildZip(files) {
    var now = new Date();
    var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    var parts = [], central = [], offset = 0, cdSize = 0;

    files.forEach(function (f) {
      var name = asciiBytes(f.name);
      var crc = crc32(f.bytes);
      var size = f.bytes.length;

      var lh = new Uint8Array(30 + name.length);          // local file header
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);                          // version needed
      lv.setUint16(6, 0, true);                           // flags
      lv.setUint16(8, 0, true);                           // method 0 = stored
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);                       // compressed size
      lv.setUint32(22, size, true);                       // uncompressed size
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);                          // extra field length
      lh.set(name, 30);
      parts.push(lh, f.bytes);

      var ch = new Uint8Array(46 + name.length);          // central directory entry
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);                          // version made by
      cv.setUint16(6, 20, true);                          // version needed
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);                          // extra length
      cv.setUint16(32, 0, true);                          // comment length
      cv.setUint16(34, 0, true);                          // disk number
      cv.setUint16(36, 0, true);                          // internal attributes
      cv.setUint32(38, 0, true);                          // external attributes
      cv.setUint32(42, offset, true);                     // where this file's local header starts
      ch.set(name, 46);
      central.push(ch);

      offset += lh.length + size;
      cdSize += ch.length;
    });

    var end = new Uint8Array(22);                         // end of central directory
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob(parts.concat(central, [end]), { type: 'application/zip' });
  }

  /* ---- 10. EXPORT ---- */

  function saveBlobAs(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function mimeFor(type) { return type === 'jpg' ? 'image/jpeg' : 'image/png'; }

  // Shows the busy state on the pressed button, lets it paint, then runs the job.
  function runBusy(btn, job) {
    if (state.rendering) return;
    state.rendering = true;
    el.downloadBtn.disabled = true;
    el.zipBtn.disabled = true;
    setBtnBusy(btn, true);

    function done() {
      state.rendering = false;
      setBtnBusy(btn, false);
      updateButtons();
    }
    // Let the busy state actually paint before the main thread blocks.
    requestAnimationFrame(function () {
      setTimeout(function () {
        var p;
        try { p = job(); } catch (e) { p = Promise.reject(e); }
        p.then(done, function () {
          showBanner('Something went wrong while creating the file. Please try again.');
          done();
        });
      }, 0);
    });
  }

  function downloadActive() {
    var slot = activeSlot();
    if (!slot.source) return;
    runBusy(el.downloadBtn, function () {
      return encodeSlot(slot).then(function (res) {
        saveBlobAs(new Blob([res.bytes], { type: mimeFor(res.type) }), res.name);
        showToast(res.name, res.w + ' × ' + res.h + ' px, ready for KDP.');
        if (res.over) showOverBanner([slot.def.label]);
        updateSlotRows();
        updateFileQuality();
      });
    });
  }

  function downloadZip() {
    var list = state.slots.filter(hasSource);
    if (!list.length) return;
    runBusy(el.zipBtn, function () {
      var files = [], over = [];
      var chain = Promise.resolve();
      list.forEach(function (slot) {
        chain = chain.then(function () {
          return encodeSlot(slot).then(function (res) {
            files.push({ name: res.name, bytes: res.bytes });
            if (res.over) over.push(slot.def.label);
          });
        });
      });
      return chain.then(function () {
        var zipName = 'aplus-' + currentPreset().slug + '.zip';
        saveBlobAs(buildZip(files), zipName);
        showToast(zipName, files.length + (files.length === 1 ? ' image' : ' images') + ', ready for KDP.');
        if (over.length) showOverBanner(over);
        updateSlotRows();
        updateFileQuality();
      });
    });
  }

  function showOverBanner(labels) {
    showBanner('Heads up: ' + labels.join(', ') + (labels.length === 1 ? ' is' : ' are') +
               ' still over KDP’s ' + KDP_LIMIT_TEXT + ' limit, so KDP may refuse ' +
               (labels.length === 1 ? 'it' : 'them') + '. Try the Minimum size, or a less detailed picture.');
  }

  function showToast(name, text) {
    el.toast.innerHTML = '';
    var strong = document.createElement('strong');
    strong.textContent = 'Saved! ';
    el.toast.appendChild(strong);
    el.toast.appendChild(document.createTextNode('"' + name + '" — ' + text));
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 5000);
  }

  /* ---- 11. UI WIRING ---- */

  /* -- module list (Step 1) -- */

  function sameSize(p) {
    return p.slots.every(function (s) { return s.w === p.slots[0].w && s.h === p.slots[0].h; });
  }

  // "970 × 600"  |  "3 images, 300 × 300 each"  |  "300 × 400 + 350 × 175"
  function shortSize(p) {
    var s0 = p.slots[0];
    if (p.slots.length === 1) return s0.w + ' × ' + s0.h;
    if (sameSize(p)) return p.slots.length + ' images, ' + s0.w + ' × ' + s0.h + ' each';
    return p.slots.map(function (s) { return s.w + ' × ' + s.h; }).join(' + ');
  }

  function buildModuleOptions() {
    PRESETS.forEach(function (p, i) {
      var o = document.createElement('option');
      o.value = String(i);
      o.textContent = p.name + ' — ' + shortSize(p) + (p.confirmed ? '' : ' (unconfirmed)');
      el.moduleSelect.appendChild(o);
    });
    el.moduleSelect.value = '0';
  }

  function updateModuleInfo() {
    var p = currentPreset();
    var text;
    if (p.slots.length === 1) {
      text = 'Minimum size: ' + px(p.slots[0].w, p.slots[0].h) + '.';
    } else if (sameSize(p)) {
      text = p.slots.length + ' images, minimum ' + px(p.slots[0].w, p.slots[0].h) + ' each.';
    } else {
      text = p.slots.map(function (s) { return s.label + ' ' + px(s.w, s.h); }).join(' + ') + ' (minimum sizes).';
    }
    el.moduleSummary.textContent = text;
    el.unconfirmedWrap.hidden = p.confirmed;
    el.popUnconfirmedText.textContent = UNCONFIRMED_TEXT + (p.note ? ' ' + p.note : '');
    $('popUnconfirmed').hidden = true;          // a new module starts with the tooltip closed
    el.unconfirmedTag.setAttribute('aria-expanded', 'false');
  }

  // Picks a module. Pictures already loaded stay (slot 1 keeps slot 1's picture, etc.).
  function setModule(index) {
    var old = state.slots;
    state.presetIndex = index;
    state.slots = currentPreset().slots.map(function (def, i) {
      var s = makeSlot(def);
      var o = old[i];
      if (o && o.source) {
        s.source = o.source;
        s.fileName = o.fileName; s.fileSize = o.fileSize; s.hasAlpha = o.hasAlpha;
        s.imgId = ++imgCounter;
        s.analysis = o.analysis;
        s.pyramid = o.pyramid;
        resetCrop(s);
      }
      return s;
    });
    state.active = Math.min(state.active, state.slots.length - 1);
    updateModuleInfo();
    buildSlotRows();
    refreshAll();
  }

  /* -- slot rows (Step 2): one drop zone per slot -- */

  function setActive(i) {
    if (i === state.active) return;
    state.active = i;
    refreshAll();
  }

  function openPicker(i) {
    state.pickSlot = i;
    el.fileInput.multiple = state.slots.length > 1;
    el.fileInput.click();
  }

  function buildSlotRows() {
    el.slotList.innerHTML = '';
    var multi = state.slots.length > 1;
    el.step2Label.textContent = multi ? 'Add your images' : 'Add your image';
    el.uploadHint.textContent = multi
      ? 'PNG or JPG. Drag a picture onto its slot, click Choose image, or paste with Ctrl+V. Dropping several files fills the slots in order.'
      : 'PNG or JPG. Drag it in, click to browse, or paste with Ctrl+V.';

    state.slots.forEach(function (slot, i) {
      var row = document.createElement('div');
      row.className = 'slot-row' + (multi ? ' is-multi' : '');

      var main = document.createElement('button');
      main.type = 'button';
      main.className = 'slot-main';

      var thumb = document.createElement('canvas');
      thumb.className = 'slot-thumb';
      thumb.width = 96; thumb.height = 96;
      thumb.setAttribute('aria-hidden', 'true');

      var text = document.createElement('span');
      text.className = 'slot-text';
      var name = document.createElement('span'); name.className = 'slot-name';
      var min = document.createElement('span'); min.className = 'slot-line';
      var file = document.createElement('span'); file.className = 'slot-line';
      var out = document.createElement('span'); out.className = 'slot-line';
      var alpha = document.createElement('span'); alpha.className = 'slot-line';
      var chip = document.createElement('span'); chip.className = 'status'; chip.hidden = true;
      text.appendChild(name); text.appendChild(min); text.appendChild(file);
      text.appendChild(alpha); text.appendChild(out); text.appendChild(chip);
      main.appendChild(thumb); main.appendChild(text);

      var choose = document.createElement('button');
      choose.type = 'button';
      choose.className = 'btn btn-secondary slot-choose';

      row.appendChild(main); row.appendChild(choose);
      el.slotList.appendChild(row);

      slot.ui = { row: row, main: main, thumb: thumb, name: name, min: min, file: file,
                  alpha: alpha, out: out, chip: chip, choose: choose };
      slot.thumbId = -1;

      main.addEventListener('click', function () { setActive(i); });
      choose.addEventListener('click', function () { setActive(i); openPicker(i); });

      // One drop zone per slot.
      row.addEventListener('dragover', function (e) {
        e.preventDefault();
        row.classList.add('dragover');
      });
      row.addEventListener('dragleave', function (e) {
        if (!row.contains(e.relatedTarget)) row.classList.remove('dragover');
      });
      row.addEventListener('drop', function (e) {
        e.preventDefault();
        e.stopPropagation();
        row.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files, i);
      });
    });
  }

  function drawThumb(slot) {
    var c = slot.ui.thumb;
    var ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    if (!slot.source) return;
    smooth(ctx);
    var src = slot.source;
    var f = Math.min(c.width / src.width, c.height / src.height);
    var w = src.width * f, h = src.height * f;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect((c.width - w) / 2, (c.height - h) / 2, w, h);
    drawSourceRect(ctx, slot, 0, 0, src.width, src.height, (c.width - w) / 2, (c.height - h) / 2, w, h);
  }

  function updateSlotRows() {
    var multi = state.slots.length > 1;
    state.slots.forEach(function (slot, i) {
      var ui = slot.ui;
      if (!ui) return;
      ui.row.classList.toggle('is-active', multi && i === state.active);
      ui.main.setAttribute('aria-label', slot.def.label + ', minimum ' + px(slot.def.w, slot.def.h) +
                           (multi ? (i === state.active ? ', selected' : ', select to preview') : ''));
      if (multi) ui.main.setAttribute('aria-pressed', i === state.active ? 'true' : 'false');
      else ui.main.removeAttribute('aria-pressed');
      ui.name.textContent = slot.def.label;
      ui.min.textContent = 'Minimum ' + px(slot.def.w, slot.def.h);
      ui.choose.textContent = slot.source ? 'Replace' : 'Choose image';
      ui.choose.setAttribute('aria-label', (slot.source ? 'Replace image for ' : 'Choose image for ') + slot.def.label);

      if (!slot.source) {
        ui.file.textContent = 'No picture yet — drop one here';
        ui.alpha.hidden = true; ui.out.hidden = true; ui.chip.hidden = true;
        slot.thumbId = -1;
        drawThumb(slot);
        return;
      }

      if (slot.thumbId !== slot.imgId) { slot.thumbId = slot.imgId; drawThumb(slot); }
      ui.file.textContent = slot.fileName + ' · ' + slot.source.width + ' × ' +
                            slot.source.height + ' px · ' + fmtBytes(slot.fileSize);
      ui.file.title = ui.file.textContent;
      ui.alpha.hidden = !slot.hasAlpha;
      ui.alpha.textContent = slot.hasAlpha ? 'Transparent areas are filled with white.' : '';

      var out = computeOutput(slot);
      var enc = encodedFor(slot);
      ui.out.hidden = false;
      ui.out.textContent = 'Output ' + px(out.w, out.h) + (enc ? ' · ' + typeLabel(enc.type) + ' ' + fmtBytes(enc.bytes.length) : '');
      ui.chip.hidden = false;
      ui.chip.className = 'status status-' + out.level;
      ui.chip.textContent = out.level === 'ok' ? 'Sharp' : out.level === 'warn' ? 'Fills the minimum' : 'Too small';
    });
  }

  /* -- steps / controls -- */

  // Steps 3-4 stay dimmed until there is a picture. Dimming alone would still
  // leave the controls tabbable, so they are genuinely disabled too.
  function setStepsEnabled(on) {
    ['step3', 'step4'].forEach(function (id) { $(id).classList.toggle('locked', !on); });
    [el.modeFill, el.modeFit, el.zoomRange, el.resetCropBtn, el.fillSelect,
     el.sizeSharp, el.sizeMin, el.fmtAuto, el.fmtPng, el.fmtJpg].forEach(function (c) { c.disabled = !on; });
  }

  function setSeg(buttons, activeBtn) {
    buttons.forEach(function (b) {
      var on = b === activeBtn;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function setMode(mode) {
    state.mode = mode;
    setSeg([el.modeFill, el.modeFit], mode === 'fill' ? el.modeFill : el.modeFit);
    el.fillModeField.hidden = mode !== 'fill';
    el.fitModeField.hidden = mode !== 'fit';
    el.modeHint.textContent = MODE_HINTS[mode];
    refreshFillUI();
    schedulePreview();
    scheduleSizes();
  }

  function setSize(size) {
    state.size = size;
    setSeg([el.sizeSharp, el.sizeMin], size === 'sharp' ? el.sizeSharp : el.sizeMin);
    el.sizeHint.textContent = SIZE_HINTS[size];
    schedulePreview();
    scheduleSizes();
  }

  function setFormat(fmt) {
    state.format = fmt;
    setSeg([el.fmtAuto, el.fmtPng, el.fmtJpg], fmt === 'auto' ? el.fmtAuto : fmt === 'png' ? el.fmtPng : el.fmtJpg);
    el.formatHint.textContent = FORMAT_HINTS[fmt];
    schedulePreview();
    scheduleSizes();
  }

  function setZoom(z) {
    var slot = activeSlot();
    if (!slot.source) return;
    slot.zoom = clamp(z, ZOOM_MIN, ZOOM_MAX);
    clampCenter(slot);                         // keeps the frame's centre, only the size changes
    updateZoomUI();
    schedulePreview();
    scheduleSizes();
  }

  function updateZoomUI() {
    var slot = activeSlot();
    var z = slot.source ? slot.zoom : 1;
    el.zoomRange.value = String(Math.round(z * 100));
    el.zoomVal.textContent = Math.round(z * 100) + '%';
  }

  function refreshAll() {
    setStepsEnabled(anySource());
    updateZoomUI();
    refreshFillUI();
    updateSlotRows();
    schedulePreview();
    scheduleSizes();
  }

  /* -- Fit mode: fill choices (copied from Margin Fixer) -- */

  function refreshFillUI() {
    updateAutoChip();
    updateSolidColorRow();
    var slot = activeSlot();
    var hint = FILL_HINTS[state.fill];
    if (state.mode === 'fit' && slot && slot.source) {
      var p = fitRect(slot, 1000, Math.round(1000 * slot.def.h / slot.def.w));
      if (p.w >= 1000 && p.h >= Math.round(1000 * slot.def.h / slot.def.w)) {
        hint = 'Your picture already has this exact shape, so there is no leftover space to fill.';
      }
    }
    el.fillHint.textContent = hint;
  }

  function updateAutoChip() {
    var slot = activeSlot();
    if (state.fill !== 'auto' || !slot.source) { el.autoChip.hidden = true; return; }
    var d = effectiveFill(slot);
    el.autoChip.hidden = false;
    el.autoChip.innerHTML = '';
    if (d === 'white') {
      el.autoChip.textContent = 'Auto chose: White';
    } else if (d === 'blur') {
      el.autoChip.textContent = 'Auto chose: Blur';
    } else {
      var col = solidColor(slot);
      el.autoChip.appendChild(document.createTextNode('Auto chose: Solid ' + col));
      var sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = col;
      el.autoChip.appendChild(sw);
    }
  }

  // Shows/hides the "Pick color" row - only relevant in explicit Solid mode
  // (not Auto, even when Auto resolves to solid; picking a color is a
  // deliberate override, not something Auto should surface).
  function updateSolidColorRow() {
    var slot = activeSlot();
    var show = state.fill === 'solid' && !!slot.source;
    el.solidColorRow.hidden = !show;
    if (!show) return;
    var col = solidColor(slot);
    el.colorSwatchPreview.style.background = col;
    el.colorSwatchLabel.textContent = state.customSolidColor ? col : 'Pick color';
    el.colorResetBtn.hidden = !state.customSolidColor;
  }

  // EyeDropper samples any pixel on screen - Chrome/Edge only. Firefox/Safari
  // fall back to the native <input type="color"> swatch picker (can't sample
  // the page, but still lets the user choose any color by hand).
  function openColorPicker() {
    if (typeof window.EyeDropper === 'function') {
      new window.EyeDropper().open().then(function (result) {
        state.customSolidColor = result.sRGBHex;
        refreshFillUI();
        schedulePreview();
        scheduleSizes();
      }).catch(function () { /* user cancelled - no-op */ });
      return;
    }
    el.colorFallbackInput.value = solidColor(activeSlot());
    el.colorFallbackInput.click();
  }

  /* -- readout -- */

  function updateReadout() {
    var slot = activeSlot();
    var d = slot.def;
    if (!slot.source) {
      el.outMain.textContent = 'Output: —';
      el.outSub.textContent = 'KDP’s minimum for this slot is ' + px(d.w, d.h) + '. Add a picture to see the result.';
      el.quality.hidden = true;
      el.fileQuality.hidden = true;
      return;
    }

    var out = computeOutput(slot);
    var label;
    if (state.size === 'min') label = 'Minimum size';
    else if (out.isSharp) label = 'Sharp (2× minimum)';
    else if (out.w > d.w) label = 'Biggest size your picture can fill';
    else label = 'Minimum size (your picture can’t fill more)';
    el.outMain.textContent = 'Output: ' + px(out.w, out.h) + '  ·  ' + label;
    el.outSub.textContent = 'KDP’s minimum for this slot: ' + px(d.w, d.h) + '  ·  saved at ' + DPI + ' DPI';

    updateQuality(slot, out);
    updateFileQuality();
  }

  // The honest badge. It judges the PICTURE, not the settings:
  // green = fills 2x the minimum, amber = fills the minimum only, red = below the minimum.
  function updateQuality(slot, out) {
    var d = slot.def;
    var zoomNote = (state.mode === 'fill' && slot.zoom > 1.001)
      ? ' You have zoomed in — zooming out gives the frame more of your picture’s pixels.' : '';
    el.quality.hidden = false;
    el.quality.className = 'quality';
    if (out.level === 'ok') {
      el.quality.classList.add('q-ok');
      el.qTitle.textContent = '✅ Image quality: Sharp';
      el.qCopy.textContent = 'Your picture has enough detail to fill twice KDP’s minimum size without stretching.';
    } else if (out.level === 'warn') {
      el.quality.classList.add('q-warn');
      el.qTitle.textContent = '⚠️ Image quality: Good enough';
      el.qCopy.textContent = 'Your picture fills KDP’s minimum size, but it doesn’t have enough detail for the Sharp (2×) size.' +
        (state.size === 'sharp' ? ' We made the file the biggest exact size it can fill (' + px(out.w, out.h) + ') instead of stretching it.' : '') +
        zoomNote;
    } else {
      el.quality.classList.add('q-bad');
      el.qTitle.textContent = '⛔ Image quality: Low';
      el.qCopy.textContent = 'Your picture is smaller than KDP’s minimum for this slot: it can fill about ' + out.avail +
        ' px across, and KDP needs ' + d.w + '. The file is exactly the minimum (' + px(out.w, out.h) +
        '), so it will look soft and KDP may refuse it. Try starting from a bigger version of your image.' + zoomNote;
    }
  }

  // File size block: real size of the real file, with the PNG/JPG decision.
  function updateFileQuality() {
    var slot = activeSlot();
    if (!slot || !slot.source) { el.fileQuality.hidden = true; return; }
    el.fileQuality.hidden = false;
    el.fileQuality.className = 'quality';
    var enc = encodedFor(slot);
    if (!enc) {
      el.fqTitle.textContent = 'File size: checking…';
      el.fqCopy.textContent = '';
      return;
    }
    var size = fmtBytes(enc.bytes.length) + ' (' + typeLabel(enc.type) + ')';
    if (!enc.over) {
      el.fileQuality.classList.add('q-ok');
      el.fqTitle.textContent = '✅ File size: ' + size;
      var copy = 'Under KDP’s ' + KDP_LIMIT_TEXT + ' limit.';
      if (enc.type === 'jpg' && state.format === 'auto') {
        copy += ' This picture is too detailed for a PNG under ' + KDP_LIMIT_TEXT + ', so it was saved as a JPG (quality ' + Math.round(enc.quality * 100) + '%).';
      } else if (enc.type === 'jpg' && enc.quality < JPEG_QUALITIES[0]) {
        copy += ' JPG quality was lowered to ' + Math.round(enc.quality * 100) + '% to fit.';
      }
      el.fqCopy.textContent = copy;
    } else {
      el.fileQuality.classList.add('q-bad');
      el.fqTitle.textContent = '⛔ File size: ' + size + ' — over the limit';
      el.fqCopy.textContent = enc.type === 'png'
        ? 'This PNG is over KDP’s ' + KDP_LIMIT_TEXT + ' limit, so KDP may refuse it. Switch File type to Auto or JPG.'
        : 'Even at the lowest JPG quality we allow (' + Math.round(enc.quality * 100) + '%) this is over KDP’s ' +
          KDP_LIMIT_TEXT + ' limit, so KDP may refuse it. Try the Minimum size, or a less detailed picture.';
    }
  }

  function updateButtons() {
    var multi = state.slots.length > 1;
    var slot = activeSlot();
    el.zipBtn.hidden = !multi;
    el.downloadBtn.classList.toggle('is-secondary', multi);
    if (state.rendering) return;

    var any = anySource();
    el.downloadBtn.disabled = !slot.source;
    el.zipBtn.disabled = !any;
    if (slot.source) el.downloadBtn.removeAttribute('title'); else el.downloadBtn.title = 'Add an image first.';
    if (any) el.zipBtn.removeAttribute('title'); else el.zipBtn.title = 'Add an image first.';

    var enc = encodedFor(slot);
    var ext = enc ? typeLabel(enc.type) : (state.format !== 'auto' ? typeLabel(state.format) : '');
    setBtnText(el.downloadBtn, multi ? 'Download this image' : (ext ? 'Download ' + ext : 'Download image'));
    var n = state.slots.filter(hasSource).length;
    setBtnText(el.zipBtn, n && n < state.slots.length
      ? 'Download ZIP (' + n + ' of ' + state.slots.length + ')'
      : 'Download all (ZIP)');
  }

  // Only the text inside the button's label changes; the label element itself
  // stays put. (Replacing it while the mouse is down would swallow the click.)
  function setBtnText(btn, text) {
    var label = btn.querySelector('.btn-label');
    if (label.textContent !== text) label.textContent = text;
  }

  function setBtnBusy(btn, busy) {
    btn.querySelector('.spinner').hidden = !busy;
    if (busy) setBtnText(btn, 'Rendering…');
  }

  /* -- banner + tooltips -- */

  function showBanner(message, actionLabel, onAction) {
    el.bannerHost.innerHTML = '';
    var box = document.createElement('div');
    box.className = 'banner';

    var body = document.createElement('div');
    body.className = 'banner-body';
    var p = document.createElement('p');
    p.textContent = message;
    body.appendChild(p);

    if (actionLabel) {
      var act = document.createElement('button');
      act.type = 'button';
      act.className = 'link-btn';
      act.style.marginTop = '6px';
      act.textContent = actionLabel;
      act.addEventListener('click', function () {
        el.bannerHost.innerHTML = '';
        onAction();
      });
      body.appendChild(act);
    }

    var x = document.createElement('button');
    x.type = 'button';
    x.className = 'banner-x';
    x.setAttribute('aria-label', 'Dismiss');
    x.innerHTML = '&times;';
    x.addEventListener('click', function () {
      state.pendingBig = null;
      el.bannerHost.innerHTML = '';
    });

    box.appendChild(body);
    box.appendChild(x);
    el.bannerHost.appendChild(box);
  }

  var POPOVERS = [['help1', 'pop1'], ['help3', 'pop3'], ['help4', 'pop4'], ['unconfirmedTag', 'popUnconfirmed']];

  function closePopovers(except) {
    POPOVERS.forEach(function (pair) {
      if (pair[1] === except) return;
      $(pair[1]).hidden = true;
      $(pair[0]).setAttribute('aria-expanded', 'false');
    });
  }

  function wirePopover(btnId, popId) {
    var btn = $(btnId), pop = $(popId);
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var open = pop.hidden;
      closePopovers(open ? popId : null);
      pop.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    pop.addEventListener('click', function (e) { e.stopPropagation(); });
  }

  /* -- keyboard control of the crop frame -- */

  function onFrameKey(e) {
    var slot = activeSlot();
    if (!slot.source || state.mode !== 'fill') return;
    var crop = cropRect(slot);
    var step = Math.max(1, Math.round(crop.w * (e.shiftKey ? 0.25 : 0.05)));
    var handled = true;
    if (e.key === 'ArrowLeft') slot.cx -= step;
    else if (e.key === 'ArrowRight') slot.cx += step;
    else if (e.key === 'ArrowUp') slot.cy -= step;
    else if (e.key === 'ArrowDown') slot.cy += step;
    else if (e.key === '+' || e.key === '=') { setZoom(slot.zoom + 0.1); e.preventDefault(); return; }
    else if (e.key === '-' || e.key === '_') { setZoom(slot.zoom - 0.1); e.preventDefault(); return; }
    else handled = false;
    if (!handled) return;
    e.preventDefault();
    clampCenter(slot);
    scheduleCropPreview();
  }

  /* -- init -- */

  function init() {
    ['bannerHost', 'moduleSelect', 'moduleSummary', 'unconfirmedWrap', 'unconfirmedTag',
     'popUnconfirmedText', 'step2Label', 'slotList', 'fileInput', 'uploadHint',
     'modeFill', 'modeFit', 'modeHint', 'fillModeField', 'zoomRange', 'zoomVal', 'resetCropBtn',
     'fitModeField', 'fillSelect', 'autoChip', 'solidColorRow', 'colorSwatchBtn',
     'colorSwatchPreview', 'colorSwatchLabel', 'colorResetBtn', 'colorFallbackInput', 'fillHint',
     'sizeSharp', 'sizeMin', 'sizeHint', 'fmtAuto', 'fmtPng', 'fmtJpg', 'formatHint',
     'downloadBtn', 'zipBtn',
     'previewTitle', 'stage', 'emptyState', 'emptyHead', 'emptySub', 'emptyPrivacy',
     'panes', 'paneAdjust', 'adjustBox', 'adjustSheet', 'adjustCanvas', 'adjustOverlay',
     'resultLabel', 'resultBox', 'resultSheet', 'resultCanvas', 'toast',
     'outMain', 'outSub', 'quality', 'qTitle', 'qCopy', 'fileQuality', 'fqTitle', 'fqCopy'
    ].forEach(function (id) { el[id] = $(id); });

    if (!PRESETS.length) {
      showBanner('The list of A+ modules (presets.js) could not be read. Make sure presets.js is in the same folder as index.html.');
      return;
    }

    buildModuleOptions();
    setModule(0);
    setMode('fill');
    setSize('sharp');
    setFormat('auto');
    setStepsEnabled(false);

    /* -- step 1: module -- */
    el.moduleSelect.addEventListener('change', function () {
      setModule(parseInt(el.moduleSelect.value, 10) || 0);
    });

    /* -- step 2: upload -- */
    el.fileInput.addEventListener('change', function () {
      handleFiles(el.fileInput.files, state.pickSlot);
      el.fileInput.value = '';                 // allow re-picking the same file
    });

    el.emptyState.addEventListener('click', function () { openPicker(state.active); });
    el.emptyState.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        openPicker(state.active);
      }
    });

    // A stray drop must never navigate away from the page.
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    el.stage.addEventListener('dragover', function (e) {
      e.preventDefault();
      el.stage.classList.add('dragover');
    });
    el.stage.addEventListener('dragleave', function () { el.stage.classList.remove('dragover'); });
    el.stage.addEventListener('drop', function (e) {
      e.preventDefault();
      el.stage.classList.remove('dragover');
      if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files, state.active);
    });

    document.addEventListener('paste', function (e) {
      if (e.clipboardData && e.clipboardData.files && e.clipboardData.files.length) {
        handleFiles(e.clipboardData.files, state.active);
      }
    });

    /* -- step 3: how it fits -- */
    el.modeFill.addEventListener('click', function () { setMode('fill'); });
    el.modeFit.addEventListener('click', function () { setMode('fit'); });
    el.zoomRange.addEventListener('input', function () {
      setZoom((parseInt(el.zoomRange.value, 10) || 100) / 100);
    });
    el.resetCropBtn.addEventListener('click', function () {
      var slot = activeSlot();
      if (!slot.source) return;
      resetCrop(slot);
      updateZoomUI();
      schedulePreview();
      scheduleSizes();
    });

    el.fillSelect.addEventListener('change', function () {
      state.fill = el.fillSelect.value;
      refreshFillUI();
      schedulePreview();
      scheduleSizes();
    });
    el.colorSwatchBtn.addEventListener('click', openColorPicker);
    el.colorFallbackInput.addEventListener('input', function () {
      state.customSolidColor = el.colorFallbackInput.value;
      refreshFillUI();
      schedulePreview();
      scheduleSizes();
    });
    el.colorResetBtn.addEventListener('click', function () {
      state.customSolidColor = null;
      refreshFillUI();
      schedulePreview();
      scheduleSizes();
    });

    /* -- step 4: size and file type -- */
    el.sizeSharp.addEventListener('click', function () { setSize('sharp'); });
    el.sizeMin.addEventListener('click', function () { setSize('min'); });
    el.fmtAuto.addEventListener('click', function () { setFormat('auto'); });
    el.fmtPng.addEventListener('click', function () { setFormat('png'); });
    el.fmtJpg.addEventListener('click', function () { setFormat('jpg'); });

    /* -- tooltips -- */
    POPOVERS.forEach(function (pair) { wirePopover(pair[0], pair[1]); });
    document.addEventListener('click', function () { closePopovers(null); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closePopovers(null);
    });

    /* -- crop frame: drag, or arrow keys -- */
    var drag = null;
    el.adjustSheet.addEventListener('pointerdown', function (e) {
      var slot = activeSlot();
      if (!slot.source || state.mode !== 'fill') return;
      var rect = el.adjustCanvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      var fx = slot.source.width / rect.width, fy = slot.source.height / rect.height;
      var sx = (e.clientX - rect.left) * fx, sy = (e.clientY - rect.top) * fy;
      var c = cropRect(slot);
      var inside = sx >= c.x && sx <= c.x + c.w && sy >= c.y && sy <= c.y + c.h;
      if (!inside) {                             // clicking outside the frame moves it there
        slot.cx = sx; slot.cy = sy;
        clampCenter(slot);
      }
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, fx: fx, fy: fy };
      if (el.adjustSheet.setPointerCapture) el.adjustSheet.setPointerCapture(e.pointerId);
      el.adjustSheet.classList.add('dragging');
      el.adjustBox.focus({ preventScroll: true });
      e.preventDefault();
      scheduleCropPreview();
    });
    el.adjustSheet.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      var slot = activeSlot();
      slot.cx += (e.clientX - drag.x) * drag.fx;
      slot.cy += (e.clientY - drag.y) * drag.fy;
      drag.x = e.clientX; drag.y = e.clientY;
      clampCenter(slot);
      scheduleCropPreview();
    });
    function endDrag(e) {
      if (!drag) return;
      if (el.adjustSheet.releasePointerCapture && e && e.pointerId !== undefined) {
        try { el.adjustSheet.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      }
      drag = null;
      el.adjustSheet.classList.remove('dragging');
    }
    el.adjustSheet.addEventListener('pointerup', endDrag);
    el.adjustSheet.addEventListener('pointercancel', endDrag);
    el.adjustBox.addEventListener('keydown', onFrameKey);

    /* -- export -- */
    el.downloadBtn.addEventListener('click', downloadActive);
    el.zipBtn.addEventListener('click', downloadZip);

    /* -- responsive re-render -- */
    window.addEventListener('resize', function () {
      clearTimeout(resizeDebounce);
      resizeDebounce = setTimeout(schedulePreview, 120);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
