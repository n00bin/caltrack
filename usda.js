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

  /* USDA answers a plain 400 to perfectly valid requests, intermittently -
   * measured at roughly one in five on identical URLs, with either space
   * encoding. It is their server, not the query, so a failed request is
   * retried rather than reported.
   *
   * Only transient statuses are retried. A 404 means the product genuinely
   * is not there, and a 401 or 403 means the key is wrong - repeating either
   * would just be slower.
   */
  var RETRY_STATUSES = [400, 500, 502, 503, 504];
  // Failures cluster rather than arriving independently, so a couple of
  // extra tries with a growing gap is worth more than a tighter loop.
  var MAX_ATTEMPTS = 4;
  var RETRY_DELAY_MS = 500;

  function fetchOnce(url) {
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
        if (!res.ok) {
          var err = new Error('USDA answered with an error (' + res.status + ').');
          err.status = res.status;
          throw err;
        }
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

  function fetchJson(url, attempt) {
    attempt = attempt || 1;
    return fetchOnce(url).catch(function (e) {
      var worthRetrying = e && RETRY_STATUSES.indexOf(e.status) !== -1;
      if (!worthRetrying || attempt >= MAX_ATTEMPTS) throw e;
      return new Promise(function (resolve) {
        setTimeout(resolve, RETRY_DELAY_MS * attempt);
      }).then(function () { return fetchJson(url, attempt + 1); });
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
      basis: (size && size.fromVolume) ? 'volume' : 'weight',
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

  /* Searching by name, for everything that has no barcode: a takeaway, a
   * plate in a restaurant, a raw ingredient.
   *
   * The dataset order matters. Survey (FNDDS) is the one built for asking
   * people what they ate, so it holds "Cheeseburger (McDonalds)" and
   * "General Tso chicken" as whole dishes. Foundation and SR Legacy carry
   * raw ingredients. Branded is packaged goods, which the barcode scanner
   * already covers, so it comes last.
   */
  /* Three datasets, not four: the API answers a 400 to a fourth dataType
   * parameter. Foundation is the one dropped - it holds a few hundred items
   * where SR Legacy holds thousands of the same kind, so it costs almost
   * nothing.
   */
  var SEARCH_TYPES = 'Survey (FNDDS),SR Legacy,Branded';

  // Nutrient numbers, which are stable where the names are not.
  var N_KCAL = '208', N_PROTEIN = '203', N_CARBS = '205', N_FAT = '204';

  /* USDA ranks purely on text relevance, so a search for "cheeseburger"
   * comes back as twenty frozen supermarket burgers and buries the one
   * that means a cheeseburger from a shop. Worse, Branded entries carry no
   * household portions at all, which is the whole reason to search by name.
   * So results are re-sorted by dataset, relevance order kept within each.
   */
  var TYPE_RANK = {
    'Survey (FNDDS)': 0,    // whole dishes, takeaways, restaurant food
    'Foundation': 1,        // not requested, but rank it if it ever appears
    'SR Legacy': 2,         // raw and generic ingredients
    'Branded': 3            // packaged, which the scanner already covers
  };

  /* Words that describe an amount rather than a thing.
   *
   * USDA returns portions in no useful order - chicken nuggets come back as
   * "1 cup 140 g" then "1 nugget 16 g" on one entry and the reverse on
   * another - so whichever landed first became the unit you logged in. A cup
   * of nuggets is a strange way to count nuggets.
   *
   * So a countable thing wins over a measure of volume, and among countable
   * things the smallest wins, since that is the one you can multiply. Pick
   * "nugget" and ten of them is ten; pick "cup" and you are estimating.
   */
  var MEASURE_WORDS = /^(cup|cups|tbsp|tablespoon|tablespoons|tsp|teaspoon|teaspoons|fl oz|floz|oz|ounce|ounces|ml|l|litre|liter|quart|pint|gallon|serving|servings|portion|portions|container|package|packet|bowl|plate|scoop)\b/i;

  function isMeasure(name) {
    return MEASURE_WORDS.test(String(name || '').trim());
  }

  function rankPortions(portions) {
    return portions.slice().sort(function (a, b) {
      var am = isMeasure(a.name) ? 1 : 0;
      var bm = isMeasure(b.name) ? 1 : 0;
      if (am !== bm) return am - bm;          // countable things first
      return a.grams - b.grams;               // then the smallest of them
    });
  }

  function rank(dataType) {
    var r = TYPE_RANK[dataType];
    return (r === undefined) ? 9 : r;
  }

  function rankResults(rows) {
    return rows.slice().sort(function (a, b) {
      return rank(a.dataType) - rank(b.dataType);
    });
  }

  function shouldRetry(status) {
    return RETRY_STATUSES.indexOf(status) !== -1;
  }

  function searchByName(query, apiKey, limit) {
    if (!apiKey) return Promise.reject(new Error(
      'Searching by name needs a USDA key. Settings has a box for one, and ' +
      'they are free from ' + SIGNUP_URL));
    if (!String(query || '').trim()) return Promise.resolve([]);

    var url = SEARCH + '?query=' + encodeURIComponent(query) +
      /* One dataType parameter per dataset. FDC answers a 400 to a
       * comma-separated list, whether the commas are encoded or not - it
       * only takes the parameter repeated.
       */
      SEARCH_TYPES.split(',').map(function (t) {
        return '&dataType=' + encodeURIComponent(t);
      }).join('') +
      '&pageSize=' + (limit || 20) +
      '&api_key=' + encodeURIComponent(apiKey);

    return fetchJson(url).then(function (data) {
      return ((data && data.foods) || []).map(function (f) {
        var by = {};
        (f.foodNutrients || []).forEach(function (n) {
          if (n.nutrientNumber) by[String(n.nutrientNumber)] = n.value;
        });
        return {
          fdcId: f.fdcId,
          name: tidy(f.description),
          brand: tidy(f.brandName || f.brandOwner),
          dataType: f.dataType,
          kcalPer100: num(by[N_KCAL])
        };
      }).filter(function (r) { return r.kcalPer100 > 0; })
        .sort(function (a, b) { return rank(a.dataType) - rank(b.dataType); });
    });
  }

  /* One result, in full. The search response carries enough for a list, but
   * not the household portions - "1 cheeseburger, 110 g" - which are the
   * whole point for food you did not weigh.
   */
  function byId(fdcId, apiKey) {
    return fetchJson(DETAIL + encodeURIComponent(fdcId) +
      '?api_key=' + encodeURIComponent(apiKey)).then(function (f) {
      if (!f) return null;

      var by = {};
      (f.foodNutrients || []).forEach(function (n) {
        var number = n.nutrient && n.nutrient.number;
        var unit = n.nutrient && n.nutrient.unitName;
        // Energy appears twice, as kilocalories and kilojoules.
        if (number === N_KCAL && unit && unit.toUpperCase() !== 'KCAL') return;
        if (number) by[String(number)] = n.amount;
      });

      var per100 = {
        kcal: num(by[N_KCAL]),
        protein: num(by[N_PROTEIN]),
        carbs: num(by[N_CARBS]),
        fat: num(by[N_FAT])
      };

      var portions = [];
      (f.foodPortions || []).forEach(function (p) {
        var grams = num(p.gramWeight);
        var label = String(p.portionDescription || p.modifier || '').trim();
        if (!(grams > 0) || !label) return;
        // FNDDS pads its list with this; it names no portion at all.
        if (/quantity not specified/i.test(label)) return;
        // "1 cheeseburger" is one of a thing, so the thing is the portion.
        var single = label.match(/^1\s+(.+)$/);
        portions.push({
          name: (single ? single[1] : label).toLowerCase().slice(0, 30),
          grams: grams
        });
      });

      portions = rankPortions(portions);

      var serving = portions.length
        ? { name: portions[0].name, grams: portions[0].grams, label: portions[0].name,
            macros: {
              kcal: per100.kcal * portions[0].grams / 100,
              protein: per100.protein * portions[0].grams / 100,
              carbs: per100.carbs * portions[0].grams / 100,
              fat: per100.fat * portions[0].grams / 100
            } }
        : null;

      var notes = ['From USDA, searched by name rather than scanned. Check it ' +
        'against what you actually ate - a restaurant portion is whatever they ' +
        'served you, not what the database averaged.'];

      return {
        barcode: null,
        name: tidy(f.description),
        brand: tidy(f.brandName || f.brandOwner),
        per_100g: per100,
        portions: portions.slice(0, 4),
        source: 'usda',
        basis: 'weight',
        serving: serving,
        notes: notes,
        usable: per100.kcal > 0
      };
    });
  }

  return {
    SIGNUP_URL: SIGNUP_URL,
    searchByName: searchByName,
    _rankResults: rankResults,
    _rankPortions: rankPortions,
    _isMeasure: isMeasure,
    _shouldRetry: shouldRetry,
    byId: byId,
    keyFor: keyFor,
    lookup: lookup,
    _draftFrom: draftFrom,
    _servingGrams: servingGrams,
    _labelMacros: labelMacros,
    _tidy: tidy,
    _sameCode: sameCode
  };
})();
