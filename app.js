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

  function setView(name) {
    state.view = name;
    ['today', 'foods', 'settings'].forEach(function (v) {
      $('view-' + v).hidden = (v !== name);
    });
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) {
      t.classList.toggle('is-active', t.dataset.view === name);
    });
    $('fab').hidden = (name === 'settings');
    if (name === 'today') renderToday();
    if (name === 'foods') renderFoods();
    if (name === 'settings') renderSettings();
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
    var grams = food ? nut.gramsFor(food, entry.portion, entry.qty) : null;
    var qtyText = round(entry.qty, 2) + ' ' + plural(entry.portion, entry.qty);
    sub.textContent = (grams !== null && entry.portion !== 'gram')
      ? qtyText + '  (' + round(grams) + ' g)'
      : qtyText;

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
    renderPickResults();
    setTimeout(function () { $('pickSearch').focus(); }, 50);
  }

  function paintMealTimes() {
    Array.prototype.forEach.call(
      $('mealTimePicker').querySelectorAll('button'),
      function (b) { b.classList.toggle('is-active', b.dataset.meal === state.mealTime); }
    );
  }

  function renderPickResults() {
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

    var del = document.createElement('button');
    del.type = 'button';
    del.innerHTML = '&times;';
    del.setAttribute('aria-label', 'Remove this portion');
    del.addEventListener('click', function () { row.remove(); });

    row.appendChild(name);
    row.appendChild(grams);
    row.appendChild(del);
    $('portionRows').appendChild(row);
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

  // ------------------------------------------------------------ scanning

  function openScanSheet(purpose) {
    state.scanPurpose = purpose;
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

  function closeScanSheet() {
    CalTrack.scan.stop();
    $('scanSheet').hidden = true;
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
        closeScanSheet();
        if (state.scanPurpose === 'log') openQtySheet(hits[0]);
        else openFoodSheet(hits[0]);
        return;
      }

      status.textContent = 'Not one of yours yet. Asking Open Food Facts...';
      return CalTrack.off.lookup(code).then(function (draft) {
        var toLog = (state.scanPurpose === 'log');
        closeScanSheet();

        if (!draft) {
          openFoodSheet({ barcode: code }, {
            asNew: true,
            thenLog: toLog,
            notes: ['Open Food Facts has never heard of ' + code + '. That is ' +
                    'common for American groceries. Type the label in once and ' +
                    'the barcode is yours from then on.']
          });
          return;
        }

        var notes = draft.notes.slice();
        notes.unshift('Found in Open Food Facts. It is written by volunteers, ' +
          'so check these numbers against the label before you save.');
        openFoodSheet(draft, { asNew: true, thenLog: toLog, notes: notes });
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

  function renderSettings() {
    $('setTargetKcal').value = state.settings.target_kcal || '';
    $('setGoalWeight').value = state.settings.goal_weight_lbs || '';
    clearMsg($('settingsMsg'));
    clearMsg($('backupMsg'));
  }

  function saveSettings() {
    var target = parseFloat($('setTargetKcal').value);
    var goal = parseFloat($('setGoalWeight').value);
    store.saveSettings({
      target_kcal: isFinite(target) && target > 0 ? target : null,
      goal_weight_lbs: isFinite(goal) && goal > 0 ? goal : null
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
      openFoodSheet(null);
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

    $('manualGo').addEventListener('click', manualLookup);
    $('manualCode').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); manualLookup(); }
    });

    $('qtyAmount').addEventListener('input', updateQtyPreview);
    $('qtyPortion').addEventListener('change', updateQtyPreview);
    $('qtyConfirm').addEventListener('click', confirmQty);

    $('foodFilter').addEventListener('input', renderFoods);
    $('newFoodBtn').addEventListener('click', function () { openFoodSheet(null); });
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
  }

  function init() {
    bind();
    store.getSettings().then(function (s) {
      state.settings = s;
      setView('today');
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
