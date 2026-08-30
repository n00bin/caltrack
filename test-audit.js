/* test-audit.js - the food-library checks. Run with:  node test-audit.js
 *
 * Every case here is a mistake that is easy to make while typing a label in
 * at arm's length in a kitchen.
 */
const fs = require('fs');

globalThis.window = globalThis;
eval(fs.readFileSync(__dirname + '/audit.js', 'utf8'));
const audit = window.CalTrack.audit;

let fails = 0;
function ok(label, cond, extra) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (cond || !extra ? '' : '  ' + extra));
  if (!cond) fails++;
}
function eq(label, got, want) {
  ok(label + '  got=' + JSON.stringify(got), got === want, 'want=' + JSON.stringify(want));
}

const food = (over) => Object.assign({
  id: 'x', name: 'Something', basis: 'weight',
  per_100g: { kcal: 400, protein: 10, carbs: 50, fat: 16 },
  portions: [{ name: 'serving', grams: 30 }, { name: 'gram', grams: 1 }]
}, over);

function messages(foods) {
  // detail included: several checks put the useful half there.
  return audit.local(foods)
    .map(f => f.severity + ': ' + f.message + ' ' + f.detail).join(' | ');
}
function has(foods, re) { return re.test(messages(foods)); }

// --- a food that is fine ------------------------------------------------
// 10x4 + 50x4 + 16x9 = 384, against 400. Close enough; real labels drift.
eq('a sound food raises nothing', audit.local([food()]).length, 0);

// --- the classic: per-serving figures typed into the per-100 boxes ------
{
  // A 30 g biscuit: 130 kcal, 2 P, 24 C, 3 F. Correct per serving, wrong here.
  const f = food({ per_100g: { kcal: 130, protein: 2, carbs: 24, fat: 3 } });
  // 2x4 + 24x4 + 3x9 = 131 against 130 - the arithmetic still holds, so this
  // one is NOT catchable by maths alone. Documented rather than pretended.
  eq('per-serving figures that are self-consistent slip through', audit.local([f]).length, 0);
}

// --- a decimal point in the wrong place ---------------------------------
ok('fat typed as 33 instead of 3.3',
  has([food({ per_100g: { kcal: 130, protein: 2, carbs: 24, fat: 33 } })], /macros imply/));
ok('calories ten times too big',
  has([food({ per_100g: { kcal: 4000, protein: 10, carbs: 50, fat: 16 } })], /not possible/));

// --- physically impossible ----------------------------------------------
ok('macros heavier than the food',
  has([food({ per_100g: { kcal: 500, protein: 40, carbs: 50, fat: 30 } })], /add up to/));
ok('negative values', has([food({ per_100g: { kcal: 100, protein: -5, carbs: 10, fat: 1 } })], /Negative/));
ok('no calories at all', has([food({ per_100g: { kcal: 0 } })], /No calories/));
ok('nothing beats pure fat', has([food({ per_100g: { kcal: 950, protein: 0, carbs: 0, fat: 100 } })], /pure fat is 900/));

// --- portions -----------------------------------------------------------
ok('a 3 g biscuit is worth a look',
  has([food({ portions: [{ name: 'cookie', grams: 3 }] })], /Smaller than most single items/));
ok('a two-kilo portion likewise',
  has([food({ portions: [{ name: 'bowl', grams: 2500 }] })], /over two kilos/));
ok('a portion with no weight',
  has([food({ portions: [{ name: 'slice', grams: 0 }] })], /no weight/));
ok('no serving at all is only a note',
  has([food({ portions: [{ name: 'gram', grams: 1 }] })], /note: No serving recorded/));

// --- drinks -------------------------------------------------------------
ok('milk measured in grams gets flagged',
  has([food({ name: 'Whole Milk', basis: 'weight' })], /looks like a drink/));
ok('milk measured in millilitres does not',
  !has([food({ name: 'Whole Milk', basis: 'volume' })], /looks like a drink/));
ok('a food that merely mentions water is not a drink',
  !has([food({ name: 'Watermelon Sweets' })], /looks like a drink/));

// --- one barcode, two foods ---------------------------------------------
{
  const two = [
    food({ id: 'a', name: 'Crackers', barcode: '111' }),
    food({ id: 'b', name: 'Crackers again', barcode: '111' })
  ];
  ok('a barcode on two foods', has(two, /is on 2 foods/));
  ok('and both are named', /Crackers, Crackers again/.test(messages(two)));
}
eq('different barcodes are fine',
  audit.local([food({ id: 'a', barcode: '111' }), food({ id: 'b', barcode: '222' })]).length, 0);

// --- unnamed ------------------------------------------------------------
ok('a food with no name', has([food({ name: '' })], /no name/));

// --- the summary --------------------------------------------------------
{
  const counts = audit.summarise(audit.local([
    food({ id: 'a', per_100g: { kcal: 0 } }),
    food({ id: 'b', name: 'Milk' }),
    food({ id: 'c' })
  ]));
  ok('errors counted', counts.error >= 1);
  ok('notes counted', counts.note >= 1);
  eq('and a clean library counts nothing', audit.summarise(audit.local([food()])).error, 0);
}

// Units follow the food, so a drink is never told off in grams.
ok('a drink is described in millilitres',
  /millilitre/.test(messages([food({
    name: 'Juice', basis: 'volume', portions: [{ name: 'gram', grams: 1 }]
  })])));

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
