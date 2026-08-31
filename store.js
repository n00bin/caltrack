/* store.js — the ONLY file that knows where the data physically lives.
 *
 * Phase 1: localStorage. Phase 3: Supabase.
 * Every function here returns a Promise, even though localStorage is
 * synchronous, because Supabase's calls are async. Writing the callers
 * against Promises now means the migration is a rewrite of THIS FILE ONLY.
 *
 * Table shapes mirror the planned Postgres schema 1:1:
 *   foods       (id, barcode, name, brand, per_100g, portions, source, user_id)
 *   meals       (id, name, items, user_id)
 *   log_entries (id, date, meal_time, food_id, meal_id, portion, qty,
 *                computed_kcal, computed_protein_g, computed_carbs_g,
 *                computed_fat_g, user_id)
 *   weigh_ins   (id, date, weight_lbs, user_id)
 *   activity    (id, date, type, duration_min, kcal_estimate, source, user_id)
 *   settings    (single row, keyed by user_id)
 *
 * In Postgres the object-valued columns (per_100g, portions, items) are jsonb.
 */
window.CalTrack = window.CalTrack || {};

CalTrack.store = (function () {
  'use strict';

  var PREFIX = 'caltrack.';
  var SCHEMA_VERSION = 1;
  var TABLES = ['foods', 'meals', 'log_entries', 'weigh_ins', 'activity'];

  var DEFAULT_SETTINGS = {
    user_id: null,
    goal_weight_lbs: null,
    target_rate_lbs_per_week: null,
    height_in: null,
    target_kcal: null,
    tdee_override: null,      // a burn rate the user has accepted as real
    // Used only to seed a starting target before there is enough logged
    // to measure one properly.
    age: null,
    sex: null,
    activity_level: null,
    body_fat_pct: null,
    estimated_tdee: null,
    usda_api_key: null,       // the user's own key; never shipped in the repo
    scale_divisor: null,      // raw scale units per pound; see bluetooth.js
    min_kcal: null            // overrides the default target floor
  };

  // --- low-level localStorage access ------------------------------------

  function readRaw(key, fallback) {
    try {
      var raw = window.localStorage.getItem(PREFIX + key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      console.error('[store] could not read ' + key, err);
      return fallback;
    }
  }

  function writeRaw(key, value) {
    try {
      window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
      return true;
    } catch (err) {
      // Quota exceeded, or a browser refusing storage in private mode.
      console.error('[store] could not write ' + key, err);
      throw new Error('Could not save - browser storage is full or blocked.');
    }
  }

  function newId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function nowIso() { return new Date().toISOString(); }

  // --- normalisation ----------------------------------------------------
  // Guarantees every food has sane per-100g numbers and always carries a
  // "gram" portion, so nothing downstream has to special-case it.

  function num(v) {
    var n = parseFloat(v);
    return isFinite(n) ? n : 0;
  }

  function normalizeFood(food) {
    var f = Object.assign({}, food);
    var p = f.per_100g || {};
    f.per_100g = {
      kcal: num(p.kcal),
      protein: num(p.protein),
      carbs: num(p.carbs),
      fat: num(p.fat)
    };
    var portions = Array.isArray(f.portions) ? f.portions.slice() : [];
    portions = portions
      .filter(function (x) { return x && x.name && num(x.grams) > 0; })
      .map(function (x) { return { name: String(x.name).trim(), grams: num(x.grams) }; });
    var hasGram = portions.some(function (x) { return x.name.toLowerCase() === 'gram'; });
    if (!hasGram) portions.push({ name: 'gram', grams: 1 });
    f.portions = portions;
    f.name = (f.name || '').trim();
    f.brand = (f.brand || '').trim();
    f.barcode = f.barcode ? String(f.barcode).trim() : null;
    f.source = f.source || 'manual';
    /* Drinks are recorded per 100 ml, not per 100 g. The arithmetic is
     * identical either way - one unit in, one unit out - so a millilitre is
     * stored in the same field a gram is. This only changes what the screens
     * CALL that unit, which matters: printing "240 g" against a carton that
     * says 240 ml is wrong, and weighing 240 ml of milk gives about 247 g.
     */
    f.basis = (f.basis === 'volume') ? 'volume' : 'weight';
    if (!('user_id' in f)) f.user_id = null;
    return f;
  }

  var NORMALIZERS = { foods: normalizeFood };

  function normalize(table, row) {
    var fn = NORMALIZERS[table];
    return fn ? fn(row) : row;
  }

  // --- generic table API ------------------------------------------------

  function all(table) {
    return Promise.resolve(readRaw(table, []));
  }

  function get(table, id) {
    return all(table).then(function (rows) {
      return rows.filter(function (r) { return r.id === id; })[0] || null;
    });
  }

  function query(table, predicate) {
    return all(table).then(function (rows) { return rows.filter(predicate); });
  }

  function insert(table, row) {
    return all(table).then(function (rows) {
      var record = normalize(table, Object.assign({}, row));
      record.id = record.id || newId();
      record.created_at = record.created_at || nowIso();
      record.updated_at = record.created_at;
      rows.push(record);
      writeRaw(table, rows);
      return record;
    });
  }

  function update(table, id, patch) {
    return all(table).then(function (rows) {
      var idx = -1;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].id === id) { idx = i; break; }
      }
      if (idx === -1) throw new Error('No ' + table + ' row with id ' + id);
      var merged = normalize(table, Object.assign({}, rows[idx], patch));
      merged.id = id;
      merged.updated_at = nowIso();
      rows[idx] = merged;
      writeRaw(table, rows);
      return merged;
    });
  }

  function remove(table, id) {
    return all(table).then(function (rows) {
      var kept = rows.filter(function (r) { return r.id !== id; });
      writeRaw(table, kept);
      return rows.length - kept.length; // how many rows went away
    });
  }

  // Lets callers read as store.foods.all(), store.log.insert(...), etc.
  function tableApi(name) {
    return {
      all: function () { return all(name); },
      get: function (id) { return get(name, id); },
      query: function (fn) { return query(name, fn); },
      insert: function (row) { return insert(name, row); },
      update: function (id, patch) { return update(name, id, patch); },
      remove: function (id) { return remove(name, id); }
    };
  }

  // --- settings (single row) --------------------------------------------

  function getSettings() {
    return Promise.resolve(Object.assign({}, DEFAULT_SETTINGS, readRaw('settings', {})));
  }

  function saveSettings(patch) {
    return getSettings().then(function (current) {
      var merged = Object.assign({}, current, patch);
      writeRaw('settings', merged);
      return merged;
    });
  }

  // --- backup -----------------------------------------------------------
  // localStorage is per-browser and easy to lose (clearing site data wipes
  // it). Export writes everything to one JSON file; import puts it back.

  function exportAll() {
    var dump = { schema_version: SCHEMA_VERSION, exported_at: nowIso(), tables: {} };
    TABLES.forEach(function (t) { dump.tables[t] = readRaw(t, []); });
    dump.tables.settings = readRaw('settings', {});
    return Promise.resolve(dump);
  }

  function importAll(dump, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      if (!dump || !dump.tables) throw new Error('That file is not a Calorie Tracker backup.');
      TABLES.forEach(function (t) {
        var incoming = Array.isArray(dump.tables[t]) ? dump.tables[t] : [];
        if (opts.merge) {
          var existing = readRaw(t, []);
          var seen = {};
          existing.forEach(function (r) { seen[r.id] = true; });
          incoming.forEach(function (r) { if (!seen[r.id]) existing.push(normalize(t, r)); });
          writeRaw(t, existing);
        } else {
          writeRaw(t, incoming.map(function (r) { return normalize(t, r); }));
        }
      });
      if (dump.tables.settings) writeRaw('settings', dump.tables.settings);
      resolve(true);
    });
  }

  function clearAll() {
    TABLES.forEach(function (t) { window.localStorage.removeItem(PREFIX + t); });
    window.localStorage.removeItem(PREFIX + 'settings');
    return Promise.resolve(true);
  }

  return {
    SCHEMA_VERSION: SCHEMA_VERSION,
    foods: tableApi('foods'),
    meals: tableApi('meals'),
    log: tableApi('log_entries'),
    weighIns: tableApi('weigh_ins'),
    activity: tableApi('activity'),
    getSettings: getSettings,
    saveSettings: saveSettings,
    exportAll: exportAll,
    importAll: importAll,
    clearAll: clearAll,
    newId: newId
  };
})();

/* nutrition - the portion maths from section 3 of the plan.
 * It lives beside the store because it is part of the data model: it is the
 * definition of what a stored food actually means.
 */
CalTrack.nutrition = (function () {
  'use strict';

  function findPortion(food, portionName) {
    var list = (food && food.portions) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].name.toLowerCase() === String(portionName || '').toLowerCase()) return list[i];
    }
    return { name: 'gram', grams: 1 };
  }

  // "2 slices" -> grams
  function gramsFor(food, portionName, qty) {
    var p = findPortion(food, portionName);
    var q = parseFloat(qty);
    return (isFinite(q) ? q : 0) * p.grams;
  }

  // grams -> macros, straight off the per-100g figures
  function macrosForGrams(food, grams) {
    var per = (food && food.per_100g) || { kcal: 0, protein: 0, carbs: 0, fat: 0 };
    var factor = grams / 100;
    return {
      kcal: per.kcal * factor,
      protein: per.protein * factor,
      carbs: per.carbs * factor,
      fat: per.fat * factor
    };
  }

  function macrosFor(food, portionName, qty) {
    return macrosForGrams(food, gramsFor(food, portionName, qty));
  }

  /* Adds up a meal: a list of {food_id, portion, qty} against a lookup of
   * foods by id. A food that has been deleted is counted as MISSING rather
   * than quietly as zero, because a meal that silently shrinks is worse
   * than one that admits it is broken.
   */
  function sumItems(items, foodsById) {
    var out = { kcal: 0, protein: 0, carbs: 0, fat: 0, grams: 0, missing: 0 };
    (items || []).forEach(function (it) {
      var food = foodsById[it.food_id];
      if (!food) { out.missing++; return; }
      var grams = gramsFor(food, it.portion, it.qty);
      var m = macrosForGrams(food, grams);
      out.kcal += m.kcal;
      out.protein += m.protein;
      out.carbs += m.carbs;
      out.fat += m.fat;
      out.grams += grams;
    });
    return out;
  }

  /* Batch cooking: everything that went into the pot, divided by what the
   * finished pot weighs. Water boils off and fat renders out, which is why
   * this uses the weight of the FINISHED dish rather than the sum of the
   * ingredients - the calories stay, the weight does not.
   */
  function per100gFrom(totals, finishedGrams) {
    var f = 100 / finishedGrams;
    return {
      kcal: totals.kcal * f,
      protein: totals.protein * f,
      carbs: totals.carbs * f,
      fat: totals.fat * f
    };
  }

  // Weigh-to-derive: five slices weighed 140 g, so a slice is 28 g.
  function perUnitGrams(totalGrams, count) {
    return totalGrams / count;
  }

  // Sums the snapshot values already stored on log entries.
  function totals(entries) {
    return entries.reduce(function (acc, e) {
      acc.kcal += e.computed_kcal || 0;
      acc.protein += e.computed_protein_g || 0;
      acc.carbs += e.computed_carbs_g || 0;
      acc.fat += e.computed_fat_g || 0;
      return acc;
    }, { kcal: 0, protein: 0, carbs: 0, fat: 0 });
  }

  return {
    findPortion: findPortion,
    gramsFor: gramsFor,
    macrosForGrams: macrosForGrams,
    macrosFor: macrosFor,
    sumItems: sumItems,
    per100gFrom: per100gFrom,
    perUnitGrams: perUnitGrams,
    totals: totals
  };
})();
