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
