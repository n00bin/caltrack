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

// The service worker must not touch other people's servers.
ok('the worker leaves other origins alone',
  /url\.origin !== self\.location\.origin/.test(sw));
ok('and only handles GET', /request\.method !== 'GET'/.test(sw));

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
