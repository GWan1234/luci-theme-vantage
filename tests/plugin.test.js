'use strict';
/* luci-app-vantage's rpcd ucode plugin (root/usr/share/rpcd/ucode/luci.vantage)
   and its replay stand-in (dev/replay/vantage-plugin.js).

   The same cases run through
     - names.js (the view's own checks: validateAlias, normMac),
     - the replay stand-in, always,
     - the real plugin under a host ucode binary, when one is found
       ($UCODE, else `ucode` on PATH; skipped otherwise), with uci and ubus
       replaced by the doubles in tests/ucode/stubs and rpcd's argument
       check emulated by tests/ucode/harness.uc.
   The ucode and JavaScript results must be identical, so the device, the
   replay and the view agree on what a valid name is. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { load } = require('./luci-stub');
const shim = require('../dev/replay/vantage-plugin');

const names = load('vantage.names');
const ROOT = path.join(__dirname, '..');
const PLUGIN = path.join(ROOT, 'luci-app-vantage/root/usr/share/rpcd/ucode/luci.vantage');

/* ------------------------------------------------------------- ucode */

function findUcode() {
	const cands = [ process.env.UCODE ].concat((process.env.PATH || '').split(path.delimiter).map(d => d && path.join(d, 'ucode')));
	for (const c of cands) {
		if (!c) continue;
		try { fs.accessSync(c, fs.constants.X_OK); return c; } catch (e) {}
	}
	return null;
}
const UCODE = findUcode();
const NO_UCODE = UCODE ? false : 'no ucode binary (set UCODE=/path/to/ucode, e.g. an OpenWrt build\'s staging_dir/hostpkg/bin/ucode)';

/* run cases through the real plugin: [ { status, reply, sections } ] */
function runUcode(cases) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-plugin-'));
	const file = path.join(dir, 'cases.json');
	try {
		fs.writeFileSync(file, JSON.stringify(cases));
		const args = [ '-L', path.join(__dirname, 'ucode/stubs') ];
		const lib = path.join(path.dirname(UCODE), '../lib/ucode');
		if (fs.existsSync(lib)) args.push('-L', lib);
		args.push('-D', 'PLUGIN=' + PLUGIN, '-D', 'CASES=' + file, path.join(__dirname, 'ucode/harness.uc'));
		const r = spawnSync(UCODE, args, { encoding: 'utf8' });
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(r.stdout);
	} finally {
		fs.unlinkSync(file);
		fs.rmdirSync(dir);
	}
}

/* the same cases through the stand-in, with a cursor that behaves like
   the ucode test double (section ids cfg000001, cfg000002, ...) */
function runShim(cases) {
	return cases.map(c => {
		const orig = JSON.parse(JSON.stringify(c.sections || []));
		let sections = JSON.parse(JSON.stringify(orig)), seq = 0, committed = false;
		const find = sid => sections.find(s => s['.name'] === sid);
		const cursor = {
			sections: () => sections.map(s => Object.assign({}, s)),
			add: type => { const sid = 'cfg' + (++seq).toString(16).padStart(6, '0'); sections.push({ '.name': sid, '.type': type, '.anonymous': true }); return sid; },
			set: (sid, opt, v) => { const s = find(sid); if (s) s[opt] = v; },
			del: (sid, opt) => { if (opt != null) { const s = find(sid); if (s) delete s[opt]; } else sections = sections.filter(s => s['.name'] !== sid); },
			commit: () => { if (c.fail_commit) return false; committed = true; return true; }
		};
		if (!Object.prototype.hasOwnProperty.call(shim.POLICY, c.method)) return { status: 3, reply: null, sections: orig };
		if (!shim.argsOk(c.method, c.args)) return { status: 2, reply: null, sections: orig };
		const reply = c.method === 'wireless'
			? shim.reduceWireless((c.ubus || {})['network.wireless status'])
			: shim.setAlias(cursor, c.args || {});
		return { status: 0, reply, sections: committed ? sections : orig };
	});
}

/* ucode prints null object members; JSON.stringify keeps them too, but
   ucode has no undefined: normalise both through JSON */
const norm = v => JSON.parse(JSON.stringify(v));

/* -------------------------------------------------------------- cases */

const MAC = '00:00:5e:00:53:21';
const client = (sid, mac, name, icon) => Object.assign({ '.name': sid, '.type': 'client', '.anonymous': true, mac, name }, icon ? { icon } : {});

/* names: [ input, ok, value ] as validateAlias sees them */
const NAMES = [
	[ 'TV', true, 'TV' ],
	[ '  Hall   printer ', true, 'Hall printer' ],
	[ 'Hall\u00a0\u2003 printer', true, 'Hall printer' ],
	[ '', true, '' ],
	[ '   ', true, '' ],
	[ 'x'.repeat(48), true, 'x'.repeat(48) ],
	[ 'x'.repeat(49), false ],
	[ '\u{1F4FA}'.repeat(48), true, '\u{1F4FA}'.repeat(48) ],
	[ '\u{1F4FA}'.repeat(49), false ],
	[ ' '.repeat(40) + 'y'.repeat(48) + ' '.repeat(40), true, 'y'.repeat(48) ],
	[ ' '.repeat(300) + 'y' + ' '.repeat(100), false ],
	[ 'Café über 中文', true, 'Café über 中文' ],
	[ '<img src=x onerror=alert(1)>', true, '<img src=x onerror=alert(1)>' ],
	[ '\u{1F468}\u200d\u{1F4BB} desk', true, '\u{1F468}\u200d\u{1F4BB} desk' ],
	[ 'a\tb', false ], [ 'a\nb', false ], [ 'a\rb', false ], [ 'a\u001bb', false ], [ 'a\u007fb', false ],
	[ 'a\u0085b', false ], [ 'a\u009fb', false ], [ 'evil\u202etxt', false ], [ 'a\u200bb', false ],
	[ 'a\u200eb', false ], [ 'a\u2066b', false ], [ 'a\u2028b', false ], [ 'a\ufeffb', false ], [ 'a\u00adb', false ],
	[ 'a\u{E0041}b', false ], [ 'a\ufe00b', false ], [ 'a\u3164b', false ]
];

const MACS = [ '00:00:5E:00:53:21', '00-00-5e-00-53-21', '0000.5e00.5321', '00005E005321', ' 00:00:5e:00:53:21\t',
	'00:00:5e:00:53', '00:00:5e:00:53:21:00', '00:00:5e:00:53:2g', '00:00-5e:00:53:21', '00:00:5e:00:53:21\n; rm', '0:0:5e:0:53:21',
	'01:00:5e:00:53:21', 'ff:ff:ff:ff:ff:ff', '02:00:5E:00:53:0F', '' ];

const SECRETS = { key: 'SECRET-PSK-1', sae_password: 'SECRET-SAE-2', auth_secret: 'SECRET-RADIUS-3', acct_secret: 'SECRET-RADIUS-4',
	r0kh: [ '02:00:5e:00:53:01,nas,SECRET-R0KH-5' ], r1kh: [ '02:00:5e:00:53:01,02:00:5e:00:53:01,SECRET-R1KH-6' ],
	password: 'SECRET-EAP-7', identity: 'SECRET-ID-8', key1: 's:SECRET-WEP-9', priv_key_pwd: 'SECRET-10' };

const WIRELESS = {
	radio0: {
		up: true, pending: false, autostart: true, disabled: false, retry_setup_failed: false,
		config: { disabled: false, type: 'mac80211', channel: '6', band: '2g', htmode: 'EHT20', country: 'US', path: 'platform/soc@0/x', txpower: 20, channels: [ '1', '6' ] },
		interfaces: [
			{ section: 'default_radio0', ifname: 'phy2g-ap0', vlans: [], stations: [],
				config: Object.assign({ network: [ 'lan' ], device: 'radio0', mode: 'ap', ssid: 'Home', encryption: 'sae-mixed+ccmp', ieee80211w: 1, macaddr: '02:00:5E:00:53:A0', hidden: '1', ieee80211r: true }, SECRETS) },
			{ section: 'sta0', ifname: 'phy2g-sta0',
				config: Object.assign({ network: 'wwan', mode: 'sta', ssid: 'Upstream', encryption: 'wpa2+ccmp key=SECRET-11' }, SECRETS) },
			'junk'
		]
	},
	'bad name': { up: true },
	radio1: 'junk'
};

const BEHAVIOUR = [
	/* add, one section per MAC, icon handling */
	{ method: 'set_alias', args: { mac: '00-00-5E-00-53-21', name: '  TV  ', icon: 'tv' } },
	{ method: 'set_alias', args: { mac: MAC, name: 'TV' } },
	{ method: 'set_alias', args: { mac: MAC, name: 'TV', icon: '' } },
	{ method: 'set_alias', args: { mac: MAC, name: 'TV', icon: 'rocket' } },
	{ method: 'set_alias', sections: [ client('cfgold', MAC, 'Old', 'tv') ], args: { mac: MAC, name: 'New', icon: 'phone' } },
	{ method: 'set_alias', sections: [ client('cfgold', MAC, 'Old', 'tv') ], args: { mac: MAC, name: 'New', icon: '' } },
	/* duplicates from before (two tabs, the old raw uci writes): one survives */
	{ method: 'set_alias', sections: [ client('a', MAC, 'One'), client('b', '00-00-5E-00-53-21', 'Two'), client('c', '00:00:5e:00:53:22', 'Other') ], args: { mac: MAC, name: 'Only' } },
	{ method: 'set_alias', sections: [ client('a', MAC, 'One'), client('b', MAC.toUpperCase(), 'Two'), client('c', '00:00:5e:00:53:22', 'Other') ], args: { mac: MAC, name: '' } },
	{ method: 'set_alias', sections: [ client('c', '00:00:5e:00:53:22', 'Other') ], args: { mac: MAC, name: '' } },
	{ method: 'set_alias', args: { mac: MAC } },
	/* refusals */
	{ method: 'set_alias', args: { mac: '01:00:5e:00:53:21', name: 'Group' } },
	{ method: 'set_alias', args: { name: 'No MAC' } },
	{ method: 'set_alias', args: { mac: MAC, name: 'a\u202eb' } },
	{ method: 'set_alias', args: { mac: MAC, name: 'x'.repeat(49) } },
	{ method: 'set_alias', args: { mac: MAC, name: 'TV' }, fail_commit: true },
	/* rpcd's argument check */
	{ method: 'set_alias', args: { mac: MAC, name: 'TV', icon: 5 } },
	{ method: 'set_alias', args: { mac: MAC, name: [ 'TV' ] } },
	{ method: 'set_alias', args: { mac: MAC, name: 'TV', section: 'x' } },
	{ method: 'nope', args: {} },
	/* the cap: a new MAC is refused at 512 client sections, an existing one is updated */
	(() => { const s = []; for (let i = 0; i < 512; i++) s.push(client('s' + i, '02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), 'n' + i)); return { method: 'set_alias', sections: s, args: { mac: MAC, name: 'One too many' } }; })(),
	(() => { const s = []; for (let i = 0; i < 512; i++) s.push(client('s' + i, '02:00:5e:00:' + (i >> 8).toString(16).padStart(2, '0') + ':' + (i & 255).toString(16).padStart(2, '0'), 'n' + i)); return { method: 'set_alias', sections: s, args: { mac: '02:00:5e:00:00:07', name: 'Renamed' } }; })(),
	/* wireless */
	{ method: 'wireless', ubus: { 'network.wireless status': WIRELESS } },
	{ method: 'wireless', ubus: {} },
	{ method: 'wireless', args: { device: 'radio0' } }
];

const NAME_CASES = NAMES.map(([ n ]) => ({ method: 'set_alias', args: { mac: MAC, name: n } }));
const MAC_CASES = MACS.map(m => ({ method: 'set_alias', args: { mac: m, name: 'x' } }));
const ALL = BEHAVIOUR.concat(NAME_CASES, MAC_CASES);

/* -------------------------------------------------------------- tests */

test('names: the stand-in, names.js and the table agree', () => {
	for (const [ n, ok, value ] of NAMES) {
		const v = names.validateAlias(n), s = shim.validateName(n);
		assert.equal(v.ok, ok, 'names.js ' + JSON.stringify(n));
		assert.equal(s.ok, ok, 'stand-in ' + JSON.stringify(n));
		if (ok) { assert.equal(v.value, value); assert.equal(s.value, value); }
	}
	for (const n of [ 'a\ud800b', '\udc00', '\ud83d' ]) {
		assert.equal(names.validateAlias(n).ok, false);
		assert.equal(shim.validateName(n).ok, false, 'lone surrogate');
	}
});

test('MACs: the stand-in and names.js normalise alike; multicast is refused', () => {
	for (const m of MACS) {
		assert.equal(shim.normMac(m), names.normMac(m), JSON.stringify(m));
		const r = runShim([ { method: 'set_alias', args: { mac: m, name: 'x' } } ])[0].reply;
		const want = names.normMac(m) && !names.isMulticastMac(m) ? names.normMac(m) : null;
		assert.equal(r.ok ? r.mac : null, want, JSON.stringify(m));
	}
});

test('stand-in: set_alias keeps one section per MAC, caps at 512, refuses bad input', () => {
	const r = runShim(BEHAVIOUR);
	assert.deepEqual(r[0].reply, { ok: true, op: 'add', mac: MAC });
	assert.deepEqual(r[0].sections, [ client('cfg000001', MAC, 'TV', 'tv') ]);
	assert.deepEqual(r[3].reply, { ok: false, error: 'invalid-icon' });
	assert.deepEqual(r[4].sections, [ Object.assign(client('cfgold', MAC, 'New', 'phone')) ]);
	assert.deepEqual(r[5].sections, [ client('cfgold', MAC, 'New') ]);
	assert.deepEqual(r[6].reply, { ok: true, op: 'set', mac: MAC });
	assert.deepEqual(r[6].sections.map(s => [ s['.name'], s.mac, s.name ]), [ [ 'a', MAC, 'Only' ], [ 'c', '00:00:5e:00:53:22', 'Other' ] ]);
	assert.deepEqual(r[7].reply, { ok: true, op: 'delete', mac: MAC });
	assert.deepEqual(r[7].sections.map(s => s['.name']), [ 'c' ]);
	assert.deepEqual(r[8].reply, { ok: true, op: 'none', mac: MAC });
	assert.deepEqual(r[9].reply, { ok: true, op: 'none', mac: MAC }, 'no name removes');
	assert.deepEqual(r.slice(10, 14).map(x => x.reply.error), [ 'invalid-mac', 'invalid-mac', 'invalid-name', 'name-too-long' ]);
	assert.deepEqual(r[14].reply, { ok: false, error: 'failed' });
	assert.deepEqual(r[14].sections, [], 'nothing committed');
	assert.deepEqual(r.slice(15, 19).map(x => x.status), [ 2, 2, 2, 3 ]);
	assert.deepEqual(r[19].reply, { ok: false, error: 'too-many' });
	assert.equal(r[19].sections.length, 512);
	assert.deepEqual(r[20].reply, { ok: true, op: 'set', mac: '02:00:5e:00:00:07' });
	assert.equal(r[20].sections.length, 512);
	for (const x of r.slice(0, 21)) for (const s of x.sections) {
		assert.equal(s['.type'], 'client');
		assert.ok(names.validateAlias(s.name).ok, 'stored names pass validateAlias');
	}
});

test('stand-in: wireless keeps the fields the view reads and no secret', () => {
	const r = runShim(BEHAVIOUR)[21].reply;
	assert.deepEqual(Object.keys(r), [ 'radio0' ]);
	const text = JSON.stringify(r);
	for (const v of Object.values(SECRETS).flat()) assert.ok(!text.includes(v.replace(/^s:/, '')), 'secret value ' + v);
	assert.doesNotMatch(text, /SECRET/);
	for (const k of Object.keys(SECRETS)) assert.ok(!new RegExp('"' + k + '"').test(text), 'secret key ' + k);
	assert.deepEqual(r.radio0.config, { band: '2g', channel: '6', htmode: 'EHT20', country: 'US', txpower: 20, disabled: false });
	const [ ap, sta ] = r.radio0.interfaces;
	assert.equal(r.radio0.interfaces.length, 2);
	assert.deepEqual(ap, { ifname: 'phy2g-ap0', section: 'default_radio0', config: { ssid: 'Home', mode: 'ap', hidden: '1', encryption: 'sae-mixed+ccmp',
		ieee80211w: 1, ieee80211r: true, ieee80211k: null, ieee80211v: null, network: [ 'lan' ], macaddr: '02:00:5e:00:53:a0' } });
	assert.equal(sta.config.encryption, 'wpa2+ccmp', 'anything beyond the mode string is dropped');
	assert.deepEqual(sta.config.network, [ 'wwan' ]);
	assert.deepEqual(runShim(BEHAVIOUR)[22].reply, {});
});

test('the model accepts what wireless returns', () => {
	const model = load('vantage.model');
	const wifi = runShim([ BEHAVIOUR[21] ])[0].reply;
	const m = model.build({ wifi, iwinfo: { 'phy2g-ap0': { channel: 6, frequency: 2437, bssid: '02:00:5E:00:53:A0', ssid: 'Home' } } });
	assert.deepEqual(m.radios.map(r => [ r.id, r.band, r.channel, r.country ]), [ [ 'radio0', '2g', 6, 'US' ] ]);
	assert.deepEqual(m.ssids.map(s => [ s.ssid, s.bssid, s.security.short, s.hidden ]), [ [ 'Home', '02:00:5E:00:53:A0', 'WPA2/3', true ], [ 'Upstream', '', 'WPA2-Ent', false ] ]);
});

test('ucode plugin: same results as the stand-in for every case', { skip: NO_UCODE }, () => {
	const u = runUcode(ALL), s = runShim(ALL);
	assert.equal(u.length, ALL.length);
	for (let i = 0; i < ALL.length; i++)
		assert.deepEqual(norm(u[i]), norm(s[i]), `case ${i}: ${JSON.stringify(ALL[i]).slice(0, 160)}`);
});

test('ucode plugin: compiles as rpcd loads it', { skip: NO_UCODE }, () => {
	/* imports resolve against the test doubles; the device has the real modules */
	const r = spawnSync(UCODE, [ '-L', path.join(__dirname, 'ucode/stubs'), '-c', '-o', '/dev/null', PLUGIN ], { encoding: 'utf8' });
	assert.equal(r.status, 0, r.stderr);
});
