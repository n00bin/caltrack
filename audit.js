/* audit.js — checks your own food library for mistakes.
 *
 * Two kinds of check:
 *
 *   local()  - arithmetic that must hold for any real food, needing no
 *              network. This is where typos show up: a decimal point in the
 *              wrong place, per-serving figures typed into a per-100 box.
 *   online() - re-asks the databases about anything with a barcode and
 *              compares. This is where "did I copy it down right" shows up.
 *
 * Nothing here changes anything. It reports, and you decide.
 */
window.CalTrack = window.CalTrack || {};

CalTrack.audit = (function () {
  'use strict';

  // Protein and carbohydrate give about 4 kcal a gram, fat about 9. Real
  // labels drift from this - fibre, sugar alcohols, rounding - so the check
  // only fires when the gap is far too big to be any of those.
  var KCAL_P = 4, KCAL_C = 4, KCAL_F = 9;
  var ATWATER_TOLERANCE = 0.25;      // 25%
  var ATWATER_FLOOR = 25;            // ...or 25 kcal, whichever is kinder

  // Pure fat is 900 kcal per 100 g. Nothing edible beats it.
  var MAX_KCAL_PER_100 = 900;

  var DRINK_WORDS = /\b(milk|juice|soda|cola|water|drink|beer|wine|coffee|tea|smoothie|lemonade|cider|latte)\b/i;

  function finding(food, severity, message, detail) {
    return {
      id: food.id,
      name: food.name || '(unnamed)',
      severity: severity,
      message: message,
      detail: detail || ''
    };
  }

  function round(n, p) {
    var f = Math.pow(10, p || 0);
    return Math.round(n * f) / f;
  }

  function local(foods) {
    var out = [];
    var byBarcode = {};

    (foods || []).forEach(function (f) {
      var per = f.per_100g || {};
      var kcal = per.kcal || 0;
      var p = per.protein || 0, c = per.carbs || 0, fat = per.fat || 0;
      var unit = f.basis === 'volume' ? 'ml' : 'g';

      if (!f.name) out.push(finding(f, 'warn', 'This food has no name.'));

      if (!(kcal > 0)) {
        out.push(finding(f, 'error', 'No calories recorded, so logging it adds nothing.'));
      } else if (kcal > MAX_KCAL_PER_100) {
        out.push(finding(f, 'error',
          round(kcal) + ' kcal per 100 ' + unit + ' is not possible - pure fat is 900.',
          'A per-serving figure typed into the per-100 box does this.'));
      }

      if (p + c + fat > 105) {
        out.push(finding(f, 'error',
          'The macros add up to ' + round(p + c + fat) + ' g in 100 ' + unit + '.',
          'Protein, carbs and fat cannot weigh more than the food does.'));
      }

      [['protein', p], ['carbs', c], ['fat', fat]].forEach(function (pair) {
        if (pair[1] < 0) {
          out.push(finding(f, 'error', 'Negative ' + pair[0] + '.'));
        }
      });

      // The arithmetic that catches most typing mistakes.
      if (kcal > 0 && (p || c || fat)) {
        var expected = (p * KCAL_P) + (c * KCAL_C) + (fat * KCAL_F);
        var gap = Math.abs(expected - kcal);
        if (gap > ATWATER_FLOOR && gap / kcal > ATWATER_TOLERANCE) {
          out.push(finding(f, 'warn',
            'The macros imply about ' + round(expected) + ' kcal, but it says ' +
            round(kcal) + '.',
            'Protein and carbs are ~4 kcal a gram, fat ~9. A gap this big is ' +
            'usually a mistyped number rather than a real food.'));
        }
      }

      (f.portions || []).forEach(function (portion) {
        if (portion.name === 'gram') return;
        if (!(portion.grams > 0)) {
          out.push(finding(f, 'error', 'Portion "' + portion.name + '" has no weight.'));
        } else if (portion.grams < 5) {
          out.push(finding(f, 'warn',
            'A "' + portion.name + '" is recorded as ' + portion.grams + ' ' + unit + '.',
            'Smaller than most single items - worth confirming. A database gave ' +
            '3 g for a biscuit once.'));
        } else if (portion.grams > 2000) {
          out.push(finding(f, 'warn',
            'A "' + portion.name + '" is recorded as ' + portion.grams + ' ' + unit + '.',
            'That is over two kilos.'));
        }
      });

      var named = (f.portions || []).filter(function (x) { return x.name !== 'gram'; });
      if (!named.length) {
        out.push(finding(f, 'note',
          'No serving recorded, so this can only be logged by the ' +
          (unit === 'ml' ? 'millilitre' : 'gram') + '.'));
      }

      if (f.basis !== 'volume' && DRINK_WORDS.test(f.name || '')) {
        out.push(finding(f, 'note',
          'This looks like a drink but is measured in grams.',
          'Drinks are usually recorded per 100 ml. Worth a look.'));
      }

      if (f.barcode) {
        (byBarcode[f.barcode] = byBarcode[f.barcode] || []).push(f);
      }
    });

    Object.keys(byBarcode).forEach(function (code) {
      var group = byBarcode[code];
      if (group.length > 1) {
        out.push(finding(group[0], 'warn',
          'Barcode ' + code + ' is on ' + group.length + ' foods.',
          'Scanning it will always pick the same one: ' +
          group.map(function (f) { return f.name; }).join(', ')));
      }
    });

    return out;
  }

  /* Re-ask the databases about everything with a barcode, and compare what
   * they say against what is saved. A disagreement is not automatically an
   * error - a label can be corrected, and you may have typed the packet in
   * front of you rather than what a volunteer uploaded - but it is worth
   * seeing.
   */
  function online(foods, settings, onProgress) {
    var withCodes = (foods || []).filter(function (f) { return f.barcode; });
    var out = [];
    var key = CalTrack.usda.keyFor(settings);
    var i = 0;

    function next() {
      if (i >= withCodes.length) return Promise.resolve(out);
      var f = withCodes[i++];
      if (onProgress) onProgress(i, withCodes.length, f.name);

      return Promise.all([
        CalTrack.off.lookup(f.barcode).catch(function () { return null; }),
        key ? CalTrack.usda.lookup(f.barcode, key).catch(function () { return null; })
            : Promise.resolve(null)
      ]).then(function (both) {
        var source = (both[1] && both[1].usable) ? both[1] : both[0];
        if (!source || !(source.per_100g.kcal > 0)) {
          out.push(finding(f, 'note', 'Neither database knows barcode ' + f.barcode + ' now.'));
          return;
        }
        var mine = (f.per_100g && f.per_100g.kcal) || 0;
        var theirs = source.per_100g.kcal;
        var gap = Math.abs(mine - theirs);
        if (mine > 0 && gap / Math.max(mine, theirs) > 0.05) {
          out.push(finding(f, 'warn',
            'You have ' + round(mine) + ' kcal per 100, the database says ' +
            round(theirs) + '.',
            'From ' + (source.source === 'usda' ? 'USDA' : 'Open Food Facts') +
            '. If you typed it off the packet, yours is probably the right one.'));
        }
      }).then(next);
    }

    return next();
  }

  function summarise(findings) {
    var counts = { error: 0, warn: 0, note: 0 };
    findings.forEach(function (f) { counts[f.severity]++; });
    return counts;
  }

  return {
    local: local,
    online: online,
    summarise: summarise
  };
})();
