/* app.js — screens and wiring. All persistence goes through CalTrack.store. */

(function () {
  'use strict';

  // Stamped by tools/stamp.py. Shown in Settings so a bug report can say
  // which version it is about.
  var BUILD = '2026-08-31.1443+1cfd3a4';

  var store = CalTrack.store;
  var nut = CalTrack.nutrition;

  var MEAL_TIMES = ['breakfast', 'lunch', 'dinner', 'snack'];
  var MEAL_LABELS = {
    breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snack'
  };

  // Everything the screens need to know about "where am I".
  var state = {
    date: localDate(new Date()),
    view: 'today',
    mealTime: guessMealTime(),
    pickedFood: null,
    editingFoodId: null,
    // Scanning from the log flow should end at the amount box; scanning from
    // the Foods tab should just leave the food saved in the library.
    scanPurpose: 'log',
    logAfterSave: false,
    segment: 'foods',        // Foods tab: foods or meals
    pickSegment: 'foods',    // the + sheet: foods or meals
    svPrefillGrams: '',      // the serving weight the app suggested
    refPer100: null,         // nutrition already known, from a scan or a save
    svTouched: false,        // has the user overridden the derived figures?
    svFromData: false,       // the serving weight came from a lookup, not a guess
    foodBasis: 'weight',     // 'volume' for drinks, so screens say ml not g
    dayTotal: 0,             // kcal already logged on the day being shown
    editingMealId: null,
    mealItemAfterSave: false,
    loggingMeal: null,       // { meal, items } while the log-a-meal sheet is open
    settings: {}
  };

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- dates

  // Local calendar date as YYYY-MM-DD. Deliberately NOT toISOString(),
  // which converts to UTC and rolls the date over in the evening.
  function localDate(d) {
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function shiftDate(dateStr, days) {
    var parts = dateStr.split('-');
    var d = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    d.setDate(d.getDate() + days);
    return localDate(d);
  }

  function prettyDate(dateStr) {
    var today = localDate(new Date());
    if (dateStr === today) return 'Today';
    if (dateStr === shiftDate(today, -1)) return 'Yesterday';
    if (dateStr === shiftDate(today, 1)) return 'Tomorrow';
    var p = dateStr.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    return d.toLocaleDateString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric'
    });
  }

  function guessMealTime() {
    var h = new Date().getHours();
    if (h < 11) return 'breakfast';
    if (h < 15) return 'lunch';
    if (h < 21) return 'dinner';
    return 'snack';
  }

  // ------------------------------------------------------------- helpers

  function round(n, places) {
    var f = Math.pow(10, places || 0);
    return Math.round(n * f) / f;
  }

  /* What to call the unit on screen. Grams for food, millilitres for
   * drinks - the number is the same either way.
   */
  function unitOf(food) {
    return (food && food.basis === 'volume') ? 'ml' : 'g';
  }

  function unitWord(food, plural) {
    if (food && food.basis === 'volume') return plural ? 'millilitres' : 'millilitre';
    return plural ? 'grams' : 'gram';
  }

  function foodLabel(food) {
    if (!food) return 'Deleted food';
    return food.brand ? food.name + ' - ' + food.brand : food.name;
  }

  function plural(name, qty) {
    if (qty === 1) return name;
    return name + (/s$/i.test(name) ? '' : 's');
  }

  /* Answers the question you are actually asking when you log something:
   * does this still fit? Uses the total for the day being shown, which is
   * also the day the entry will be written to.
   */
  function leftAfter(extraKcal) {
    var target = state.settings.target_kcal;
    if (!(target > 0)) return '';
    var left = target - (state.dayTotal || 0) - extraKcal;
    return left >= 0
      ? 'That leaves ' + round(left) + ' for the day.'
      : 'That puts you ' + round(-left) + ' over.';
  }

  var toastTimer = null;
  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2200);
  }

  function showError(el, message) {
    el.textContent = message;
    el.classList.add('err');
  }

  function clearMsg(el) {
    el.textContent = '';
    el.classList.remove('err');
  }

  // ---------------------------------------------------------------- views

  var VIEWS = ['today', 'foods', 'trend', 'settings'];

  function setView(name) {
    state.view = name;
    VIEWS.forEach(function (v) { $('view-' + v).hidden = (v !== name); });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('is-active', t.dataset.view === name);
    });
    $('fab').hidden = (name === 'settings' || name === 'trend');
    if (name === 'today') renderToday();
    if (name === 'foods') renderFoodsView();
    if (name === 'trend') renderTrend();
    if (name === 'settings') renderSettings();
  }

  function setSegment(which) {
    state.segment = which;
    $('foodsPane').hidden = (which !== 'foods');
    $('mealsPane').hidden = (which !== 'meals');
    Array.prototype.forEach.call($('foodsSegment').querySelectorAll('button'), function (b) {
      b.classList.toggle('is-active', b.dataset.seg === which);
    });
    renderFoodsView();
  }

  function renderFoodsView() {
    if (state.segment === 'meals') renderMeals(); else renderFoods();
  }

  // ------------------------------------------------------------- today

  function renderToday() {
    $('dayLabel').textContent = prettyDate(state.date);

    Promise.all([
      store.log.query(function (e) { return e.date === state.date; }),
      store.foods.all()
    ]).then(function (res) {
      var entries = res[0];
      var foods = res[1];

      var byId = {};
      foods.forEach(function (f) { byId[f.id] = f; });

      var t = nut.totals(entries);
      state.dayTotal = t.kcal;          // so the amount box can say what fits

      $('mProtein').textContent = round(t.protein, 1);
      $('mCarbs').textContent = round(t.carbs, 1);
      $('mFat').textContent = round(t.fat, 1);

      /* What's left is the number you act on, so it gets to be the big one.
       * What you've eaten is context, and moves underneath.
       */
      var target = state.settings.target_kcal;
      var caption = $('kcalCaption');
      var bar = $('kcalBar');

      if (target > 0) {
        var left = target - t.kcal;
        $('kcalBig').textContent = round(Math.abs(left));
        $('kcalUnit').textContent = left >= 0 ? 'kcal left' : 'kcal over';
        caption.textContent = round(t.kcal) + ' of ' + round(target) + ' eaten';
        caption.classList.toggle('over', left < 0);

        bar.hidden = false;
        bar.classList.toggle('over', left < 0);
        $('kcalBarFill').style.width =
          Math.max(0, Math.min(100, (t.kcal / target) * 100)) + '%';
      } else {
        $('kcalBig').textContent = round(t.kcal);
        $('kcalUnit').textContent = 'kcal';
        caption.textContent = 'No daily target yet. Settings can work one out for you.';
        caption.classList.remove('over');
        bar.hidden = true;
      }

      var list = $('logList');
      list.innerHTML = '';

      if (!entries.length) {
        var empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = 'Nothing logged yet. Tap + to add something.';
        list.appendChild(empty);
        return;
      }

      MEAL_TIMES.forEach(function (meal) {
        var group = entries.filter(function (e) { return e.meal_time === meal; });
        if (!group.length) return;

        var groupTotal = nut.totals(group);

        var wrap = document.createElement('div');
        wrap.className = 'mealgroup';

        var head = document.createElement('div');
        head.className = 'mealhead';
        head.innerHTML = '<span>' + MEAL_LABELS[meal] + '</span><span>' +
          round(groupTotal.kcal) + ' kcal</span>';
        wrap.appendChild(head);

        group.forEach(function (e) {
          wrap.appendChild(entryRow(e, byId[e.food_id]));
        });

        list.appendChild(wrap);
      });
    });
  }

  function entryRow(entry, food) {
    var row = document.createElement('div');
    row.className = 'entry';

    var main = document.createElement('div');
    main.className = 'entry-main';

    var name = document.createElement('div');
    name.className = 'entry-name';
    name.textContent = entry.food_name || foodLabel(food);

    var sub = document.createElement('div');
    sub.className = 'entry-sub';
    if (entry.meal_id) {
      var n = (entry.items || []).length;
      sub.textContent = 'meal, ' + n + ' item' + (n === 1 ? '' : 's');
    } else {
      var grams = food ? nut.gramsFor(food, entry.portion, entry.qty) : null;
      var qtyText = round(entry.qty, 2) + ' ' + plural(entry.portion, entry.qty);
      sub.textContent = (grams !== null && entry.portion !== 'gram')
        ? qtyText + '  (' + round(grams) + ' ' + unitOf(food) + ')'
        : qtyText;
    }

    main.appendChild(name);
    main.appendChild(sub);

    var kcal = document.createElement('div');
    kcal.className = 'entry-kcal';
    kcal.textContent = round(entry.computed_kcal) + ' kcal';

    var del = document.createElement('button');
    del.className = 'del';
    del.setAttribute('aria-label', 'Remove ' + name.textContent);
    del.innerHTML = '&times;';
    del.addEventListener('click', function () {
      store.log.remove(entry.id).then(function () {
        toast('Removed');
        renderToday();
      });
    });

    row.appendChild(main);
    row.appendChild(kcal);
    row.appendChild(del);
    return row;
  }

  // -------------------------------------------------------------- foods

  function renderFoods() {
    var filter = $('foodFilter').value.trim().toLowerCase();
    store.foods.all().then(function (foods) {
      var list = $('foodList');
      list.innerHTML = '';

      var shown = foods.filter(function (f) {
        if (!filter) return true;
        return (f.name + ' ' + f.brand).toLowerCase().indexOf(filter) !== -1;
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });

      if (!shown.length) {
        var empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = foods.length
          ? 'No food matches that.'
          : 'Your food library is empty. Add your first food and it stays here for good.';
        list.appendChild(empty);
        return;
      }

      shown.forEach(function (f) {
        var btn = document.createElement('button');
        btn.className = 'fooditem';
        btn.innerHTML =
          '<span class="fi-main"><span class="fi-name"></span>' +
          '<span class="fi-sub"></span></span>';
        btn.querySelector('.fi-name').textContent = f.name;
        btn.querySelector('.fi-sub').textContent = foodSubtitle(f);
        btn.addEventListener('click', function () { openFoodSheet(f); });
        list.appendChild(btn);
      });
    });
  }

  // ------------------------------------------------------- pick a food

  function openPickSheet() {
    state.mealTime = guessMealTime();
    paintMealTimes();
    $('pickSearch').value = '';
    $('pickSheet').hidden = false;
    setPickSegment('foods');
    setTimeout(function () { $('pickSearch').focus(); }, 50);
  }

  function paintMealTimes() {
    Array.prototype.forEach.call(
      $('mealTimePicker').querySelectorAll('button'),
      function (b) { b.classList.toggle('is-active', b.dataset.meal === state.mealTime); }
    );
  }

  function setPickSegment(which) {
    state.pickSegment = which;
    Array.prototype.forEach.call($('pickSegment').querySelectorAll('button'), function (b) {
      b.classList.toggle('is-active', b.dataset.seg === which);
    });
    $('pickSearch').placeholder = (which === 'meals') ? 'Search meals' : 'Search food';
    $('pickScanBtn').hidden = (which === 'meals');
    $('pickNewFood').textContent = (which === 'meals')
      ? 'Build a new meal' : "Add a food that isn't here yet";
    renderPickResults();
  }

  function renderPickResults() {
    if (state.pickSegment === 'meals') return renderPickMeals();
    var q = $('pickSearch').value.trim().toLowerCase();

    Promise.all([store.foods.all(), store.log.all()]).then(function (res) {
      var foods = res[0];
      var entries = res[1];

      // Recently used first — that is what makes logging fast.
      var lastUsed = {};
      entries.forEach(function (e) {
        var stamp = e.created_at || e.date;
        if (!lastUsed[e.food_id] || stamp > lastUsed[e.food_id]) lastUsed[e.food_id] = stamp;
      });

      var shown = foods.filter(function (f) {
        if (!q) return true;
        return (f.name + ' ' + f.brand + ' ' + (f.barcode || '')).toLowerCase().indexOf(q) !== -1;
      }).sort(function (a, b) {
        var la = lastUsed[a.id] || '';
        var lb = lastUsed[b.id] || '';
        if (la !== lb) return la < lb ? 1 : -1;
        return a.name.localeCompare(b.name);
      });

      var box = $('pickResults');
      box.innerHTML = '';

      if (!shown.length) {
        var empty = document.createElement('p');
        empty.className = 'empty';
        empty.textContent = foods.length ? 'Nothing matches.' : 'No foods saved yet.';
        box.appendChild(empty);
        return;
      }

      shown.slice(0, 60).forEach(function (f) {
        var btn = document.createElement('button');
        btn.className = 'fooditem';
        btn.innerHTML =
          '<span class="fi-main"><span class="fi-name"></span>' +
          '<span class="fi-sub"></span></span>';
        btn.querySelector('.fi-name').textContent = f.name;
        btn.querySelector('.fi-sub').textContent = foodSubtitle(f);
        btn.addEventListener('click', function () {
          $('pickSheet').hidden = true;
          openQtySheet(f);
        });
        box.appendChild(btn);
      });
    });
  }

  function renderPickMeals() {
    var q = $('pickSearch').value.trim().toLowerCase();
    Promise.all([store.meals.all(), store.foods.all()]).then(function (res) {
      var meals = res[0];
      var byId = indexById(res[1]);
      var box = $('pickResults');
      box.innerHTML = '';

      var shown = meals.filter(function (m) {
        return !q || m.name.toLowerCase().indexOf(q) !== -1;
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });

      if (!shown.length) {
        box.appendChild(emptyNote(meals.length
          ? 'No meal matches that.'
          : 'No meals yet. A meal is a list of foods you tap once instead of four times.'));
        return;
      }

      shown.forEach(function (m) {
        box.appendChild(mealButton(m, byId, function () {
          $('pickSheet').hidden = true;
          openMealLogSheet(m);
        }));
      });
    });
  }

  // ------------------------------------------------------ quantity sheet

  function openQtySheet(food) {
    state.pickedFood = food;
    $('qtyFoodName').textContent = foodLabel(food);

    var sel = $('qtyPortion');
    sel.innerHTML = '';
    food.portions.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p.name;
      opt.textContent = p.name === 'gram'
        ? unitWord(food, true)
        : p.name + ' (' + round(p.grams, 1) + ' ' + unitOf(food) + ')';
      sel.appendChild(opt);
    });

    // Default to the first named portion — "2 slices" beats "56 grams".
    var named = food.portions.filter(function (p) { return p.name !== 'gram'; })[0];
    sel.value = named ? named.name : 'gram';
    $('qtyAmount').value = named ? 1 : 100;

    updateQtyPreview();
    $('qtySheet').hidden = false;
    setTimeout(function () { $('qtyAmount').select(); }, 50);
  }

  function updateQtyPreview() {
    var food = state.pickedFood;
    if (!food) return;
    var qty = parseFloat($('qtyAmount').value);
    var portion = $('qtyPortion').value;
    var grams = nut.gramsFor(food, portion, qty);
    var m = nut.macrosForGrams(food, grams);
    var fits = leftAfter(m.kcal);
    $('qtyPreview').innerHTML =
      '<b>' + round(m.kcal) + '</b> kcal<br>' +
      round(grams, 1) + ' ' + unitOf(food) + '  -  ' +
      round(m.protein, 1) + ' g protein, ' +
      round(m.carbs, 1) + ' g carbs, ' +
      round(m.fat, 1) + ' g fat' +
      (fits ? '<br><span class="fits">' + fits + '</span>' : '');
  }

  function confirmQty() {
    var food = state.pickedFood;
    var qty = parseFloat($('qtyAmount').value);
    if (!isFinite(qty) || qty <= 0) { toast('Enter an amount above zero'); return; }

    var portion = $('qtyPortion').value;
    var m = nut.macrosFor(food, portion, qty);

    store.log.insert({
      date: state.date,
      meal_time: state.mealTime,
      food_id: food.id,
      meal_id: null,
      food_name: foodLabel(food),   // snapshot, so history survives a deleted food
      portion: portion,
      qty: qty,
      computed_kcal: m.kcal,
      computed_protein_g: m.protein,
      computed_carbs_g: m.carbs,
      computed_fat_g: m.fat,
      user_id: null
    }).then(function () {
      $('qtySheet').hidden = true;
      state.pickedFood = null;
      toast('Logged ' + round(m.kcal) + ' kcal');
      setView('today');
    }).catch(function (err) { toast(err.message); });
  }

  // -------------------------------------------------------- food editor

  /* food may be an existing row, a draft from Open Food Facts, or null.
   * opts.asNew   - prefill the form but save as a new food
   * opts.notes   - things worth telling the user about the draft
   * opts.thenLog - after saving, go straight to the amount box
   */
  function openFoodSheet(food, opts) {
    opts = opts || {};
    var isExisting = !!(food && food.id && !opts.asNew);
    state.editingFoodId = isExisting ? food.id : null;
    state.logAfterSave = !!opts.thenLog;
    state.mealItemAfterSave = !!opts.thenMealItem;
    clearMsg($('foodMsg'));

    var notesEl = $('foodNotes');
    var notes = (opts.notes || []).filter(Boolean);
    notesEl.hidden = !notes.length;
    notesEl.textContent = notes.join(' ');

    $('foodSheetTitle').textContent = isExisting ? 'Edit food' : 'New food';
    var per = (food && food.per_100g) || {};

    $('fName').value = food ? (food.name || '') : '';
    $('fBrand').value = food ? (food.brand || '') : '';
    $('fBarcode').value = food && food.barcode ? food.barcode : '';

    // "gram" is implicit and always available, so it is never listed.
    var named = (food && food.portions || []).filter(function (p) {
      return p.name !== 'gram';
    });

    /* The first named portion IS the serving, so the form opens showing the
     * food the way its label describes it. A food with no named portion has
     * nothing to be per-serving about, so that one opens on per 100 g.
     */
    var serving = named[0] || null;

    /* Four cases, in order of how much is actually known. The boxes are
     * only ever left empty when nothing at all can be worked out - a blank
     * form after a successful scan reads as a failure, which is how this
     * looked when the recovered serving sat behind a button nobody pressed.
     *
     *  1. the label's own per-serving figures came with the scan - verbatim
     *  2. a serving weight is known but not its figures - derive them
     *  3. neither, but the per-100 g decimals give the serving away -
     *     use what they imply and say plainly that is what happened
     *  4. nothing to go on - empty, with the packet-reading prompt
     */
    var label = (food && food.serving && food.serving.macros) || null;
    var inferred = (!serving && per.kcal > 0)
      ? CalTrack.off.inferServing(per) : null;

    var prefillGrams = serving ? serving.grams : (inferred ? inferred.grams : '');
    state.svPrefillGrams = prefillGrams;

    /* The name box stays EMPTY unless the food already has a real portion
     * name. Filling it with the word "serving" made the form read "a serving
     * is one serving", and a serving is often two of something anyway - the
     * packet says "2 sheets". Blank means it is simply called a serving.
     */
    state.foodBasis = (food && food.basis === 'volume') ? 'volume' : 'weight';
    var unit = unitOf({ basis: state.foodBasis });
    $('svGramsLabel').textContent = 'One serving is (' + unit + ')';

    var realName = serving && serving.name !== 'serving' ? serving.name : '';
    $('svName').value = realName;
    $('svGrams').value = prefillGrams;

    // A weight that came from data is a portion worth keeping, even if the
    // user never touches the name box.
    state.svFromData = !!(serving || inferred);

    if (label) {
      $('svKcal').value = round(label.kcal, 2);
      $('svProtein').value = round(label.protein, 2);
      $('svCarbs').value = round(label.carbs, 2);
      $('svFat').value = round(label.fat, 2);
    } else if (serving && food) {
      // Two decimals: these get converted back to per 100 g on save, so a
      // coarse round here would nudge the stored numbers every time you
      // opened and saved a food without changing anything.
      var m = nut.macrosFor(food, serving.name, 1);
      $('svKcal').value = round(m.kcal, 2);
      $('svProtein').value = round(m.protein, 2);
      $('svCarbs').value = round(m.carbs, 2);
      $('svFat').value = round(m.fat, 2);
    } else if (inferred) {
      $('svKcal').value = inferred.kcal;
      $('svProtein').value = inferred.protein;
      $('svCarbs').value = inferred.carbs;
      $('svFat').value = inferred.fat;
    } else {
      ['svKcal', 'svProtein', 'svCarbs', 'svFat'].forEach(function (id) { $(id).value = ''; });
    }

    showServingNote(serving, inferred);

    /* Whatever nutrition we already hold - from a scan, or from the saved
     * food - becomes the REFERENCE, so changing the portion weight can
     * recalculate the figures instead of asking for them again.
     */
    state.refPer100 = (per.kcal > 0) ? {
      kcal: per.kcal, protein: per.protein || 0,
      carbs: per.carbs || 0, fat: per.fat || 0
    } : null;
    state.svTouched = false;

    updateServingHint();
    updateServingEcho();

    // The serving is edited above, so only the extra ones are listed here.
    $('portionRows').innerHTML = '';
    named.slice(1).forEach(addPortionRow);

    $('deleteFoodBtn').hidden = !isExisting;
    $('foodSheet').hidden = false;
    if (!food) setTimeout(function () { $('fName').focus(); }, 50);
  }

  function addPortionRow(portion) {
    var wrap = document.createElement('div');
    wrap.className = 'portionwrap';

    var row = document.createElement('div');
    row.className = 'portionrow';

    var name = document.createElement('input');
    name.type = 'text';
    name.placeholder = 'slice';
    name.className = 'p-name';
    name.value = portion ? portion.name : '';

    var grams = document.createElement('input');
    grams.type = 'number';
    grams.step = 'any';
    grams.inputMode = 'decimal';
    grams.placeholder = unitWord({ basis: state.foodBasis }, true);
    grams.className = 'p-grams';
    grams.value = portion ? portion.grams : '';

    // Weigh-to-derive: put five slices on the scale, say five, and the app
    // works out what one slice weighs. Beats guessing, beats arithmetic.
    var weigh = document.createElement('button');
    weigh.type = 'button';
    weigh.className = 'weighbtn';
    weigh.textContent = 'Weigh';
    weigh.title = 'Work this out from your kitchen scale';

    var del = document.createElement('button');
    del.type = 'button';
    del.innerHTML = '&times;';
    del.setAttribute('aria-label', 'Remove this portion');
    del.addEventListener('click', function () { wrap.remove(); });

    row.appendChild(name);
    row.appendChild(grams);
    row.appendChild(weigh);
    row.appendChild(del);
    wrap.appendChild(row);

    var strip = buildWeighStrip(name, grams);
    wrap.appendChild(strip);
    weigh.addEventListener('click', function () {
      strip.hidden = !strip.hidden;
      if (!strip.hidden) strip.querySelector('.w-count').focus();
    });

    $('portionRows').appendChild(wrap);
  }

  /* The scale strip: how many went on the scale, and what the scale said.
   * One divided by the other is the weight of one.
   */
  function buildWeighStrip(nameInput, gramsInput) {
    var strip = document.createElement('div');
    strip.className = 'weighstrip';
    strip.hidden = true;

    var count = document.createElement('input');
    count.type = 'number';
    count.step = 'any';
    count.inputMode = 'decimal';
    count.className = 'w-count';
    count.placeholder = 'how many';

    var total = document.createElement('input');
    total.type = 'number';
    total.step = 'any';
    total.inputMode = 'decimal';
    total.className = 'w-total';
    total.placeholder = 'scale says (g)';

    var go = document.createElement('button');
    go.type = 'button';
    go.className = 'btn small';
    go.textContent = 'Work it out';

    var out = document.createElement('p');
    out.className = 'w-out hint';

    go.addEventListener('click', function () {
      var n = parseFloat(count.value);
      var g = parseFloat(total.value);
      if (!isFinite(n) || n <= 0) { out.textContent = 'How many did you put on the scale?'; return; }
      if (!isFinite(g) || g <= 0) { out.textContent = 'What did the scale read, in grams?'; return; }
      var each = nut.perUnitGrams(g, n);
      gramsInput.value = round(each, 2);
      var unit = nameInput.value.trim() || 'portion';
      out.textContent = round(n, 2) + ' ' + plural(unit, n) + ' weighed ' +
        round(g, 1) + ' g, so one is ' + round(each, 2) + ' g.';
    });

    strip.appendChild(count);
    strip.appendChild(total);
    strip.appendChild(go);
    strip.appendChild(out);
    return strip;
  }

  function collectPortions() {
    var rows = $('portionRows').querySelectorAll('.portionrow');
    var out = [];
    Array.prototype.forEach.call(rows, function (r) {
      var name = r.querySelector('.p-name').value.trim();
      var grams = parseFloat(r.querySelector('.p-grams').value);
      if (name && isFinite(grams) && grams > 0) out.push({ name: name, grams: grams });
    });
    return out;
  }

  function updateServingHint() {
    var el = $('svHint');
    if (state.refPer100) {
      el.textContent = $('svGrams').value
        ? 'Straight off the scan, as the packet prints it. Change the weight if ' +
          'you eat a different amount and the figures follow.'
        : 'The scan found this food but not its serving size, so read that off ' +
          'the packet: what one serving weighs, and what is in it. For reference ' +
          'it holds ' + round(state.refPer100.kcal) + ' kcal per 100 g.';
    } else {
      el.textContent = "Copy this straight off the label, exactly as it's " +
        'written. The serving weight in grams is printed there too, usually in ' +
        'brackets right after the serving size - "1 slice (28g)". If your label ' +
        'is written per 100 g, put 100 in the weight box and copy it as it is.';
    }
  }

  /* Says where a recovered serving came from. The figures are already in
   * the boxes above - this explains that they were worked out rather than
   * read, so they get checked against the packet rather than trusted.
   */
  function showServingNote(serving, inferred) {
    var box = $('svSuggest');
    box.innerHTML = '';
    box.hidden = true;

    var text = document.createElement('p');
    text.className = 'hint';
    text.style.margin = '0';

    if (state.foodBasis === 'volume') {
      text.textContent = 'This is a drink, so everything here is in millilitres ' +
        'rather than grams - the nutrition is recorded per 100 ml' +
        (serving && serving.label ? ', and the label calls one serving "' +
          serving.label + '"' : '') +
        '. Logging it by millilitres is exact. If you weigh it instead, milk is ' +
        'about 3% heavier than the same volume of water.';
    } else if (serving && serving.label) {
      // "2 sheets (31 g)" or "2 full" - what the packet actually says, which
      // is far more use than a bare weight when you are holding the box.
      text.textContent = 'The label calls one serving "' + serving.label +
        '". Leave the name blank and it logs as "1 serving"; put "sheet" in ' +
        'and change the weight to one sheet if you would rather count those.';
    } else if (!serving && inferred) {
      text.textContent = 'The database had no serving size for this, but its ' +
        'per-100 g figures divide exactly by ' + inferred.grams + ' g - so that ' +
        'is almost certainly the serving someone typed in, and it is what is ' +
        'filled in above. Worth checking against the packet.';
    } else {
      return;
    }

    box.appendChild(text);
    box.hidden = false;
  }

  /* Type "28 g" against a food whose nutrition we already have, and the four
   * boxes fill themselves. Stops the moment you edit one by hand - at that
   * point the label in front of you beats the database.
   */
  function fillServingFromReference() {
    if (!state.refPer100 || state.svTouched) return;
    var grams = parseFloat($('svGrams').value);
    if (!(grams > 0)) return;
    var m = nut.macrosForGrams({ per_100g: state.refPer100 }, grams);
    $('svKcal').value = round(m.kcal, 2);
    $('svProtein').value = round(m.protein, 2);
    $('svCarbs').value = round(m.carbs, 2);
    $('svFat').value = round(m.fat, 2);
  }

  // Shows the working, so the numbers are never a black box.
  function updateServingEcho() {
    var el = $('svEcho');
    var g = parseFloat($('svGrams').value);
    var kcal = parseFloat($('svKcal').value);
    if (!(g > 0) || !isFinite(kcal)) { el.textContent = ''; return; }
    var unit = $('svName').value.trim();
    el.textContent = unit
      ? 'So one ' + unit + ' is ' + round(kcal) + ' kcal, and you can log "2 ' +
        plural(unit, 2) + '" without thinking about grams again.'
      : 'So a serving is ' + round(kcal) + ' kcal at ' + round(g, 1) + ' g. Log ' +
        'it as "1 serving", or by the gram when you weigh it.';
  }

  function saveFood() {
    var msg = $('foodMsg');
    clearMsg(msg);

    var name = $('fName').value.trim();
    if (!name) { showError(msg, 'Give the food a name.'); return; }

    /* Nutrition is only ever typed per serving, because that is how every
     * label is written. It is STORED per 100 g, because that is the only
     * unit that makes "2 slices", "150 grams" and "a third of the pot" all
     * work off one record. This is where one becomes the other.
     */
    var grams = parseFloat($('svGrams').value);
    var sKcal = parseFloat($('svKcal').value);
    var haveServing = (grams > 0) && isFinite(sKcal) && sKcal >= 0;
    var unit = ($('svName').value.trim() || 'serving').toLowerCase();

    // A weight the app suggested and the user never touched is a guess, not
    // a portion they have told us about, so it does not get saved as one.
    var engaged = !!$('svName').value.trim() || state.svTouched ||
      state.svFromData || grams !== Number(state.svPrefillGrams);

    var extras = collectPortions().filter(function (p) {
      return p.name.toLowerCase() !== unit;
    });

    var per100, portions;

    if (haveServing) {
      // Same arithmetic as batch cooking, and tested in the same place.
      per100 = nut.per100gFrom({
        kcal: sKcal,
        protein: parseFloat($('svProtein').value) || 0,
        carbs: parseFloat($('svCarbs').value) || 0,
        fat: parseFloat($('svFat').value) || 0
      }, grams);
      portions = engaged ? [{ name: unit, grams: grams }].concat(extras) : extras;
    } else if (state.refPer100) {
      // Scanned, and the portion left alone. Perfectly usable - it just gets
      // logged by the gram until a weight is added.
      per100 = state.refPer100;
      portions = (grams > 0) ? [{ name: unit, grams: grams }].concat(extras) : extras;
    } else if (grams > 0) {
      showError(msg, 'Enter the calories in one ' + unit + '.');
      return;
    } else {
      showError(msg, 'Enter what one serving weighs and what is in it.');
      return;
    }

    var record = {
      name: name,
      brand: $('fBrand').value.trim(),
      barcode: $('fBarcode').value.trim() || null,
      basis: state.foodBasis,
      per_100g: per100,
      portions: portions,
      source: 'manual'
    };

    barcodeClash(record.barcode, state.editingFoodId).then(function (clash) {
      if (clash) {
        showError(msg, 'That barcode is already on "' + foodLabel(clash) +
          '". Edit that food instead, or clear the barcode here.');
        return null;
      }
      return state.editingFoodId
        ? store.foods.update(state.editingFoodId, record)
        : store.foods.insert(record);
    }).then(function (saved) {
      if (!saved) return;
      $('foodSheet').hidden = true;
      toast('Saved');
      if (state.mealItemAfterSave) {
        state.mealItemAfterSave = false;
        return addScannedIngredient(saved);   // scanned while building a meal
      }
      if (state.logAfterSave) {
        state.logAfterSave = false;
        openQtySheet(saved);          // scanned to eat it, so ask how much
        return;
      }
      if (state.view === 'foods') renderFoods(); else setView('foods');
    }).catch(function (err) { showError(msg, err.message); });
  }

  // Two foods sharing a barcode would make scanning ambiguous forever after.
  function barcodeClash(barcode, ownId) {
    if (!barcode) return Promise.resolve(null);
    return store.foods.query(function (f) {
      return f.barcode === barcode && f.id !== ownId;
    }).then(function (hits) { return hits[0] || null; });
  }

  function deleteFood() {
    var id = state.editingFoodId;
    if (!id) return;
    store.log.query(function (e) { return e.food_id === id; }).then(function (used) {
      var warn = 'Delete this food?';
      if (used.length) {
        warn += '\n\nIt is used by ' + used.length + ' log entr' +
          (used.length === 1 ? 'y' : 'ies') +
          '. Those stay in your log with the calories already worked out.';
      }
      if (!window.confirm(warn)) return;
      store.foods.remove(id).then(function () {
        $('foodSheet').hidden = true;
        toast('Deleted');
        renderFoods();
      });
    });
  }

  // --------------------------------------------------------------- meals

  function indexById(rows) {
    var out = {};
    rows.forEach(function (r) { out[r.id] = r; });
    return out;
  }

  /* What a food says underneath its name. If it has a serving, that is what
   * the person actually eats, so that is what gets shown - per 100 g only
   * appears for foods that have no serving to speak of.
   */
  function foodSubtitle(f) {
    var prefix = f.brand ? f.brand + '  -  ' : '';
    var named = (f.portions || []).filter(function (p) { return p.name !== 'gram'; })[0];
    if (named) {
      return prefix + round(nut.macrosFor(f, named.name, 1).kcal) +
        ' kcal per ' + (named.name === 'serving' ? 'serving' : named.name);
    }
    return prefix + round(f.per_100g.kcal) + ' kcal / 100 ' + unitOf(f);
  }

  function emptyNote(text) {
    var p = document.createElement('p');
    p.className = 'empty';
    p.textContent = text;
    return p;
  }

  // The arithmetic itself lives in store.js, where it can be tested.
  function mealTotals(items, byId) {
    return nut.sumItems(items, byId);
  }

  function mealButton(meal, byId, onClick) {
    var t = mealTotals(meal.items, byId);
    var btn = document.createElement('button');
    btn.className = 'fooditem';
    btn.innerHTML = '<span class="fi-main"><span class="fi-name"></span>' +
      '<span class="fi-sub"></span></span><span class="entry-kcal"></span>';
    btn.querySelector('.fi-name').textContent = meal.name;
    btn.querySelector('.fi-sub').textContent =
      (meal.items || []).length + ' item' + ((meal.items || []).length === 1 ? '' : 's') +
      (t.missing ? '  -  ' + t.missing + ' deleted' : '');
    btn.querySelector('.entry-kcal').textContent = round(t.kcal) + ' kcal';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderMeals() {
    var filter = $('mealFilter').value.trim().toLowerCase();
    Promise.all([store.meals.all(), store.foods.all()]).then(function (res) {
      var meals = res[0];
      var byId = indexById(res[1]);
      var list = $('mealList');
      list.innerHTML = '';

      var shown = meals.filter(function (m) {
        return !filter || m.name.toLowerCase().indexOf(filter) !== -1;
      }).sort(function (a, b) { return a.name.localeCompare(b.name); });

      if (!shown.length) {
        list.appendChild(emptyNote(meals.length
          ? 'No meal matches that.'
          : 'No meals yet. Build one for something you eat often and it becomes a single tap.'));
        return;
      }
      shown.forEach(function (m) {
        list.appendChild(mealButton(m, byId, function () { openMealSheet(m); }));
      });
    });
  }

  function openMealSheet(meal) {
    state.editingMealId = meal ? meal.id : null;
    clearMsg($('mealMsg'));
    $('mealSheetTitle').textContent = meal ? 'Edit meal' : 'New meal';
    $('mealName').value = meal ? meal.name : '';
    $('batchGrams').value = '';
    $('deleteMealBtn').hidden = !meal;

    store.foods.all().then(function (foods) {
      state.mealFoods = foods;
      var box = $('mealItems');
      box.innerHTML = '';
      var items = (meal && meal.items) || [];
      if (!items.length) {
        addMealItemRow(null, foods);
      } else {
        items.forEach(function (it) { addMealItemRow(it, foods); });
      }
      refreshMealTotals();
      $('mealSheet').hidden = false;
      if (!meal) setTimeout(function () { $('mealName').focus(); }, 50);
    });
  }

  function addMealItemRow(item, foods) {
    var row = document.createElement('div');
    row.className = 'itemrow';

    var foodSel = document.createElement('select');
    foodSel.className = 'm-food';
    foods.slice().sort(function (a, b) { return a.name.localeCompare(b.name); })
      .forEach(function (f) {
        var opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = foodLabel(f);
        foodSel.appendChild(opt);
      });
    if (item && item.food_id) foodSel.value = item.food_id;

    var portionSel = document.createElement('select');
    portionSel.className = 'm-portion';

    var qty = document.createElement('input');
    qty.type = 'number';
    qty.step = 'any';
    qty.inputMode = 'decimal';
    qty.className = 'm-qty';
    qty.value = item ? item.qty : 1;

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'rowdel';
    del.innerHTML = '&times;';
    del.setAttribute('aria-label', 'Remove this ingredient');
    del.addEventListener('click', function () { row.remove(); refreshMealTotals(); });

    function fillPortions(selected) {
      var food = state.mealFoods.filter(function (f) { return f.id === foodSel.value; })[0];
      portionSel.innerHTML = '';
      ((food && food.portions) || [{ name: 'gram', grams: 1 }]).forEach(function (p) {
        var opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name === 'gram' ? 'grams' : p.name;
        portionSel.appendChild(opt);
      });
      if (selected) portionSel.value = selected;
    }
    fillPortions(item && item.portion);

    foodSel.addEventListener('change', function () { fillPortions(); refreshMealTotals(); });
    portionSel.addEventListener('change', refreshMealTotals);
    qty.addEventListener('input', refreshMealTotals);

    row.appendChild(foodSel);
    row.appendChild(qty);
    row.appendChild(portionSel);
    row.appendChild(del);
    $('mealItems').appendChild(row);
  }

  function collectMealItems() {
    var rows = $('mealItems').querySelectorAll('.itemrow');
    var out = [];
    Array.prototype.forEach.call(rows, function (r) {
      var foodId = r.querySelector('.m-food').value;
      var qty = parseFloat(r.querySelector('.m-qty').value);
      var portion = r.querySelector('.m-portion').value;
      if (foodId && isFinite(qty) && qty > 0) {
        out.push({ food_id: foodId, portion: portion, qty: qty });
      }
    });
    return out;
  }

  function refreshMealTotals() {
    var byId = indexById(state.mealFoods || []);
    var t = mealTotals(collectMealItems(), byId);
    $('mealTotals').innerHTML = '<b>' + round(t.kcal) + '</b> kcal<br>' +
      round(t.protein, 1) + ' g protein, ' + round(t.carbs, 1) + ' g carbs, ' +
      round(t.fat, 1) + ' g fat';
  }

  function saveMeal() {
    var msg = $('mealMsg');
    clearMsg(msg);
    var name = $('mealName').value.trim();
    if (!name) { showError(msg, 'Give the meal a name.'); return; }

    var items = collectMealItems();
    if (!items.length) { showError(msg, 'Add at least one ingredient.'); return; }

    var record = { name: name, items: items, user_id: null };
    var op = state.editingMealId
      ? store.meals.update(state.editingMealId, record)
      : store.meals.insert(record);

    op.then(function () {
      $('mealSheet').hidden = true;
      toast('Meal saved');
      state.segment = 'meals';
      setSegment('meals');
    }).catch(function (err) { showError(msg, err.message); });
  }

  function deleteMeal() {
    if (!state.editingMealId) return;
    if (!window.confirm('Delete this meal? Anything already logged from it stays in your log.')) return;
    store.meals.remove(state.editingMealId).then(function () {
      $('mealSheet').hidden = true;
      toast('Deleted');
      renderMeals();
    });
  }

  /* Batch cooking, from section 4 of the plan: everything that went in the
   * pot, divided by what the pot weighs, gives a per-100 g food.
   */
  function batchToFood() {
    var msg = $('mealMsg');
    clearMsg(msg);
    var grams = parseFloat($('batchGrams').value);
    if (!isFinite(grams) || grams <= 0) {
      showError(msg, 'Weigh the finished dish and put that in, in grams.');
      return;
    }
    var name = $('mealName').value.trim();
    if (!name) { showError(msg, 'Give it a name first.'); return; }

    var items = collectMealItems();
    if (!items.length) { showError(msg, 'List what went into it first.'); return; }

    var t = mealTotals(items, indexById(state.mealFoods || []));
    if (t.missing) {
      showError(msg, t.missing + ' of the ingredients no longer exist, so the total would be wrong.');
      return;
    }
    store.foods.insert({
      name: name,
      brand: '',
      barcode: null,
      per_100g: nut.per100gFrom(t, grams),
      portions: [{ name: 'whole batch', grams: grams }],
      source: 'batch'
    }).then(function (food) {
      $('mealSheet').hidden = true;
      toast('Saved as a food');
      state.segment = 'foods';
      setSegment('foods');
      openFoodSheet(food, {
        notes: ['Worked out from ' + round(t.kcal) + ' kcal across ' + round(grams) +
                ' g of finished dish. Weigh your bowl and log it in grams.']
      });
    }).catch(function (err) { showError(msg, err.message); });
  }

  // ------------------------------------------------------- logging a meal

  function openMealLogSheet(meal) {
    store.foods.all().then(function (foods) {
      state.mealFoods = foods;
      state.loggingMeal = meal;
      $('mealLogName').textContent = meal.name;

      var box = $('mealLogItems');
      box.innerHTML = '';
      var byId = indexById(foods);

      (meal.items || []).forEach(function (it) {
        var food = byId[it.food_id];
        var row = document.createElement('div');
        row.className = 'itemrow logrow';

        var label = document.createElement('div');
        label.className = 'logrow-name';
        label.textContent = food ? foodLabel(food) : 'Deleted food';

        var qty = document.createElement('input');
        qty.type = 'number';
        qty.step = 'any';
        qty.inputMode = 'decimal';
        qty.className = 'm-qty';
        qty.value = it.qty;
        qty.disabled = !food;

        var portion = document.createElement('select');
        portion.className = 'm-portion';
        ((food && food.portions) || [{ name: 'gram', grams: 1 }]).forEach(function (p) {
          var opt = document.createElement('option');
          opt.value = p.name;
          opt.textContent = p.name === 'gram' ? 'grams' : p.name;
          portion.appendChild(opt);
        });
        portion.value = it.portion;
        portion.disabled = !food;

        row.dataset.foodId = it.food_id;
        qty.addEventListener('input', refreshMealLogTotals);
        portion.addEventListener('change', refreshMealLogTotals);

        row.appendChild(label);
        row.appendChild(qty);
        row.appendChild(portion);
        box.appendChild(row);
      });

      refreshMealLogTotals();
      $('mealLogSheet').hidden = false;
    });
  }

  function collectMealLogItems() {
    var rows = $('mealLogItems').querySelectorAll('.logrow');
    var out = [];
    Array.prototype.forEach.call(rows, function (r) {
      var qty = parseFloat(r.querySelector('.m-qty').value);
      if (!isFinite(qty) || qty <= 0) return;
      out.push({
        food_id: r.dataset.foodId,
        portion: r.querySelector('.m-portion').value,
        qty: qty
      });
    });
    return out;
  }

  function refreshMealLogTotals() {
    var t = mealTotals(collectMealLogItems(), indexById(state.mealFoods || []));
    var fits = leftAfter(t.kcal);
    $('mealLogTotals').innerHTML = '<b>' + round(t.kcal) + '</b> kcal<br>' +
      round(t.protein, 1) + ' g protein, ' + round(t.carbs, 1) + ' g carbs, ' +
      round(t.fat, 1) + ' g fat' +
      (fits ? '<br><span class="fits">' + fits + '</span>' : '');
  }

  function confirmMealLog() {
    var meal = state.loggingMeal;
    if (!meal) return;
    var items = collectMealLogItems();
    if (!items.length) { toast('Nothing to log'); return; }

    var t = mealTotals(items, indexById(state.mealFoods || []));

    store.log.insert({
      date: state.date,
      meal_time: state.mealTime,
      food_id: null,
      meal_id: meal.id,
      food_name: meal.name,
      items: items,                 // as logged, not as saved
      portion: 'meal',
      qty: 1,
      computed_kcal: t.kcal,
      computed_protein_g: t.protein,
      computed_carbs_g: t.carbs,
      computed_fat_g: t.fat,
      user_id: null
    }).then(function () {
      $('mealLogSheet').hidden = true;
      state.loggingMeal = null;
      toast('Logged ' + round(t.kcal) + ' kcal');
      setView('today');
    }).catch(function (err) { toast(err.message); });
  }

  // --------------------------------------------------------------- trend

  function renderTrend() {
    if (!$('weightDate').value) $('weightDate').value = localDate(new Date());

    Promise.all([store.weighIns.all(), store.log.all()]).then(function (res) {
      var weighIns = res[0];
      var entries = res[1];
      var T = CalTrack.trend;

      drawChart(weighIns);
      renderWeighList(weighIns);

      var measured = T.measureTdee({
        entries: entries, weighIns: weighIns,
        asOf: localDate(new Date())
      });
      renderTdee(measured);

      renderComposition(weighIns);
      renderGoal(T.projectGoal({
        weighIns: weighIns, settings: state.settings, asOf: localDate(new Date())
      }));

      var p = T.plateau({
        entries: entries, weighIns: weighIns,
        settings: state.settings, measured: measured,
        asOf: localDate(new Date())
      });
      renderPlateau(p, measured);
    });
  }

  function renderTdee(m) {
    var box = $('tdeeBody');
    box.innerHTML = '';

    if (!m.tdee) {
      box.appendChild(emptyNote('Weigh in a few times and keep logging food. ' +
        'This works your burn rate out from what actually happens, which needs ' +
        'about two weeks of both before it means anything.'));
      return;
    }

    var big = document.createElement('div');
    big.className = 'bignum';
    big.innerHTML = '<b>' + round(m.tdee) + '</b> kcal a day';

    var badge = document.createElement('span');
    badge.className = 'badge badge-' + m.confidence;
    badge.textContent = m.confidence === 'ok' ? 'measured'
      : m.confidence === 'low' ? 'early estimate' : 'not yet reliable';

    var detail = document.createElement('p');
    detail.className = 'hint';
    detail.textContent = m.reason + ' Over ' + m.days + ' days you averaged ' +
      round(m.avgIntake) + ' kcal and your weight moved ' +
      (m.weightChangeLbs <= 0 ? 'down ' : 'up ') +
      Math.abs(m.weightChangeLbs).toFixed(1) + ' lb.';

    box.appendChild(big);
    box.appendChild(badge);
    box.appendChild(detail);

    // The handover: once there is a real measurement, say how far the
    // formula that got you started actually was.
    var est = state.settings.estimated_tdee;
    if (est && m.confidence !== 'none') {
      var diff = Math.round(m.tdee - est);
      var handover = document.createElement('p');
      handover.className = 'notes';
      handover.textContent = Math.abs(diff) < 50
        ? 'The starting estimate said ' + round(est) + '. It was close. This ' +
          'measured figure is the one to trust from here.'
        : 'The starting estimate said ' + round(est) + ', so the formula was out by ' +
          Math.abs(diff) + ' kcal ' + (diff > 0 ? 'low' : 'high') +
          '. This measured figure replaces it.';
      box.appendChild(handover);
    }
  }

  function renderComposition(weighIns) {
    var box = $('compBody');
    box.innerHTML = '';
    var T = CalTrack.trend;

    // --- BMI ---
    var smoothed = T.emaSeries(weighIns);
    var current = smoothed.length ? smoothed[smoothed.length - 1].ema : null;
    var height = state.settings.height_in;

    if (current && height > 0) {
      var b = T.bmi(current, height);
      var line = document.createElement('div');
      line.className = 'bignum';
      line.innerHTML = '<b>' + round(b.bmi, 1) + '</b> BMI';
      box.appendChild(line);
      box.appendChild(hintP('At ' + round(current, 1) + ' lb and ' +
        Math.floor(height / 12) + "'" + Math.round(height % 12) + '", that is ' +
        b.category + '.'));

      /* The second marker is the nearest edge of the healthy band - the
       * weight you would actually be aiming at from where you are, rather
       * than an abstract midpoint nobody targets.
       */
      var range = T.healthyWeightRange(height);
      var target = null;
      if (current > range.max) {
        target = { bmi: 25, weight: range.max };
      } else if (current < range.min) {
        target = { bmi: 18.5, weight: range.min };
      }

      box.appendChild(bmiBar(b.bmi, target));

      var feet = Math.floor(height / 12) + "'" + Math.round(height % 12) + '"';
      var text = 'A healthy weight at ' + feet + ' is ' + round(range.min) +
        ' to ' + round(range.max) + ' lb. ';

      if (current > range.max) {
        text += 'You are ' + round(current - range.max) + ' lb above that.';
      } else if (current < range.min) {
        text += 'You are ' + round(range.min - current) + ' lb below it.';
      } else {
        text += 'You are in it.';
      }
      box.appendChild(hintP(text));

      // Age does not move the adult thresholds, with one exception worth
      // saying out loud rather than quietly encoding.
      if (state.settings.age >= 65) {
        box.appendChild(hintP('That band is the same at every adult age. Past ' +
          '65 though, a number of guidelines suggest aiming a little higher ' +
          'than the bottom of it - some reserve is protective at that point.'));
      }
    } else if (current) {
      box.appendChild(hintP('BMI needs your height. Put it in Settings, under ' +
        'Daily target, and it appears here.'));
    } else if (height > 0) {
      box.appendChild(hintP('BMI needs a weigh-in. Add one above and it appears ' +
        'here.'));
    } else {
      box.appendChild(hintP('BMI needs two things: your height, in Settings ' +
        'under Daily target, and at least one weigh-in above.'));
    }

    // --- composition ---
    var c = T.composition(weighIns);
    if (!c.readings) {
      box.appendChild(hintP('Add a body fat % or muscle mass beside a weigh-in ' +
        'and this will track which of fat and muscle is moving.'));
      return;
    }
    if (c.readings < 2) {
      box.appendChild(hintP('One body fat reading recorded. A second one, a few ' +
        'weeks apart, is what makes it useful.'));
      return;
    }

    var badge = document.createElement('span');
    badge.className = 'badge badge-' + c.confidence;
    badge.textContent = c.confidence === 'ok' ? 'measured'
      : c.confidence === 'low' ? 'early' : 'too soon to read';
    box.appendChild(badge);

    box.appendChild(hintP('Over ' + c.days + ' days: lean mass ' +
      signed(c.leanChange) + ' lb, fat mass ' + signed(c.fatChange) + ' lb, ' +
      'total ' + signed(c.weightChange) + ' lb. Body fat ' +
      round(c.first.bodyFatPct, 1) + '% to ' + round(c.last.bodyFatPct, 1) + '%.'));

    if (c.muscleChange !== undefined) {
      box.appendChild(hintP('Muscle mass ' + signed(c.muscleChange) + ' lb over ' +
        c.muscleDays + ' days, ' + round(c.muscleFirst, 1) + ' to ' +
        round(c.muscleLast, 1) + ' lb.'));
      var mVerdict = T.readTissueRate(c.musclePerWeek, 'Muscle');
      if (mVerdict) box.appendChild(hintP(mVerdict));
    } else if (c.leanPerWeek !== undefined) {
      var lVerdict = T.readTissueRate(c.leanPerWeek, 'Lean mass');
      if (lVerdict) box.appendChild(hintP(lVerdict));
    }

    box.appendChild(hintP('Your scale works out fat, muscle and water from one ' +
      'electrical measurement plus the height and age programmed into it, so those ' +
      'figures are not independent of each other - if fat reads low, muscle reads ' +
      'high by construction. Hydration moves it by several points, so weigh in the ' +
      'same conditions each time: same hour, before eating or drinking, after the ' +
      'loo. Only the trend across many readings means anything.'));
  }

  /* The BMI bar: coloured bands and a marker for where you are. Built from
   * trend.js's segments so the thresholds live in one place.
   */
  function bmiBar(current, target) {
    var T = CalTrack.trend;
    var wrap = document.createElement('div');
    wrap.className = 'bmibar-wrap';

    var bar = document.createElement('div');
    bar.className = 'bmibar';
    T.bmiSegments().forEach(function (seg) {
      var piece = document.createElement('span');
      piece.className = 'tone-' + seg.tone;
      piece.style.width = seg.widthPct + '%';
      piece.title = seg.name + ' (' + seg.from + ' to ' + seg.to + ')';
      bar.appendChild(piece);
    });
    wrap.appendChild(bar);

    var marks = document.createElement('div');
    marks.className = 'bmimarks';

    var you = document.createElement('div');
    you.className = 'bmimark';
    you.style.left = T.bmiPercent(current) + '%';
    you.innerHTML = '<b>' + round(current, 1) + '</b>you';
    marks.appendChild(you);

    if (target) {
      var t = document.createElement('div');
      t.className = 'bmimark target';
      t.style.left = T.bmiPercent(target.bmi) + '%';
      t.innerHTML = '<b>' + round(target.weight) + ' lb</b>healthy';
      // Two labels on the same spot would overlap illegibly.
      if (Math.abs(T.bmiPercent(target.bmi) - T.bmiPercent(current)) < 12) {
        t.style.top = '17px';
      }
      marks.appendChild(t);
    }
    wrap.appendChild(marks);

    var scale = document.createElement('div');
    scale.className = 'bmiscale';
    scale.innerHTML = '<span>' + T.BMI_MIN + '</span><span>18.5</span>' +
      '<span>25</span><span>30</span><span>' + T.BMI_MAX + '</span>';
    wrap.appendChild(scale);

    return wrap;
  }

  function signed(n) {
    return (n > 0 ? '+' : '') + round(n, 1);
  }

  function renderGoal(g) {
    var box = $('goalBody');
    box.innerHTML = '';

    if (!g.goal) {
      box.appendChild(emptyNote('Set a goal weight in Settings and this works ' +
        'out when you would get there.'));
      return;
    }

    if (g.reason === 'You are there.') {
      var done = document.createElement('div');
      done.className = 'bignum';
      done.innerHTML = '<b>Done</b>';
      box.appendChild(done);
      box.appendChild(hintP('You are at your goal of ' + round(g.goal, 1) + ' lb.'));
      return;
    }

    if (!g.current) {
      box.appendChild(emptyNote(g.reason));
      return;
    }

    if (g.date) {
      var big = document.createElement('div');
      big.className = 'bignum';
      big.innerHTML = '<b>' + prettyDate(g.date) + '</b>';
      box.appendChild(big);

      var badge = document.createElement('span');
      badge.className = 'badge badge-' + g.confidence;
      badge.textContent = g.confidence === 'ok' ? 'on current trend'
        : g.confidence === 'low' ? 'early estimate' : 'not enough data yet';
      box.appendChild(badge);

      box.appendChild(hintP(
        Math.abs(round(g.toGo, 1)) + ' lb to go at ' + round(g.ratePerWeek, 2) +
        ' lb a week - about ' + Math.round(g.weeks) + ' week' +
        (Math.round(g.weeks) === 1 ? '' : 's') + '.'));
    } else {
      box.appendChild(hintP(g.reason + ' ' + Math.abs(round(g.toGo, 1)) +
        ' lb still to go.'));
    }

    if (g.planned) {
      box.appendChild(hintP('At your target of ' + g.planned.ratePerWeek +
        ' lb a week it would be ' + prettyDate(g.planned.date) + '.'));
    }

    box.appendChild(hintP('Both assume the rate holds, and it will not: as you ' +
      'get lighter you burn less, so the same food becomes a smaller deficit ' +
      'and the line bends. Treat a far-off date as the optimistic end.'));
  }

  function hintP(text) {
    var p = document.createElement('p');
    p.className = 'hint';
    p.textContent = text;
    return p;
  }

  function renderPlateau(p, measured) {
    var box = $('plateauBody');
    box.innerHTML = '';

    var tierLabel = { watch: 'Worth watching', likely: 'Likely stall', confirmed: 'Stalled' };
    if (p.tier !== 'none') {
      var badge = document.createElement('span');
      badge.className = 'badge badge-' + p.tier;
      badge.textContent = tierLabel[p.tier];
      box.appendChild(badge);
    }

    var msg = document.createElement('p');
    msg.className = 'hint';
    msg.textContent = p.message || 'Nothing to report yet.';
    box.appendChild(msg);

    if (p.expectedLoss !== null && p.expectedLoss !== undefined && p.ratio !== null) {
      var nums = document.createElement('p');
      nums.className = 'hint';
      nums.textContent = 'Predicted ' + p.expectedLoss.toFixed(1) + ' lb, actually ' +
        p.actualLoss.toFixed(1) + ' lb, trend ' + p.slope.toFixed(2) + ' lb a week.';
      box.appendChild(nums);
    }

    // Only offer to move the target once the burn rate is worth trusting.
    if (p.tier === 'likely' || p.tier === 'confirmed') {
      var adj = CalTrack.trend.adjustment({
        tdee: measured.tdee, settings: state.settings
      });
      if (adj) box.appendChild(adjustmentBlock(adj));
    }
  }

  function adjustmentBlock(adj) {
    var wrap = document.createElement('div');
    wrap.className = 'adjust';

    var head = document.createElement('p');
    head.className = 'hint';
    head.textContent = 'Two ways to fix it. Pick one - the app will not change ' +
      'anything on its own.';
    wrap.appendChild(head);

    var eat = document.createElement('button');
    eat.className = 'btn wide';
    eat.textContent = 'Eat less: set the target to ' + adj.newTarget + ' kcal' +
      (adj.change ? ' (' + (adj.change > 0 ? '+' : '') + adj.change + ')' : '');
    eat.addEventListener('click', function () { applyAdjustment(adj); });
    wrap.appendChild(eat);

    var move = document.createElement('p');
    move.className = 'hint';
    move.textContent = adj.activityKcalPerDay > 0
      ? 'Move more: keep eating what you eat and burn about ' +
        adj.activityKcalPerDay + ' kcal a day on top of what you do now.'
      : 'Move more: your current target already covers the gap.';
    wrap.appendChild(move);

    if (adj.cappedAtFloor) {
      var note = document.createElement('p');
      note.className = 'notes';
      note.textContent = adj.note;
      wrap.appendChild(note);
    }
    return wrap;
  }

  function applyAdjustment(adj) {
    if (!window.confirm('Set your daily target to ' + adj.newTarget +
      ' kcal, based on a measured burn of ' + round(adj.measuredTdee) + '?')) return;
    store.saveSettings({
      target_kcal: adj.newTarget,
      tdee_override: Math.round(adj.measuredTdee)
    }).then(function (s) {
      state.settings = s;
      toast('Target updated');
      renderTrend();
    });
  }

  function saveWeighIn() {
    var msg = $('weightMsg');
    clearMsg(msg);
    var lbs = parseFloat($('weightInput').value);
    var date = $('weightDate').value || localDate(new Date());

    if (!isFinite(lbs) || lbs <= 0) { showError(msg, 'Enter your weight in pounds.'); return; }
    if (lbs > 1000) { showError(msg, 'That looks like grams rather than pounds.'); return; }

    var fat = parseFloat($('bodyFatInput').value);
    var muscle = parseFloat($('muscleInput').value);
    var record = { weight_lbs: lbs };

    if (isFinite(fat) && fat > 0 && fat < 70) {
      record.body_fat_pct = fat;
    } else if ($('bodyFatInput').value.trim()) {
      showError(msg, 'Body fat should be a percentage between 0 and 70.');
      return;
    }

    if (isFinite(muscle) && muscle > 0 && muscle < lbs) {
      record.muscle_mass_lbs = muscle;
    } else if ($('muscleInput').value.trim()) {
      showError(msg, 'Muscle mass should be in pounds, and less than your weight.');
      return;
    }

    // One reading per day: weighing twice replaces, it does not stack.
    store.weighIns.query(function (w) { return w.date === date; }).then(function (hits) {
      return hits.length
        ? store.weighIns.update(hits[0].id, record)
        : store.weighIns.insert(Object.assign({ date: date, user_id: null }, record));
    }).then(function () {
      $('weightInput').value = '';
      $('bodyFatInput').value = '';
      $('muscleInput').value = '';
      toast('Weight saved');
      renderTrend();
    }).catch(function (err) { showError(msg, err.message); });
  }

  function renderWeighList(weighIns) {
    var box = $('weighList');
    box.innerHTML = '';
    var rows = weighIns.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; }).slice(0, 14);

    if (!rows.length) {
      box.appendChild(emptyNote('No weigh-ins yet.'));
      return;
    }

    rows.forEach(function (w, i) {
      var row = document.createElement('div');
      row.className = 'entry';

      var main = document.createElement('div');
      main.className = 'entry-main';
      var name = document.createElement('div');
      name.className = 'entry-name';
      name.textContent = w.weight_lbs.toFixed(1) + ' lb';
      var sub = document.createElement('div');
      sub.className = 'entry-sub';
      var delta = (i + 1 < rows.length) ? w.weight_lbs - rows[i + 1].weight_lbs : null;
      sub.textContent = prettyDate(w.date) +
        (delta === null ? '' : '  ' + (delta > 0 ? '+' : '') + delta.toFixed(1) + ' lb');
      main.appendChild(name);
      main.appendChild(sub);

      var del = document.createElement('button');
      del.className = 'del';
      del.innerHTML = '&times;';
      del.setAttribute('aria-label', 'Remove this weigh-in');
      del.addEventListener('click', function () {
        store.weighIns.remove(w.id).then(function () { toast('Removed'); renderTrend(); });
      });

      row.appendChild(main);
      row.appendChild(del);
      box.appendChild(row);
    });
  }

  /* The chart: raw readings faint, smoothed trend line prominent, exactly as
   * the plan asks. Hand-built SVG - a charting library would be a bigger
   * download than the whole app.
   */
  function drawChart(weighIns) {
    var box = $('chart');
    var caption = $('chartCaption');
    box.innerHTML = '';

    var T = CalTrack.trend;
    var all = T.emaSeries(weighIns);
    if (all.length < 2) {
      box.appendChild(emptyNote('Two weigh-ins and a line appears here.'));
      caption.textContent = '';
      return;
    }

    var cutoff = T.dayNumber(localDate(new Date())) - 90;
    var series = all.filter(function (p) { return T.dayNumber(p.date) >= cutoff; });
    if (series.length < 2) series = all.slice(-2);

    var W = 320, H = 150, padL = 34, padR = 8, padT = 10, padB = 20;
    var xs = series.map(function (p) { return T.dayNumber(p.date); });
    var minX = Math.min.apply(null, xs);
    var maxX = Math.max.apply(null, xs);
    var values = series.map(function (p) { return p.raw; })
      .concat(series.map(function (p) { return p.ema; }));
    var minY = Math.min.apply(null, values);
    var maxY = Math.max.apply(null, values);
    var padY = Math.max(0.5, (maxY - minY) * 0.15);
    minY -= padY; maxY += padY;

    function px(d) {
      if (maxX === minX) return padL;
      return padL + (d - minX) / (maxX - minX) * (W - padL - padR);
    }
    function py(v) {
      if (maxY === minY) return H / 2;
      return padT + (maxY - v) / (maxY - minY) * (H - padT - padB);
    }

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'chartsvg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Weight trend over the last ' + series.length + ' weigh-ins');

    function el(name, attrs) {
      var n = document.createElementNS('http://www.w3.org/2000/svg', name);
      Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
      return n;
    }

    // Horizontal guides, labelled in pounds.
    [maxY, (maxY + minY) / 2, minY].forEach(function (v) {
      svg.appendChild(el('line', {
        x1: padL, x2: W - padR, y1: py(v), y2: py(v), class: 'grid'
      }));
      var t = el('text', { x: 4, y: py(v) + 3, class: 'axis' });
      t.textContent = v.toFixed(0);
      svg.appendChild(t);
    });

    series.forEach(function (p) {
      svg.appendChild(el('circle', { cx: px(T.dayNumber(p.date)), cy: py(p.raw), r: 1.8, class: 'raw' }));
    });

    var d = series.map(function (p, i) {
      return (i ? 'L' : 'M') + px(T.dayNumber(p.date)).toFixed(1) + ' ' + py(p.ema).toFixed(1);
    }).join(' ');
    svg.appendChild(el('path', { d: d, class: 'trendline' }));

    box.appendChild(svg);

    var slope = T.slopeLbsPerWeek(series, 'raw');
    caption.textContent = series.length + ' weigh-ins. The line is the smoothed trend; ' +
      'the dots are what the scale actually said. Currently ' +
      (Math.abs(slope) < 0.05 ? 'flat.'
        : (slope < 0 ? 'falling ' : 'rising ') + Math.abs(slope).toFixed(2) + ' lb a week.');
  }

  // ------------------------------------------------------------ scanning

  function openScanSheet(purpose) {
    state.scanPurpose = purpose;
    // Scanning an ingredient happens on top of the meal builder, so that
    // sheet steps out of the way and comes back with its rows intact.
    if (purpose === 'meal') $('mealSheet').hidden = true;
    var status = $('scanStatus');
    clearMsg(status);
    $('manualCode').value = '';
    $('manualBox').open = false;
    $('scanSheet').hidden = false;

    CalTrack.scan.start({
      stage: $('scanStage'),
      onStatus: function (text) { clearMsg(status); status.textContent = text; },
      onResult: handleBarcode,
      onError: function (err) {
        showError(status, err.message);
        $('manualBox').open = true;   // always leave a way through
      }
    });
  }

  /* Pass false when the next thing to open is the food editor - the meal
   * builder should stay out of sight until that is finished with.
   */
  function closeScanSheet(restoreMeal) {
    CalTrack.scan.stop();
    $('scanSheet').hidden = true;
    if (restoreMeal !== false && state.scanPurpose === 'meal') {
      $('mealSheet').hidden = false;
    }
  }

  // Drops a food into the meal builder as a new ingredient row.
  function addScannedIngredient(food) {
    var named = (food.portions || []).filter(function (p) { return p.name !== 'gram'; })[0];
    return store.foods.all().then(function (foods) {
      state.mealFoods = foods;
      $('mealSheet').hidden = false;
      addMealItemRow({
        food_id: food.id,
        portion: named ? named.name : 'gram',
        qty: named ? 1 : 100
      }, foods);
      refreshMealTotals();
      toast('Added ' + food.name);
    });
  }

  /* One barcode, three outcomes:
   *   already in your library  -> straight to the amount box, no lookup
   *   in Open Food Facts       -> a prefilled draft to check
   *   nowhere                  -> a blank form with the barcode filled in
   */
  function handleBarcode(code) {
    var status = $('scanStatus');
    clearMsg(status);
    status.textContent = 'Read ' + code + ' - checking your foods...';

    store.foods.query(function (f) { return f.barcode === code; }).then(function (hits) {
      if (hits.length) {
        if (state.scanPurpose === 'meal') {
          closeScanSheet();
          return addScannedIngredient(hits[0]);
        }
        closeScanSheet();
        if (state.scanPurpose === 'log') openQtySheet(hits[0]);
        else openFoodSheet(hits[0]);
        return;
      }

      status.textContent = 'Not one of yours yet. Asking Open Food Facts...';
      return lookupBarcode(code, status).then(function (draft) {
        var purpose = state.scanPurpose;
        closeScanSheet(false);

        var opts = {
          asNew: true,
          thenLog: purpose === 'log',
          thenMealItem: purpose === 'meal'
        };

        if (!draft) {
          opts.notes = ['Open Food Facts has never heard of ' + code + '. That is ' +
                        'common for American groceries. Type the label in once and ' +
                        'the barcode is yours from then on.'];
          openFoodSheet({ barcode: code }, opts);
          return;
        }

        opts.notes = draft.notes.slice();
        opts.notes.unshift('Found in Open Food Facts. It is written by volunteers, ' +
          'so check these numbers against the label before you save.');
        if (purpose === 'meal') {
          opts.notes.push('Save it and it drops straight into the meal you are building.');
        }
        openFoodSheet(draft, opts);
      });
    }).catch(function (err) {
      showError(status, err.message + ' Close and scan again, or type the number.');
      $('manualBox').open = true;
    });
  }

  /* Open Food Facts first: no key, instant, and it covers the world.
   * USDA second, and only when it can actually help - the barcode was a
   * miss, or the product came back without a serving size, which is the
   * case that had the numbers disagreeing with the packet.
   */
  /* USDA is the preferred source: labelNutrients is the printed panel, so
   * its answer needs no derivation and no guessing. It is not the only
   * source, because its coverage is thinner - across twelve US barcodes it
   * knew three where Open Food Facts knew eight. So both are asked at once
   * and USDA wins whenever it has an answer.
   */
  function lookupBarcode(code, status) {
    var key = CalTrack.usda.keyFor(state.settings);

    if (status) {
      status.textContent = key ? 'Looking it up...' : 'Asking Open Food Facts...';
    }

    // Declared before the closure that writes it, so the ordering is not
    // quietly relying on hoisting.
    var usdaError = null;

    var offCall = CalTrack.off.lookup(code).catch(function () { return null; });
    var usdaCall = key
      ? CalTrack.usda.lookup(code, key).catch(function (err) {
          usdaError = err;                       // reported, never fatal
          return null;
        })
      : Promise.resolve(null);

    return Promise.all([offCall, usdaCall]).then(function (both) {
      var offDraft = both[0];
      var usdaDraft = both[1];

      // The printed label beats anything derived from a per-100 g figure.
      if (usdaDraft && usdaDraft.usable) return mergeDrafts(offDraft, usdaDraft);

      if (!offDraft) {
        if (usdaError) throw usdaError;
        return null;
      }

      // No USDA answer. Patch up what Open Food Facts gave us: a missing
      // serving, or one that is not believable - Chips Ahoy comes back at
      // 3 g, which is not a biscuit.
      var g = offDraft.serving && offDraft.serving.grams;
      var implausible = g && (g < 5 || g > 1000);
      if (offDraft.serving && !implausible) return withKeyHint(offDraft, key);

      return borrowServing(offDraft, status).then(function (fixed) {
        return withKeyHint(fixed || offDraft, key);
      });
    });
  }

  // Nudge towards a key exactly once: when a scan came up short without one.
  function withKeyHint(draft, key) {
    if (key || !draft || draft.serving) return draft;
    draft.notes = (draft.notes || []).concat([
      'USDA FoodData Central often has the serving size when Open Food Facts ' +
      'does not. It needs a free key - Settings, "Second food database" - which ' +
      'takes about thirty seconds and stays on this phone.'
    ]);
    return draft;
  }

  /* Take the serving from a duplicate entry for the same product. Needs no
   * key, so it is tried before anything that does.
   */
  function borrowServing(offDraft, status) {
    if (!offDraft || !offDraft.name) return Promise.resolve(null);
    if (status) status.textContent = 'That entry has no serving size. Checking duplicates...';

    return CalTrack.off.findServingByName(offDraft.name, offDraft.per_100g)
      .then(function (sv) {
        if (!sv) return null;
        var fixed = Object.assign({}, offDraft);
        fixed.serving = {
          name: sv.name,
          grams: sv.grams,
          fromVolume: sv.fromVolume,
          // Worked out from the nutrition on the barcode actually scanned.
          macros: nut.macrosForGrams({ per_100g: offDraft.per_100g }, sv.grams)
        };
        fixed.portions = [{ name: sv.name, grams: sv.grams }].concat(
          (offDraft.portions || []).filter(function (p) { return p.name !== sv.name; })
        );
        fixed.notes = ['This entry had no serving size, so it came from ' +
          (sv.borrowedFrom > 1 ? sv.borrowedFrom + ' matching entries' : 'a matching entry') +
          ' for the same product - identical calories per 100 g. Worth a glance ' +
          'at the packet.']
          .concat((offDraft.notes || []).filter(function (n) {
            return n.indexOf('no serving size on record') === -1;
          }));
        return fixed;
      })
      .catch(function () { return null; });   // a failed guess is not an error
  }

  /* USDA wins on the serving and the nutrition, because labelNutrients is
   * the printed panel rather than a conversion of it. Open Food Facts
   * usually wins on the name - USDA descriptions are shouty and often
   * repeat themselves ("HONEY GRAHAM CRACKERS, HONEY").
   */
  function mergeDrafts(off, usda) {
    if (!off) return usda;
    var merged = Object.assign({}, usda);
    if (off.name) merged.name = off.name;
    if (off.brand) merged.brand = off.brand;
    merged.notes = ['Serving size and nutrition from USDA, which stores the ' +
      'label as printed.' + (off.serving && Math.abs(off.serving.grams - usda.serving.grams) > 0.5
        ? ' Open Food Facts said ' + off.serving.grams + ' g for the same product; ' +
          'the packet decides.'
        : '')]
      .concat(usda.notes || [])
      .concat((off.notes || []).filter(function (n) {
        // OFF's "no serving size" complaint is moot now that USDA supplied one.
        return n.indexOf('no serving size on record') === -1;
      }));
    return merged;
  }

  function manualLookup() {
    var status = $('scanStatus');
    var code = $('manualCode').value.replace(/\D/g, '');
    clearMsg(status);

    if (!code) { showError(status, 'Type the digits printed under the barcode.'); return; }
    if (!CalTrack.scan.checkDigitValid(code)) {
      showError(status, 'Those digits do not add up, so one of them is wrong. Have another look.');
      return;
    }
    CalTrack.scan.stop();
    handleBarcode(code);
  }

  // ------------------------------------------------------------ settings



  // ------------------------------------------------------ auditing foods

  function renderFindings(findings, box) {
    box.innerHTML = '';
    if (!findings.length) {
      box.appendChild(emptyNote('Nothing looks wrong.'));
      return;
    }

    var order = { error: 0, warn: 1, note: 2 };
    findings.slice().sort(function (a, b) {
      return order[a.severity] - order[b.severity];
    }).forEach(function (f) {
      var row = document.createElement('div');
      row.className = 'entry';

      var main = document.createElement('div');
      main.className = 'entry-main';

      var name = document.createElement('div');
      name.className = 'entry-name';
      name.textContent = f.name;

      var msg = document.createElement('div');
      msg.className = 'entry-sub';
      msg.textContent = f.message + (f.detail ? ' ' + f.detail : '');

      main.appendChild(name);
      main.appendChild(msg);

      var badge = document.createElement('span');
      badge.className = 'badge badge-' +
        (f.severity === 'error' ? 'confirmed' : f.severity === 'warn' ? 'watch' : 'ok');
      badge.textContent = f.severity === 'error' ? 'wrong'
        : f.severity === 'warn' ? 'check' : 'note';

      row.appendChild(main);
      row.appendChild(badge);

      // Straight to the food, so a fix is one tap away.
      row.style.cursor = 'pointer';
      row.addEventListener('click', function () {
        store.foods.get(f.id).then(function (food) {
          if (food) openFoodSheet(food);
        });
      });

      box.appendChild(row);
    });
  }

  function runAudit() {
    var msg = $('auditMsg');
    clearMsg(msg);
    store.foods.all().then(function (foods) {
      if (!foods.length) { msg.textContent = 'No foods saved yet.'; return; }
      var findings = CalTrack.audit.local(foods);
      var counts = CalTrack.audit.summarise(findings);
      msg.textContent = 'Checked ' + foods.length + ' food' +
        (foods.length === 1 ? '' : 's') + ': ' + counts.error + ' wrong, ' +
        counts.warn + ' worth checking, ' + counts.note + ' notes.';
      renderFindings(findings, $('auditResults'));
    });
  }

  function runOnlineAudit() {
    var msg = $('auditMsg');
    clearMsg(msg);
    store.foods.all().then(function (foods) {
      var scanned = foods.filter(function (f) { return f.barcode; });
      if (!scanned.length) { msg.textContent = 'Nothing in your library was scanned.'; return; }

      msg.textContent = 'Re-checking ' + scanned.length + '...';
      return CalTrack.audit.online(foods, state.settings, function (done, total, name) {
        msg.textContent = 'Re-checking ' + done + ' of ' + total + ': ' + name;
      }).then(function (findings) {
        var local = CalTrack.audit.local(foods);
        var all = local.concat(findings);
        var counts = CalTrack.audit.summarise(all);
        msg.textContent = 'Checked ' + foods.length + ' food' +
          (foods.length === 1 ? '' : 's') + ', ' + scanned.length + ' against the ' +
          'databases: ' + counts.error + ' wrong, ' + counts.warn +
          ' worth checking, ' + counts.note + ' notes.';
        renderFindings(all, $('auditResults'));
      });
    }).catch(function (err) { showError(msg, err.message); });
  }

  // ------------------------------------------------------- offline support

  /* The service worker is what lets the app open with no signal. It is
   * registered here rather than inline so there is one place to look when
   * it misbehaves. Nothing else in the app depends on it - if registration
   * fails, everything still works, it just needs a connection to start.
   */
  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    navigator.serviceWorker.register('sw.js').catch(function (err) {
      console.warn('[app] offline support unavailable', err);
    });
  }

  function renderOfflineState() {
    var el = $('offlineState');
    if (!('serviceWorker' in navigator)) {
      el.textContent = 'This browser cannot store the app for offline use.';
      return;
    }
    if (navigator.serviceWorker.controller) {
      el.textContent = 'Saved for offline use. It will open without a signal; ' +
        'barcode lookups still need one.';
    } else {
      el.textContent = 'Not saved for offline use yet. Reload once while online ' +
        'and it will be.';
    }
  }

  function checkForUpdate() {
    var el = $('offlineState');
    el.textContent = 'Fetching the latest version...';

    // Empty the offline copy first. Without this the worker can keep serving
    // the stored files whenever the network is merely slow, and an update
    // never actually lands.
    var wipe = ('caches' in window)
      ? caches.keys().then(function (names) {
          return Promise.all(names.map(function (n) { return caches.delete(n); }));
        })
      : Promise.resolve();

    /* A plain reload can still take app.js from the browser's HTTP cache,
     * which is what made this button unreliable. A one-off query string
     * cannot be served from it, so the next load is guaranteed fresh.
     */
    var reloadNow = function () {
      var url = location.href.split('#')[0].replace(/[?&]fresh=\d+/, '');
      location.href = url + (url.indexOf('?') === -1 ? '?' : '&') +
        'fresh=' + Date.now();
    };

    wipe.then(function () {
      if (!('serviceWorker' in navigator)) return null;
      return navigator.serviceWorker.getRegistration().then(function (reg) {
        return reg ? reg.update() : null;
      });
    }).then(reloadNow, reloadNow);
  }

  function renderSettings() {
    renderOfflineState();
    $('setTargetKcal').value = state.settings.target_kcal || '';
    $('setGoalWeight').value = state.settings.goal_weight_lbs || '';
    $('setTargetRate').value = state.settings.target_rate_lbs_per_week || '';
    if (state.settings.height_in > 0) {
      $('setFeet').value = Math.floor(state.settings.height_in / 12);
      $('setInches').value = Math.round(state.settings.height_in % 12);
    } else {
      $('setFeet').value = '';
      $('setInches').value = '';
    }
    $('usdaKey').value = state.settings.usda_api_key || '';
    clearMsg($('usdaMsg'));
    clearMsg($('settingsMsg'));
    clearMsg($('backupMsg'));
    fillEstimator();
  }

  function saveUsdaKey() {
    var msg = $('usdaMsg');
    clearMsg(msg);
    var key = $('usdaKey').value.trim();
    store.saveSettings({ usda_api_key: key || null }).then(function (s) {
      state.settings = s;
      msg.textContent = key ? 'Saved. USDA will be asked when the free lookups fall short.'
                            : 'Cleared. Open Food Facts only.';
      toast(key ? 'USDA key saved' : 'USDA key cleared');
    });
  }

  // Proves the key works before you find out mid-shop that it does not.
  function testUsdaKey() {
    var msg = $('usdaMsg');
    clearMsg(msg);
    var key = $('usdaKey').value.trim();
    if (!key) { showError(msg, 'Paste a key first, then test it.'); return; }
    msg.textContent = 'Asking USDA...';

    // A barcode known to be in FDC, so a miss means the key is the problem.
    CalTrack.usda.lookup('842798105464', key).then(function (d) {
      if (d && d.usable) {
        msg.textContent = 'Working. It found "' + d.name + '" at ' +
          Math.round(d.serving.macros.kcal) + ' kcal per ' + d.serving.grams + ' g.';
      } else {
        showError(msg, 'The key worked but the test product came back empty. ' +
          'Odd, but scanning should still work.');
      }
    }).catch(function (err) { showError(msg, err.message); });
  }

  // ---------------------------------------------- working out a target

  function fillEstimator() {
    var s = state.settings;

    var sel = $('estActivity');
    if (!sel.options.length) {
      Object.keys(CalTrack.trend.ACTIVITY).forEach(function (key) {
        var opt = document.createElement('option');
        opt.value = key;
        opt.textContent = CalTrack.trend.ACTIVITY[key].label;
        sel.appendChild(opt);
      });
    }
    sel.value = s.activity_level || 'sedentary';

    $('estAge').value = s.age || '';
    $('estSex').value = s.sex || 'male';
    $('estBodyFat').value = s.body_fat_pct || '';

    if (s.height_in) {
      $('estFeet').value = Math.floor(s.height_in / 12);
      $('estInches').value = Math.round(s.height_in % 12);
    }

    // Prefill the weight from the most recent weigh-in rather than asking
    // for something the app already knows.
    if (!$('estWeight').value) {
      store.weighIns.all().then(function (rows) {
        if (!rows.length) return;
        var latest = rows.slice().sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0];
        $('estWeight').value = latest.weight_lbs;
      });
    }
  }

  function readProfile() {
    var feet = parseFloat($('estFeet').value) || 0;
    var inches = parseFloat($('estInches').value) || 0;
    return {
      weightLbs: parseFloat($('estWeight').value),
      age: parseFloat($('estAge').value),
      heightIn: (feet * 12) + inches,
      sex: $('estSex').value,
      activity: $('estActivity').value,
      bodyFatPct: parseFloat($('estBodyFat').value)
    };
  }

  function runEstimate() {
    var box = $('estimateResult');
    box.innerHTML = '';

    var profile = readProfile();
    var result = CalTrack.trend.suggestTarget(profile, state.settings);

    if (result.error) {
      var err = document.createElement('p');
      err.className = 'msg err';
      err.textContent = result.error;
      box.appendChild(err);
      return;
    }

    var big = document.createElement('div');
    big.className = 'bignum';
    big.innerHTML = '<b>' + result.target + '</b> kcal a day';
    box.appendChild(big);

    var how = document.createElement('p');
    how.className = 'hint';
    how.textContent = result.formula + ' puts your resting burn at ' + result.bmr +
      ' kcal. ' + result.activityLabel + ' multiplies that by ' + result.multiplier +
      ', giving about ' + result.tdee + ' a day. Taking off ' + result.deficit +
      ' for ' + result.ratePerWeek + ' lb a week leaves ' + result.target + '.';
    box.appendChild(how);

    if (result.cappedAtFloor) {
      var capped = document.createElement('p');
      capped.className = 'notes';
      capped.textContent = 'That rate would put you below a sensible floor, so ' +
        'this is the floor (' + result.floor + ') instead. Either aim for a ' +
        'slower loss, or add activity rather than cutting further.';
      box.appendChild(capped);
    }

    var caveat = document.createElement('p');
    caveat.className = 'notes';
    caveat.textContent = result.caveat;
    box.appendChild(caveat);

    var use = document.createElement('button');
    use.className = 'btn primary wide';
    use.textContent = 'Use ' + result.target + ' as my target';
    use.addEventListener('click', function () { applyEstimate(profile, result); });
    box.appendChild(use);
  }

  function applyEstimate(profile, result) {
    store.saveSettings({
      target_kcal: result.target,
      // Kept so the form comes back filled in, and so the Trend screen can
      // say when the measured figure has overtaken the estimate.
      age: profile.age || null,
      sex: profile.sex,
      height_in: profile.heightIn || null,
      activity_level: profile.activity,
      body_fat_pct: isFinite(profile.bodyFatPct) ? profile.bodyFatPct : null,
      estimated_tdee: result.tdee,
      // Without a rate the app cannot work out what deficit the target
      // implies, so the one used in the sum gets written down.
      target_rate_lbs_per_week: state.settings.target_rate_lbs_per_week || result.ratePerWeek
    }).then(function (s) {
      state.settings = s;
      renderSettings();
      toast('Target set to ' + result.target);
    });
  }

  function saveSettings() {
    var target = parseFloat($('setTargetKcal').value);
    var goal = parseFloat($('setGoalWeight').value);
    var rate = parseFloat($('setTargetRate').value);

    var feet = parseFloat($('setFeet').value) || 0;
    var inches = parseFloat($('setInches').value) || 0;
    var heightIn = (feet * 12) + inches;

    store.saveSettings({
      target_kcal: isFinite(target) && target > 0 ? target : null,
      goal_weight_lbs: isFinite(goal) && goal > 0 ? goal : null,
      target_rate_lbs_per_week: isFinite(rate) && rate > 0 ? rate : null,
      height_in: heightIn > 0 ? heightIn : state.settings.height_in
    }).then(function (s) {
      state.settings = s;
      $('settingsMsg').textContent = 'Saved.';
      toast('Settings saved');
    });
  }

  function exportBackup() {
    store.exportAll().then(function (dump) {
      var blob = new Blob([JSON.stringify(dump, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'caltrack-backup-' + localDate(new Date()) + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      $('backupMsg').textContent = 'Backup downloaded.';
    });
  }

  function importBackup(file) {
    var msg = $('backupMsg');
    clearMsg(msg);
    var reader = new FileReader();
    reader.onload = function () {
      var dump;
      try {
        dump = JSON.parse(reader.result);
      } catch (err) {
        showError(msg, 'That file is not readable JSON.');
        return;
      }
      if (!window.confirm('Restoring replaces everything currently in this browser. Continue?')) return;
      store.importAll(dump).then(function () {
        return store.getSettings();
      }).then(function (s) {
        state.settings = s;
        msg.textContent = 'Restored.';
        toast('Backup restored');
        setView('today');
      }).catch(function (err) { showError(msg, err.message); });
    };
    reader.readAsText(file);
  }

  function clearEverything() {
    if (!window.confirm('This erases every food, meal and log entry in this browser. There is no undo. Export a backup first if you are not sure.')) return;
    if (!window.confirm('Really erase everything?')) return;
    store.clearAll().then(function () {
      return store.getSettings();
    }).then(function (s) {
      state.settings = s;
      toast('All data erased');
      setView('today');
    });
  }

  // ---------------------------------------------------------------- wiring

  function bind() {
    $('prevDay').addEventListener('click', function () {
      state.date = shiftDate(state.date, -1);
      renderToday();
    });
    $('nextDay').addEventListener('click', function () {
      state.date = shiftDate(state.date, 1);
      renderToday();
    });
    $('dayLabel').addEventListener('click', function () {
      var picker = $('datePicker');
      picker.value = state.date;
      if (picker.showPicker) { picker.showPicker(); } else { picker.click(); }
    });
    $('datePicker').addEventListener('change', function () {
      if (this.value) { state.date = this.value; renderToday(); }
    });

    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.addEventListener('click', function () { setView(t.dataset.view); });
    });

    $('fab').addEventListener('click', openPickSheet);

    // Any [data-close] button closes the sheet it sits in; so does the backdrop.
    Array.prototype.forEach.call(document.querySelectorAll('.sheet'), function (sheet) {
      sheet.addEventListener('click', function (ev) {
        if (ev.target === sheet || ev.target.hasAttribute('data-close')) sheet.hidden = true;
      });
    });

    $('mealTimePicker').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-meal]');
      if (!b) return;
      state.mealTime = b.dataset.meal;
      paintMealTimes();
    });

    $('pickSearch').addEventListener('input', renderPickResults);
    $('pickNewFood').addEventListener('click', function () {
      $('pickSheet').hidden = true;
      if (state.pickSegment === 'meals') openMealSheet(null); else openFoodSheet(null);
    });

    $('pickScanBtn').addEventListener('click', function () {
      $('pickSheet').hidden = true;
      openScanSheet('log');
    });
    $('foodsScanBtn').addEventListener('click', function () { openScanSheet('library'); });

    // The generic handler above only hides the sheet; the camera has to be
    // told to let go of the lens as well.
    $('scanSheet').addEventListener('click', function (ev) {
      if (ev.target === this || ev.target.hasAttribute('data-close')) closeScanSheet();
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden && !$('scanSheet').hidden) closeScanSheet();
    });

    // Backing out of the food editor mid-scan must not strand the meal
    // builder off screen.
    $('foodSheet').addEventListener('click', function (ev) {
      if (ev.target !== this && !ev.target.hasAttribute('data-close')) return;
      if (state.mealItemAfterSave) {
        state.mealItemAfterSave = false;
        $('mealSheet').hidden = false;
      }
    });

    $('manualGo').addEventListener('click', manualLookup);
    $('manualCode').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); manualLookup(); }
    });

    $('qtyAmount').addEventListener('input', updateQtyPreview);
    $('qtyPortion').addEventListener('change', updateQtyPreview);
    $('qtyConfirm').addEventListener('click', confirmQty);

    $('foodFilter').addEventListener('input', renderFoods);
    $('newFoodBtn').addEventListener('click', function () { openFoodSheet(null); });

    $('foodsSegment').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-seg]');
      if (b) setSegment(b.dataset.seg);
    });
    $('pickSegment').addEventListener('click', function (ev) {
      var b = ev.target.closest('button[data-seg]');
      if (b) setPickSegment(b.dataset.seg);
    });

    $('mealFilter').addEventListener('input', renderMeals);
    $('newMealBtn').addEventListener('click', function () { openMealSheet(null); });
    $('mealAddItem').addEventListener('click', function () {
      addMealItemRow(null, state.mealFoods || []);
      refreshMealTotals();
    });
    $('mealScanItem').addEventListener('click', function () { openScanSheet('meal'); });
    $('saveMealBtn').addEventListener('click', saveMeal);
    $('deleteMealBtn').addEventListener('click', deleteMeal);
    $('batchBtn').addEventListener('click', batchToFood);
    $('mealLogConfirm').addEventListener('click', confirmMealLog);

    $('saveWeight').addEventListener('click', saveWeighIn);
    $('weightInput').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); saveWeighIn(); }
    });
    $('addPortionBtn').addEventListener('click', function () { addPortionRow(); });
    $('svGrams').addEventListener('input', function () {
      fillServingFromReference();
      updateServingEcho();
    });
    ['svKcal', 'svProtein', 'svCarbs', 'svFat'].forEach(function (id) {
      $(id).addEventListener('input', function () {
        state.svTouched = true;      // hand-typed figures win from here
        updateServingEcho();
      });
    });
    $('svName').addEventListener('input', updateServingEcho);
    $('saveFoodBtn').addEventListener('click', saveFood);
    $('deleteFoodBtn').addEventListener('click', deleteFood);

    $('estimateBtn').addEventListener('click', runEstimate);
    $('auditBtn').addEventListener('click', runAudit);
    $('auditOnlineBtn').addEventListener('click', runOnlineAudit);
    $('saveUsdaKey').addEventListener('click', saveUsdaKey);
    $('testUsdaKey').addEventListener('click', testUsdaKey);
    $('saveSettingsBtn').addEventListener('click', saveSettings);
    $('exportBtn').addEventListener('click', exportBackup);
    $('importBtn').addEventListener('click', function () { $('importFile').click(); });
    $('importFile').addEventListener('change', function () {
      if (this.files && this.files[0]) importBackup(this.files[0]);
      this.value = '';
    });
    $('clearBtn').addEventListener('click', clearEverything);
    $('updateBtn').addEventListener('click', checkForUpdate);
  }

  function init() {
    $('buildId').textContent = BUILD;
    bind();
    registerServiceWorker();
    store.getSettings().then(function (s) {
      state.settings = s;
      setView('today');
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
