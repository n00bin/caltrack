/* bluetooth.js — reading a scale directly, over Web Bluetooth.
 *
 * WHETHER THIS WORKS DEPENDS ENTIRELY ON YOUR SCALE. The Bluetooth SIG
 * defines two standard services for exactly this - Weight Scale (0x181D) and
 * Body Composition (0x181B) - and a scale that implements them can be read by
 * any client, including a web page. Plenty of budget scales do not: they
 * broadcast a proprietary blob in their advertising packets that only the
 * vendor's own app can decode, and never expose a readable service at all.
 *
 * There is no way to tell from the outside which sort you own except to try.
 * So this tries, and says plainly what it found rather than failing silently.
 *
 * Chrome on Android only, over HTTPS, and the page must ask from a real tap.
 *
 * The measurement characteristics INDICATE rather than read: the scale sends
 * a value when it takes one. So connecting is not enough - you have to stand
 * on the scale while connected.
 */
window.CalTrack = window.CalTrack || {};

CalTrack.ble = (function () {
  'use strict';

  var WEIGHT_SCALE_SERVICE = 0x181D;
  var WEIGHT_MEASUREMENT = 0x2A9D;
  var BODY_COMPOSITION_SERVICE = 0x181B;
  var BODY_COMPOSITION_MEASUREMENT = 0x2A9C;

  var KG_TO_LB = 2.20462262;
  var KG_RESOLUTION = 0.005;    // SI mass, per the spec
  var LB_RESOLUTION = 0.01;     // Imperial mass
  var PCT_RESOLUTION = 0.1;

  function supported() {
    return !!(navigator.bluetooth && navigator.bluetooth.requestDevice);
  }

  function whyUnsupported() {
    if (!window.isSecureContext) return 'Bluetooth needs an https:// page.';
    if (!navigator.bluetooth) {
      return 'This browser has no Bluetooth. Chrome on Android does; Safari and ' +
        'Firefox do not, and neither does iPhone.';
    }
    return null;
  }

  // --------------------------------------------------------------- parsing
  // Both of these are pure: a DataView in, a plain object out. They are the
  // only part of this file that can be tested without a scale, so they carry
  // the detail and the connection code stays thin.

  function massToLbs(raw, imperial) {
    return imperial ? raw * LB_RESOLUTION : raw * KG_RESOLUTION * KG_TO_LB;
  }

  /* Weight Measurement, 0x2A9D.
   *   uint8  flags
   *   uint16 weight
   *   [7]    timestamp      if flags bit 1
   *   uint8  user id        if flags bit 2
   *   uint16 BMI, uint16 height   if flags bit 3
   */
  function parseWeight(view) {
    if (!view || view.byteLength < 3) return null;
    var flags = view.getUint8(0);
    var imperial = !!(flags & 0x01);
    var offset = 1;

    var weight = massToLbs(view.getUint16(offset, true), imperial);
    offset += 2;

    var out = { weightLbs: weight, imperial: imperial };

    // Every read past this point is bounds-checked. A scale that sets a flag
    // and then sends a packet too short to hold that field would otherwise
    // throw inside the notification handler, where nothing catches it.
    function room(n) { return offset + n <= view.byteLength; }

    if (flags & 0x02) offset += 7;                     // timestamp, not needed
    if (flags & 0x04) {
      if (!room(1)) return out;
      out.userId = view.getUint8(offset);
      offset += 1;
    }
    if ((flags & 0x08) && room(2)) {
      out.bmi = view.getUint16(offset, true) * 0.1;
    }
    return out;
  }

  /* Body Composition Measurement, 0x2A9C. Every field after the body fat
   * percentage is optional, and they appear in THIS ORDER when their flag is
   * set - get the order wrong and muscle mass reads as body water.
   *
   *   uint16 flags
   *   uint16 body fat percentage        (always)
   *   [7]    timestamp                  bit 1
   *   uint8  user id                    bit 2
   *   uint16 basal metabolism           bit 3
   *   uint16 muscle percentage          bit 4
   *   uint16 muscle mass                bit 5
   *   uint16 fat free mass              bit 6
   *   uint16 soft lean mass             bit 7
   *   uint16 body water mass            bit 8
   *   uint16 impedance                  bit 9
   *   uint16 weight                     bit 10
   *   uint16 height                     bit 11
   */
  function parseBodyComposition(view) {
    if (!view || view.byteLength < 4) return null;
    var flags = view.getUint16(0, true);
    var imperial = !!(flags & 0x0001);
    var offset = 2;

    var out = { imperial: imperial };

    var fat = view.getUint16(offset, true);
    offset += 2;
    // 0xFFFF is the spec's "measurement unsuccessful".
    if (fat !== 0xFFFF) out.bodyFatPct = fat * PCT_RESOLUTION;

    function room(n) { return offset + n <= view.byteLength; }

    function u16() {
      if (!room(2)) return null;
      var v = view.getUint16(offset, true);
      offset += 2;
      return v === 0xFFFF ? null : v;   // the spec's "measurement failed"
    }

    if (flags & 0x0002) offset += 7;                       // timestamp
    if (flags & 0x0004) {
      if (!room(1)) return out;
      out.userId = view.getUint8(offset);
      offset += 1;
    }
    if (flags & 0x0008) { var bmr = u16(); if (bmr !== null) out.basalMetabolismKj = bmr; }
    if (flags & 0x0010) { var mp = u16(); if (mp !== null) out.musclePct = mp * PCT_RESOLUTION; }
    if (flags & 0x0020) { var mm = u16(); if (mm !== null) out.muscleMassLbs = massToLbs(mm, imperial); }
    if (flags & 0x0040) { var ff = u16(); if (ff !== null) out.fatFreeMassLbs = massToLbs(ff, imperial); }
    if (flags & 0x0080) { var sl = u16(); if (sl !== null) out.softLeanMassLbs = massToLbs(sl, imperial); }
    if (flags & 0x0100) { var bw = u16(); if (bw !== null) out.bodyWaterMassLbs = massToLbs(bw, imperial); }
    if (flags & 0x0200) { var imp = u16(); if (imp !== null) out.impedance = imp * 0.1; }
    if (flags & 0x0400) { var wt = u16(); if (wt !== null) out.weightLbs = massToLbs(wt, imperial); }

    return out;
  }

  // Whatever arrived, in the shape a weigh-in wants.
  function toReading(weight, composition) {
    var out = {};
    if (composition) {
      if (composition.weightLbs) out.weight_lbs = composition.weightLbs;
      if (composition.bodyFatPct) out.body_fat_pct = composition.bodyFatPct;
      if (composition.muscleMassLbs) out.muscle_mass_lbs = composition.muscleMassLbs;
      // Some scales give a muscle PERCENTAGE instead of a mass.
      if (!out.muscle_mass_lbs && composition.musclePct && (out.weight_lbs || (weight && weight.weightLbs))) {
        out.muscle_mass_lbs = (out.weight_lbs || weight.weightLbs) * composition.musclePct / 100;
      }
    }
    if (weight && weight.weightLbs) out.weight_lbs = weight.weightLbs;
    return out;
  }

  // ------------------------------------------------------------ connecting

  var device = null;

  function disconnect() {
    if (device && device.gatt && device.gatt.connected) device.gatt.disconnect();
    device = null;
  }

  /* opts:
   *   onStatus  fn(text)
   *   onReading fn({weight_lbs, body_fat_pct, muscle_mass_lbs})
   *   onError   fn(Error)
   *   allDevices  true to list every Bluetooth device, for a scale that does
   *               not advertise the standard services but might still expose
   *               them once connected
   */
  function connect(opts) {
    var err = whyUnsupported();
    if (err) { opts.onError(new Error(err)); return Promise.resolve(); }

    var request = opts.allDevices
      ? { acceptAllDevices: true,
          optionalServices: [WEIGHT_SCALE_SERVICE, BODY_COMPOSITION_SERVICE] }
      : { filters: [{ services: [WEIGHT_SCALE_SERVICE] },
                    { services: [BODY_COMPOSITION_SERVICE] }],
          optionalServices: [WEIGHT_SCALE_SERVICE, BODY_COMPOSITION_SERVICE] };

    opts.onStatus('Pick your scale from the list...');

    var latestWeight = null;
    var latestComposition = null;

    function push() {
      var reading = toReading(latestWeight, latestComposition);
      if (reading.weight_lbs || reading.body_fat_pct || reading.muscle_mass_lbs) {
        opts.onReading(reading);
      }
    }

    return navigator.bluetooth.requestDevice(request).then(function (d) {
      device = d;
      opts.onStatus('Connecting...');
      d.addEventListener('gattserverdisconnected', function () {
        opts.onStatus('The scale disconnected.');
      });
      return d.gatt.connect();
    }).then(function (server) {
      opts.onStatus('Connected. Looking for the standard services...');
      return Promise.all([
        subscribe(server, WEIGHT_SCALE_SERVICE, WEIGHT_MEASUREMENT, function (view) {
          latestWeight = parseWeight(view);
          push();
        }),
        subscribe(server, BODY_COMPOSITION_SERVICE, BODY_COMPOSITION_MEASUREMENT, function (view) {
          latestComposition = parseBodyComposition(view);
          push();
        })
      ]);
    }).then(function (found) {
      var got = found.filter(Boolean);
      if (!got.length) {
        disconnect();
        throw new Error('That device connected, but it does not offer the standard ' +
          'weight or body composition services - so there is nothing a web page ' +
          'is allowed to read. Scales like that only talk to their own app.');
      }
      opts.onStatus('Ready. Step on the scale now and stay still - the reading ' +
        'arrives when it finishes measuring.');
    }).catch(function (e) {
      if (e && e.name === 'NotFoundError') {
        opts.onError(new Error('No scale picked, or none nearby offering the ' +
          'standard services. Try "show every device" if you can see it in your ' +
          'phone settings but not here.'));
        return;
      }
      opts.onError(e instanceof Error ? e : new Error('Could not connect.'));
    });
  }

  // Resolves to true if that service existed and is now streaming.
  function subscribe(server, serviceId, characteristicId, onValue) {
    return server.getPrimaryService(serviceId)
      .then(function (service) { return service.getCharacteristic(characteristicId); })
      .then(function (ch) {
        ch.addEventListener('characteristicvaluechanged', function (ev) {
          onValue(ev.target.value);
        });
        return ch.startNotifications();
      })
      .then(function () { return true; })
      .catch(function () { return false; });   // this scale has not got it
  }

  return {
    supported: supported,
    whyUnsupported: whyUnsupported,
    connect: connect,
    disconnect: disconnect,
    parseWeight: parseWeight,
    parseBodyComposition: parseBodyComposition,
    toReading: toReading
  };
})();
