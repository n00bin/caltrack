# Calorie Tracker

A barcode-scanning food log that runs as a plain static web page. No build
step, no framework, no packaging — the browser reads the files directly.

**Live at [n00bin.github.io/caltrack](https://n00bin.github.io/caltrack/).**
Open it on your phone, then Chrome menu -> *Install app*. It gets its own
icon, opens full screen with no address bar, and starts without a signal.

Built to a written build plan kept privately alongside the repo.
**All six steps of that plan are done** — food logging, barcode scanning,
portions, meals, weigh-ins, and the adaptive-TDEE and plateau maths.

## What works right now

- **Today** — how much you have **left** today, big, updating the moment you
  log anything, with a bar showing how much of the day's allowance is gone.
  Underneath, the log grouped into breakfast / lunch / dinner / snack with
  calories and macros for each meal. Step backwards and forwards through days,
  or tap the date to jump to one. Go over and the number flips to how far over
  you are, in red.
- **Logging** — the round `+` button. It guesses the meal from the clock,
  shows your foods most-recently-used first, then asks for an amount. Two taps
  and a number for something you've eaten before. Before you commit it tells
  you what it would leave you for the day, so you can decide on the spot
  whether it fits.
- **Scanning** — the Scan button. Point it at a barcode and one of three
  things happens: it's already one of your foods and you go straight to the
  amount box; it's in Open Food Facts and you get a filled-in form to check;
  or it's in neither, and you type the label once and own it from then on.
  There's a "type the number instead" box for when the camera won't play.
- **Portions** — every food stores its nutrition per 100 g and carries a list
  of named portions. Tell it once that a slice of bread is 28 g and from then
  on you log "2 slices" and it does the maths. Grams is always available.
  Don't know what a slice weighs? Press **Weigh**, put five on the scale, type
  5 and the reading, and it works out the rest.
- **Foods** — your own library. Add, edit and delete. The nutrition form asks
  for **one serving**, exactly as a label writes it, and works out the rest.
  That is the only way in; per 100 g is storage, never something you type.
- **Meals** — a saved list of food + quantity, tapped once instead of four
  times. Build one by picking from your library or by pressing **Scan one in**
  and pointing the camera at each packet in turn; anything new goes through
  the usual check-the-label form and drops straight back into the meal.
  Before logging a meal you can bump any line — four slices of bologna today
  instead of three — without disturbing the saved meal.
- **Batch cooking** — list everything that went into the pot, weigh the
  finished dish, and press *Make it a food*. You get a food worked out per
  100 g, so from then on you weigh your bowl and log the grams. It uses the
  finished weight rather than the sum of the ingredients, because water boils
  off and the calories don't.
- **Trend** — weigh in, and the chart shows the smoothed trend line
  prominently with the raw scale readings faint behind it. Weighing twice in
  a day replaces the reading rather than stacking it.
- **What you actually burn** — your TDEE, backed out of what really happened
  rather than predicted from a formula, with an honest label on it: *not yet
  reliable*, *early estimate*, or *measured*.
- **Plateau detection** — compares the loss your logged deficit predicts
  against the loss the scale actually shows, and raises a tiered, honestly
  worded alert. If it's confident, it offers two levers — eat less, or move
  more — and applies neither without you pressing the button.
- **Work out a target for me** — on day one you have no data, so Settings can
  estimate one from your weight, height, age and activity. It's labelled as a
  formula rather than a measurement, and the Trend screen tells you how far
  out it was once there's enough logged to know.
- **Settings** — a daily calorie target, a goal weight, the rate you're aiming
  for, plus backup export/restore.

## What to expect from Open Food Facts

It is free, needs no key and works straight from the browser — but it is a
volunteer database, and on American groceries the coverage is patchy. Some
real results from the live API:

| Barcode | What came back |
|---|---|
| `3017620422003` Nutella | Full and correct |
| `038000138416` Pringles | Good, serving "1 serving (28 g)" |
| `016000275270` Cheerios | Name reads `Gmills hny nut cheerios sweetened whl grn oat cereal` |
| `072250007559` a US store-brand bread | **Not in the database at all** |
| `028400090353` Doritos | Not in the database |

Where it does have a product it usually has the label's own **per-serving**
figures, not just per-100 g — `serving_quantity: 28` and
`energy-kcal_serving: 150` for a tin of crisps, which is what the packet
prints. Those are used verbatim, because deriving 150.08 from the per-100 g
value is close but is not what you are holding in your hand.

Where it has no serving size at all — Nutella, for instance — the form says so
and leaves the boxes empty for you to read off the packet. It does **not**
invent a 100 g serving: that looked like captured data and disagreed with the
label, which is worse than an honest blank.

So the app treats a miss as an ordinary outcome rather than a failure, and it
never saves a scanned result behind your back — you always see the form first.
Scanning is a shortcut past typing, not a source of truth. The upside is that
you only pay the cost once per product: after that the barcode is in your own
library and a scan goes straight to the amount box.

Two deliberate refusals in the parsing, both covered by tests:

- A serving of `3/4 cup (28 g)` is stored as a 28 g portion called "serving",
  **not** as a "cup" — three-quarters of a cup weighing 28 g does not make a
  cup 28 g, and that mistake would quietly be wrong forever.
- A serving given only as `355 ml` or `16 fl oz` produces no portion at all.
  The app says so and leaves it to you, rather than assuming millilitres are
  grams — which is fine for a soda and badly wrong for oil.

## The maths, and one deliberate change to the plan

`trend.js` holds all of it, touches neither the DOM nor storage, and is
covered by 93 checks against synthetic data where the right answer is known
in advance — including the plan's own worked example (2,100 kcal a day and
2 lb lost over 28 days gives a TDEE of 2,350).

**Where it departs from the plan.** The plan measures the change in weight as
`ema_start - ema_now`. That's right once the average has settled, but wrong at
the start: the EMA is seeded on your first weigh-in, so it begins with no lag
and ends about nine days behind, which makes the loss look smaller than it was.
On a fresh 28-day window that reads 1.4 lb where the truth is 2 lb — and an
under-stated loss means an under-stated burn rate, which means a target that's
tighter than it should be. Wrong in the worst direction for a tool like this.

So the change is measured with a least-squares fit through the weigh-ins
instead. No warm-up, uses every reading rather than two, and it's what the
flat-trend test needs anyway. The EMA is still what you see on the chart.
There's a test that fails if endpoint differencing is ever put back.

**The starting target.** A formula can't tell you your burn rate, but it can
give you somewhere to stand for the first fortnight. Settings uses
**Mifflin-St Jeor** — the usual choice, typically within about 10%, which is
200-odd calories and therefore the whole difference between losing and not —
times a standard activity multiplier. If you know your body fat percentage it
uses **Katch-McArdle** instead, which works from lean mass and needs neither
your age nor a male/female term.

The app is explicit that this is scaffolding. It shows the caveat next to the
number, and it prefers real data everywhere: an accepted burn rate beats a
measurement, a measurement beats the formula, the formula beats nothing.
There's a test asserting exactly that order. Once the measured figure is
trustworthy, the Trend screen says how far off the estimate was and replaces
it.

**Things it refuses to do:**

- A day with no food logged is not a zero-calorie day. Counting it as one
  would invent an enormous deficit and poison every number downstream.
- It won't cry plateau on thin evidence. Fewer than four weigh-ins in the
  window, a gap of more than three days in the food log, or a single overnight
  jump above 3 lb, and it holds its verdict and tells you which one muted it.
- It won't drop your target below the floor — the higher of 1,500 kcal or 75%
  of your measured burn. At that point it says so, and says that a couple of
  weeks at maintenance beats a smaller number.
- It changes nothing on its own. Every adjustment is a button you press.

## Running it

Open `index.html` in a browser and it works.

To use it on your phone over your home network, serve the folder instead:

```
cd G:\ai_projects\caltrack
python -m http.server 8000
```

then visit `http://<your-pc-ip>:8000` on the phone.

**Scanning needs more than that.** Browsers only hand over the camera on
`https://` or on `localhost` — so a `file://` page can't scan, and neither can
a plain `http://192.168.…` address on your phone. The app says so plainly and
offers the type-the-number box instead. For scanning, use the live HTTPS
address above; local files and the LAN server are for development.

### Installing it, and working offline

`manifest.json` and `sw.js` make it a real installed app rather than a
bookmark. The service worker is **network first**: it fetches the current
files every time and only falls back to its cache when the network fails or
takes more than three seconds. Cache-first would load quicker but go stale -
you would push a fix and the phone would keep running last week's code.
At about 100 KB total, fetching fresh costs nothing worth having.

Anything on another origin - Open Food Facts, the ZXing library - is left
alone entirely. A barcode lookup should fail honestly when there's no signal
rather than quietly serve yesterday's answer.

So: **everything works offline except barcode lookups**, which need the
network by their nature. Settings has a line telling you whether the app is
saved for offline use, and a button to force it to the newest version.

### Shipping a change to the phone

`sw.js` names its cache after the build, and **`tools/stamp.py` must be run
before committing** — it writes the stamp into both `app.js` and `sw.js`:

```
python tools/stamp.py && git add -A && git commit -m "..." && git push
```

This is not decoration. The cache name was a fixed string for the first eight
deploys, so the worker's `activate` never purged anything and the phone kept
serving old code — two consecutive fixes appeared not to work because they
never arrived. `test-shell.js` now fails if the stamp is missing, and Settings
shows the running build so a bug report can name a version.

### The one external dependency

Chrome on Android has a barcode reader built in, so on the phone this app
downloads nothing extra. On browsers without it (Safari, Firefox) it lazily
pulls ZXing from jsDelivr — pinned to one version and locked to a
`sha384` integrity hash, so the browser refuses the file outright if the bytes
ever change. Nothing is fetched until someone actually opens the scanner on
one of those browsers.

## Where your data lives

In this browser's `localStorage`, on this device only. Nothing is uploaded and
there are no accounts yet. That means:

- clearing site data, or "clear browsing history" with cookies ticked, erases it
- a different browser, or a different device, is a different empty log
- **Settings → Export a backup file** writes the whole thing to one JSON file.
  Do that occasionally until phase 3 (Supabase sync) exists.

## Files

| File | What it is |
|---|---|
| `index.html` | Every screen. Sheets that slide up are plain `<div>`s toggled with `hidden`. |
| `style.css` | Mobile-first. Follows your phone's light/dark setting. |
| `store.js` | **The only file that knows where data lives.** Also holds the portion maths. |
| `scan.js` | The camera, and the Open Food Facts lookup behind it. |
| `trend.js` | EMA smoothing, adaptive TDEE, plateau detection, target adjustment. No DOM, no storage. |
| `app.js` | Screens and wiring. Never touches `localStorage` itself. |
| `test-store.js` | `node test-store.js` — the data layer, portions, meals, batch cooking. |
| `test-scan.js` | `node test-scan.js` — barcode check-digits and the API parsing, against real captured responses in `test-fixtures/`. |
| `test-trend.js` | `node test-trend.js` — the TDEE and plateau maths against synthetic data with known answers. |
| `test-shell.js` | `node test-shell.js` — checks every file the page loads is in the offline cache, and that the manifest will actually install. |
| `manifest.json`, `sw.js` | What makes it installable and offline-capable. |
| `tools/make-icons.py` | Regenerates `icons/` if the mark ever changes. |

All three run without a browser and without a network: `node test-store.js &&
node test-scan.js && node test-trend.js && node test-shell.js` is 206
checks in about a second.

`store.js` is deliberately walled off, and every one of its functions returns a
Promise even though `localStorage` is instant. That's so the phase 3 move to
Supabase — whose calls really are async — is a rewrite of that one file, with
nothing else in the app changing.

## Data shapes

Foods are stored per 100 g, which is the one unit that is never ambiguous.
That is a **storage** decision, not an interface one: nothing asks you to
think in per-100 g. You type what the label says about one serving, and the
app converts. Lists show "70 kcal per slice", not "265 kcal / 100 g", and
per-100 g only appears for foods that have no serving to speak of.

```js
{
  id: "…", barcode: "072250007559",
  name: "Butterbread", brand: "Nature's Own",
  per_100g: { kcal: 265, protein: 8, carbs: 49, fat: 3.5 },
  portions: [ { name: "slice", grams: 28 }, { name: "gram", grams: 1 } ],
  source: "manual", user_id: null
}
```

A log entry stores the food it came from *and* a snapshot of the calories and
macros as they were when you logged it. So correcting a food's nutrition later
fixes it going forward without silently rewriting your history, and deleting a
food leaves past entries intact.

The keys are `caltrack.foods`, `caltrack.log_entries`, `caltrack.meals`,
`caltrack.weigh_ins`, `caltrack.activity` and `caltrack.settings` — one per
planned Postgres table, so the migration is a straight lift.

## Deploying

Done — GitHub Pages serves `main` from the repository root, with HTTPS
enforced. From here the whole deploy flow is:

```
git add -A
git commit -m "what changed"
git push
```

A push takes roughly a minute to appear. `gh api repos/n00bin/caltrack/pages
--jq .status` says whether the last one built. Pages occasionally fails for no
good reason; pushing again clears it.

The build plan lives outside the repo, since it carries personal context that
doesn't belong in a public one.
