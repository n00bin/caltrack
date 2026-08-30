/* scan.js — the camera, and the Open Food Facts lookup behind it.
 *
 * Two independent pieces:
 *   CalTrack.scan  - point the camera at a barcode, get the digits back
 *   CalTrack.off   - turn digits into a draft food record
 *
 * Scanning uses the browser's own BarcodeDetector where it exists (Chrome on
 * Android, which is the phone case that matters) and falls back to loading
 * ZXing only on browsers that lack it. Nothing is downloaded on the fast path.
 */
window.CalTrack = window.CalTrack || {};

CalTrack.scan = (function () {
  'use strict';

  // Pinned version + integrity hash: jsDelivr serves a fixed file per version,
  // so the browser refuses it outright if the bytes ever differ.
  var ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
  var ZXING_SRI = 'sha384-BzBxP10ZE72aitqj5UMmUsbKFliP/DZqA8Wq+BNNhlIJDGoEd1tpkMYXOg9+n6sB';

  // Grocery barcodes, plus Code 128 which turns up on store-packed items.
  var WANTED = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'];

  var session = null;   // the scan currently running, or null

  // ------------------------------------------------------------ capability

  function cameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // Cameras are blocked outside a secure context. file:// counts as insecure.
  function secureContextOk() {
    return window.isSecureContext === true ||
      location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  }

  // 'native' | 'zxing' | 'none'
  function detectorMode() {
    if (!cameraSupported() || !secureContextOk()) return Promise.resolve('none');
    if (!('BarcodeDetector' in window)) return Promise.resolve('zxing');
    return window.BarcodeDetector.getSupportedFormats().then(function (formats) {
      var usable = WANTED.filter(function (f) { return formats.indexOf(f) !== -1; });
      return usable.length ? 'native' : 'zxing';
    }).catch(function () { return 'zxing'; });
  }

  function whyUnavailable() {
    if (!cameraSupported()) return 'This browser will not give a web page camera access.';
    if (!secureContextOk()) {
      return 'The camera only works on an https:// page or on localhost. ' +
        'Open the served address rather than the file itself.';
    }
    return null;
  }

  // -------------------------------------------------------- check digits
  // Only used to sanity-check a hand-typed number. Scanners check this
  // themselves, so a scanned code that fails here is a genuine misread.

  function checkDigitValid(code) {
    if (!/^\d+$/.test(code)) return false;
    if (code.length !== 8 && code.length !== 12 && code.length !== 13) return true; // not our business
    var digits = code.split('').map(Number);
    var check = digits.pop();
    var sum = 0;
    // Weights alternate 3,1 reading right-to-left from the check digit.
    for (var i = digits.length - 1, w = 3; i >= 0; i--, w = (w === 3 ? 1 : 3)) {
      sum += digits[i] * w;
    }
    return ((10 - (sum % 10)) % 10) === check;
  }

  // ------------------------------------------------------------- loading

  var zxingPromise = null;
  function loadZxing() {
    if (window.ZXing) return Promise.resolve(window.ZXing);
    if (zxingPromise) return zxingPromise;
    zxingPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = ZXING_URL;
      s.integrity = ZXING_SRI;
      s.crossOrigin = 'anonymous';
      s.onload = function () {
        window.ZXing ? resolve(window.ZXing)
                     : reject(new Error('The barcode library loaded but looks wrong.'));
      };
      s.onerror = function () {
        zxingPromise = null;
        reject(new Error('Could not download the barcode library. Check your connection.'));
      };
      document.head.appendChild(s);
    });
    return zxingPromise;
  }

  // --------------------------------------------------------------- start

  /* opts:
   *   stage    - element the <video> gets built inside
   *   onResult - fn(code)      a barcode read twice in a row
   *   onStatus - fn(text)      progress worth showing the user
   *   onError  - fn(Error)
   */
  function start(opts) {
    stop();

    var err = whyUnavailable();
    if (err) { opts.onError(new Error(err)); return Promise.resolve(); }

    var video = document.createElement('video');
    video.setAttribute('playsinline', '');   // iOS: stay inline, do not go fullscreen
    video.muted = true;
    video.autoplay = true;
    opts.stage.innerHTML = '';
    opts.stage.appendChild(video);

    // One read is a guess; the same digits twice running is a barcode.
    var lastSeen = null;
    var done = false;
    function consider(code) {
      if (done || !code) return;
      code = String(code).trim();
      if (code !== lastSeen) { lastSeen = code; return; }
      done = true;
      if (navigator.vibrate) navigator.vibrate(60);
      stop();
      opts.onResult(code);
    }

    session = { video: video, stage: opts.stage, stream: null, reader: null, stopped: false };
    var mine = session;

    return detectorMode().then(function (mode) {
      if (mine.stopped) return;
      if (mode === 'native') return startNative(mine, consider, opts);
      return startZxing(mine, consider, opts);
    }).catch(function (e) {
      if (!mine.stopped) opts.onError(cameraError(e));
    });
  }

  function cameraError(e) {
    var name = e && e.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return new Error('Camera permission was refused. Allow it in the address bar, then try again.');
    }
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      return new Error('No camera found on this device.');
    }
    if (name === 'NotReadableError') {
      return new Error('The camera is busy in another app. Close that and try again.');
    }
    return e instanceof Error ? e : new Error('The camera would not start.');
  }

  function startNative(sess, consider, opts) {
    opts.onStatus('Starting the camera...');
    return navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } }
    }).then(function (stream) {
      if (sess.stopped) { stopTracks(stream); return; }
      sess.stream = stream;
      sess.video.srcObject = stream;
      return sess.video.play();
    }).then(function () {
      if (sess.stopped) return;
      return window.BarcodeDetector.getSupportedFormats();
    }).then(function (formats) {
      if (sess.stopped || !formats) return;
      var usable = WANTED.filter(function (f) { return formats.indexOf(f) !== -1; });
      var detector = new window.BarcodeDetector({ formats: usable });
      opts.onStatus('Point the camera at the barcode.');

      (function loop() {
        if (sess.stopped) return;
        if (sess.video.readyState < 2) { sess.timer = setTimeout(loop, 150); return; }
        detector.detect(sess.video).then(function (codes) {
          if (codes && codes.length) consider(codes[0].rawValue);
        }).catch(function () {
          // A single failed frame is normal; keep going.
        }).then(function () {
          if (!sess.stopped) sess.timer = setTimeout(loop, 120);
        });
      })();
    });
  }

  function startZxing(sess, consider, opts) {
    opts.onStatus('Loading the barcode reader...');
    return loadZxing().then(function (ZXing) {
      if (sess.stopped) return;
      var hints = new Map();
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
        ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8,
        ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E,
        ZXing.BarcodeFormat.CODE_128
      ]);
      var reader = new ZXing.BrowserMultiFormatReader(hints, 200);
      sess.reader = reader;
      opts.onStatus('Point the camera at the barcode.');
      return reader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } } },
        sess.video,
        function (result) { if (result) consider(result.getText()); }
      );
    });
  }

  function stopTracks(stream) {
    if (!stream) return;
    stream.getTracks().forEach(function (t) { t.stop(); });
  }

  // Idempotent. Always leaves the camera light off.
  function stop() {
    if (!session) return;
    var s = session;
    session = null;
    s.stopped = true;
    clearTimeout(s.timer);
    if (s.reader) {
      try { s.reader.reset(); } catch (e) { /* already torn down */ }
    }
    stopTracks(s.stream);
    if (s.video) s.video.srcObject = null;
    if (s.stage) s.stage.innerHTML = '';
  }

  return {
    cameraSupported: cameraSupported,
    secureContextOk: secureContextOk,
    detectorMode: detectorMode,
    whyUnavailable: whyUnavailable,
    checkDigitValid: checkDigitValid,
    start: start,
    stop: stop
  };
})();


/* CalTrack.off — Open Food Facts.
 *
 * Free, no key, no CORS trouble. Coverage is a different matter: it is a
 * volunteer database, strongest on European products, patchy on American
 * groceries, and the names people type in are often abbreviated to the point
 * of comedy. So this returns a DRAFT for the user to check, never a finished
 * food, and a miss is an ordinary outcome rather than an error.
 */
CalTrack.off = (function () {
  'use strict';

  var ENDPOINT = 'https://world.openfoodfacts.org/api/v2/product/';
  var FIELDS = 'code,product_name,generic_name,brands,quantity,product_quantity,' +
    'serving_size,serving_quantity,serving_quantity_unit,nutrition_data_per,nutriments';
  var TIMEOUT_MS = 10000;

  function num(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function fetchJson(url) {
    var controller = ('AbortController' in window) ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);
    var init = controller ? { signal: controller.signal } : {};
    return fetch(url, init).then(function (res) {
      clearTimeout(timer);
      if (res.status === 404) return null;          // no such product
      if (!res.ok) throw new Error('Open Food Facts answered with an error (' + res.status + ').');
      return res.json();
    }).catch(function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('Open Food Facts took too long to answer.');
      if (e instanceof TypeError) throw new Error('Could not reach Open Food Facts. Are you online?');
      throw e;
    });
  }

  // "NUTELLA HAZELNUT SPREAD" reads better as "Nutella Hazelnut Spread".
  function tidyName(name) {
    name = (name || '').trim();
    if (!name) return '';
    if (name === name.toUpperCase()) {
      // Not \b: it counts an apostrophe as a boundary, so NATURE'S OWN
      // would come out as Nature'S Own.
      name = name.toLowerCase().replace(/(^|[\s\-\/(,.])([a-z])/g,
        function (m, gap, c) { return gap + c.toUpperCase(); });
    }
    return name;
  }

  // brands is a comma list, most specific first: "Nutella, Ferrero, Yum yum".
  function firstBrand(brands) {
    return tidyName(String(brands || '').split(',')[0]);
  }

  function kcalPer100g(n) {
    var kcal = num(n['energy-kcal_100g']);
    if (kcal) return kcal;
    var kj = num(n['energy-kj_100g']);
    if (!kj && String(n.energy_unit || '').toLowerCase() === 'kj') kj = num(n.energy_100g);
    if (kj) return kj / 4.184;
    if (String(n.energy_unit || '').toLowerCase() === 'kcal') return num(n.energy_100g);
    return 0;
  }

  /* serving_size is free text typed by volunteers. Real examples:
   *   "1 serving (28 g)"   "3/4 cup (28 g) (28 g)"   "28g"   "355ml"   ""
   * Grams are the only part that can be trusted, so that is all this takes.
   */
  function parseServing(text) {
    text = String(text || '').trim();
    if (!text) return null;

    var grams = text.match(/([\d]+(?:[.,][\d]+)?)\s*g\b/i);
    if (!grams) {
      var ml = text.match(/([\d]+(?:[.,][\d]+)?)\s*(ml|fl\s*oz)\b/i);
      if (!ml) return null;
      // Still not a portion - but the number is worth keeping as a
      // starting weight the user can confirm or correct.
      var value = parseFloat(ml[1].replace(',', '.'));
      return {
        volumeOnly: text,
        approxMl: /oz/i.test(ml[2]) ? value * 29.5735 : value
      };
    }

    var value = parseFloat(grams[1].replace(',', '.'));
    if (!isFinite(value) || value <= 0) return null;

    // Name it properly only when the text is unambiguously one of something:
    // "1 slice (28 g)" -> slice. Anything fractional stays "serving", because
    // "3/4 cup (28 g)" does NOT mean a cup weighs 28 g.
    var name = 'serving';
    var one = text.match(/^\s*1\s+([a-z][a-z ]{0,18}?)\s*[\(,]/i);
    if (one) {
      var word = one[1].trim().toLowerCase();
      if (word && word !== 'serving' && word.indexOf('/') === -1) name = word;
    }
    return { name: name, grams: value };
  }

  /* The per-serving figures exactly as the label prints them.
   *
   * These are the numbers the user is looking at while they hold the packet,
   * so they beat anything derived from the per-100 g values. A tin of crisps
   * reports energy-kcal_serving 150 against a 28 g serving; deriving it from
   * 536 per 100 g gives 150.08, which is close but is not what the packet
   * says, and "the numbers don't add up" is exactly the complaint that gets.
   */
  function servingMacrosFrom(n) {
    var kcal = num(n['energy-kcal_serving']);
    if (!kcal) {
      var kj = num(n['energy-kj_serving']) || num(n.energy_serving);
      if (kj) kcal = kj / 4.184;
    }
    if (!kcal) return null;
    return {
      kcal: kcal,
      protein: num(n.proteins_serving),
      carbs: num(n.carbohydrates_serving),
      fat: num(n.fat_serving)
    };
  }

  /* What one serving is, in grams, from whichever field actually has it.
   *
   * serving_size is free text and often missing; serving_quantity is a clean
   * number but its unit is unreliable (Cheerios reports 28 "ml" for what the
   * text calls 28 g). Text first, number second.
   */
  function servingFrom(product) {
    var parsed = parseServing(product.serving_size);
    var grams = (parsed && parsed.grams) ? parsed.grams : 0;
    var name = (parsed && parsed.name) ? parsed.name : 'serving';
    var fromVolume = false;

    if (!grams) {
      var q = num(product.serving_quantity);
      var unit = String(product.serving_quantity_unit || '').toLowerCase();
      if (q > 0 && (unit === 'g' || unit === '')) {
        grams = q;
      } else if (q > 0 && unit === 'l') {
        grams = q * 1000; fromVolume = true;
      } else if (q > 0 && unit === 'ml') {
        grams = q; fromVolume = true;
      } else if (parsed && parsed.approxMl) {
        grams = parsed.approxMl; fromVolume = true;
      }
    }

    if (!grams) return null;
    return {
      name: name,
      grams: Math.round(grams * 100) / 100,
      fromVolume: fromVolume,
      macros: servingMacrosFrom(product.nutriments || {})
    };
  }

  function portionsFrom(product, serving) {
    var portions = [];
    var notes = [];

    if (serving) {
      portions.push({ name: serving.name, grams: serving.grams });
      if (serving.fromVolume) {
        notes.push('The label gives the serving as a volume, so ' + serving.grams +
          ' g is millilitres treated as grams. That is fine for a drink and ' +
          'wrong for anything denser, like oil - correct it if you need to.');
      }
    }

    // Whole-package weight, handy for "I ate the bag".
    var pkg = num(product.product_quantity);
    if (pkg > 0 && pkg <= 20000) {
      var already = portions.some(function (p) { return Math.abs(p.grams - pkg) < 0.5; });
      if (!already) portions.push({ name: 'package', grams: pkg });
    }
    return { portions: portions, notes: notes };
  }

  function draftFrom(product, code) {
    var n = product.nutriments || {};
    var serving = servingFrom(product);
    var built = portionsFrom(product, serving);
    var kcal = kcalPer100g(n);

    if (!kcal) {
      built.notes.push('Open Food Facts has this product but no calorie figure, ' +
        'so you will have to type the label yourself.');
    }
    if (!serving) {
      built.notes.push('It has no serving size on record, so you will need to ' +
        'read that off the packet - the nutrition below is per 100 g.');
    }

    return {
      barcode: code,
      name: tidyName(product.product_name) || tidyName(product.generic_name),
      brand: firstBrand(product.brands),
      per_100g: {
        kcal: kcal,
        protein: num(n.proteins_100g),
        carbs: num(n.carbohydrates_100g),
        fat: num(n.fat_100g)
      },
      portions: built.portions,
      source: 'openfoodfacts',
      // The label's own serving figures, for the form to show verbatim.
      // Not stored on the food; per_100g above is what gets saved.
      serving: serving,
      notes: built.notes
    };
  }

  /* Recover a serving size that the database lost.
   *
   * Volunteers usually type an American label, which is written per serving.
   * Open Food Facts stores the per-100 g conversion and sometimes drops the
   * serving field entirely - leaving figures like 419.35483870968 kcal, which
   * is 130 divided by 31 and multiplied by 100. The awkward decimals are the
   * fingerprint of the serving weight, so it can be read back out.
   *
   * Labels round hard: American ones give calories to a whole number and
   * macros to the nearest half gram. So the right weight is the one that
   * turns all four figures back into label-shaped numbers at once. Returns
   * the smallest weight that does, or null when nothing fits - it is offered
   * as a suggestion to confirm against the packet, never applied silently.
   */
  function nearestStep(v, step) {
    return Math.abs(v - Math.round(v / step) * step);
  }

  // Values arrive as x/y*100 divisions, so they land a hair off the mark.
  var TOL = 0.03;

  function labelShaped(kcal, macros) {
    if (nearestStep(kcal, 1) > TOL) return false;
    for (var i = 0; i < macros.length; i++) {
      if (nearestStep(macros[i], 0.5) > TOL) return false;
    }
    return true;
  }

  function inferServing(per) {
    if (!per || !(per.kcal > 0)) return null;

    var flat = [per.protein || 0, per.carbs || 0, per.fat || 0];

    /* If the per-100 g figures are ALREADY label-shaped, they were almost
     * certainly typed per 100 g and there is no lost serving to recover.
     * Guessing here produced nonsense - a "500 g serving" of chocolate
     * spread - so this leaves those alone.
     */
    if (labelShaped(per.kcal, flat)) return null;

    /* Half of a serving fits just as neatly as the serving does, so the
     * smallest match is not automatically the right one. Labels state whole
     * grams far more often than halves, so the fit with the most whole
     * numbers wins, and the smaller weight only breaks a tie.
     */
    var best = null;

    for (var g = 10; g <= 250; g++) {          // beyond this it is not a serving
      if (g === 100) continue;                 // restating per 100 g helps nobody
      var f = g / 100;
      var kcal = per.kcal * f;
      if (kcal < 15 || kcal > 900) continue;
      if (nearestStep(kcal, 1) > TOL) continue;

      var macros = [flat[0] * f, flat[1] * f, flat[2] * f];
      var hits = 0, whole = 0;
      for (var i = 0; i < macros.length; i++) {
        if (nearestStep(macros[i], 0.5) <= TOL) hits++;
        if (nearestStep(macros[i], 1) <= TOL) whole++;
      }
      if (hits < 3) continue;                  // all three have to line up

      if (!best || whole > best.whole) {
        best = {
          whole: whole,
          grams: g,
          kcal: Math.round(kcal),
          protein: Math.round(macros[0] * 2) / 2,
          carbs: Math.round(macros[1] * 2) / 2,
          fat: Math.round(macros[2] * 2) / 2
        };
      }
    }

    if (!best) return null;
    delete best.whole;
    return best;
  }

  // Resolves to a draft food, or null when the product is not in the database.
  function lookup(barcode) {
    var code = String(barcode).trim();
    return fetchJson(ENDPOINT + encodeURIComponent(code) + '.json?fields=' + FIELDS)
      .then(function (data) {
        if (!data || data.status === 0 || !data.product) return null;
        return draftFrom(data.product, data.code || code);
      });
  }

  return {
    lookup: lookup,
    // exported for the tests
    _parseServing: parseServing,
    _servingFrom: servingFrom,
    inferServing: inferServing,
    _servingMacrosFrom: servingMacrosFrom,
    _draftFrom: draftFrom,
    _kcalPer100g: kcalPer100g,
    _tidyName: tidyName,
    _firstBrand: firstBrand
  };
})();
