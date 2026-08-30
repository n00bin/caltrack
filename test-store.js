/* test-store.js - checks the data layer without needing a browser.
 * Run it with:  node test-store.js
 * It stubs localStorage in memory, so it never touches your real data.
 */
const fs = require('fs');

const mem = {};
// In a browser, window IS the global object - mirror that so `window.X = ...`
// creates a real global, exactly as store.js expects.
globalThis.window = globalThis;
window.localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};

eval(fs.readFileSync(__dirname + '/store.js', 'utf8'));
const store = window.CalTrack.store;
const nut = window.CalTrack.nutrition;

let fails = 0;
function check(label, got, want) {
  const ok = Math.abs(got - want) < 1e-9 || got === want;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  got=' + got + ' want=' + want);
  if (!ok) fails++;
}
function checkTrue(label, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) fails++;
}

(async function () {
  // --- the plan's own worked example -----------------------------------
  const bread = await store.foods.insert({
    barcode: '072250007559',
    name: "Nature's Own Butterbread",
    brand: "Nature's Own",
    per_100g: { kcal: 265, protein: 8, carbs: 49, fat: 3.5 },
    portions: [{ name: 'slice', grams: 28 }]
  });

  checkTrue('gram portion auto-added', bread.portions.some(p => p.name === 'gram'));
  check('2 slices -> grams', nut.gramsFor(bread, 'slice', 2), 56);
  check('2 slices -> kcal', nut.macrosFor(bread, 'slice', 2).kcal, 265 * 0.56);
  check('2 slices -> protein', nut.macrosFor(bread, 'slice', 2).protein, 8 * 0.56);
  check('100 g -> kcal', nut.macrosFor(bread, 'gram', 100).kcal, 265);
  check('unknown portion falls back to gram', nut.gramsFor(bread, 'nope', 10), 10);

  // --- dirty input is normalised ---------------------------------------
  const junk = await store.foods.insert({
    name: '  Mayo  ',
    per_100g: { kcal: '680', protein: null, carbs: undefined, fat: 'x' },
    portions: [{ name: 'tbsp', grams: 14 }, { name: '', grams: 5 }, { name: 'bad', grams: 0 }]
  });
  check('numeric strings coerced', junk.per_100g.kcal, 680);
  check('junk macros become 0', junk.per_100g.fat, 0);
  check('name trimmed', junk.name, 'Mayo');
  check('bad portions dropped (tbsp + gram)', junk.portions.length, 2);

  // --- log entries + totals --------------------------------------------
  const m = nut.macrosFor(bread, 'slice', 2);
  await store.log.insert({
    date: '2026-08-30', meal_time: 'lunch', food_id: bread.id, meal_id: null,
    food_name: 'Butterbread', portion: 'slice', qty: 2,
    computed_kcal: m.kcal, computed_protein_g: m.protein,
    computed_carbs_g: m.carbs, computed_fat_g: m.fat, user_id: null
  });
  await store.log.insert({
    date: '2026-08-30', meal_time: 'lunch', food_id: junk.id, meal_id: null,
    food_name: 'Mayo', portion: 'tbsp', qty: 1,
    computed_kcal: nut.macrosFor(junk, 'tbsp', 1).kcal,
    computed_protein_g: 0, computed_carbs_g: 0, computed_fat_g: 0, user_id: null
  });
  await store.log.insert({
    date: '2026-08-29', meal_time: 'dinner', food_id: bread.id, meal_id: null,
    food_name: 'Butterbread', portion: 'slice', qty: 1,
    computed_kcal: 74.2, computed_protein_g: 2.24,
    computed_carbs_g: 13.72, computed_fat_g: 0.98, user_id: null
  });

  const today = await store.log.query(e => e.date === '2026-08-30');
  check('entries filtered by date', today.length, 2);
  check('day total kcal', Math.round(nut.totals(today).kcal), Math.round(148.4 + 95.2));

  // --- update / remove --------------------------------------------------
  const edited = await store.foods.update(bread.id, { per_100g: { kcal: 270, protein: 8, carbs: 49, fat: 3.5 } });
  check('update applied', edited.per_100g.kcal, 270);
  check('update kept id', edited.id, bread.id);
  checkTrue('updated_at moved', edited.updated_at >= edited.created_at);
  checkTrue('past entry unaffected by edit', today[0].computed_kcal === 148.4);

  const deleted = await store.log.remove(today[1].id);
  check('remove returns count', deleted, 1);
  check('rows left', (await store.log.all()).length, 2);

  // --- meals: composite foods ------------------------------------------
  const byId = {};
  (await store.foods.all()).forEach(f => { byId[f.id] = f; });

  const sandwich = [
    { food_id: bread.id, portion: 'slice', qty: 2 },
    { food_id: junk.id, portion: 'tbsp', qty: 1 }
  ];
  const st = nut.sumItems(sandwich, byId);
  // bread was edited to 270 kcal/100g above; 2 slices = 56 g
  check('meal kcal is the sum of its parts', st.kcal, 270 * 0.56 + 680 * 0.14);
  check('meal weight is tracked too', st.grams, 56 + 14);
  check('nothing missing', st.missing, 0);

  // A deleted ingredient must be reported, never counted as zero.
  const broken = nut.sumItems(
    [{ food_id: bread.id, portion: 'slice', qty: 1 },
     { food_id: 'gone', portion: 'gram', qty: 50 }], byId);
  check('a deleted ingredient is flagged', broken.missing, 1);
  check('and the rest still adds up', broken.kcal, 270 * 0.28);

  // --- batch cooking: the pot of chilli ---------------------------------
  // 1200 kcal of ingredients, and the finished pot weighs 900 g.
  const pot = nut.per100gFrom({ kcal: 1200, protein: 90, carbs: 60, fat: 45 }, 900);
  check('pot kcal per 100 g', pot.kcal, 1200 / 9);
  check('pot protein per 100 g', pot.protein, 10);
  // A 300 g bowl is a third of the pot.
  check('a 300 g bowl is a third of it', pot.kcal * 3, 400);

  // Boiling water off concentrates it: same calories, less weight.
  const reduced = nut.per100gFrom({ kcal: 1200, protein: 90, carbs: 60, fat: 45 }, 600);
  checkTrue('a reduced sauce is denser per 100 g', reduced.kcal > pot.kcal);

  // --- typing a label per serving ---------------------------------------
  // The promise the form makes: type what the label says about ONE serving,
  // then log "1 slice" and get that number straight back.
  const label = { kcal: 70, protein: 2, carbs: 13, fat: 1 };
  const fromLabel = {
    per_100g: nut.per100gFrom(label, 28),
    portions: [{ name: 'slice', grams: 28 }, { name: 'gram', grams: 1 }]
  };
  check('one slice gives the label back', nut.macrosFor(fromLabel, 'slice', 1).kcal, 70);
  check('protein too', nut.macrosFor(fromLabel, 'slice', 1).protein, 2);
  check('two slices double it', nut.macrosFor(fromLabel, 'slice', 2).kcal, 140);
  check('and grams still work underneath', nut.macrosFor(fromLabel, 'gram', 28).kcal, 70);

  // Opening a saved food shows per-serving figures; saving converts them
  // back. That round trip must not drift the stored numbers.
  const roundTrip = nut.per100gFrom(
    { kcal: Math.round(nut.macrosFor(fromLabel, 'slice', 1).kcal * 100) / 100,
      protein: 0, carbs: 0, fat: 0 }, 28);
  checkTrue('editing and re-saving does not move the number',
    Math.abs(roundTrip.kcal - fromLabel.per_100g.kcal) < 0.05);

  // --- weigh to derive ---------------------------------------------------
  check('five slices weighing 140 g means 28 g each', nut.perUnitGrams(140, 5), 28);
  check('one item on the scale', nut.perUnitGrams(31.5, 1), 31.5);
  check('fractional counts work', nut.perUnitGrams(50, 2.5), 20);

  // --- settings ---------------------------------------------------------
  let s = await store.getSettings();
  check('settings default target', s.target_kcal, null);
  s = await store.saveSettings({ target_kcal: 2000 });
  check('settings saved', (await store.getSettings()).target_kcal, 2000);

  // --- backup round trip -------------------------------------------------
  const dump = await store.exportAll();
  await store.clearAll();
  check('cleared', (await store.foods.all()).length, 0);
  await store.importAll(dump);
  check('foods restored', (await store.foods.all()).length, 2);
  check('log restored', (await store.log.all()).length, 2);
  check('settings restored', (await store.getSettings()).target_kcal, 2000);

  let threw = false;
  try { await store.importAll({ nonsense: true }); } catch (e) { threw = true; }
  checkTrue('bad backup rejected', threw);

  let threw2 = false;
  try { await store.foods.update('no-such-id', { name: 'x' }); } catch (e) { threw2 = true; }
  checkTrue('update of missing row throws', threw2);

  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
})();
