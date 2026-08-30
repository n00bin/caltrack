# Calorie Tracker

A barcode-scanning food log that runs as a plain static web page. No build
step, no framework, no packaging — the browser reads the files directly.

**Live at [n00bin.github.io/caltrack](https://n00bin.github.io/caltrack/).**
Open that on your phone and add it to the home screen.

Built to a written build plan kept privately alongside the repo.
**Steps 1 and 2 of that plan are done:**
manual food entry, a food library, today's log and running total, and barcode
scanning with an Open Food Facts lookup.

## What works right now

- **Today** — your log for a day, grouped into breakfast / lunch / dinner /
  snack, with calories and macros for each meal and for the day. Step backwards
  and forwards through days, or tap the date to jump to one.
- **Logging** — the round `+` button. It guesses the meal from the clock,
  shows your foods most-recently-used first, then asks for an amount. Two taps
  and a number for something you've eaten before.
- **Scanning** — the Scan button. Point it at a barcode and one of three
  things happens: it's already one of your foods and you go straight to the
  amount box; it's in Open Food Facts and you get a filled-in form to check;
  or it's in neither, and you type the label once and own it from then on.
  There's a "type the number instead" box for when the camera won't play.
- **Portions** — every food stores its nutrition per 100 g and carries a list
  of named portions. Tell it once that a slice of bread is 28 g and from then
  on you log "2 slices" and it does the maths. Grams is always available.
- **Foods** — your own library. Add, edit and delete. If a label is written
  per serving instead of per 100 g, open "The label is per serving" and it
  converts for you.
- **Settings** — a daily calorie target (the Today screen then shows what's
  left), plus backup export/restore.

Not built yet, in plan order: the weigh-to-derive button, meals, weigh-ins and
the trend chart, adaptive TDEE and plateau detection.

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
| `app.js` | Screens and wiring. Never touches `localStorage` itself. |
| `test-store.js` | `node test-store.js` — checks the data layer. No browser needed. |
| `test-scan.js` | `node test-scan.js` — checks barcode check-digits and the API parsing, against real captured responses in `test-fixtures/`. |

`store.js` is deliberately walled off, and every one of its functions returns a
Promise even though `localStorage` is instant. That's so the phase 3 move to
Supabase — whose calls really are async — is a rewrite of that one file, with
nothing else in the app changing.

## Data shapes

Foods are stored per 100 g, which is the one unit that is never ambiguous:

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
