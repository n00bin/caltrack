/* test-bluetooth.js - the scale packet parsers. Run:  node test-bluetooth.js
 *
 * No scale and no Bluetooth needed: the parsers take a DataView and return a
 * plain object, so the packets are built here byte by byte from the Bluetooth
 * SIG spec. This is the half of the feature that CAN be verified, which is
 * why the field order and the awkward units live there rather than in the
 * connection code.
 */
const fs = require('fs');

// In a browser, window IS the global object. Node already provides a
// `navigator` with no `bluetooth` on it, which is exactly the unsupported
// case the last assertions check.
globalThis.window = globalThis;
globalThis.isSecureContext = true;
eval(fs.readFileSync(__dirname + '/bluetooth.js', 'utf8'));
const ble = window.CalTrack.ble;

let fails = 0;
function near(label, got, want, tol) {
  const ok = Math.abs(got - want) <= (tol === undefined ? 1e-6 : tol);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  got=' + got +
    (ok ? '' : ' want=' + want));
  if (!ok) fails++;
}
function eq(label, got, want) {
  const ok = got === want;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '  got=' + JSON.stringify(got) +
    (ok ? '' : ' want=' + JSON.stringify(want)));
  if (!ok) fails++;
}
function ok(label, cond) {
  console.log((cond ? 'PASS  ' : 'FAIL  ') + label);
  if (!cond) fails++;
}

// Little-endian builder, which is what BLE uses throughout.
function packet(parts) {
  const bytes = [];
  parts.forEach(([size, value]) => {
    for (let i = 0; i < size; i++) bytes.push((value >> (8 * i)) & 0xFF);
  });
  return new DataView(new Uint8Array(bytes).buffer);
}

// --- Weight Measurement, 0x2A9D ----------------------------------------
{
  // SI: flags 0, weight in 5 g units. 81.65 kg = 16330 units = 180.0 lb.
  const p = packet([[1, 0x00], [2, 16330]]);
  const r = ble.parseWeight(p);
  near('81.65 kg comes through as 180 lb', r.weightLbs, 180, 0.05);
  eq('and it knows it was metric', r.imperial, false);
}
{
  // Imperial: flags bit 0, weight in 0.01 lb units.
  const r = ble.parseWeight(packet([[1, 0x01], [2, 18000]]));
  near('180.00 lb read directly', r.weightLbs, 180);
  eq('flagged imperial', r.imperial, true);
}
{
  // Timestamp and user id present: the weight must still be found, and the
  // user id must be read from AFTER the seven timestamp bytes.
  // imperial (bit 0) as well, since the weight below is in 0.01 lb units.
  const flags = 0x01 | 0x02 | 0x04;
  const r = ble.parseWeight(packet([
    [1, flags], [2, 18000],
    [2, 2026], [1, 8], [1, 31], [1, 13], [1, 5], [1, 0],   // timestamp
    [1, 3]                                                  // user id
  ]));
  near('weight survives the optional fields', r.weightLbs, 180);
  eq('and the user id is not read out of the timestamp', r.userId, 3);
}
eq('a runt packet is refused', ble.parseWeight(packet([[1, 0]])), null);
eq('nothing at all', ble.parseWeight(null), null);

// --- Body Composition Measurement, 0x2A9C -------------------------------
{
  // The one that matters: body fat AND muscle mass, metric.
  // flags: muscle mass (bit 5) + weight (bit 10).
  const flags = 0x0020 | 0x0400;
  const r = ble.parseBodyComposition(packet([
    [2, flags],
    [2, 220],      // 22.0% body fat
    [2, 8000],     // muscle mass: 8000 x 5 g = 40 kg = 88.18 lb
    [2, 18143]     // weight: 18143 x 5 g = 90.7 kg = 200 lb
  ]));
  near('body fat percentage', r.bodyFatPct, 22, 1e-9);
  near('muscle mass in pounds', r.muscleMassLbs, 40 * 2.20462262, 0.01);
  near('and the weight it came with', r.weightLbs, 200, 0.05);
}
{
  // Field ORDER is the thing that breaks silently. Set basal metabolism,
  // muscle percentage, muscle mass and body water, and check muscle mass is
  // not read out of one of its neighbours.
  const flags = 0x0008 | 0x0010 | 0x0020 | 0x0100;
  const r = ble.parseBodyComposition(packet([
    [2, flags],
    [2, 250],      // 25.0% fat
    [2, 7000],     // basal metabolism, kJ - must be skipped, not treated as mass
    [2, 400],      // muscle percentage 40.0%
    [2, 8000],     // muscle mass 40 kg
    [2, 9000]      // body water 45 kg
  ]));
  near('fat', r.bodyFatPct, 25, 1e-9);
  near('basal metabolism kept separate', r.basalMetabolismKj, 7000);
  near('muscle percentage', r.musclePct, 40, 1e-9);
  near('muscle MASS, not the water that follows it', r.muscleMassLbs, 40 * 2.20462262, 0.01);
  near('and the water is the water', r.bodyWaterMassLbs, 45 * 2.20462262, 0.01);
}
{
  // Imperial body composition: masses in 0.01 lb.
  const r = ble.parseBodyComposition(packet([
    [2, 0x0001 | 0x0020], [2, 180], [2, 8800]
  ]));
  near('18.0% fat', r.bodyFatPct, 18, 1e-9);
  near('88.00 lb of muscle read directly', r.muscleMassLbs, 88, 1e-9);
}
{
  // 0xFFFF is the spec's "could not measure" and must not become a number.
  const r = ble.parseBodyComposition(packet([
    [2, 0x0020], [2, 0xFFFF], [2, 0xFFFF]
  ]));
  eq('a failed fat reading is absent, not 6553.5%', r.bodyFatPct, undefined);
  eq('and a failed muscle reading likewise', r.muscleMassLbs, undefined);
}
{
  // A packet that claims fields it does not carry must not read past its end.
  const r = ble.parseBodyComposition(packet([[2, 0xFFFF], [2, 200]]));
  ok('a truncated packet does not throw', !!r);
  near('what was there is still read', r.bodyFatPct, 20, 1e-9);
}
eq('a runt composition packet', ble.parseBodyComposition(packet([[2, 0]])), null);

// --- turning packets into a weigh-in ------------------------------------
{
  const r = ble.toReading(
    { weightLbs: 200 },
    { bodyFatPct: 22, muscleMassLbs: 88, weightLbs: 199.5 });
  near('the weight service wins over the composition one', r.weight_lbs, 200);
  near('body fat carried', r.body_fat_pct, 22);
  near('muscle carried', r.muscle_mass_lbs, 88);
}
{
  // A scale that reports muscle as a percentage still yields a mass.
  const r = ble.toReading(null, { bodyFatPct: 22, musclePct: 40, weightLbs: 200 });
  near('40% of 200 lb is 80 lb of muscle', r.muscle_mass_lbs, 80, 1e-9);
}
{
  const r = ble.toReading({ weightLbs: 180 }, null);
  near('weight alone is a valid reading', r.weight_lbs, 180);
  eq('with nothing invented alongside it', r.body_fat_pct, undefined);
}
eq('nothing in, nothing out', JSON.stringify(ble.toReading(null, null)), '{}');

// --- errors have to be readable, not swallowed --------------------------
ok('a missing device is explained',
  /not advertising anything/.test(ble.describe({ name: 'NotFoundError' }).message));
ok('a blocked request names the cause',
  /https:\/\/ page and a real tap/.test(ble.describe({ name: 'SecurityError' }).message));
ok('a dropped connection suggests waking the scale',
  /step on it to wake it/.test(ble.describe({ name: 'NetworkError' }).message));
ok('an unknown error still comes back as an Error',
  ble.describe(new Error('boom')) instanceof Error);
eq('and keeps its message', ble.describe(new Error('boom')).message, 'boom');
ok('even a bare string', ble.describe('odd') instanceof Error);

// The probe has to ask permission for the custom UUIDs, or Chrome hides them.
ok('the probe asks for the standard weight service',
  ble.KNOWN_SERVICES.indexOf(0x181D) !== -1);
ok('and body composition', ble.KNOWN_SERVICES.indexOf(0x181B) !== -1);
ok('and FFB0, which is the Lefu/FitDays one',
  ble.KNOWN_SERVICES.indexOf(0xFFB0) !== -1);

// --- capability reporting ------------------------------------------------
ok('no Bluetooth in this browser is reported, not thrown',
  /no Bluetooth/.test(ble.whyUnsupported()));
eq('and supported() agrees', ble.supported(), false);

console.log(fails === 0 ? '\nALL PASS' : '\n' + fails + ' FAILED');
process.exit(fails ? 1 : 0);
