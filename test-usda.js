/* test-usda.js - the USDA FoodData Central mapping, offline.
 * Run it with:  node test-usda.js
 *
 * The fixture is a real captured record for barcode 842798105464 - the
 * product that exposed the whole problem, since Open Food Facts has it with
 * no serving size at all.
 */
const fs = require('fs');

globalThis.window = globalThis;
eval(fs.readFileSync(__dirname + '/usda.js', 'utf8'));
const usda = window.CalTrack.usda;

let fails = 0;
function eq(label, got, want) {
  const ok = (got && typeof got === 'object')
    ? JSON.stringify(got) === JSON.stringify(want)
    : got === want;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  got=' + JSON.stringify(got) +
    (ok ? '' : ' want=' + JSON.stringify(want)));
  if (!ok) fails++;
}
function near(label, got, want, tol) {
  const ok = Math.abs(got - want) <= (tol === undefined ? 1e-6 : tol);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  got=' + got);
  if (!ok) fails++;
}
function ok(label, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) fails++;
}

const grahams = JSON.parse(
  fs.readFileSync(__dirname + '/test-fixtures/usda-grahams.json', 'utf8'));

// --- the record that started it ----------------------------------------
{
  const d = usda._draftFrom(grahams, '842798105464');
  eq('usable', d.usable, true);
  eq('serving weight straight from USDA', d.serving.grams, 31);
  eq('and the printed calories', d.serving.macros.kcal, 130);
  eq('protein', d.serving.macros.protein, 2);
  eq('carbs', d.serving.macros.carbs, 24);
  eq('fat', d.serving.macros.fat, 3);

  // Which is exactly what Open Food Facts stored per 100 g, arrived at from
  // the other direction - 130/31*100.
  near('per 100 g agrees with what OFF holds', d.per_100g.kcal, 419.35483870968, 1e-6);
  near('protein likewise', d.per_100g.protein, 6.4516129032258, 1e-6);

  eq('the portion is recorded', d.portions, [{ name: 'serving', grams: 31 }]);
  eq('source is named', d.source, 'usda');
  ok('the household description is passed on', /2 full/.test(d.notes.join(' ')));
  eq('SHOUTY names are tidied and de-duplicated', d.name, 'Honey Graham Crackers');
  eq('brand name preferred over the owner', d.brand, "Freedom's Choice");
}

// --- serving weights ----------------------------------------------------
eq('grams', usda._servingGrams({ servingSize: 31, servingSizeUnit: 'g' }),
  { grams: 31, fromVolume: false });
eq('the older GRM unit code', usda._servingGrams({ servingSize: 45, servingSizeUnit: 'GRM' }),
  { grams: 45, fromVolume: false });
eq('millilitres are flagged, not silently taken as grams',
  usda._servingGrams({ servingSize: 240, servingSizeUnit: 'ml' }),
  { grams: 240, fromVolume: true });
eq('ounces are refused - not a weight we can trust',
  usda._servingGrams({ servingSize: 2, servingSizeUnit: 'oz' }), null);
eq('no serving at all', usda._servingGrams({}), null);

// --- label nutrients ----------------------------------------------------
eq('missing labelNutrients', usda._labelMacros({}), null);
eq('a zero-calorie panel is treated as absent',
  usda._labelMacros({ labelNutrients: { calories: { value: 0 } } }), null);
{
  const m = usda._labelMacros({ labelNutrients: { calories: { value: 90 } } });
  eq('calories alone still work', m.kcal, 90);
  eq('with the rest at zero', m.protein, 0);
}

// A record with figures but no serving weight cannot be used as one.
{
  const d = usda._draftFrom({
    description: 'MYSTERY BAR',
    labelNutrients: { calories: { value: 200 } }
  }, '111');
  eq('not usable without a serving weight', d.usable, false);
  ok('and it says why', /no serving weight/.test(d.notes.join(' ')));
}

// A drink measured in millilitres says so.
{
  const d = usda._draftFrom({
    description: 'SOME DRINK', servingSize: 240, servingSizeUnit: 'ml',
    labelNutrients: { calories: { value: 120 }, carbohydrates: { value: 30 } }
  }, '222');
  eq('usable', d.usable, true);
  ok('the volume assumption is stated', /millilitres treated as grams/.test(d.notes.join(' ')));
  near('per 100 g from a 240 ml serving', d.per_100g.kcal, 50);
}

// --- barcode matching ---------------------------------------------------
ok('same digits match', usda._sameCode('842798105464', '842798105464'));
ok('leading zeros are ignored', usda._sameCode('0038000138416', '38000138416'));
ok('padded to 14 digits still matches', usda._sameCode('00038000138416', '038000138416'));
ok('different codes do not match', !usda._sameCode('842798105464', '842798105465'));
ok('empty matches nothing', !usda._sameCode('', ''));
ok('null matches nothing', !usda._sameCode(null, '123'));

// --- no key, no call ----------------------------------------------------
usda.lookup('842798105464', null).then(function (r) {
  eq('without a key it stays quiet rather than erroring', r, null);
  console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
  process.exit(fails ? 1 : 0);
});
