'use strict';
/* dev/replay/demo.js: the replay's --demo pseudonymiser.

   Unit tests use inputs built from numbers (this tree must stay free of
   real-looking addresses). The mirror test runs the pseudonymiser over the
   private mirror when it is present ($VANTAGE_MIRROR or ../vantage-mirror)
   and requires zero findings from check_private_addresses.js's detectors
   and zero recorded identifiers in everything the replay can serve. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { Pseudonymiser, v6text, AP_HOSTNAME } = require('../dev/replay/demo');
const checker = require('../security-tests/check_private_addresses');

const ROOT = path.join(__dirname, '..');
const MIRROR = process.env.VANTAGE_MIRROR || path.join(ROOT, '..', 'vantage-mirror');
const hasMirror = fs.existsSync(MIRROR) && fs.statSync(MIRROR).isDirectory();

/* private-looking values, assembled so the source file itself stays clean */
const ip = (...o) => o.join('.');
const mac = (...o) => o.map(x => x.toString(16).padStart(2, '0')).join(':');
const LAN = n => ip(192, 168, 7, n), MGMT = n => ip(10, 20, 30, n);
const UNI = mac(0xa4, 0x5e, 0x60, 0x11, 0x22, 0x33);       /* universal */
const LOC = mac(0x6e, 0x11, 0x22, 0x33, 0x44, 0x55);       /* locally administered */
const ULA = [ 'fd12', '3456', '789a' ].join(':');
const GUA = [ '2a01', '4f8', 'c0c' ].join(':');
const EUI = [ '6c11', '22ff', 'fe33', '4455' ].join(':');   /* EUI-64 of LOC */

test('demo: MACs map into the documentation ranges, keeping U/L and case', () => {
	const p = new Pseudonymiser();
	const a = p.text(UNI), b = p.text(LOC.toUpperCase()), m = p.text(mac(0x33, 0x33, 0, 0, 0, 1));
	assert.match(a, /^00:00:5e:00:53:[0-9a-f]{2}$/);
	assert.match(b, /^02:00:5E:00:53:[0-9A-F]{2}$/);
	assert.match(m, /^01:00:5e:90:10:[0-9a-f]{2}$/);
	assert.equal(p.text(UNI.toUpperCase()), a.toUpperCase(), 'same MAC, same demo MAC');
	assert.equal(p.text(UNI.replace(/:/g, '-')), a.replace(/:/g, '-'));
	/* bare form of a known MAC, e.g. a bridge id */
	assert.equal(p.text('7fff.' + UNI.replace(/:/g, '')), '7fff.' + a.replace(/:/g, ''));
	assert.equal(p.text('00:00:00:00:00:00'), '00:00:00:00:00:00');
	for (const out of [ a, b, m ]) assert.deepEqual(checker.findings(out, null), []);
});

test('demo: IPv4 keeps the /24 layout, IPv6 moves to 2001:db8::/32', () => {
	const p = new Pseudonymiser();
	assert.equal(p.text(LAN(69) + '/24 via ' + LAN(1)), '192.0.2.69/24 via 192.0.2.1');
	assert.equal(p.text(LAN(255)), '192.0.2.255');
	assert.equal(p.text(MGMT(0)), '198.51.100.0');
	assert.equal(p.text('255.255.255.0 0.0.0.0 127.0.0.1 198.51.100.7'), '255.255.255.0 0.0.0.0 127.0.0.1 198.51.100.7');
	assert.match(p.text(ip(8, 8, 4, 4)), /^203\.0\.113\.\d+$/);
	/* EUI-64 link-local -> short form; same identifier in a global address */
	const ll = p.text('fe80::' + EUI), gua = p.text(GUA + ':1:' + EUI);
	assert.match(ll, /^fe80::[0-9a-f]{1,4}$/);
	assert.equal(gua, '2001:db8:1:1::' + ll.slice(6));
	assert.equal(p.text(ULA + '::/48'), '2001:db8:fd01::/48');
	assert.equal(p.text('fe80::1 ::1 ff02::1'), 'fe80::1 ::1 ff02::1');
	assert.deepEqual(checker.findings(p.text([ LAN(5), MGMT(9), ll, gua, ULA + '::1' ].join(' ')), null), []);
	assert.equal(v6text([ 0x2001, 0xdb8, 0, 0, 1, 0, 0, 0 ]), '2001:db8:0:0:1::');
	assert.equal(v6text([ 0x2001, 0xdb8, 0, 0, 0, 0, 0, 1 ]), '2001:db8::1');
});

test('demo: names, SSIDs by band, WPS names, country, time zone, fingerprints', () => {
	const p = new Pseudonymiser();
	const wireless = {
		radio0: { '.type': 'wifi-device', band: '2g', country: 'NL' },
		radio1: { '.type': 'wifi-device', band: '6g', country: 'NL' },
		a: { '.type': 'wifi-iface', '.index': 2, device: 'radio0', ssid: 'Casa-Rossi' },
		b: { '.type': 'wifi-iface', '.index': 3, device: 'radio0', ssid: 'Casa-Rossi-Old' },
		c: { '.type': 'wifi-iface', '.index': 4, device: 'radio1', ssid: 'Casa-Rossi-Fast' }
	};
	p.ssids(wireless);
	const board = { hostname: 'rossi-attic-ap', model: 'Zyxel NWA50BE' };
	const clients = { [LOC]: { signature: 'wifi4|probe:0,1,wps:HP_ENVY_6000_series|assoc:0' } };
	for (const [ v, ctx ] of [ [ { values: wireless }, 'uci wireless' ], [ board, 'system board' ], [ clients, 'hostapd.x get_clients' ] ])
		p.learn(v, undefined, ctx);
	p.learn({ [UNI]: { name: 'marios-iphone', ipaddrs: [ LAN(20) ] } }, undefined, 'luci-rpc getHostHints');

	const w = p.value({ values: wireless }, undefined, 'uci wireless').values;
	assert.deepEqual([ w.a.ssid, w.b.ssid, w.c.ssid ], [ 'Harbor', 'Harbor-IoT', 'Harbor-6E' ]);
	assert.equal(w.radio0.country, 'US');
	const b = p.value(board, undefined, 'system board');
	assert.deepEqual(b, { hostname: AP_HOSTNAME, model: 'Zyxel NWA50BE' });
	const c = p.value(clients, undefined, 'hostapd.x get_clients');
	assert.match(Object.values(c)[0].signature, /wps:Office_printer\|/);
	assert.equal(p.text('HP ENVY 6000 series'), 'Office printer');
	const h = p.value({ [UNI]: { name: 'marios-iphone' } }, undefined, 'luci-rpc getHostHints');
	assert.equal(Object.values(h)[0].name, 'phone');
	assert.equal(p.text('uhttpd -r rossi-attic-ap -x /cgi-bin'), 'uhttpd -r vantage-ap -x /cgi-bin');
	assert.deepEqual(p.value({ zonename: 'Europe/Amsterdam', timezone: 'CET-1CEST' }), { zonename: 'UTC', timezone: 'UTC0' });
	const cl = p.value([ 0, { results: [ { code: 'NL', active: true }, { code: 'US', active: false } ] } ], undefined, 'iwinfo countrylist');
	assert.deepEqual(cl[1].results.map(r => r.active), [ false, true ]);
	assert.doesNotMatch(p.text('Pubkey auth succeeded with ssh-rsa key SHA256:wS0Au9q1Gy2x3EGWb4+ug5anU6OPLJk7L8vowZ9d0E1 from'), /wS0Au9q/);
	assert.deepEqual(p.value({ board: 'x', serial: 'S1234', sn: 'Q9' }), { board: 'x' });
});

test('demo: the pseudonymised mirror carries no real identifiers', { skip: !hasMirror && `no mirror at ${MIRROR}` }, () => {
	const { Store } = require('../dev/replay/store');
	const ids = checker.mirrorIdentifiers(MIRROR);
	assert.ok(ids.size > 0, 'mirror identifiers loaded');
	const store = new Store(MIRROR, { synthetic: true, demo: true });
	const p = store.demo;

	/* everything the replay can serve from the recording, one JSON value per
	   line like a file the checker scans */
	const chunks = new Set();
	const add = v => chunks.add(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
	for (const [ k, r ] of store.exact) { add(k.replace(/\0/g, ' ')); add(r); }
	for (const r of store.loose.values()) add(r);
	for (const [ k, rows ] of store.series) { add(k.replace(/\0/g, ' ')); for (const r of rows) add(r); }
	for (const [ u, b ] of store.http) { add(u); add(b); }
	for (const [ a, o ] of store.exec) { add(a); add(o); }
	add(store.uciCommitted);
	add(store.menu());
	for (const radio of [ 'radio0', 'radio1' ]) { add(store.call('iwinfo', 'scan', { device: radio })); add(store.call('iwinfo', 'info', { device: radio })); }
	for (const mode of [ 'load', 'conntrack' ]) add(store.call('luci', 'getRealtimeStats', { mode }));
	add(store.call('luci', 'getConntrackList', {}));
	const text = [ ...chunks ].join('\n');

	/* 1. the address/MAC detectors and the recorded identifiers */
	const found = checker.findings(text, ids);
	assert.deepEqual(found.slice(0, 5).map(f => f[1]), [], `${found.length} finding(s) in the demo output`);

	/* 2. none of the originals the pseudonymiser replaced */
	const lower = text.toLowerCase();
	const leaks = [];
	for (const real of p.names.keys()) if (new RegExp('(?<![a-z0-9])' + real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![a-z0-9])').test(lower)) leaks.push('name ' + real.length + ' chars');
	for (const [ real, demo ] of p.macs) if (real !== demo && (lower.includes(real.match(/../g).join(':')) || lower.includes(real))) leaks.push('MAC');
	for (const real of p.v4other.keys()) if (new RegExp('(?<![\\d.])' + real.replace(/\./g, '\\.') + '(?![\\d]|\\.\\d)').test(text)) leaks.push('IPv4');
	for (const c of p.countries) if (text.includes(`"country":"${c}"`)) leaks.push('country');
	assert.deepEqual(leaks, []);

	/* 3. the demo data is what the screenshots expect */
	const board = store.data('system', 'board', {});
	assert.equal(board.hostname, AP_HOSTNAME);
	assert.match(JSON.stringify(store.data('network.wireless', 'status', {})), /"ssid":"Harbor"/);
});
