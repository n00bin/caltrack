/* trend.js — the part that makes this worth building.
 *
 * Nothing here touches the DOM or the store. It takes plain arrays in and
 * returns plain objects out, which is why every rule below is covered by
 * test-trend.js rather than by squinting at a chart.
 *
 * Sections 5 and 6 of the plan:
 *   - smooth the scale noise with an EMA
 *   - back TDEE out of what actually happened instead of predicting it
 *   - compare the trend against what the logged deficit says it should be
 *   - raise a tiered, honestly-labelled alert when those disagree
 */
window.CalTrack = window.CalTrack || {};

CalTrack.trend = (function () {
  'use strict';

  var KCAL_PER_LB = 3500;
  var EMA_ALPHA = 0.1;          // section 6: heavy smoothing, scale weight is noisy
  var DEFAULT_WINDOW = 28;      // the plan's rolling 21-28 day window

  // Below these the numbers are arithmetic, not evidence.
  var MIN_DAYS_FOR_TDEE = 14;
  var MIN_WEIGH_INS = 4;
  var MAX_LOG_GAP_DAYS = 3;
  var SODIUM_JUMP_LBS = 3;

  // "trend slope is about zero" needs a number. Half a pound a month.
  var FLAT_LBS_PER_WEEK = 0.15;
  var STILL_FALLING_LBS_PER_WEEK = -0.25;

  var DEFAULT_FLOOR_KCAL = 1500;
  var MIN_FRACTION_OF_TDEE = 0.75;   // never suggest more than a 25% deficit

  // ------------------------------------------------------------- dates
  // Dates are compared, never displayed, so UTC day numbers are safe here.

  function dayNumber(dateStr) {
    var p = String(dateStr).split('-');
    return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  }

  function dateFromDay(n) {
    var d = new Date(n * 86400000);
    return d.getUTCFullYear() + '-' +
      String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
      String(d.getUTCDate()).padStart(2, '0');
  }

  function byDate(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }

  // ------------------------------------------------------- daily intake
  // A day with nothing logged is a day with no data. Counting it as zero
  // calories would invent an enormous deficit and wreck every number below.

  function dailyIntake(entries) {
    var byDay = {};
    (entries || []).forEach(function (e) {
      if (!e.date) return;
      byDay[e.date] = (byDay[e.date] || 0) + (e.computed_kcal || 0);
    });
    return Object.keys(byDay).sort().map(function (d) {
      return { date: d, kcal: byDay[d] };
    });
  }

  // ---------------------------------------------------------------- EMA

  /* Exponentially weighted moving average over the weigh-ins, in date order.
   * Seeded with the first reading so it starts at a sensible place rather
   * than climbing up from zero.
   */
  function emaSeries(weighIns, alpha) {
    alpha = alpha || EMA_ALPHA;
    var rows = (weighIns || [])
      .filter(function (w) { return w && w.date && isFinite(w.weight_lbs); })
      .slice().sort(byDate);

    var out = [];
    var value = null;
    rows.forEach(function (w) {
      var raw = Number(w.weight_lbs);
      value = (value === null) ? raw : value + alpha * (raw - value);
      out.push({ date: w.date, raw: raw, ema: value });
    });
    return out;
  }

  /* Least-squares fit through the weigh-ins.
   *
   * The plan measures the change as ema_start - ema_now. That is right in
   * steady state but wrong early on: the EMA is seeded at the first reading,
   * so it starts with no lag and ends about nine days behind, which shrinks
   * the apparent loss. It would under-state the burn rate in exactly the
   * first weeks people look at it, and an under-stated burn rate means an
   * over-tight target. A regression has no such warm-up, uses every reading
   * rather than two, and is what the slope test needs anyway - so the change
   * is measured as slope x days, and the EMA is kept for the chart and for
   * showing where the trend line sits.
   */
  function linearFit(points, key) {
    key = key || 'raw';
    if (!points || points.length < 2) {
      return { slopePerDay: 0, intercept: null, n: points ? points.length : 0 };
    }
    var n = points.length;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    points.forEach(function (p) {
      var x = dayNumber(p.date);
      var y = p[key];
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    });
    var denom = (n * sxx) - (sx * sx);
    if (!denom) return { slopePerDay: 0, intercept: sy / n, n: n };
    var slope = ((n * sxy) - (sx * sy)) / denom;
    return { slopePerDay: slope, intercept: (sy - slope * sx) / n, n: n };
  }

  // Where the fitted line sits on a given day number.
  function fitAt(fit, day) {
    return fit.slopePerDay * day + fit.intercept;
  }

  function slopeLbsPerWeek(points, key) {
    return linearFit(points, key).slopePerDay * 7;
  }

  // Pounds lost across the window, positive when losing.
  function measuredLoss(points, days) {
    return -linearFit(points, 'raw').slopePerDay * days;
  }

  function inWindow(rows, fromDay, toDay) {
    return rows.filter(function (r) {
      var d = dayNumber(r.date);
      return d >= fromDay && d <= toDay;
    });
  }

  // --------------------------------------------------------- adaptive TDEE

  /* TDEE = average intake + (weight lost x 3500) / days.
   *
   * The endpoints come off the SMOOTHED line, not raw scale readings: a
   * single puffy morning at either end would otherwise swing the answer by
   * hundreds of calories. The EMA is built from the full history so it is
   * already warmed up by the time the window starts, and both endpoints lag
   * by the same amount, so the difference between them stays honest.
   */
  function measureTdee(opts) {
    var windowDays = opts.windowDays || DEFAULT_WINDOW;
    var asOf = opts.asOf || (opts.weighIns && opts.weighIns.length
      ? opts.weighIns[opts.weighIns.length - 1].date : null);

    var blank = {
      tdee: null, confidence: 'none', reason: 'Not enough logged yet.',
      avgIntake: null, weightChangeLbs: null, days: 0,
      loggedDays: 0, weighInCount: 0, coverage: 0
    };
    if (!asOf) return blank;

    var toDay = dayNumber(asOf);
    var fromDay = toDay - windowDays + 1;

    var smoothed = emaSeries(opts.weighIns);
    var win = inWindow(smoothed, fromDay, toDay);
    var logged = dailyIntake(opts.entries);

    if (win.length < 2) {
      return Object.assign({}, blank, {
        weighInCount: win.length,
        loggedDays: inWindow(logged, fromDay, toDay).length,
        reason: 'Needs at least two weigh-ins in the window.'
      });
    }

    var first = win[0];
    var last = win[win.length - 1];
    var days = dayNumber(last.date) - dayNumber(first.date);
    var lost = measuredLoss(win, days);          // positive when losing

    /* Intake is averaged over exactly the days the weight change covers:
     * from the first weigh-in up to the day BEFORE the last one. What was
     * eaten on the day of the last weigh-in has not reached the scale yet,
     * and what was eaten before the first one went into the weight that
     * was already there. Averaging over the whole window instead counted a
     * few heavy days before the weigh-ins began as if they had produced a
     * loss they had nothing to do with - a couple of hundred calories out,
     * with the "measured" badge on it - and counted today as a full day of
     * eating the moment breakfast was logged.
     */
    var intake = inWindow(logged, dayNumber(first.date), dayNumber(last.date) - 1);

    var kcalSum = intake.reduce(function (a, r) { return a + r.kcal; }, 0);
    var avgIntake = intake.length ? kcalSum / intake.length : null;
    var coverage = days ? intake.length / days : 0;

    var result = {
      tdee: null,
      avgIntake: avgIntake,
      weightChangeLbs: -lost,                    // negative = lost weight
      days: days,
      loggedDays: intake.length,
      weighInCount: win.length,
      coverage: coverage,
      emaStart: first.ema,
      emaNow: last.ema,
      confidence: 'none',
      reason: ''
    };

    if (!days || avgIntake === null) {
      result.reason = 'Needs weigh-ins on at least two different days.';
      return result;
    }

    result.tdee = avgIntake + (lost * KCAL_PER_LB) / days;

    if (days < MIN_DAYS_FOR_TDEE || win.length < MIN_WEIGH_INS || intake.length < 10) {
      result.confidence = 'none';
      result.reason = 'Keep logging - this needs about two weeks before it means anything.';
    } else if (days < 21 || coverage < 0.7) {
      result.confidence = 'low';
      result.reason = 'Early estimate. It firms up as the window fills in.';
    } else {
      result.confidence = 'ok';
      result.reason = 'Measured from ' + intake.length + ' logged days and ' +
        win.length + ' weigh-ins.';
    }
    return result;
  }

  /* What we compare reality against. In order of trust:
   *   1. a TDEE the user has already accepted
   *   2. a well-measured one from the current window
   *   3. the one implied by their own target and goal rate
   * Anything less and there is no reference, so no alert is honest.
   */
  function assumedTdee(settings, measured) {
    settings = settings || {};
    if (settings.tdee_override > 0) return settings.tdee_override;
    if (measured && measured.tdee && measured.confidence !== 'none') return measured.tdee;
    if (settings.estimated_tdee > 0) return settings.estimated_tdee;
    if (settings.target_kcal > 0 && settings.target_rate_lbs_per_week > 0) {
      return settings.target_kcal + (settings.target_rate_lbs_per_week * KCAL_PER_LB / 7);
    }
    return null;
  }

  // ------------------------------------------------------ plateau detection

  // Reasons to keep quiet, from the plan's "suppress false positives".
  function suppressions(intakeWin, weighWin) {
    var out = [];

    if (weighWin.length < MIN_WEIGH_INS) {
      out.push('only ' + weighWin.length + ' weigh-in' +
        (weighWin.length === 1 ? '' : 's') + ' in this window');
    }

    var days = intakeWin.map(function (r) { return dayNumber(r.date); }).sort(function (a, b) { return a - b; });
    for (var i = 1; i < days.length; i++) {
      if (days[i] - days[i - 1] > MAX_LOG_GAP_DAYS) {
        out.push('a ' + (days[i] - days[i - 1] - 1) + '-day gap in your food log');
        break;
      }
    }

    for (var j = 1; j < weighWin.length; j++) {
      var gap = dayNumber(weighWin[j].date) - dayNumber(weighWin[j - 1].date);
      var jump = Math.abs(weighWin[j].raw - weighWin[j - 1].raw);
      if (gap <= 1 && jump > SODIUM_JUMP_LBS) {
        out.push('a ' + jump.toFixed(1) + ' lb overnight jump, which is salt or a big meal rather than fat');
        break;
      }
    }
    return out;
  }

  /* Returns the tier, the arithmetic behind it, and - importantly - what it
   * would have said if something had not muted it.
   */
  function plateau(opts) {
    var windowDays = opts.windowDays || DEFAULT_WINDOW;
    var measured = opts.measured || measureTdee(opts);
    var reference = assumedTdee(opts.settings, measured);

    var none = {
      tier: 'none', ratio: null, expectedLoss: null, actualLoss: null,
      days: 0, slope: 0, suppressedBy: [], message: ''
    };

    var asOf = opts.asOf || (opts.weighIns && opts.weighIns.length
      ? opts.weighIns[opts.weighIns.length - 1].date : null);
    if (!asOf || !reference) {
      return Object.assign({}, none, {
        message: 'No calorie target or measured burn rate yet, so there is nothing to compare against.'
      });
    }

    var toDay = dayNumber(asOf);
    var fromDay = toDay - windowDays + 1;

    var smoothed = inWindow(emaSeries(opts.weighIns), fromDay, toDay);
    if (smoothed.length < 2) return none;

    var first = smoothed[0];
    var last = smoothed[smoothed.length - 1];
    var days = dayNumber(last.date) - dayNumber(first.date);
    if (!days) return none;

    // The same days the weight change covers - see measureTdee for why.
    var intakeWin = inWindow(dailyIntake(opts.entries),
      dayNumber(first.date), dayNumber(last.date) - 1);
    if (!intakeWin.length) return none;

    var avgIntake = intakeWin.reduce(function (a, r) { return a + r.kcal; }, 0) / intakeWin.length;
    var avgDeficit = reference - avgIntake;

    var expectedLoss = (avgDeficit * days) / KCAL_PER_LB;
    var actualLoss = measuredLoss(smoothed, days);
    var slope = slopeLbsPerWeek(smoothed, 'raw');

    var base = {
      tier: 'none', ratio: null, expectedLoss: expectedLoss, actualLoss: actualLoss,
      days: days, slope: slope, avgIntake: avgIntake, avgDeficit: avgDeficit,
      reference: reference, suppressedBy: [], message: ''
    };

    // Eating at or above the reference burn: nothing has stalled, the
    // deficit simply is not there.
    if (avgDeficit <= 0 || expectedLoss <= 0) {
      base.message = 'You are averaging ' + Math.round(avgIntake) +
        ' kcal against an estimated burn of ' + Math.round(reference) +
        ', so there is no deficit to stall.';
      return base;
    }

    base.ratio = actualLoss / expectedLoss;

    var muted = suppressions(intakeWin, smoothed);
    var tier = 'none';
    if (days >= 21 && Math.abs(slope) < FLAT_LBS_PER_WEEK) tier = 'confirmed';
    else if (days >= 14 && base.ratio < 0.4 && slope > STILL_FALLING_LBS_PER_WEEK) tier = 'likely';
    else if (days >= 10 && base.ratio < 0.5) tier = 'watch';

    if (tier !== 'none' && muted.length) {
      base.suppressedBy = muted;
      base.wouldHaveBeen = tier;
      base.message = 'Holding off on a verdict: ' + muted.join(', ') + '.';
      return base;
    }

    base.tier = tier;
    base.message = messageFor(tier, base);
    return base;
  }

  function messageFor(tier, r) {
    var pct = Math.round((r.ratio || 0) * 100);
    if (tier === 'watch') {
      return 'You are ' + pct + '% of the way to the loss your logged deficit predicts ' +
        'over ' + r.days + ' days. That is often water. Hold course and check back in a week.';
    }
    if (tier === 'likely') {
      return 'Over ' + r.days + ' days you have lost ' + r.actualLoss.toFixed(1) +
        ' lb against a predicted ' + r.expectedLoss.toFixed(1) +
        ' lb. The trend has flattened and your burn rate has probably dropped.';
    }
    if (tier === 'confirmed') {
      return 'The smoothed trend has been flat for ' + r.days +
        ' days. Time to work the target out from what your body is actually doing.';
    }
    return 'On track: ' + r.actualLoss.toFixed(1) + ' lb lost against ' +
      r.expectedLoss.toFixed(1) + ' lb predicted.';
  }

  // ------------------------------------------------------------ adjustment

  // How low a target is allowed to go, whatever the arithmetic says.
  function floorFor(tdee, settings) {
    settings = settings || {};
    return Math.max(
      settings.min_kcal > 0 ? settings.min_kcal : DEFAULT_FLOOR_KCAL,
      tdee * MIN_FRACTION_OF_TDEE
    );
  }

  // Burn rate + the rate you want to lose at -> what to eat, floored.
  function targetFor(tdee, settings) {
    settings = settings || {};
    var rate = settings.target_rate_lbs_per_week > 0 ? settings.target_rate_lbs_per_week : 1;
    var wantedDeficit = rate * KCAL_PER_LB / 7;
    var floor = floorFor(tdee, settings);
    var ideal = tdee - wantedDeficit;
    var capped = ideal < floor;
    return {
      target: Math.round(capped ? floor : ideal),
      floor: Math.round(floor),
      cappedAtFloor: capped,
      ratePerWeek: rate,
      deficit: Math.round(wantedDeficit)
    };
  }

  /* Two levers, as the plan asks: eat less, or move more. Never drops the
   * target through the floor - past that point the answer is a diet break,
   * not a smaller number, and the caller is told so.
   */
  function adjustment(opts) {
    var tdee = opts.tdee;
    var settings = opts.settings || {};
    if (!(tdee > 0)) return null;

    var t = targetFor(tdee, settings);

    // The other lever: keep eating what you eat now, burn the shortfall.
    var current = settings.target_kcal > 0 ? settings.target_kcal : t.target;
    var activityKcal = Math.max(0, t.deficit - (tdee - current));

    return {
      measuredTdee: tdee,
      ratePerWeek: t.ratePerWeek,
      newTarget: t.target,
      currentTarget: settings.target_kcal || null,
      change: settings.target_kcal ? Math.round(t.target - settings.target_kcal) : null,
      floor: t.floor,
      cappedAtFloor: t.cappedAtFloor,
      activityKcalPerDay: Math.round(activityKcal),
      note: t.cappedAtFloor
        ? 'That is as low as this will go. Cutting further is not the answer here - ' +
          'a couple of weeks eating at maintenance does more than a smaller number would.'
        : ''
    };
  }

  // ------------------------------------------------ the starting estimate

  /* A formula cannot tell you your burn rate. It can only give you somewhere
   * to stand for the first fortnight, until there is enough logged for
   * measureTdee() to do the job properly. Everything below is scaffolding,
   * and the app says so wherever it shows a number from it.
   *
   * Mifflin-St Jeor is the usual starting point and is typically within
   * about 10% for most people - which is 200-odd calories, i.e. the whole
   * difference between losing and not. Katch-McArdle is used instead when
   * body fat is known, because lean mass is what actually burns; it needs no
   * age and no sex term at all.
   */
  var ACTIVITY = {
    sedentary: { factor: 1.2, label: 'Desk job, little exercise' },
    light: { factor: 1.375, label: 'Light exercise 1-3 days a week' },
    moderate: { factor: 1.55, label: 'Moderate exercise 3-5 days a week' },
    high: { factor: 1.725, label: 'Hard exercise 6-7 days a week' },
    athlete: { factor: 1.9, label: 'Physical job or twice-daily training' }
  };

  var LB_TO_KG = 0.45359237;
  var IN_TO_CM = 2.54;

  function estimateBmr(p) {
    p = p || {};
    var lbs = Number(p.weightLbs);
    if (!(lbs > 0)) return { error: 'Needs your current weight.' };
    var kg = lbs * LB_TO_KG;

    var bf = Number(p.bodyFatPct);
    if (bf > 0 && bf < 70) {
      var lean = kg * (1 - bf / 100);
      return { bmr: 370 + 21.6 * lean, formula: 'Katch-McArdle', usedBodyFat: true };
    }

    var inches = Number(p.heightIn);
    var age = Number(p.age);
    if (!(inches > 0)) return { error: 'Needs your height.' };
    if (!(age > 0)) return { error: 'Needs your age.' };

    var base = 10 * kg + 6.25 * (inches * IN_TO_CM) - 5 * age;
    // The only difference between the two forms of this equation.
    var constant = (String(p.sex).toLowerCase() === 'female') ? -161 : 5;
    return { bmr: base + constant, formula: 'Mifflin-St Jeor', usedBodyFat: false };
  }

  function estimateTdee(p) {
    var r = estimateBmr(p);
    if (r.error) return r;
    var key = ACTIVITY[p.activity] ? p.activity : 'sedentary';
    var act = ACTIVITY[key];
    return {
      bmr: r.bmr,
      formula: r.formula,
      usedBodyFat: r.usedBodyFat,
      activity: key,
      activityLabel: act.label,
      multiplier: act.factor,
      tdee: r.bmr * act.factor,
      estimated: true
    };
  }

  // The whole starting suggestion: burn rate, target, and the caveat.
  function suggestTarget(profile, settings) {
    var est = estimateTdee(profile);
    if (est.error) return est;
    var t = targetFor(est.tdee, settings);
    return {
      bmr: Math.round(est.bmr),
      tdee: Math.round(est.tdee),
      formula: est.formula,
      usedBodyFat: est.usedBodyFat,
      activityLabel: est.activityLabel,
      multiplier: est.multiplier,
      target: t.target,
      deficit: t.deficit,
      ratePerWeek: t.ratePerWeek,
      floor: t.floor,
      cappedAtFloor: t.cappedAtFloor,
      caveat: 'This is a formula, not a measurement. Expect it to be out by ' +
        '10% either way - about ' + Math.round(est.tdee * 0.1) + ' kcal. ' +
        'Two weeks of weighing in and logging replaces it with your real number.'
    };
  }

  /* BMI. Weight over height squared, in the imperial form.
   *
   * It is a screening number for populations, not a verdict on a person: it
   * cannot tell muscle from fat, so it reads heavy for anyone who lifts and
   * light for someone thin with little muscle. Reported with its category
   * and that caveat attached, because a bare number invites the wrong reading.
   */
  /* The bands, with the colour each gets on the bar.
   *
   * Not a green-to-red gradient: a BMI below 18.5 carries its own risks, so
   * the low band is amber rather than the "best" end of a scale. Green is
   * the middle, which is what the thresholds actually say.
   */
  var BMI_BANDS = [
    { upto: 18.5, name: 'under the healthy range', tone: 'low' },
    { upto: 25, name: 'the healthy range', tone: 'good' },
    { upto: 30, name: 'the overweight range', tone: 'warn' },
    { upto: Infinity, name: 'the obese range', tone: 'high' }
  ];

  // The bar covers 15 to 40. Below and above that the exact number stops
  // telling you anything the category has not already said.
  var BMI_MIN = 15;
  var BMI_MAX = 40;

  // Where a BMI sits along the bar, 0 to 100.
  function bmiPercent(value) {
    var p = ((value - BMI_MIN) / (BMI_MAX - BMI_MIN)) * 100;
    return Math.max(0, Math.min(100, p));
  }

  /* The bar as drawable segments: each band's share of the width, so the
   * markup does not have to know the thresholds.
   */
  function bmiSegments() {
    var out = [];
    var from = BMI_MIN;
    BMI_BANDS.forEach(function (band) {
      var to = Math.min(band.upto, BMI_MAX);
      if (to <= from) return;
      out.push({
        tone: band.tone,
        name: band.name,
        from: from,
        to: to,
        widthPct: ((to - from) / (BMI_MAX - BMI_MIN)) * 100
      });
      from = to;
    });
    return out;
  }

  function bmi(weightLbs, heightIn) {
    if (!(weightLbs > 0) || !(heightIn > 0)) return null;
    var value = 703 * weightLbs / (heightIn * heightIn);
    var band = BMI_BANDS.filter(function (b) { return value < b.upto; })[0];
    return { bmi: value, category: band.name };
  }

  /* The healthy BMI band turned into actual pounds, for one height.
   *
   * BMI already divides out height, which is the whole point of it - so the
   * healthy BAND is 18.5 to 25 for everyone, tall or short. What changes with
   * height is the WEIGHT that lands in it, and that is the number worth
   * showing someone.
   *
   * Age does not move the adult cutoffs either. The one real caveat is that
   * for people past about 65 a number of guidelines suggest aiming slightly
   * higher, since a little reserve is protective at that age - so that gets
   * said rather than silently shifting the bands.
   */
  function healthyWeightRange(heightIn) {
    if (!(heightIn > 0)) return null;
    var perBmi = (heightIn * heightIn) / 703;
    return {
      min: 18.5 * perBmi,
      max: 25 * perBmi,
      heightIn: heightIn
    };
  }

  /* Body composition, and the only honest answer to "am I gaining muscle?".
   *
   * A scale weighs everything at once. Nothing in intake or weight alone can
   * separate muscle from fat from water - an app claiming otherwise is
   * guessing. What CAN be done is arithmetic on a body fat percentage you
   * measured: fat mass is weight x fat%, lean mass is the rest, and watching
   * those two move apart is as close as this gets.
   *
   * Two warnings travel with it. Lean mass is muscle AND water AND glycogen
   * AND organs, so a two-pound jump in a week is a full glycogen store, not
   * new muscle - real muscle arrives at a quarter to half a pound a week at
   * best, and slower in a deficit. And consumer scales measure fat by passing
   * a current through you, which hydration moves by several points, so only
   * the trend across many readings means anything.
   */
  function composition(weighIns) {
    var rows = (weighIns || [])
      .filter(function (w) {
        if (!w || !w.date || !isFinite(w.weight_lbs)) return false;
        var hasFat = isFinite(w.body_fat_pct) && w.body_fat_pct > 0 && w.body_fat_pct < 70;
        var hasMuscle = isFinite(w.muscle_mass_lbs) && w.muscle_mass_lbs > 0 &&
          w.muscle_mass_lbs < w.weight_lbs;
        return hasFat || hasMuscle;
      })
      .slice().sort(byDate)
      .map(function (w) {
        var hasFat = isFinite(w.body_fat_pct) && w.body_fat_pct > 0 && w.body_fat_pct < 70;
        var fat = hasFat ? w.weight_lbs * (w.body_fat_pct / 100) : null;
        var muscle = (isFinite(w.muscle_mass_lbs) && w.muscle_mass_lbs > 0 &&
          w.muscle_mass_lbs < w.weight_lbs) ? w.muscle_mass_lbs : null;
        return {
          date: w.date,
          weight: w.weight_lbs,
          bodyFatPct: hasFat ? w.body_fat_pct : null,
          fatMass: fat,
          leanMass: hasFat ? w.weight_lbs - fat : null,
          muscleMass: muscle
        };
      });

    var out = { readings: rows.length, series: rows, first: null, last: null };
    if (rows.length < 2) return out;

    var first = rows[0], last = rows[rows.length - 1];
    var days = dayNumber(last.date) - dayNumber(first.date);

    out.first = first;
    out.last = last;
    out.days = days;
    out.weightChange = last.weight - first.weight;

    if (first.fatMass !== null && last.fatMass !== null) {
      out.fatChange = last.fatMass - first.fatMass;
      out.leanChange = last.leanMass - first.leanMass;
      if (days >= 7) {
        out.leanPerWeek = out.leanChange / (days / 7);
        out.fatPerWeek = out.fatChange / (days / 7);
      }
    }

    /* A scale that reports muscle mass gives it directly, which beats
     * subtracting fat from weight: lean mass is muscle plus water plus bone
     * plus organs, while this at least tries to name the muscle part. It
     * comes from the same impedance measurement though, so it is no more
     * independent - see the warnings the caller prints.
     */
    var withMuscle = rows.filter(function (r) { return r.muscleMass !== null; });
    if (withMuscle.length >= 2) {
      var mFirst = withMuscle[0];
      var mLast = withMuscle[withMuscle.length - 1];
      var mDays = dayNumber(mLast.date) - dayNumber(mFirst.date);
      out.muscleReadings = withMuscle.length;
      out.muscleDays = mDays;
      out.muscleChange = mLast.muscleMass - mFirst.muscleMass;
      out.muscleFirst = mFirst.muscleMass;
      out.muscleLast = mLast.muscleMass;
      if (mDays >= 7) out.musclePerWeek = out.muscleChange / (mDays / 7);
    }

    // Under a month, body fat readings are mostly noise.
    out.confidence = (rows.length >= 6 && days >= 28) ? 'ok'
      : (rows.length >= 3 && days >= 14) ? 'low' : 'none';
    return out;
  }

  /* When will the goal weight arrive?
   *
   * Two answers, because they are different questions. The MEASURED one
   * extends the trend line you are actually on. The PLANNED one is what the
   * rate in Settings would give if you hit it every week.
   *
   * Both assume a straight line, and weight loss is not one: as you get
   * lighter you burn less, so the same food is a smaller deficit and the
   * line bends. A projection is therefore optimistic by construction, and
   * further out it is more optimistic. The app says so rather than dressing
   * a linear extrapolation up as a delivery date - and its own plateau
   * detection exists precisely because that bend is real.
   */
  function projectGoal(opts) {
    var settings = opts.settings || {};
    var goal = Number(settings.goal_weight_lbs);

    var base = {
      goal: goal > 0 ? goal : null,
      current: null, toGo: null, latest: null, toGoLatest: null,
      ratePerWeek: null, weeks: null, date: null,
      planned: null, confidence: 'none', reason: ''
    };

    if (!(goal > 0)) {
      base.reason = 'No goal weight set.';
      return base;
    }

    var smoothed = emaSeries(opts.weighIns);
    if (smoothed.length < 2) {
      base.reason = 'Needs a couple of weigh-ins first.';
      return base;
    }

    var asOf = opts.asOf || smoothed[smoothed.length - 1].date;
    var toDay = dayNumber(asOf);
    var windowDays = opts.windowDays || DEFAULT_WINDOW;
    var win = inWindow(smoothed, toDay - windowDays + 1, toDay);
    if (win.length < 2) {
      base.reason = 'No recent weigh-ins to draw a line through.';
      return base;
    }

    /* "Current" is the fitted trend line read at the last weigh-in. Not this
     * morning's reading, which is water and salt as much as fat - and not
     * the smoothed EMA either, which runs about nine readings behind, so
     * "to go" was overstated by more than a pound at a pound a week and the
     * arrival date landed nine days late, every day. The straight-line fit
     * has no lag, and it is the same fit the rate below comes from.
     */
    var lastRow = win[win.length - 1];
    var lastDay = dayNumber(lastRow.date);
    var fit = linearFit(win, 'raw');
    var current = fitAt(fit, lastDay);
    base.current = current;
    base.toGo = current - goal;
    base.latest = lastRow.raw;
    base.toGoLatest = lastRow.raw - goal;

    if (Math.abs(base.toGo) < 0.5) {
      base.reason = 'You are there.';
      base.confidence = 'ok';
      return base;
    }

    // Positive when moving towards the goal, whichever side of it you start.
    var slope = fit.slopePerDay * 7;
    var towards = base.toGo > 0 ? -slope : slope;
    base.ratePerWeek = Math.abs(slope);

    var days = lastDay - dayNumber(win[0].date);
    if (days < MIN_DAYS_FOR_TDEE || win.length < MIN_WEIGH_INS) {
      base.confidence = 'none';
    } else if (days < 21) {
      base.confidence = 'low';
    } else {
      base.confidence = 'ok';
    }

    // Dates count from the last weigh-in, where "current" was measured.
    if (towards > 0.05) {
      var weeks = Math.abs(base.toGo) / towards;
      base.weeks = weeks;
      base.date = dateFromDay(lastDay + Math.round(weeks * 7));
      base.reason = 'At the rate you are actually going.';
    } else {
      base.reason = towards < -0.05
        ? 'You are moving away from the goal, so there is no arrival date.'
        : 'The trend is flat, so there is no arrival date at this rate.';
    }

    // What the plan says, for comparison.
    var planned = Number(settings.target_rate_lbs_per_week);
    if (planned > 0) {
      var plannedWeeks = Math.abs(base.toGo) / planned;
      base.planned = {
        ratePerWeek: planned,
        weeks: plannedWeeks,
        date: dateFromDay(lastDay + Math.round(plannedWeeks * 7))
      };
    }

    return base;
  }

  /* What a rate of lean or muscle change actually means.
   *
   * Muscle is built slowly - a quarter to half a pound a week is a good
   * novice rate in a surplus, and a deficit makes it slower still. Anything
   * far above that is the body's water content moving, which a bioimpedance
   * scale cannot tell apart from tissue.
   */
  function readTissueRate(perWeek, what) {
    if (perWeek === undefined || perWeek === null) return '';
    if (perWeek > 0.6) {
      return what + ' rising at ' + Math.round(perWeek * 100) / 100 + ' lb a week ' +
        'is faster than muscle is built - most of that is water and glycogen.';
    }
    if (perWeek > 0.05) {
      return what + ' rising at ' + Math.round(perWeek * 100) / 100 + ' lb a week ' +
        'is in the range real muscle actually arrives at.';
    }
    if (perWeek > -0.05) {
      return what + ' is holding, which is the goal while fat comes off.';
    }
    return what + ' is falling at ' + Math.round(Math.abs(perWeek) * 100) / 100 +
      ' lb a week. Usually too big a deficit, too little protein, or no ' +
      'resistance training - often all three.';
  }

  return {
    KCAL_PER_LB: KCAL_PER_LB,
    EMA_ALPHA: EMA_ALPHA,
    DEFAULT_WINDOW: DEFAULT_WINDOW,
    dayNumber: dayNumber,
    dateFromDay: dateFromDay,
    dailyIntake: dailyIntake,
    emaSeries: emaSeries,
    linearFit: linearFit,
    slopeLbsPerWeek: slopeLbsPerWeek,
    measuredLoss: measuredLoss,
    measureTdee: measureTdee,
    assumedTdee: assumedTdee,
    plateau: plateau,
    adjustment: adjustment,
    projectGoal: projectGoal,
    bmi: bmi,
    BMI_MIN: BMI_MIN,
    BMI_MAX: BMI_MAX,
    bmiPercent: bmiPercent,
    healthyWeightRange: healthyWeightRange,
    bmiSegments: bmiSegments,
    composition: composition,
    readTissueRate: readTissueRate,
    floorFor: floorFor,
    targetFor: targetFor,
    ACTIVITY: ACTIVITY,
    estimateBmr: estimateBmr,
    estimateTdee: estimateTdee,
    suggestTarget: suggestTarget
  };
})();
