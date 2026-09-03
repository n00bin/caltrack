/* test-mealrow.js - the meal editor must not lose an ingredient whose food
 * has since been deleted. Run it with: node test-mealrow.js
 *
 * The failure this catches: you delete a food, weeks later open a meal that
 * used it just to rename it, press Save, and that ingredient is gone with no
 * warning. addMealItemRow builds the food picker from the live food list, so
 * a deleted food had nothing to select, the row read as empty, and
 * collectMealItems dropped it on the floor.
 *
 * app.js is one closure over the real DOM, so the two functions are lifted
 * out of the source text and run against a stub DOM just big enough for
 * them: elements with children, a select whose .value behaves like a
 * browser's (setting it to a value no option has leaves it blank), and a
 * querySelector that understands ".class".
 */
const fs = require('fs');
const src = fs.readFileSync(__dirname + '/app.js', 'utf8');

let fails = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  got=' + JSON.stringify(got) +
    (ok ? '' : ' want=' + JSON.stringify(want)));
  if (!ok) fails++;
}

// ----------------------------------------------------- lift the functions

function lift(name) {
  const start = src.indexOf('  function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found in app.js');
  // Top-level functions inside the app closure sit at two-space indent and
  // end with a brace at that indent; nothing nested does.
  const end = src.indexOf('\n  }\n', start);
  return src.slice(start, end + 4);
}

// ------------------------------------------------------------- stub DOM

class El {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.className = '';
    this.textContent = '';
    this.attrs = {};
    this._html = '';
    this._value = '';
    this.parent = null;
  }
  appendChild(c) { c.parent = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    c.parent = this;
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  addEventListener() {}
  setAttribute(k, v) { this.attrs[k] = v; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = v; if (v === '') this.children = []; }
  get firstChild() { return this.children[0] || null; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const cls = sel.slice(1);
    const out = [];
    (function walk(el) {
      el.children.forEach((c) => {
        if (c.className.split(' ').indexOf(cls) >= 0) out.push(c);
        walk(c);
      });
    })(this);
    return out;
  }
  // A select's value is whichever option is selected, or '' if none is -
  // which is exactly what happens when the value set has no option.
  get value() {
    if (this.tagName !== 'select') return this._value;
    const sel = this.children.filter((o) => o.selected)[0];
    return sel ? sel.value : '';
  }
  set value(v) {
    if (this.tagName !== 'select') { this._value = v; return; }
    let hit = false;
    this.children.forEach((o) => { o.selected = (!hit && o.value === v); if (o.selected) hit = true; });
  }
  get selectedText() {
    const sel = this.children.filter((o) => o.selected)[0];
    return sel ? sel.textContent : '';
  }
}

const mealItems = new El('div');
const document = { createElement: (t) => new El(t) };
const $ = (id) => (id === 'mealItems' ? mealItems : new El('div'));

const foods = [
  { id: 'eggs', name: 'Eggs', portions: [{ name: 'gram', grams: 1 }, { name: 'egg', grams: 50 }] },
  { id: 'bread', name: 'Bread', portions: [{ name: 'gram', grams: 1 }, { name: 'slice', grams: 28 }] }
];
const state = { mealFoods: foods };
const foodLabel = (f) => f.name;
const refreshMealTotals = () => {};

const fns = new Function('document', '$', 'state', 'foodLabel', 'refreshMealTotals',
  lift('addMealItemRow') + '\n' + lift('collectMealItems') +
  '\nreturn { addMealItemRow: addMealItemRow, collectMealItems: collectMealItems };'
)(document, $, state, foodLabel, refreshMealTotals);

// ------------------------------------------------------------------ tests

// A meal saved with eggs, bread, and a food that has since been deleted.
const saved = [
  { food_id: 'eggs', portion: 'egg', qty: 3 },
  { food_id: 'gone-1234', portion: 'slice', qty: 2 },
  { food_id: 'bread', portion: 'slice', qty: 1 }
];
saved.forEach((it) => fns.addMealItemRow(it, foods));

eq('re-saving an untouched meal keeps every ingredient, deleted food included',
  fns.collectMealItems(), saved);

const rows = mealItems.querySelectorAll('.itemrow');
eq('the deleted food is labelled as such in the picker',
  rows[1].querySelector('.m-food').selectedText, 'Deleted food');
eq('and its portion survives too',
  rows[1].querySelector('.m-portion').value, 'slice');
eq('a live food shows its own name', rows[0].querySelector('.m-food').selectedText, 'Eggs');

// Choosing a replacement works the normal way: the row now carries that food.
rows[1].querySelector('.m-food').value = 'bread';
eq('picking a replacement swaps the id',
  fns.collectMealItems()[1].food_id, 'bread');

// Removing the row drops it, as before.
rows[1].remove();
eq('removing the row drops it', fns.collectMealItems().map((i) => i.food_id), ['eggs', 'bread']);

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
