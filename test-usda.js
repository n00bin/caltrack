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

// --- searching by name --------------------------------------------------
// Results are re-sorted by dataset, because USDA ranks on text relevance
// alone and buries the prepared dishes under supermarket packets - and
// Branded entries carry no household portions, which is the whole point.
{
  const sorted = usda._rankResults([
    { name: 'a', dataType: 'Branded' },
    { name: 'b', dataType: 'Survey (FNDDS)' },
    { name: 'c', dataType: 'SR Legacy' },
    { name: 'd', dataType: 'Survey (FNDDS)' }
  ]);
  eq('prepared dishes come first', sorted[0].dataType, 'Survey (FNDDS)');
  eq('and stay in the order the API gave them', sorted[0].name + sorted[1].name, 'bd');
  eq('raw ingredients next', sorted[2].dataType, 'SR Legacy');
  eq('packets last, since the scanner covers those', sorted[3].dataType, 'Branded');
}

// A transient 400 must be retried, a real 404 must not.
ok('400 is retried', usda._shouldRetry(400));
ok('and 503', usda._shouldRetry(503));
ok('404 is not - the food is simply absent', !usda._shouldRetry(404));
ok('nor 403 - repeating a bad key is just slower', !usda._shouldRetry(403));
ok('nor 429', !usda._shouldRetry(429));

// Without a key, say so rather than failing obscurely.
usda.searchByName('cheeseburger', null).catch(function (e) {
  ok('searching with no key explains itself', /needs a USDA key/.test(e.message));
});

// --- which portion becomes the unit you count in ------------------------
/* Real data: USDA returns the nugget entries with the portions in opposite
 * orders, so whichever arrived first used to become the unit. A cup of
 * nuggets is a strange way to count nuggets.
 */
{
  const ranked = usda._rankPortions([
    { name: 'cup', grams: 140 },
    { name: 'nugget', grams: 16 }
  ]);
  eq('the countable thing wins over the measure', ranked[0].name, 'nugget');
  eq('and the measure is still there to pick', ranked[1].name, 'cup');
}
{
  // The other entry lists them the other way round; same answer.
  const ranked = usda._rankPortions([
    { name: 'nugget', grams: 16 },
    { name: 'cup', grams: 140 }
  ]);
  eq('order from the API does not decide it', ranked[0].name, 'nugget');
}
{
  // Among countable things, the smallest is the one you multiply.
  const ranked = usda._rankPortions([
    { name: 'loaf', grams: 500 },
    { name: 'slice', grams: 28 }
  ]);
  eq('a slice beats a loaf', ranked[0].name, 'slice');
}

ok('cup is a measure', usda._isMeasure('cup'));
ok('so is tbsp', usda._isMeasure('tbsp'));
ok('and fl oz', usda._isMeasure('fl oz'));
ok('and the word serving itself', usda._isMeasure('serving'));
ok('a nugget is not', !usda._isMeasure('nugget'));
ok('nor a slice', !usda._isMeasure('slice'));
ok('nor a cookie', !usda._isMeasure('cookie'));
ok('nor a cheeseburger', !usda._isMeasure('cheeseburger'));

// --- which key gets used ------------------------------------------------
// The key comes from Settings and nowhere else - nothing is committed to
// this repository. Nothing here touches the network; the suite runs offline.
eq('the key from Settings is used', usda.keyFor({ usda_api_key: 'mine-goes-here' }), 'mine-goes-here');
eq('blank is no key', usda.keyFor({ usda_api_key: '   ' }), null);
eq('no key configured', usda.keyFor({}), null);
eq('no settings at all', usda.keyFor(null), null);

// No key must mean no request, not a request that fails.
var called = false;
globalThis.fetch = function () { called = true; return Promise.reject(new Error('should not run')); };
usda.lookup('842798105464', null);
ok('without a key it never calls out', !called);

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
