/* foodsearch.js — searching food by name, offline.
 *
 * `food-db.json` is 13,000 foods lifted out of USDA's bulk download by
 * tools/build-food-db.py: whole dishes from the Survey dataset and raw
 * ingredients from SR Legacy, with their household portions.
 *
 * It exists because the API version of this needed a free key that everyone
 * had to go and get, a working connection while standing in a kitchen, and
 * tolerance for USDA answering a transient 400 to roughly one request in
 * five. A 1.5 MB file downloaded once and cached solves all three.
 *
 * Loaded lazily: nobody pays for it until they search.
 */
window.CalTrack = window.CalTrack || {};

CalTrack.foodsearch = (function () {
  'use strict';

  var DB_URL = 'food-db.json';

  // Column order in each record, matching the build script.
  var NAME = 0, KCAL = 1, PROTEIN = 2, CARBS = 3, FAT = 4, PORTIONS = 5, SET = 6;
  var SURVEY = 0;   // whole dishes; SR Legacy is 1

  var loading = null;
  var db = null;

  function load() {
    if (db) return Promise.resolve(db);
    if (loading) return loading;
    loading = fetch(DB_URL).then(function (res) {
      if (!res.ok) throw new Error('Could not load the food list (' + res.status + ').');
      return res.json();
    }).then(function (data) {
      db = data;
      loading = null;
      return db;
    }).catch(function (e) {
      loading = null;
      if (e instanceof TypeError) {
        throw new Error('Could not load the food list. It downloads once and ' +
          'then works offline, so try again with a connection.');
      }
      throw e;
    });
    return loading;
  }

  function ready() { return !!db; }
  function count() { return db ? db.foods.length : 0; }

  /* Scoring, in the order a person would rank them:
   *
   *  - the whole query as a phrase, at the start of the name, beats
   *    everything: "chicken nuggets" should find "Chicken nuggets, NFS"
   *    before "Soup, chicken with nuggets of something else"
   *  - then the phrase anywhere
   *  - then all the words present but scattered
   *
   * Shorter names win ties, because USDA names get more specific the longer
   * they run, and the plain one is usually what was meant.
   */
  function score(name, query, words) {
    var lower = name.toLowerCase();
    var at = lower.indexOf(query);

    var base;
    if (at === 0) base = 1000;
    else if (at > 0) base = 700 - Math.min(at, 200);
    else {
      for (var i = 0; i < words.length; i++) {
        if (lower.indexOf(words[i]) === -1) return -1;   // a word is missing
      }
      base = 300;
    }
    return base - Math.min(name.length, 120);
  }

  function search(query, limit) {
    if (!db) return [];
    var q = String(query || '').trim().toLowerCase();
    if (q.length < 2) return [];
    var words = q.split(/\s+/).filter(Boolean);

    var hits = [];
    var foods = db.foods;
    for (var i = 0; i < foods.length; i++) {
      var s = score(foods[i][NAME], q, words);
      if (s < 0) continue;
      // Whole dishes ahead of raw ingredients at the same score, since a
      // name search is usually someone asking about a meal.
      if (foods[i][SET] === SURVEY) s += 40;
      hits.push({ row: foods[i], score: s });
    }

    hits.sort(function (a, b) { return b.score - a.score; });

    return hits.slice(0, limit || 25).map(function (h) {
      return {
        name: h.row[NAME],
        kcalPer100: h.row[KCAL],
        isDish: h.row[SET] === SURVEY,
        row: h.row
      };
    });
  }

  /* One result, in the shape the food editor takes - the same shape a scan
   * produces, so nothing downstream can tell where a food came from.
   */
  function toDraft(result) {
    var row = result.row;
    var per100 = {
      kcal: row[KCAL],
      protein: row[PROTEIN],
      carbs: row[CARBS],
      fat: row[FAT]
    };

    // Ranked so the unit you count in comes first - a nugget, not a cup.
    var portions = CalTrack.usda.rankPortions(
      (row[PORTIONS] || []).map(function (p) {
        return { name: p[0], grams: p[1] };
      })
    );

    var serving = portions.length ? {
      name: portions[0].name,
      grams: portions[0].grams,
      label: portions[0].name,
      macros: {
        kcal: per100.kcal * portions[0].grams / 100,
        protein: per100.protein * portions[0].grams / 100,
        carbs: per100.carbs * portions[0].grams / 100,
        fat: per100.fat * portions[0].grams / 100
      }
    } : null;

    return {
      barcode: null,
      name: row[NAME],
      brand: '',
      per_100g: per100,
      portions: portions,
      source: 'usda-offline',
      basis: 'weight',
      serving: serving,
      usable: per100.kcal > 0,
      notes: ['From the USDA food list built into the app. Check it against ' +
        'what you actually ate - a restaurant portion is whatever they served ' +
        'you, not what the database averaged.']
    };
  }

  return {
    load: load,
    ready: ready,
    count: count,
    search: search,
    toDraft: toDraft,
    _score: score
  };
})();
