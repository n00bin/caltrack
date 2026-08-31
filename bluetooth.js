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

  /* Services worth asking permission for.
   *
   * Web Bluetooth will only let a page see services it named up front, so a
   * probe has to guess. These are the standard pair plus the custom UUIDs
   * that turn up on cheap body-composition scales - FFB0 is the Lefu/FitDays
   * one, and the rest are the usual Chinese BLE module defaults.
   */
  var KNOWN_SERVICES = [
    0x181D, 0x181B,             // Weight Scale, Body Composition
    0xFFB0,                     // Lefu / FitDays
    0xFFF0, 0xFFE0, 0xFEE7,     // common module defaults
    0x1910,                     // Xiaomi
    0xFE95,                     // Xiaomi/MiBeacon
    0x180A, 0x180F              // device info, battery
  ];

  function hex(uuid) {
    return String(uuid);
  }

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

  /* ---------------------------------------------------------------------
   * ICOMON / Lefu "ffb0" scales - the A-Scale X and its many rebadges.
   *
   * Captured from a real device (FI2019LB-B, firmware 1.0.4) on 31 Aug 2026.
   * Twenty-byte frames, big-endian, on two characteristics:
   *
   *   ffb2 [notify]   type a2, the live reading while you are stepping on
   *   ffb3 [indicate] type a3, the settled reading, sent once
   *
   *   byte 0     sequence counter, wraps ff -> 00
   *   byte 3     frame type: a1 status, a2 live, a3 final
   *   byte 4     (a2 only) settling state: 01 weighing, 02 stable,
   *              04 measuring impedance
   *   bytes 6-8  (a2) weight, 24-bit big-endian
   *   bytes 5-7  (a3) weight, 24-bit big-endian - one earlier, since a2
   *              carries the extra state byte
   *   bytes 8-10 (a3) impedance, present ONLY when both feet are properly
   *              on the electrodes. Absent readings come through as zeros.
   *   byte 19    checksum, independent of the sequence byte
   *
   * The raw weight is always a multiple of 50, so the last unit is not
   * meaningful - the divisor is what turns it into pounds, and that is
   * confirmed against the scale's own display rather than assumed. See
   * DEFAULT_DIVISOR.
   */
  var ICOMON_SERVICE = 0xFFB0;
  var ICOMON_WRITE = 0xFFB1;
  var ICOMON_LIVE = 0xFFB2;
  var ICOMON_FINAL = 0xFFB3;

  // raw / 500 = pounds, i.e. 0.1 lb per 50 raw units. Overridable, because
  // a scale set to kilograms would need a different divisor and there is no
  // flag in the frame that says which.
  var DEFAULT_DIVISOR = 500;

  function u24(view, offset) {
    return (view.getUint8(offset) << 16) |
           (view.getUint8(offset + 1) << 8) |
            view.getUint8(offset + 2);
  }

  function parseIcomon(view, divisor) {
    if (!view || view.byteLength < 20) return null;
    divisor = divisor > 0 ? divisor : DEFAULT_DIVISOR;

    var type = view.getUint8(3);

    if (type === 0xA2) {
      return {
        kind: 'live',
        state: view.getUint8(4),
        raw: u24(view, 6),
        weightLbs: u24(view, 6) / divisor
      };
    }

    if (type === 0xA3) {
      var raw = u24(view, 5);
      var out = {
        kind: 'final',
        raw: raw,
        weightLbs: raw / divisor,
        impedanceBytes: [view.getUint8(8), view.getUint8(9), view.getUint8(10)]
      };
      // All three zero means the feet were not on the electrodes properly,
      // so there is no body composition to be had from this reading.
      out.hasImpedance = !!(out.impedanceBytes[0] || out.impedanceBytes[1] ||
                            out.impedanceBytes[2]);
      if (out.hasImpedance) {
        // Big-endian, matching every other field in the frame.
        out.impedance = (view.getUint8(9) << 8) | view.getUint8(10);
      }
      return out;
    }

    return { kind: 'status', type: type };
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
          optionalServices: [WEIGHT_SCALE_SERVICE, BODY_COMPOSITION_SERVICE,
                             ICOMON_SERVICE] }
      : { filters: [{ services: [WEIGHT_SCALE_SERVICE] },
                    { services: [BODY_COMPOSITION_SERVICE] },
                    { services: [ICOMON_SERVICE] }],
          optionalServices: [WEIGHT_SCALE_SERVICE, BODY_COMPOSITION_SERVICE,
                             ICOMON_SERVICE] };

    var latestWeight = null;
    var latestComposition = null;

    function push() {
      var reading = toReading(latestWeight, latestComposition);
      if (reading.weight_lbs || reading.body_fat_pct || reading.muscle_mass_lbs) {
        opts.onReading(reading);
      }
    }

    var started;
    try {
      opts.onStatus('Pick your scale from the list...');
      started = navigator.bluetooth.requestDevice(request);
    } catch (e) {
      // A synchronous throw here used to escape the click handler entirely,
      // so the button appeared to do nothing at all.
      opts.onError(describe(e));
      return Promise.resolve();
    }

    return started.then(function (d) {
      device = d;
      opts.onStatus('Connecting...');
      d.addEventListener('gattserverdisconnected', function () {
        opts.onStatus('The scale disconnected.');
      });
      return d.gatt.connect();
    }).then(function (server) {
      opts.onStatus('Connected. Looking for the standard services...');
      /* The live characteristic is noisy - a packet every tenth of a second
       * while you settle. Only the FINAL frame is worth reporting, so the
       * live one just drives the status line.
       */
      function onIcomon(view) {
        var r = parseIcomon(view, opts.divisor);
        if (!r) return;
        if (r.kind === 'live') {
          opts.onStatus('Reading ' + r.weightLbs.toFixed(1) + ' lb' +
            (r.state === 4 ? ' - measuring body composition, stay still...'
                           : ' - hold still...'));
          return;
        }
        if (r.kind !== 'final') return;
        var reading = { weight_lbs: r.weightLbs, raw: r.raw };
        if (r.hasImpedance) reading.impedance = r.impedance;
        reading.footContact = r.hasImpedance;
        opts.onReading(reading);
      }

      return Promise.all([
        subscribe(server, WEIGHT_SCALE_SERVICE, WEIGHT_MEASUREMENT, function (view) {
          latestWeight = parseWeight(view);
          push();
        }),
        subscribe(server, BODY_COMPOSITION_SERVICE, BODY_COMPOSITION_MEASUREMENT, function (view) {
          latestComposition = parseBodyComposition(view);
          push();
        }),
        subscribe(server, ICOMON_SERVICE, ICOMON_LIVE, onIcomon),
        subscribe(server, ICOMON_SERVICE, ICOMON_FINAL, onIcomon)
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
      if (e && e.name === 'NotFoundError' && !opts.allDevices) {
        opts.onError(new Error('Nothing nearby is offering the standard weight ' +
          'services. Try "show every device", and if that does not find it ' +
          'either, use "what does my scale offer?".'));
        return;
      }
      opts.onError(describe(e));
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

  /* Connect to ANY device and list what it actually offers.
   *
   * This exists because "it did nothing" is not a diagnosis. A scale that is
   * a pure broadcaster - which many cheap ones are - exposes no services at
   * all, and that is worth knowing definitively rather than inferring. The
   * output is meant to be read out or screenshotted.
   */
  function probe(opts) {
    var err = whyUnsupported();
    if (err) { opts.onError(new Error(err)); return Promise.resolve(); }

    var lines = [];
    var picked = null;

    try {
      opts.onStatus('Pick your scale from the list...');
      return navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: KNOWN_SERVICES
      }).then(function (d) {
        picked = d;
        device = d;
        lines.push('Device: ' + (d.name || '(no name)'));
        opts.onStatus('Connecting to ' + (d.name || 'it') + '...');
        return d.gatt.connect();
      }).then(function (server) {
        opts.onStatus('Connected. Asking what it offers...');
        return server.getPrimaryServices();
      }).then(function (services) {
        if (!services.length) {
          lines.push('No readable services at all.');
          return null;
        }
        lines.push(services.length + ' service(s):');
        return services.reduce(function (chain, svc) {
          return chain.then(function () {
            lines.push('  service ' + hex(svc.uuid));
            return svc.getCharacteristics().then(function (chars) {
              chars.forEach(function (c) {
                var p = c.properties || {};
                var flags = [];
                if (p.read) flags.push('read');
                if (p.write) flags.push('write');
                if (p.writeWithoutResponse) flags.push('write-no-response');
                if (p.notify) flags.push('notify');
                if (p.indicate) flags.push('indicate');
                lines.push('    char ' + hex(c.uuid) + '  [' + flags.join(', ') + ']');
              });
            }).catch(function () {
              lines.push('    (characteristics not readable)');
            });
          });
        }, Promise.resolve());
      }).then(function () {
        if (picked && picked.gatt && picked.gatt.connected) picked.gatt.disconnect();
        opts.onReport(lines.join('\n'));
      }).catch(function (e) {
        if (picked && picked.gatt && picked.gatt.connected) picked.gatt.disconnect();
        if (lines.length) {
          lines.push('Then it failed: ' + (e && e.message ? e.message : e));
          opts.onReport(lines.join('\n'));
          return;
        }
        opts.onError(describe(e));
      });
    } catch (e) {
      // requestDevice can throw synchronously, which otherwise vanishes.
      opts.onError(describe(e));
      return Promise.resolve();
    }
  }

  // Turns a Web Bluetooth exception into something worth reading.
  function describe(e) {
    var name = e && e.name;
    if (name === 'NotFoundError') {
      return new Error('No device was picked, or none were offered. If your scale ' +
        'is not in the list, it is not advertising anything a web page may see.');
    }
    if (name === 'SecurityError') {
      return new Error('The browser blocked the request. Bluetooth needs an ' +
        'https:// page and a real tap on the button.');
    }
    if (name === 'NotSupportedError') {
      return new Error('This browser says it does not support that.');
    }
    if (name === 'NetworkError') {
      return new Error('Could not connect. The scale may have gone to sleep - ' +
        'step on it to wake it, then try again straight away.');
    }
    return e instanceof Error ? e : new Error(String(e));
  }

  return {
    ICOMON_SERVICE: ICOMON_SERVICE,
    ICOMON_LIVE: ICOMON_LIVE,
    ICOMON_FINAL: ICOMON_FINAL,
    DEFAULT_DIVISOR: DEFAULT_DIVISOR,
    parseIcomon: parseIcomon,
    KNOWN_SERVICES: KNOWN_SERVICES,
    probe: probe,
    describe: describe,
    supported: supported,
    whyUnsupported: whyUnsupported,
    connect: connect,
    disconnect: disconnect,
    parseWeight: parseWeight,
    parseBodyComposition: parseBodyComposition,
    toReading: toReading
  };
})();
