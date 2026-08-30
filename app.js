/* app.js — screens and wiring. All persistence goes through CalTrack.store. */

(function () {
  'use strict';

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

  function foodLabel(food) {
    if (!food) return 'Deleted food';
    return food.brand ? food.name + ' - ' + food.brand : food.name;
  }

  function plural(name, qty) {
    if (qty === 1) return name;
    return name + (/s$/i.test(name) ? '' : 's');
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
      $('kcalTotal').textContent = round(t.kcal);
      $('mProtein').textContent = round(t.protein, 1);
      $('mCarbs').textContent = round(t.carbs, 1);
      $('mFat').textContent = round(t.fat, 1);

      var targetEl = $('kcalTarget');
      var target = state.settings.target_kcal;
      if (target) {
        var left = target - t.kcal;
        targetEl.textContent = left >= 0
          ? round(left) + ' left of ' + target
          : round(-left) + ' over your ' + target + ' target';
        targetEl.classList.toggle('over', left < 0);
      } else {
        targetEl.textContent = '';
        targetEl.classList.remove('over');
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
        ? qtyText + '  (' + round(grams) + ' g)'
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
        btn.querySelector('.fi-sub').textContent =
          (f.brand ? f.brand + '  -  ' : '') +
          round(f.per_100g.kcal) + ' kcal / 100 g';
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
        btn.querySelector('.fi-sub').textContent =
          (f.brand ? f.brand + '  -  ' : '') +
          round(f.per_100g.kcal) + ' kcal / 100 g';
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
        ? 'grams'
        : p.name + ' (' + round(p.grams, 1) + ' g)';
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
    $('qtyPreview').innerHTML =
      '<b>' + round(m.kcal) + '</b> kcal<br>' +
      round(grams, 1) + ' g  -  ' +
      round(m.protein, 1) + ' g protein, ' +
      round(m.carbs, 1) + ' g carbs, ' +
      round(m.fat, 1) + ' g fat';
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
    // A zero that came from Open Food Facts usually means "not filled in",
    // so leave the box empty rather than pretending the number is known.
    function shown(v) {
      if (v === undefined || v === null) return '';
      return (v === 0 && !isExisting) ? '' : v;
    }
    var per = (food && food.per_100g) || {};

    $('fName').value = food ? (food.name || '') : '';
    $('fBrand').value = food ? (food.brand || '') : '';
    $('fBarcode').value = food && food.barcode ? food.barcode : '';
    $('fKcal').value = shown(per.kcal);
    $('fProtein').value = shown(per.protein);
    $('fCarbs').value = shown(per.carbs);
    $('fFat').value = shown(per.fat);

    ['cvGrams', 'cvKcal', 'cvProtein', 'cvCarbs', 'cvFat'].forEach(function (id) {
      $(id).value = '';
    });

    // "gram" is implicit and always available, so it is not shown here.
    var named = (food && food.portions || []).filter(function (p) {
      return p.name !== 'gram';
    });
    $('portionRows').innerHTML = '';
    named.forEach(addPortionRow);
    if (!named.length) addPortionRow();

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
    grams.placeholder = 'grams';
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

  function saveFood() {
    var msg = $('foodMsg');
    clearMsg(msg);

    var name = $('fName').value.trim();
    if (!name) { showError(msg, 'Give the food a name.'); return; }

    var kcal = parseFloat($('fKcal').value);
    if (!isFinite(kcal) || kcal < 0) {
      showError(msg, 'Enter the calories per 100 g.');
      return;
    }

    var record = {
      name: name,
      brand: $('fBrand').value.trim(),
      barcode: $('fBarcode').value.trim() || null,
      per_100g: {
        kcal: kcal,
        protein: parseFloat($('fProtein').value) || 0,
        carbs: parseFloat($('fCarbs').value) || 0,
        fat: parseFloat($('fFat').value) || 0
      },
      portions: collectPortions(),
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

  // Label says "per serving"? Convert it to per 100 g.
  function convertServing() {
    var g = parseFloat($('cvGrams').value);
    if (!isFinite(g) || g <= 0) { toast('Enter the serving weight in grams'); return; }
    var factor = 100 / g;
    [['cvKcal', 'fKcal'], ['cvProtein', 'fProtein'],
     ['cvCarbs', 'fCarbs'], ['cvFat', 'fFat']].forEach(function (pair) {
      var v = parseFloat($(pair[0]).value);
      if (isFinite(v)) $(pair[1]).value = round(v * factor, 2);
    });
    toast('Filled in per 100 g');
  }

  // --------------------------------------------------------------- meals

  function indexById(rows) {
    var out = {};
    rows.forEach(function (r) { out[r.id] = r; });
    return out;
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
    $('mealLogTotals').innerHTML = '<b>' + round(t.kcal) + '</b> kcal<br>' +
      round(t.protein, 1) + ' g protein, ' + round(t.carbs, 1) + ' g carbs, ' +
      round(t.fat, 1) + ' g fat';
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

    // One reading per day: weighing twice replaces, it does not stack.
    store.weighIns.query(function (w) { return w.date === date; }).then(function (hits) {
      return hits.length
        ? store.weighIns.update(hits[0].id, { weight_lbs: lbs })
        : store.weighIns.insert({ date: date, weight_lbs: lbs, user_id: null });
    }).then(function () {
      $('weightInput').value = '';
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
      return CalTrack.off.lookup(code).then(function (draft) {
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
    if (!('serviceWorker' in navigator)) { location.reload(); return; }
    el.textContent = 'Looking...';
    navigator.serviceWorker.getRegistration().then(function (reg) {
      return reg ? reg.update() : null;
    }).then(function () {
      toast('Reloading with the latest version');
      setTimeout(function () { location.reload(); }, 400);
    }).catch(function () {
      location.reload();
    });
  }

  function renderSettings() {
    renderOfflineState();
    $('setTargetKcal').value = state.settings.target_kcal || '';
    $('setGoalWeight').value = state.settings.goal_weight_lbs || '';
    $('setTargetRate').value = state.settings.target_rate_lbs_per_week || '';
    clearMsg($('settingsMsg'));
    clearMsg($('backupMsg'));
  }

  function saveSettings() {
    var target = parseFloat($('setTargetKcal').value);
    var goal = parseFloat($('setGoalWeight').value);
    var rate = parseFloat($('setTargetRate').value);
    store.saveSettings({
      target_kcal: isFinite(target) && target > 0 ? target : null,
      goal_weight_lbs: isFinite(goal) && goal > 0 ? goal : null,
      target_rate_lbs_per_week: isFinite(rate) && rate > 0 ? rate : null
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
    $('saveFoodBtn').addEventListener('click', saveFood);
    $('deleteFoodBtn').addEventListener('click', deleteFood);
    $('convertBtn').addEventListener('click', convertServing);

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
    bind();
    registerServiceWorker();
    store.getSettings().then(function (s) {
      state.settings = s;
      setView('today');
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
