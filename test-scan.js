/* test-scan.js - checks the barcode maths and the Open Food Facts parsing
 * without a camera or a network. Run it with:  node test-scan.js
 *
 * The fixtures in test-fixtures/ are real captured API responses, including
 * the 404 for a real US store-brand bread barcode.
 */
const fs = require('fs');

// In a browser, window IS the global object - mirror that so `window.X = ...`
// creates a real global, exactly as scan.js expects.
globalThis.window = globalThis;

eval(fs.readFileSync(__dirname + '/scan.js', 'utf8'));
const scan = window.CalTrack.scan;
const off = window.CalTrack.off;

let fails = 0;
function eq(label, got, want) {
  const ok = (typeof got === 'number' && typeof want === 'number')
    ? Math.abs(got - want) < 1e-6
    : JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label +
    '  got=' + JSON.stringify(got) + (ok ? '' : ' want=' + JSON.stringify(want)));
  if (!ok) fails++;
}
function near2(label, got, want) {
  const good = Math.abs(got - want) < 1e-6;
  console.log((good ? 'PASS  ' : 'FAIL  ') + label + '  got=' + got);
  if (!good) fails++;
}
function ok(label, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) fails++;
}

// --- check digits ------------------------------------------------------
ok('EAN-13 valid (Nutella)', scan.checkDigitValid('3017620422003'));
ok('UPC-A valid (12 digits)', scan.checkDigitValid('072250007559'));
ok('same code padded to EAN-13', scan.checkDigitValid('0072250007559'));
ok('EAN-8 valid', scan.checkDigitValid('96385074'));
ok('single wrong digit rejected', !scan.checkDigitValid('3017620422004'));
ok('transposed digits rejected', !scan.checkDigitValid('3017620422030'));
ok('letters rejected', !scan.checkDigitValid('30176abc22003'));
ok('odd length left alone (Code 128)', scan.checkDigitValid('12345'));

// --- serving_size parsing, all strings seen in the live database --------
eq('"1 serving (28 g)"', off._parseServing('1 serving (28 g)'), { name: 'serving', grams: 28 });
eq('"1 slice (28 g)" keeps the noun', off._parseServing('1 slice (28 g)'), { name: 'slice', grams: 28 });
eq('"28g" bare', off._parseServing('28g'), { name: 'serving', grams: 28 });
eq('"30 g" spaced', off._parseServing('30 g'), { name: 'serving', grams: 30 });
eq('decimal comma', off._parseServing('28,5 g'), { name: 'serving', grams: 28.5 });

// The trap: 3/4 cup weighing 28 g does NOT make a cup 28 g, so it must not
// be recorded as a portion called "cup".
eq('"3/4 cup (28 g) (28 g)" stays generic',
  off._parseServing('3/4 cup (28 g) (28 g)'), { name: 'serving', grams: 28 });

eq('volume only is flagged, never treated as a portion',
  off._parseServing('355ml'), { volumeOnly: '355ml', approxMl: 355 });
eq('fluid ounces are converted to ml',
  off._parseServing('1 serving (16 fl oz)'),
  { volumeOnly: '1 serving (16 fl oz)', approxMl: 16 * 29.5735 });
eq('empty', off._parseServing(''), null);
eq('missing', off._parseServing(null), null);
eq('no number', off._parseServing('one slice'), null);

// --- energy ------------------------------------------------------------
eq('kcal used when present', off._kcalPer100g({ 'energy-kcal_100g': 539 }), 539);
eq('kJ converted when kcal missing',
  off._kcalPer100g({ 'energy-kj_100g': 2252 }), 2252 / 4.184);
eq('energy_100g in kJ converted',
  off._kcalPer100g({ energy_100g: 2252, energy_unit: 'kJ' }), 2252 / 4.184);
eq('energy_100g already kcal',
  off._kcalPer100g({ energy_100g: 539, energy_unit: 'kcal' }), 539);
eq('nothing at all', off._kcalPer100g({}), 0);

// --- names -------------------------------------------------------------
eq('shouty name title-cased',
  off._tidyName('NUTELLA HAZELNUT SPREAD'), 'Nutella Hazelnut Spread');
eq('normal name untouched', off._tidyName('Original Potato Crisps'), 'Original Potato Crisps');
eq('first brand only', off._firstBrand('Nutella, Ferrero, Yum yum'), 'Nutella');
eq('no brand', off._firstBrand(undefined), '');

// --- the serving fields, which are what the packet actually says --------
// Real values captured from the live API on 2026-08-30.
{
  const pringles = {
    serving_size: '1 serving (28 g)',
    serving_quantity: 28, serving_quantity_unit: 'g',
    nutriments: {
      'energy-kcal_100g': 536, proteins_100g: 3.5, carbohydrates_100g: 57, fat_100g: 32,
      'energy-kcal_serving': 150, proteins_serving: 0.98,
      carbohydrates_serving: 16, fat_serving: 8.96
    }
  };
  const sv = off._servingFrom(pringles);
  eq('serving weight taken from the label', sv.grams, 28);
  eq('and it is not a volume guess', sv.fromVolume, false);
  eq("the packet's own calories, not 536 x 0.28", sv.macros.kcal, 150);
  eq('and its protein', sv.macros.protein, 0.98);

  const d = off._draftFrom(pringles, '038000138416');
  eq('the draft carries the label figures through', d.serving.macros.kcal, 150);
  eq('and the portion', d.portions[0], { name: 'serving', grams: 28 });
}

// serving_quantity's unit is unreliable - Cheerios calls 28 g "28 ml".
// The free text is checked first, so it wins.
{
  const cheerios = {
    serving_size: '3/4 cup (28 g) (28 g)',
    serving_quantity: 28, serving_quantity_unit: 'ml',
    nutriments: { 'energy-kcal_100g': 393, 'energy-kcal_serving': 110 }
  };
  const sv = off._servingFrom(cheerios);
  eq('the written grams beat the mislabelled unit', sv.grams, 28);
  eq('not treated as a volume', sv.fromVolume, false);
  eq('110 kcal a bowl, as printed', sv.macros.kcal, 110);
}

// serving_quantity alone, with no free text at all.
{
  const sv = off._servingFrom({
    serving_quantity: 45, serving_quantity_unit: 'g',
    nutriments: { 'energy-kcal_serving': 180 }
  });
  eq('falls back to the numeric field', sv.grams, 45);
  eq('with its figures', sv.macros.kcal, 180);
}

// Nutella genuinely has no serving on record.
{
  const sv = off._servingFrom({ serving_size: null, nutriments: { 'energy-kcal_100g': 539 } });
  eq('no serving means no invention', sv, null);
  const d = off._draftFrom({ product_name: 'Nutella', nutriments: { 'energy-kcal_100g': 539 } }, '3017620422003');
  eq('and no portion is fabricated', d.portions, []);
  eq('the draft says so', d.serving, null);
  ok('and the user is told to read the packet',
    /no serving size on record/.test(d.notes.join(' ')));
}

// kJ-only serving figures still convert.
{
  const m = off._servingMacrosFrom({ 'energy-kj_serving': 628 });
  near2('628 kJ a serving is ~150 kcal', m.kcal, 628 / 4.184);
}
eq('no serving energy at all', off._servingMacrosFrom({}), null);

// --- a real API payload end to end -------------------------------------
const nutella = JSON.parse(fs.readFileSync(__dirname + '/test-fixtures/off-nutella.json', 'utf8'));
const draft = off._draftFrom(nutella.product, nutella.code);
eq('draft name', draft.name, 'Nutella');
eq('draft brand', draft.brand, 'Nutella');
eq('draft barcode', draft.barcode, '3017620422003');
eq('draft kcal', draft.per_100g.kcal, 539);
eq('draft protein', draft.per_100g.protein, 6.3);
eq('draft carbs', draft.per_100g.carbs, 57.5);
eq('draft fat', draft.per_100g.fat, 30.9);
eq('no serving data, so no portions', draft.portions, []);
eq('source recorded', draft.source, 'openfoodfacts');

// A product with a gram serving and a package weight gets both portions.
const withServing = off._draftFrom({
  product_name: 'Original Potato Crisps',
  brands: 'Pringles',
  serving_size: '1 serving (28 g)',
  product_quantity: 158,
  nutriments: { 'energy-kcal_100g': 536, proteins_100g: 4, carbohydrates_100g: 51, fat_100g: 35 }
}, '038000138416');
eq('serving + package portions', withServing.portions,
  [{ name: 'serving', grams: 28 }, { name: 'package', grams: 158 }]);

// A drink: volume is reported honestly rather than assumed to be grams.
const drink = off._draftFrom({
  product_name: 'Monster Energy', brands: 'Monster',
  serving_size: '1 serving (16 fl oz)',
  nutriments: { 'energy-kcal_100g': 48.6 }
}, '070847811169');
ok('a volume serving still yields a portion', drink.portions.length === 1);
// A volume becomes a portion, but only with the assumption spelled out.
eq('16 fl oz read as ~473 g', drink.portions[0].grams, Math.round(16 * 29.5735 * 100) / 100);
ok('and the assumption is stated', /millilitres treated as grams/.test(drink.notes.join(' ')));

// Missing calories must be called out, not silently saved as zero.
const empty = off._draftFrom({ product_name: 'Mystery', nutriments: {} }, '111');
eq('kcal zero', empty.per_100g.kcal, 0);
ok('missing calories flagged', /calorie/.test(empty.notes.join(' ')));

// --- a real 404 from the live API ---------------------------------------
const missing = JSON.parse(fs.readFileSync(__dirname + '/test-fixtures/off-not-found.json', 'utf8'));
eq('status 0 means not found', missing.status, 0);

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
