/* test-shell.js - keeps the offline cache honest. Run: node test-shell.js
 *
 * The failure this catches: you add a new .js file, wire it into index.html,
 * forget to add it to the SHELL list in sw.js, and the app silently stops
 * working offline - which you will not notice until you are standing in a
 * supermarket with no signal.
 */
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(HERE, 'sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));

let fails = 0;
function ok(label, cond, detail) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label + (cond || !detail ? '' : '  ' + detail));
  if (!cond) fails++;
}

// Everything the page pulls in from our own origin.
const refs = new Set();
(html.match(/(?:src|href)="([^"]+)"/g) || []).forEach((m) => {
  const url = m.replace(/^(?:src|href)="/, '').replace(/"$/, '');
  if (/^(https?:|data:|#|mailto:)/.test(url)) return;
  refs.add(url.replace(/^\.\//, ''));
});

// What the service worker promises to keep.
const shellBlock = sw.match(/const SHELL = \[([\s\S]*?)\];/);
ok('sw.js has a SHELL list', !!shellBlock);
const shell = new Set(
  (shellBlock ? shellBlock[1].match(/'([^']+)'/g) || [] : [])
    .map((s) => s.replace(/'/g, '').replace(/^\.\//, ''))
);

ok('the shell caches the app root', shell.has(''));

refs.forEach((ref) => {
  ok('index.html references ' + ref + ', and the shell caches it',
    shell.has(ref), '-> add ' + JSON.stringify('./' + ref) + ' to SHELL in sw.js');
});

// Every file named anywhere must actually exist.
const named = new Set([...refs, ...shell].filter((f) => f !== ''));
manifest.icons.forEach((i) => named.add(i.src.replace(/^\.\//, '')));
named.forEach((f) => {
  ok(f + ' exists on disk', fs.existsSync(path.join(HERE, f)));
});

// Manifest sanity - a bad one means Android quietly refuses to install.
ok('manifest has a name', !!manifest.name);
ok('manifest has a short_name for the home screen', !!manifest.short_name);
ok('manifest is standalone', manifest.display === 'standalone');
ok('manifest start_url is relative, so project pages work',
  manifest.start_url === '.' || manifest.start_url.startsWith('./'));
ok('manifest has a 192px icon',
  manifest.icons.some((i) => i.sizes === '192x192'));
ok('manifest has a 512px icon',
  manifest.icons.some((i) => i.sizes === '512x512'));
ok('icons are maskable, so Android does not letterbox them',
  manifest.icons.every((i) => /maskable/.test(i.purpose || '')));
ok('index.html links the manifest', /rel="manifest"/.test(html));
ok('index.html has an apple-touch-icon', /apple-touch-icon/.test(html));

/* The cache name must change with every build. It did not for eight
 * deploys, so `activate` never purged anything and phones kept serving old
 * code - two fixes in a row appeared not to work because they never landed.
 * tools/stamp.py writes this; the test makes sure nobody unstamps it.
 */
const version = (sw.match(/const VERSION = '([^']+)'/) || [])[1] || '';
ok('the cache name carries a build stamp, not a fixed name',
  /\d{4}-\d{2}-\d{2}/.test(version), 'got ' + JSON.stringify(version) +
  ' - run: python tools/stamp.py');
const build = (fs.readFileSync(path.join(HERE, 'app.js'), 'utf8')
  .match(/var BUILD = '([^']+)'/) || [])[1] || '';
ok('app.js carries the same stamp', build && version.indexOf(build) !== -1,
  'BUILD=' + JSON.stringify(build) + ' VERSION=' + JSON.stringify(version));
ok('the build id is shown to the user', /id="buildId"/.test(html));

/* GitHub Pages sends Cache-Control: max-age=600, and a plain fetch() obeys
 * the browser's HTTP cache - so a "network first" worker can still serve a
 * ten-minute-old file and look like it deployed nothing. Every fetch has to
 * opt out explicitly.
 */
ok('the worker bypasses the browser HTTP cache', /cache: 'no-store'/.test(sw));
ok('and does it on the live fetch, not just in a comment',
  /fetch\(fresh\(request\)\)/.test(sw));
ok('the precache bypasses it too', /SHELL\.map\(fresh\)/.test(sw));

// The service worker must not touch other people's servers.
ok('the worker leaves other origins alone',
  /url\.origin !== self\.location\.origin/.test(sw));
ok('and only handles GET', /request\.method !== 'GET'/.test(sw));

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
