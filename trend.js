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
    if (!points || points.length < 2) return { slopePerDay: 0, n: points ? points.length : 0 };
    var n = points.length;
    var sx = 0, sy = 0, sxx = 0, sxy = 0;
    points.forEach(function (p) {
      var x = dayNumber(p.date);
      var y = p[key];
      sx += x; sy += y; sxx += x * x; sxy += x * y;
    });
    var denom = (n * sxx) - (sx * sx);
    if (!denom) return { slopePerDay: 0, n: n };
    return { slopePerDay: ((n * sxy) - (sx * sy)) / denom, n: n };
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
    var intake = inWindow(dailyIntake(opts.entries), fromDay, toDay);

    if (win.length < 2) {
      return Object.assign({}, blank, {
        weighInCount: win.length,
        loggedDays: intake.length,
        reason: 'Needs at least two weigh-ins in the window.'
      });
    }

    var first = win[0];
    var last = win[win.length - 1];
    var days = dayNumber(last.date) - dayNumber(first.date);
    var lost = measuredLoss(win, days);          // positive when losing

    var kcalSum = intake.reduce(function (a, r) { return a + r.kcal; }, 0);
    var avgIntake = intake.length ? kcalSum / intake.length : null;
    var coverage = intake.length / windowDays;

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
    var intakeWin = inWindow(dailyIntake(opts.entries), fromDay, toDay);
    if (smoothed.length < 2 || !intakeWin.length) return none;

    var first = smoothed[0];
    var last = smoothed[smoothed.length - 1];
    var days = dayNumber(last.date) - dayNumber(first.date);
    if (!days) return none;

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

  /* Two levers, as the plan asks: eat less, or move more. Never drops the
   * target through the floor - past that point the answer is a diet break,
   * not a smaller number, and the caller is told so.
   */
  function adjustment(opts) {
    var tdee = opts.tdee;
    var settings = opts.settings || {};
    if (!(tdee > 0)) return null;

    var rate = settings.target_rate_lbs_per_week > 0 ? settings.target_rate_lbs_per_week : 1;
    var wantedDeficit = rate * KCAL_PER_LB / 7;

    var floor = Math.max(
      settings.min_kcal > 0 ? settings.min_kcal : DEFAULT_FLOOR_KCAL,
      tdee * MIN_FRACTION_OF_TDEE
    );

    var idealTarget = tdee - wantedDeficit;
    var capped = idealTarget < floor;
    var newTarget = capped ? floor : idealTarget;

    // The other lever: keep eating what you eat now, burn the shortfall.
    var current = settings.target_kcal > 0 ? settings.target_kcal : newTarget;
    var activityKcal = Math.max(0, wantedDeficit - (tdee - current));

    return {
      measuredTdee: tdee,
      ratePerWeek: rate,
      newTarget: Math.round(newTarget),
      currentTarget: settings.target_kcal || null,
      change: settings.target_kcal ? Math.round(newTarget - settings.target_kcal) : null,
      floor: Math.round(floor),
      cappedAtFloor: capped,
      activityKcalPerDay: Math.round(activityKcal),
      note: capped
        ? 'That is as low as this will go. Cutting further is not the answer here - ' +
          'a couple of weeks eating at maintenance does more than a smaller number would.'
        : ''
    };
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
    adjustment: adjustment
  };
})();
