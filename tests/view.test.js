'use strict';
/* Pieces of the dashboard view (view/vantage/overview.js) that take input
   from outside the device replies: the URL hash (deep links) and the
   history kept in sessionStorage. The view is loaded with stub LuCI
   modules; only the methods under test run. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { load, RES } = require('./luci-stub');

const REPLIES = {};

function loadView() {
	const src = fs.readFileSync(path.join(RES, 'view/vantage/overview.js'), 'utf8');
	const stubs = {
		view: { extend: p => p },
		/* replies come from REPLIES['object method'](...args) when set */
		rpc: { declare: o => function(...args) { const f = REPLIES[o.object + ' ' + o.method]; return f ? f(...args) : Promise.resolve(null); } },
		poll: {}, ui: {}, dom: {}
	};
	const params = [], values = [];
	for (const m of src.matchAll(/^'require ([\w.-]+)(?: as (\w+))?';$/gm)) {
		params.push(m[2] || m[1]);
		values.push(Object.prototype.hasOwnProperty.call(stubs, m[1]) ? stubs[m[1]] : load(m[1]));
	}
	return new Function(...params, src)(...values);
}

const view = loadView();

function withLocation(hash, fn) {
	const cleared = [];
	const saved = { location: global.location, history: global.history };
	global.location = { hash, pathname: '/cgi-bin/luci/admin/dashboard', search: '' };
	global.history = { replaceState: (s, t, url) => cleared.push(url) };
	try { return fn(cleared); }
	finally { global.location = saved.location; global.history = saved.history; }
}

function openFor(hash) {
	const self = Object.create(view);
	self.m = { radios: [ { id: 'radio0' }, { id: 'radio1' } ] };
	self.opened = [];
	self.openDrawer = function(kind, id) { this.opened.push([ kind, id ]); };
	return withLocation(hash, cleared => {
		self.openFromHash();
		return { opened: self.opened, cleared };
	});
}

test('deep links: a station MAC or a known radio opens its drawer', () => {
	assert.deepEqual(openFor('#client=00-00-5E-00-53-21').opened, [ [ 'client', '00:00:5e:00:53:21' ] ]);
	assert.deepEqual(openFor('#client=00%3A00%3A5e%3A00%3A53%3A21').opened, [ [ 'client', '00:00:5e:00:53:21' ] ]);
	assert.deepEqual(openFor('#radio=radio1').opened, [ [ 'radio', 'radio1' ] ]);
	assert.deepEqual(openFor('#uplink=anything').opened, [ [ 'uplink', 'uplink' ] ], 'uplink takes no id');
	assert.deepEqual(openFor('#device=%3Cb%3E').opened, [ [ 'device', 'device' ] ], 'device takes no id');
});

test('deep links: arbitrary text, unknown radios and bad escapes are dropped, not shown', () => {
	const lure = '#radio=URGENT%3A%20firmware%20compromised%20-%20re-enter%20password%20at%20http%3A%2F%2Fevil.example';
	for (const hash of [ lure, '#client=URGENT%3A%20call%20support', '#radio=radio9', '#client=%E0%A4%A', '#radio=%E2%80%AEevil',
		'#client=01-00-5E-00-53-21x', '#client=' + 'a'.repeat(300) ]) {
		let r;
		assert.doesNotThrow(() => { r = openFor(hash); }, hash);
		assert.deepEqual(r.opened, [], hash);
		assert.deepEqual(r.cleared, [ '/cgi-bin/luci/admin/dashboard' ], `${hash}: cleared from the address bar`);
	}
	/* hashes that are not deep links are left alone */
	for (const hash of [ '', '#', '#tab=wifi' ]) assert.deepEqual(openFor(hash), { opened: [], cleared: [] }, hash);
});

test('stored history: keys from sessionStorage cannot replace a prototype', () => {
	const stored = JSON.stringify({ net: JSON.parse('{"__proto__":[[1,2,3]],"constructor":[[1,2,3]],"radio0":[[1,2,3]]}'), clients: {} });
	const saved = global.window;
	global.window = {
		sessionStorage: { getItem: () => stored, setItem() {} },
		localStorage: { getItem: () => null, setItem() {} }
	};
	try {
		const self = Object.create(view);
		self.initState({ board: {}, canWrite: false, canRdns: false, mdns: null });
		const net = self.st.hist.net;
		assert.equal(Object.getPrototypeOf(net), null);
		assert.ok(Object.prototype.hasOwnProperty.call(net, '__proto__'), 'kept as an ordinary key');
		assert.equal(typeof net.map, 'undefined', 'no Array methods through the prototype');
		assert.equal(self.st.rdnsOff, true, 'reverse DNS off without its group');
		for (const k of [ 'devRates', 'staRates', 'radioRates', 'ssidRates', 'isNew' ])
			assert.equal(Object.getPrototypeOf(self.st[k]), null, k);
	} finally {
		global.window = saved;
	}
});

test('saving a name: set_alias with the normalised MAC, names reloaded after every outcome', async () => {
	const calls = [];
	const self = Object.create(view);
	self.aliases = Object.create(null);
	let reloads = 0;
	self.loadAliases = () => { reloads++; return Promise.resolve({}); };
	const outcomes = [
		[ () => Promise.resolve({ ok: true, op: 'add', mac: '00:00:5e:00:53:21' }), true ],
		[ () => Promise.resolve({ ok: false, error: 'too-many' }), 'This device already stores 512 names; remove some first.' ],
		[ () => Promise.resolve({ ok: false, error: 'failed' }), 'The device could not write /etc/config/vantage.' ],
		[ () => Promise.resolve(6), false ],
		[ () => Promise.reject(new Error('RPCError')), false ]
	];
	for (const [ reply, want ] of outcomes) {
		REPLIES['luci.vantage set_alias'] = (...a) => { calls.push(a); return reply(); };
		const before = reloads;
		assert.deepEqual(await self.saveAlias('00-00-5E-00-53-21', 'TV', 'tv'), want);
		assert.equal(reloads, before + 1, 'aliases reloaded');
	}
	assert.deepEqual(calls[0], [ '00:00:5e:00:53:21', 'TV', 'tv' ]);
	/* removing a name, and an unknown icon: sent as empty strings */
	REPLIES['luci.vantage set_alias'] = (...a) => { calls.push(a); return Promise.resolve({ ok: true }); };
	await self.saveAlias('00:00:5e:00:53:21', 'TV', 'rocket');
	await self.saveAlias('00:00:5e:00:53:21', '', 'tv');
	assert.deepEqual(calls.slice(-2), [ [ '00:00:5e:00:53:21', 'TV', '' ], [ '00:00:5e:00:53:21', '', '' ] ]);
	/* refused before any call */
	const n = calls.length;
	assert.equal(typeof await self.saveAlias('01:00:5e:00:53:21', 'TV', null), 'string');
	assert.equal(typeof await self.saveAlias('00:00:5e:00:53:21', 'a\u202eb', null), 'string');
	assert.equal(calls.length, n);
	delete REPLIES['luci.vantage set_alias'];
});
