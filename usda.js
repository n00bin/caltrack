/* usda.js — USDA FoodData Central, the second opinion.
 *
 * Open Food Facts is tried first: it needs no key and covers the world.
 * This is what gets asked when OFF misses, or when OFF has the product but
 * not its serving size — the case that made the numbers disagree with the
 * packet, because a per-100 g figure is not what a label prints.
 *
 * FDC returns `labelNutrients`, which IS the printed panel: calories,
 * protein, carbohydrates and fat for one serving, alongside `servingSize`
 * in grams. Nothing to derive and nothing to infer.
 *
 * It needs a free API key, which lives in the user's own settings and is
 * never committed here - this repository is public, and a key on a public
 * page is scraped within days and becomes a stranger's rate limit.
 *
 * Most scans never get this far. Open Food Facts is asked first, and when
 * its entry has no serving size the app borrows one from a duplicate entry
 * for the same product, which needs no key at all. USDA is the backstop for
 * what that misses.
 */
window.CalTrack = window.CalTrack || {};

CalTrack.usda = (function () {
  'use strict';

  var SEARCH = 'https://api.nal.usda.gov/fdc/v1/foods/search';
  var DETAIL = 'https://api.nal.usda.gov/fdc/v1/food/';
  var TIMEOUT_MS = 12000;
  var SIGNUP_URL = 'https://fdc.nal.usda.gov/api-key-signup.html';

  // Whatever key the user has put in Settings, or nothing.
  function keyFor(settings) {
    var own = settings && settings.usda_api_key;
    return (own && String(own).trim()) || null;
  }

  function num(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  // Barcodes are written with varying leading zeros. Compare the digits.
  function sameCode(a, b) {
    var x = String(a || '').replace(/\D/g, '').replace(/^0+/, '');
    var y = String(b || '').replace(/\D/g, '').replace(/^0+/, '');
    return x !== '' && x === y;
  }

  function fetchJson(url) {
    var controller = ('AbortController' in window) ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, TIMEOUT_MS);
    return fetch(url, controller ? { signal: controller.signal } : {})
      .then(function (res) {
        clearTimeout(timer);
        if (res.status === 401 || res.status === 403) {
          throw new Error('USDA rejected that API key. Check it in Settings, or get ' +
            'a new free one at ' + SIGNUP_URL);
        }
        if (res.status === 429) {
          throw new Error('USDA is rate-limiting your key. Try again in a little while.');
        }
        if (!res.ok) throw new Error('USDA answered with an error (' + res.status + ').');
        return res.json().catch(function () {
          throw new Error('USDA sent something that was not JSON.');
        });
      })
      .catch(function (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') throw new Error('USDA took too long to answer.');
        if (e instanceof TypeError) throw new Error('Could not reach USDA. Are you online?');
        throw e;
      });
  }

  // "31.0 g" / "240 ml" / the older GRM and MLT unit codes.
  function servingGrams(food) {
    var size = num(food.servingSize);
    if (!(size > 0)) return null;
    var unit = String(food.servingSizeUnit || '').trim().toLowerCase();
    if (unit === 'g' || unit === 'grm' || unit === 'gram' || unit === 'grams') {
      return { grams: size, fromVolume: false };
    }
    if (unit === 'ml' || unit === 'mlt' || unit === 'millilitre' || unit === 'milliliter') {
      return { grams: size, fromVolume: true };
    }
    return null;   // ounces, cups and the rest are not weights we can trust
  }

  // labelNutrients is the printed panel, per serving.
  function labelMacros(food) {
    var ln = food.labelNutrients;
    if (!ln || !ln.calories || !(num(ln.calories.value) > 0)) return null;
    return {
      kcal: num(ln.calories.value),
      protein: ln.protein ? num(ln.protein.value) : 0,
      carbs: ln.carbohydrates ? num(ln.carbohydrates.value) : 0,
      fat: ln.fat ? num(ln.fat.value) : 0
    };
  }

  // ALL CAPS descriptions are the norm here. "HONEY GRAHAM CRACKERS, HONEY"
  // also likes to repeat itself, so drop a trailing duplicate word.
  function tidy(text) {
    var s = String(text || '').trim();
    if (!s) return '';
    if (s === s.toUpperCase()) {
      // Capitalise after a gap only. \b treats an apostrophe as a word
      // boundary, which turns FREEDOM'S CHOICE into Freedom'S Choice.
      s = s.toLowerCase().replace(/(^|[\s\-\/(,.])([a-z])/g,
        function (m, gap, c) { return gap + c.toUpperCase(); });
    }
    var parts = s.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
    if (parts.length > 1 && parts[0].toLowerCase().indexOf(parts[parts.length - 1].toLowerCase()) !== -1) {
      parts.pop();
    }
    return parts.join(', ');
  }

  /* Turns one FDC record into the same shape CalTrack.off returns, so the
   * rest of the app cannot tell which database an answer came from.
   */
  function draftFrom(food, code) {
    var macros = labelMacros(food);
    var size = servingGrams(food);
    var notes = [];
    var portions = [];
    var serving = null;
    var per100 = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

    if (macros && size) {
      serving = {
        name: 'serving',
        grams: Math.round(size.grams * 100) / 100,
        fromVolume: size.fromVolume,
        label: String(food.householdServingFullText || '').trim(),
        macros: macros
      };
      portions.push({ name: serving.name, grams: serving.grams });
      var f = 100 / serving.grams;
      per100 = {
        kcal: macros.kcal * f, protein: macros.protein * f,
        carbs: macros.carbs * f, fat: macros.fat * f
      };
      if (size.fromVolume) {
        notes.push('USDA gives that serving as a volume, so ' + serving.grams +
          ' g is millilitres treated as grams. Fine for a drink, wrong for oil.');
      }
      var household = String(food.householdServingFullText || '').trim();
      if (household) {
        notes.push('USDA calls one serving "' + household + '".');
      }
    } else if (macros) {
      notes.push('USDA has the label figures but no serving weight, so you will ' +
        'need to read that off the packet.');
    }

    return {
      barcode: code,
      name: tidy(food.description),
      brand: tidy(food.brandName || food.brandOwner),
      per_100g: per100,
      portions: portions,
      source: 'usda',
      serving: serving,
      notes: notes,
      usable: !!(macros && size)
    };
  }

  /* Two calls: search finds the record by barcode, and only the detail
   * endpoint carries labelNutrients. Resolves to a draft, or null when the
   * barcode is not in FDC.
   */
  function lookup(barcode, apiKey) {
    if (!apiKey) return Promise.resolve(null);   // no key, no call
    var code = String(barcode).replace(/\D/g, '');
    // No quotes around the barcode: FDC answers a quoted query with a bare
    // nginx 400 before it reaches the API at all.
    var url = SEARCH + '?query=' + encodeURIComponent(code) +
      '&dataType=Branded&pageSize=10&api_key=' + encodeURIComponent(apiKey);

    return fetchJson(url).then(function (data) {
      var foods = (data && data.foods) || [];
      // The search is a text match, so confirm the barcode really is this one.
      var hit = foods.filter(function (f) { return sameCode(f.gtinUpc, code); })[0];
      if (!hit) return null;
      return fetchJson(DETAIL + hit.fdcId + '?api_key=' + encodeURIComponent(apiKey))
        .then(function (full) {
          return draftFrom(Object.assign({}, hit, full || {}), code);
        });
    });
  }

  return {
    SIGNUP_URL: SIGNUP_URL,
    keyFor: keyFor,
    lookup: lookup,
    _draftFrom: draftFrom,
    _servingGrams: servingGrams,
    _labelMacros: labelMacros,
    _tidy: tidy,
    _sameCode: sameCode
  };
})();
