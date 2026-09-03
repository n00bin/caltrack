/* test-today.js - the app's idea of "today" must follow the calendar.
 * Run it with: node test-today.js
 *
 * The failure this catches: a phone keeps the app open for days, the
 * weigh-in date box stays on the day the app was opened, and every later
 * weigh-in saves against that date - replacing the reading before it, since
 * there is one reading per day. The list looked like it only kept three
 * days. rollDay moves the log date and the date box forward when the
 * calendar has, and leaves alone any date the user picked on purpose.
 *
 * rollDay lives inside app.js's closure, so it is lifted out of the source
 * text and run with stubs for the few things it touches.
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

function lift(name) {
  const start = src.indexOf('  function ' + name + '(');
  if (start < 0) throw new Error(name + ' not found in app.js');
  const end = src.indexOf('\n  }\n', start);
  return src.slice(start, end + 4);
}

// The real localDate, so "today" here is exactly what the app would say.
const localDate = new Function(lift('localDate') + '\nreturn localDate;')();
const today = localDate(new Date());
const yesterday = localDate(new Date(Date.now() - 86400000));

// Runs rollDay once with a given starting "known today" and returns what it
// did: the state and date box afterwards, and which view it redrew.
function run(knownToday, stateDate, boxDate) {
  const state = { date: stateDate, view: 'trend' };
  const box = { value: boxDate };
  const redrew = [];
  const $ = (id) => (id === 'weightDate' ? box : {});
  const setView = (v) => redrew.push(v);
  const rolled = new Function('$', 'state', 'setView', 'localDate',
    'var knownToday = ' + JSON.stringify(knownToday) + ';\n' + lift('rollDay') +
    '\nreturn rollDay();')($, state, setView, localDate);
  return { rolled, date: state.date, box: box.value, redrew };
}

// Opened yesterday, left open, looked at again today.
{
  const r = run(yesterday, yesterday, yesterday);
  eq('the calendar moved, so the day rolls', r.rolled, true);
  eq('the log date is now today', r.date, today);
  eq('and so is the weigh-in date box', r.box, today);
  eq('and the screen was redrawn', r.redrew, ['trend']);
}

// The user had picked a past date on purpose: leave it alone.
{
  const r = run(yesterday, '2026-01-05', '2026-01-05');
  eq('a date picked on purpose is not touched', r.date, '2026-01-05');
  eq('nor is a backfill date in the box', r.box, '2026-01-05');
}

// An empty box is filled in.
{
  const r = run(yesterday, yesterday, '');
  eq('an empty date box gets today', r.box, today);
}

// Still the same day: nothing happens, nothing redraws.
{
  const r = run(today, today, today);
  eq('same day, no roll', r.rolled, false);
  eq('and no redraw', r.redrew, []);
}

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
