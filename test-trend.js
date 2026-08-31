/* test-trend.js - the adaptive TDEE and plateau logic, on synthetic data
 * where the right answer is known in advance. Run it with: node test-trend.js
 */
const fs = require('fs');

globalThis.window = globalThis;
eval(fs.readFileSync(__dirname + '/trend.js', 'utf8'));
const T = window.CalTrack.trend;

let fails = 0;
function near(label, got, want, tol) {
  const ok = Math.abs(got - want) <= (tol === undefined ? 1e-6 : tol);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  got=' +
    (typeof got === 'number' ? got.toFixed(3) : got) +
    (ok ? '' : ' want=' + want + ' +/-' + tol));
  if (!ok) fails++;
}
function eq(label, got, want) {
  const ok = (got && typeof got === 'object')
    ? JSON.stringify(got) === JSON.stringify(want)
    : got === want;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  got=' + JSON.stringify(got) +
    (ok ? '' : ' want=' + JSON.stringify(want)));
  if (!ok) fails++;
}
function ok(label, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) fails++;
}

// ------------------------------------------------------------ helpers

const DAY = 86400000;
function dstr(n) {
  const d = new Date(n * DAY);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') +
    '-' + String(d.getUTCDate()).padStart(2, '0');
}
const D0 = T.dayNumber('2026-01-01');

// A run of days: intake every day, weigh-in every day, weight falling at a
// steady rate with optional daily noise from a fixed seed.
function makeRun(opts) {
  const days = opts.days;
  const entries = [];
  const weighIns = [];
  let seed = opts.seed === undefined ? 7 : opts.seed;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 - 0.5; };

  for (let i = 0; i < days; i++) {
    const date = dstr(D0 + i);
    if (!opts.skipLog || !opts.skipLog(i)) {
      entries.push({ date, computed_kcal: typeof opts.intake === 'function' ? opts.intake(i) : opts.intake });
    }
    if (!opts.skipWeigh || !opts.skipWeigh(i)) {
      const trend = opts.startWeight - (opts.lbsPerDay || 0) * i;
      const noise = (opts.noise || 0) * rnd() * 2;
      weighIns.push({ date, weight_lbs: +(trend + noise + (opts.bump ? opts.bump(i) : 0)).toFixed(1) });
    }
  }
  return { entries, weighIns, asOf: dstr(D0 + days - 1) };
}

// ------------------------------------------- the plan's worked example
// "If you averaged 2,100 kcal and lost 2 lbs over 28 days, your real TDEE
//  is about 2,350."
{
  // 29 daily readings span 28 days, which is what "over 28 days" means.
  const run = makeRun({ days: 29, intake: 2100, startWeight: 220, lbsPerDay: 2 / 28 });
  const m = T.measureTdee({ entries: run.entries, weighIns: run.weighIns, asOf: run.asOf });
  near("the plan's example: TDEE from 2100 kcal and 2 lb in 28 days", m.tdee, 2350, 5);
  near('average intake', m.avgIntake, 2100, 0.5);
  // A 28-day window has 27 days between its first and last reading, so the
  // loss across it is 27/28 of 2 lb. Same rate, same TDEE - assert the rate.
  eq('a 28-day window spans 27 days end to end', m.days, 27);
  ok('and the change is a loss', m.weightChangeLbs < 0);
  near('losing at 2 lb per 28 days', -m.weightChangeLbs / m.days, 2 / 28, 0.001);
  eq('confidence with a full clean window', m.confidence, 'ok');
}

// The same truth recovered through realistic scale noise.
{
  const run = makeRun({ days: 29, intake: 2100, startWeight: 220, lbsPerDay: 2 / 28, noise: 1.5 });
  const m = T.measureTdee({ entries: run.entries, weighIns: run.weighIns, asOf: run.asOf });
  near('TDEE survives +/-1.5 lb of daily noise', m.tdee, 2350, 90);
}

// Maintenance: eating exactly TDEE, weight flat -> TDEE = intake.
{
  const run = makeRun({ days: 28, intake: 2400, startWeight: 200, lbsPerDay: 0 });
  const m = T.measureTdee({ entries: run.entries, weighIns: run.weighIns, asOf: run.asOf });
  near('flat weight means TDEE equals intake', m.tdee, 2400, 1);
}

// Gaining: TDEE must come out BELOW intake.
{
  const run = makeRun({ days: 28, intake: 3000, startWeight: 200, lbsPerDay: -1 / 27 });
  const m = T.measureTdee({ entries: run.entries, weighIns: run.weighIns, asOf: run.asOf });
  ok('gaining weight puts TDEE below intake', m.tdee < 3000);
  near('gaining 1 lb in 28 days', m.tdee, 3000 - 3500 / 27, 5);
}

// --------------------------------------------------- the warm-up trap
// Endpoint EMA differencing under-reads the loss in the first window, which
// would under-state TDEE and over-tighten the target. Regression must not.
{
  const run = makeRun({ days: 28, intake: 2100, startWeight: 220, lbsPerDay: 2 / 27 });
  const ema = T.emaSeries(run.weighIns);
  const endpointLoss = ema[0].ema - ema[ema.length - 1].ema;
  const fittedLoss = T.measuredLoss(ema, 27);
  ok('endpoint EMA really does under-read a fresh window', endpointLoss < 1.6);
  near('regression recovers the true 2 lb', fittedLoss, 2, 0.05);
  ok('and it is the more accurate of the two',
    Math.abs(fittedLoss - 2) < Math.abs(endpointLoss - 2));
}

// ------------------------------------------------------- confidence

{
  const run = makeRun({ days: 8, intake: 2000, startWeight: 200, lbsPerDay: 0.07 });
  const m = T.measureTdee({ entries: run.entries, weighIns: run.weighIns, asOf: run.asOf });
  eq('eight days is not enough to trust', m.confidence, 'none');
  ok('but it still shows a number with a caveat', m.tdee > 0);
  ok('and says why', /two weeks/.test(m.reason));
}
{
  const run = makeRun({ days: 16, intake: 2000, startWeight: 200, lbsPerDay: 0.07 });
  const m = T.measureTdee({ entries: run.entries, weighIns: run.weighIns, asOf: run.asOf });
  eq('sixteen days is an early estimate', m.confidence, 'low');
}
{
  // Plenty of days, but only weighed twice.
  const run = makeRun({ days: 28, intake: 2000, startWeight: 200, lbsPerDay: 0.07,
    skipWeigh: i => i !== 0 && i !== 27 });
  const m = T.measureTdee({ entries: run.entries, weighIns: run.weighIns, asOf: run.asOf });
  eq('two weigh-ins is not enough', m.confidence, 'none');
}
{
  const m = T.measureTdee({ entries: [], weighIns: [], asOf: '2026-02-01' });
  eq('nothing logged at all', m.tdee, null);
  eq('and no false confidence', m.confidence, 'none');
}

// A day with no food logged is NOT a zero-calorie day.
{
  const run = makeRun({ days: 28, intake: 2100, startWeight: 220, lbsPerDay: 2 / 27,
    skipLog: i => i % 7 === 3 });
  const m = T.measureTdee({ entries: run.entries, weighIns: run.weighIns, asOf: run.asOf });
  near('unlogged days are ignored, not counted as zero', m.avgIntake, 2100, 0.5);
  eq('only the logged days count', m.loggedDays, 24);
}

// ------------------------------------------------------ plateau tiers

const settings = { target_kcal: 2000, target_rate_lbs_per_week: 1, tdee_override: 2500 };

// Losing right on prediction: no alert.
{
  // 2500 burn - 2000 eaten = 500/day = 1 lb/week
  const run = makeRun({ days: 28, intake: 2000, startWeight: 220, lbsPerDay: 1 / 7 });
  const p = T.plateau({ entries: run.entries, weighIns: run.weighIns, settings, asOf: run.asOf });
  eq('on-track raises nothing', p.tier, 'none');
  near('ratio about 1', p.ratio, 1, 0.05);
}

// Dead flat for four weeks: confirmed.
{
  const run = makeRun({ days: 28, intake: 2000, startWeight: 220, lbsPerDay: 0 });
  const p = T.plateau({ entries: run.entries, weighIns: run.weighIns, settings, asOf: run.asOf });
  eq('flat for four weeks is confirmed', p.tier, 'confirmed');
  ok('and says so plainly', /flat/.test(p.message));
}

// Twelve days at a third of predicted: watch, not a verdict.
{
  const run = makeRun({ days: 12, intake: 2000, startWeight: 220, lbsPerDay: (1 / 7) * 0.3 });
  const p = T.plateau({ entries: run.entries, weighIns: run.weighIns, settings, asOf: run.asOf });
  eq('twelve days behind pace is a watch', p.tier, 'watch');
  ok('worded as uncertain', /water|check back/.test(p.message));
}

// Sixteen days badly behind: likely stall.
{
  const run = makeRun({ days: 16, intake: 2000, startWeight: 220, lbsPerDay: (1 / 7) * 0.15 });
  const p = T.plateau({ entries: run.entries, weighIns: run.weighIns, settings, asOf: run.asOf });
  eq('sixteen days badly behind is a likely stall', p.tier, 'likely');
}

// Nine days is too early for anything, however bad it looks.
{
  const run = makeRun({ days: 9, intake: 2000, startWeight: 220, lbsPerDay: 0 });
  const p = T.plateau({ entries: run.entries, weighIns: run.weighIns, settings, asOf: run.asOf });
  eq('nine days raises nothing', p.tier, 'none');
}

// ------------------------------------------------- false-positive guards

{
  // Flat, but only weighed three times.
  const run = makeRun({ days: 28, intake: 2000, startWeight: 220, lbsPerDay: 0,
    skipWeigh: i => [0, 13, 27].indexOf(i) === -1 });
  const p = T.plateau({ entries: run.entries, weighIns: run.weighIns, settings, asOf: run.asOf });
  eq('too few weigh-ins mutes the alert', p.tier, 'none');
  eq('but records what it would have said', p.wouldHaveBeen, 'confirmed');
  ok('and tells the user why', /weigh-in/.test(p.suppressedBy.join(' ')));
}
{
  // Flat, but a five-day hole in the food log.
  const run = makeRun({ days: 28, intake: 2000, startWeight: 220, lbsPerDay: 0,
    skipLog: i => i >= 10 && i <= 14 });
  const p = T.plateau({ entries: run.entries, weighIns: run.weighIns, settings, asOf: run.asOf });
  eq('a logging gap mutes the alert', p.tier, 'none');
  ok('named as a gap', /gap/.test(p.suppressedBy.join(' ')));
}
{
  // Flat, with one salty overnight jump.
  const run = makeRun({ days: 28, intake: 2000, startWeight: 220, lbsPerDay: 0,
    bump: i => (i === 20 ? 4.2 : 0) });
  const p = T.plateau({ entries: run.entries, weighIns: run.weighIns, settings, asOf: run.asOf });
  eq('a 4 lb overnight jump mutes the alert', p.tier, 'none');
  ok('named as salt rather than fat', /salt/.test(p.suppressedBy.join(' ')));
}

// No deficit at all is not a plateau - it is arithmetic.
{
  const run = makeRun({ days: 28, intake: 2600, startWeight: 220, lbsPerDay: 0 });
  const p = T.plateau({ entries: run.entries, weighIns: run.weighIns, settings, asOf: run.asOf });
  eq('eating above burn is not a stall', p.tier, 'none');
  ok('and says the deficit is the problem', /no deficit to stall/.test(p.message));
}

// With no target set, a well-measured burn becomes the reference by itself.
{
  const run = makeRun({ days: 28, intake: 2000, startWeight: 220, lbsPerDay: 0 });
  const p = T.plateau({ entries: run.entries, weighIns: run.weighIns, settings: {}, asOf: run.asOf });
  const m = T.measureTdee({ entries: run.entries, weighIns: run.weighIns, asOf: run.asOf });
  eq('the measured burn stands in for a missing target', T.assumedTdee({}, m), m.tdee);
  eq('flat weight at your own burn rate is not a stall', p.tier, 'none');
  ok('and the message points at the deficit, not a plateau',
    /no deficit to stall/.test(p.message));
}

// Nine days in, with nothing set: there is genuinely nothing to compare to.
{
  const run = makeRun({ days: 9, intake: 2000, startWeight: 220, lbsPerDay: 0 });
  const p = T.plateau({ entries: run.entries, weighIns: run.weighIns, settings: {}, asOf: run.asOf });
  eq('no reference means no verdict', p.tier, 'none');
  ok('explained', /nothing to compare/.test(p.message));
}

// --------------------------------------------------------- adjustment

{
  const a = T.adjustment({ tdee: 2350, settings: { target_kcal: 2000, target_rate_lbs_per_week: 1 } });
  eq('new target is measured burn minus the rate', a.newTarget, Math.round(2350 - 500));
  eq('not capped', a.cappedAtFloor, false);
  eq('shows the change against the old target', a.change, -150);
  ok('offers the activity lever too', a.activityKcalPerDay >= 0);
}
{
  // A small person on a fast rate: the floor has to bite.
  const a = T.adjustment({ tdee: 1700, settings: { target_kcal: 1400, target_rate_lbs_per_week: 2 } });
  eq('capped at the floor', a.cappedAtFloor, true);
  eq('floor is 75% of measured burn here', a.floor, 1500);
  ok('never suggests below the floor', a.newTarget >= a.floor);
  ok('tells the user a diet break is the answer', /diet break|maintenance/.test(a.note));
}
{
  const a = T.adjustment({ tdee: 3000, settings: { target_kcal: 2400, target_rate_lbs_per_week: 1 } });
  eq('floor tracks 75% of burn for larger appetites', a.floor, 2250);
  eq('and the target sits above it', a.newTarget, 2500);
}
{
  // Keep eating 2400 against a 2350 burn: the shortfall has to be moved.
  const a = T.adjustment({ tdee: 2350, settings: { target_kcal: 2400, target_rate_lbs_per_week: 1 } });
  near('activity lever covers the whole gap', a.activityKcalPerDay, 550, 1);
}
eq('no TDEE means no advice', T.adjustment({ tdee: null, settings: {} }), null);

// ------------------------------------------ the starting estimate
// Mifflin-St Jeor, worked by hand: 180 lb, 5'10", 30 years old.
//   kg = 180 x 0.45359237 = 81.6466
//   cm = 70 x 2.54        = 177.8
//   base = 10(81.6466) + 6.25(177.8) - 5(30) = 1777.716
{
  const male = T.estimateBmr({ weightLbs: 180, heightIn: 70, age: 30, sex: 'male' });
  near('Mifflin-St Jeor, male constant +5', male.bmr, 1777.716 + 5, 0.01);
  eq('names the formula', male.formula, 'Mifflin-St Jeor');

  const female = T.estimateBmr({ weightLbs: 180, heightIn: 70, age: 30, sex: 'female' });
  near('Mifflin-St Jeor, female constant -161', female.bmr, 1777.716 - 161, 0.01);
  near('the two forms differ by exactly 166', male.bmr - female.bmr, 166, 0.01);

  // Katch-McArdle needs neither age nor sex: 180 lb at 20% fat is 144 lb lean.
  const bf = T.estimateBmr({ weightLbs: 180, bodyFatPct: 20 });
  near('Katch-McArdle from lean mass', bf.bmr, 370 + 21.6 * (144 * 0.45359237), 0.01);
  eq('names that formula too', bf.formula, 'Katch-McArdle');
  eq('and says it used body fat', bf.usedBodyFat, true);

  // Body fat wins when it is known, even with everything else supplied.
  const both = T.estimateBmr({ weightLbs: 180, heightIn: 70, age: 30, sex: 'male', bodyFatPct: 20 });
  eq('body fat takes precedence', both.formula, 'Katch-McArdle');

  // Nonsense body fat falls back rather than producing a silly number.
  const silly = T.estimateBmr({ weightLbs: 180, heightIn: 70, age: 30, sex: 'male', bodyFatPct: 95 });
  eq('an impossible body fat is ignored', silly.formula, 'Mifflin-St Jeor');
}

// Missing inputs must say what is missing, not guess.
ok('no weight is an error', !!T.estimateBmr({ heightIn: 70, age: 30 }).error);
ok('no height is an error', !!T.estimateBmr({ weightLbs: 180, age: 30 }).error);
ok('no age is an error', !!T.estimateBmr({ weightLbs: 180, heightIn: 70 }).error);
ok('an empty profile is an error', !!T.estimateTdee({}).error);

// Activity multipliers
{
  const sed = T.estimateTdee({ weightLbs: 180, heightIn: 70, age: 30, sex: 'male', activity: 'sedentary' });
  near('sedentary is BMR x 1.2', sed.tdee, sed.bmr * 1.2, 0.01);
  const hard = T.estimateTdee({ weightLbs: 180, heightIn: 70, age: 30, sex: 'male', activity: 'athlete' });
  near('athlete is BMR x 1.9', hard.tdee, hard.bmr * 1.9, 0.01);
  ok('more activity means a higher burn', hard.tdee > sed.tdee);
  eq('an unknown activity falls back to sedentary',
    T.estimateTdee({ weightLbs: 180, heightIn: 70, age: 30, activity: 'nonsense' }).activity, 'sedentary');
}

// The whole suggestion, and its floor.
{
  const s = T.suggestTarget(
    { weightLbs: 180, heightIn: 70, age: 30, sex: 'male', activity: 'sedentary' },
    { target_rate_lbs_per_week: 1 });
  eq('target is the estimate minus 500 a day', s.target, Math.round(s.tdee - 500));
  eq('deficit stated', s.deficit, 500);
  eq('not capped for this profile', s.cappedAtFloor, false);
  ok('and it admits it is a formula', /formula, not a measurement/.test(s.caveat));

  // A small person chasing 2 lb a week has to hit the floor.
  const tight = T.suggestTarget(
    { weightLbs: 120, heightIn: 62, age: 55, sex: 'female', activity: 'sedentary' },
    { target_rate_lbs_per_week: 2 });
  eq('the floor bites', tight.cappedAtFloor, true);
  ok('and the target respects it', tight.target >= tight.floor);
  ok('never below the absolute floor', tight.target >= 1500 * 0.999);
}

// The reference chain: an estimate is better than nothing, and worse than
// a measurement. It must sit in exactly that order.
{
  const run = makeRun({ days: 28, intake: 2000, startWeight: 220, lbsPerDay: 1 / 7 });
  const m = T.measureTdee({ entries: run.entries, weighIns: run.weighIns, asOf: run.asOf });
  ok('the measurement is trustworthy here', m.confidence !== 'none');

  eq('an accepted burn rate beats everything',
    T.assumedTdee({ tdee_override: 2600, estimated_tdee: 2100, target_kcal: 1800,
                    target_rate_lbs_per_week: 1 }, m), 2600);
  eq('a good measurement beats the formula',
    T.assumedTdee({ estimated_tdee: 2100 }, m), m.tdee);
  eq('the formula is used when the measurement is not ready',
    T.assumedTdee({ estimated_tdee: 2100 }, { tdee: 9999, confidence: 'none' }), 2100);
  eq('and the target implies one when there is no formula either',
    T.assumedTdee({ target_kcal: 1800, target_rate_lbs_per_week: 1 },
                  { tdee: 9999, confidence: 'none' }), 1800 + 500);
  eq('nothing at all means nothing',
    T.assumedTdee({}, { tdee: 9999, confidence: 'none' }), null);
}

// The estimate and the measurement must agree on how a target is derived.
{
  const settings = { target_rate_lbs_per_week: 1 };
  const viaAdjustment = T.adjustment({ tdee: 2400, settings: settings });
  const viaTarget = T.targetFor(2400, settings);
  eq('one shared rule for the target', viaAdjustment.newTarget, viaTarget.target);
  eq('and one shared floor', viaAdjustment.floor, viaTarget.floor);
}

// ------------------------------------------------------------ BMI
// 703 x 180 / 70^2 = 25.83
near('BMI for 180 lb at 5 foot 10', T.bmi(180, 70).bmi, 703 * 180 / 4900, 1e-9);
eq('and its band', T.bmi(180, 70).category, 'the overweight range');
eq('healthy', T.bmi(150, 70).category, 'the healthy range');
eq('under', T.bmi(120, 70).category, 'under the healthy range');
eq('obese', T.bmi(220, 70).category, 'the obese range');
eq('no height, no BMI', T.bmi(180, 0), null);
eq('no weight, no BMI', T.bmi(0, 70), null);
// The boundary belongs to the band above it: 25 x 4900 / 703 lb is exactly 25.
eq('exactly 25 is overweight, not healthy',
  T.bmi(25 * 4900 / 703, 70).category, 'the overweight range');
eq('a hair under 25 is still healthy', T.bmi(174.2, 70).category, 'the healthy range');

// --- the healthy band, in pounds ----------------------------------------
// BMI already divides out height, so the BAND is the same for everyone and
// only the weight it corresponds to moves. These must round-trip exactly.
{
  const r = T.healthyWeightRange(70);
  near('the bottom of the band is BMI 18.5', T.bmi(r.min, 70).bmi, 18.5, 1e-9);
  near('and the top is BMI 25', T.bmi(r.max, 70).bmi, 25, 1e-9);
  near('which at 5 foot 10 is about 129 lb', r.min, 129, 0.5);
  near('to about 174 lb', r.max, 174, 0.5);
}
{
  // Taller means the same band lands on more pounds.
  const short = T.healthyWeightRange(62);
  const tall = T.healthyWeightRange(76);
  ok('a taller person has a heavier healthy range', tall.min > short.min);
  near('but both ends are still BMI 18.5', T.bmi(tall.min, 76).bmi, 18.5, 1e-9);
  near('and 25', T.bmi(short.max, 62).bmi, 25, 1e-9);
}
eq('no height, no range', T.healthyWeightRange(0), null);
eq('nor a negative one', T.healthyWeightRange(-70), null);

// --- the BMI bar --------------------------------------------------------
{
  const segs = T.bmiSegments();
  eq('four bands', segs.length, 4);
  eq('they start at the bottom of the bar', segs[0].from, T.BMI_MIN);
  eq('and finish at the top', segs[segs.length - 1].to, T.BMI_MAX);
  near('the widths add up to the whole bar',
    segs.reduce((a, s) => a + s.widthPct, 0), 100, 1e-9);

  // Each band has to end where the next begins, or the bar lies.
  for (let i = 1; i < segs.length; i++) {
    eq('band ' + i + ' begins where band ' + (i - 1) + ' ended',
      segs[i].from, segs[i - 1].to);
  }

  // A low BMI is not the "good" end - it carries its own risk.
  eq('under 18.5 is not green', segs[0].tone, 'low');
  eq('the healthy band is', segs[1].tone, 'good');
  eq('overweight', segs[2].tone, 'warn');
  eq('obese', segs[3].tone, 'high');
}

near('the bottom of the scale is the left edge', T.bmiPercent(15), 0);
near('the top is the right edge', T.bmiPercent(40), 100);
near('the healthy threshold sits where its band starts', T.bmiPercent(18.5), 14);
near('and 25 where the next begins', T.bmiPercent(25), 40);
// Off-scale values clamp rather than running off the end of the bar.
near('a very low BMI clamps to the left', T.bmiPercent(9), 0);
near('a very high one clamps to the right', T.bmiPercent(70), 100);

// The marker and the band must agree about which colour someone is in.
{
  const at = (v) => T.bmiSegments().filter(s => v >= s.from && v < s.to)[0];
  eq('a BMI of 22 lands in the healthy band', at(22).tone, 'good');
  eq('and 27 in the overweight one', at(27).tone, 'warn');
  eq('which matches what bmi() calls it', T.bmi(703 * 27 * 4900 / 703 / 4900, 70) &&
    T.bmi(188.1, 70).category, 'the overweight range');
}

// ------------------------------------------- lean and fat mass
{
  // 200 lb at 25% fat -> 50 lb fat, 150 lb lean.
  const c = T.composition([
    { date: '2026-01-01', weight_lbs: 200, body_fat_pct: 25 },
    { date: '2026-02-12', weight_lbs: 190, body_fat_pct: 20 }
  ]);
  eq('two readings used', c.readings, 2);
  near('fat mass at the start', c.first.fatMass, 50);
  near('lean mass at the start', c.first.leanMass, 150);
  near('fat mass at the end', c.last.fatMass, 38);
  near('lean mass at the end', c.last.leanMass, 152);
  near('so 12 lb of fat went', c.fatChange, -12, 1e-9);
  near('and 2 lb of lean arrived', c.leanChange, 2, 1e-9);
  near('while the scale moved 10', c.weightChange, -10, 1e-9);
  eq('42 days spanned', c.days, 42);
}

// Readings without a body fat figure are ignored rather than assumed.
{
  const c = T.composition([
    { date: '2026-01-01', weight_lbs: 200, body_fat_pct: 25 },
    { date: '2026-01-02', weight_lbs: 199 },
    { date: '2026-01-03', weight_lbs: 198, body_fat_pct: 24.6 }
  ]);
  eq('only the measured ones count', c.readings, 2);
}
eq('an impossible body fat is skipped',
  T.composition([{ date: '2026-01-01', weight_lbs: 200, body_fat_pct: 95 }]).readings, 0);
eq('no readings at all', T.composition([]).readings, 0);
eq('one reading is not a trend', T.composition(
  [{ date: '2026-01-01', weight_lbs: 200, body_fat_pct: 25 }]).first, null);

// Confidence: body fat readings are noisy, so a fortnight is not enough.
{
  const many = [];
  for (let i = 0; i < 8; i++) {
    const d = new Date(T.dayNumber('2026-01-01') * 86400000 + i * 5 * 86400000);
    many.push({
      date: T.dateFromDay(T.dayNumber('2026-01-01') + i * 5),
      weight_lbs: 200 - i, body_fat_pct: 25 - i * 0.3
    });
  }
  eq('eight readings over 35 days is trustworthy', T.composition(many).confidence, 'ok');
  // Readings are five days apart, so four of them span fifteen days.
  eq('four readings over a fortnight is early',
    T.composition(many.slice(0, 4)).confidence, 'low');
  eq('three of them span only ten days, which is not enough',
    T.composition(many.slice(0, 3)).confidence, 'none');
  eq('two readings days apart is not readable yet',
    T.composition(many.slice(0, 2)).confidence, 'none');
}

// ------------------------------------ muscle mass straight from the scale
{
  const c = T.composition([
    { date: '2026-01-01', weight_lbs: 200, body_fat_pct: 25, muscle_mass_lbs: 88 },
    { date: '2026-02-12', weight_lbs: 190, body_fat_pct: 20, muscle_mass_lbs: 89.5 }
  ]);
  near('the scale figure is used as given', c.muscleFirst, 88);
  near('and its change', c.muscleChange, 1.5, 1e-9);
  eq('over the days between those two', c.muscleDays, 42);
  near('a quarter pound a week', c.musclePerWeek, 1.5 / 6, 1e-9);
  // Fat and lean still come from the percentage, independently.
  near('fat still tracked', c.fatChange, -12, 1e-9);
}

// A scale that reports muscle but no body fat is still usable.
{
  const c = T.composition([
    { date: '2026-01-01', weight_lbs: 200, muscle_mass_lbs: 88 },
    { date: '2026-02-12', weight_lbs: 195, muscle_mass_lbs: 89 }
  ]);
  eq('both readings count', c.readings, 2);
  near('muscle change', c.muscleChange, 1, 1e-9);
  eq('with no body fat there is no fat figure', c.fatChange, undefined);
  eq('nor a lean one', c.leanChange, undefined);
}

// Nonsense muscle values are ignored rather than believed.
eq('muscle heavier than the person', T.composition(
  [{ date: '2026-01-01', weight_lbs: 200, muscle_mass_lbs: 250 }]).readings, 0);
eq('negative muscle', T.composition(
  [{ date: '2026-01-01', weight_lbs: 200, muscle_mass_lbs: -5 }]).readings, 0);

// One muscle reading is not a trend.
eq('a single muscle reading gives no rate', T.composition([
  { date: '2026-01-01', weight_lbs: 200, body_fat_pct: 25, muscle_mass_lbs: 88 },
  { date: '2026-02-12', weight_lbs: 190, body_fat_pct: 20 }
]).muscleChange, undefined);

// --- how a rate gets described ------------------------------------------
ok('2 lb a week is called water, not muscle',
  /water and glycogen/.test(T.readTissueRate(2, 'Muscle')));
ok('a third of a pound is called real',
  /range real muscle actually arrives at/.test(T.readTissueRate(0.33, 'Muscle')));
ok('holding steady is the goal, not a failure',
  /holding, which is the goal/.test(T.readTissueRate(0, 'Muscle')));
ok('losing it names the causes',
  /too little protein/.test(T.readTissueRate(-0.4, 'Muscle')));
eq('nothing to describe', T.readTissueRate(null, 'Muscle'), '');

// ------------------------------------------------- when is the goal due
{
  // 220 lb falling a pound a week, goal 200. Twenty pounds, twenty weeks.
  const run = makeRun({ days: 28, intake: 2000, startWeight: 220, lbsPerDay: 1 / 7 });
  const g = T.projectGoal({
    weighIns: run.weighIns, asOf: run.asOf,
    settings: { goal_weight_lbs: 200, target_rate_lbs_per_week: 1 }
  });
  near('current weight is the smoothed one, not this morning', g.current, 218.6, 1.5);
  near('rate matches the trend', g.ratePerWeek, 1, 0.05);
  ok('an arrival date exists', !!g.date);
  near('about as many weeks as pounds at a pound a week', g.weeks, g.toGo, 0.6);
  eq('a full clean window is trusted', g.confidence, 'ok');
  ok('the planned date is offered too', !!g.planned.date);
}

// Flat: no date, and it says why rather than showing infinity.
{
  const run = makeRun({ days: 28, intake: 2000, startWeight: 220, lbsPerDay: 0 });
  const g = T.projectGoal({ weighIns: run.weighIns, asOf: run.asOf,
    settings: { goal_weight_lbs: 200 } });
  eq('no date when flat', g.date, null);
  ok('and it explains', /flat/.test(g.reason));
  near('but it still says how far there is to go', g.toGo, 20, 1.5);
}

// Going the wrong way.
{
  const run = makeRun({ days: 28, intake: 3000, startWeight: 220, lbsPerDay: -1 / 7 });
  const g = T.projectGoal({ weighIns: run.weighIns, asOf: run.asOf,
    settings: { goal_weight_lbs: 200 } });
  eq('no date when gaining', g.date, null);
  ok('and it says so plainly', /moving away/.test(g.reason));
}

// Already there.
{
  const run = makeRun({ days: 28, intake: 2000, startWeight: 200.2, lbsPerDay: 0 });
  const g = T.projectGoal({ weighIns: run.weighIns, asOf: run.asOf,
    settings: { goal_weight_lbs: 200 } });
  ok('arriving is recognised', /You are there/.test(g.reason));
}

// Goal ABOVE current weight - gaining towards it counts as progress.
{
  const run = makeRun({ days: 28, intake: 3000, startWeight: 140, lbsPerDay: -1 / 7 });
  const g = T.projectGoal({ weighIns: run.weighIns, asOf: run.asOf,
    settings: { goal_weight_lbs: 160 } });
  ok('gaining towards a higher goal gives a date', !!g.date);
  ok('and the gap is negative', g.toGo < 0);
}

// Not enough behind it yet.
{
  const run = makeRun({ days: 8, intake: 2000, startWeight: 220, lbsPerDay: 1 / 7 });
  const g = T.projectGoal({ weighIns: run.weighIns, asOf: run.asOf,
    settings: { goal_weight_lbs: 200 } });
  eq('eight days is not enough to trust a date', g.confidence, 'none');
  ok('though a date is still offered, labelled', !!g.date);
}

eq('no goal, no projection',
  T.projectGoal({ weighIns: [], settings: {} }).goal, null);
ok('no weigh-ins says so',
  /couple of weigh-ins/.test(T.projectGoal({ weighIns: [], settings: { goal_weight_lbs: 200 } }).reason));

// ------------------------------------------------------------ plumbing

{
  const intake = T.dailyIntake([
    { date: '2026-01-02', computed_kcal: 300 },
    { date: '2026-01-01', computed_kcal: 500 },
    { date: '2026-01-02', computed_kcal: 200 }
  ]);
  eq('entries roll up per day, in order',
    intake, [{ date: '2026-01-01', kcal: 500 }, { date: '2026-01-02', kcal: 500 }]);
}
{
  const s = T.emaSeries([
    { date: '2026-01-01', weight_lbs: 200 },
    { date: '2026-01-02', weight_lbs: 210 }
  ]);
  near('EMA seeds on the first reading', s[0].ema, 200);
  near('and moves a tenth of the way to the next', s[1].ema, 201);
}
near('slope of a clean 1 lb/week fall',
  T.slopeLbsPerWeek(makeRun({ days: 28, startWeight: 200, lbsPerDay: 1 / 7, intake: 0 })
    .weighIns.map(w => ({ date: w.date, raw: w.weight_lbs })), 'raw'), -1, 0.02);
eq('round trip through day numbers', T.dateFromDay(T.dayNumber('2026-08-30')), '2026-08-30');

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
