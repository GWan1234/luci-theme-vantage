'use strict';
/* dev/replay/store.js: the uci overlay cannot reach Object.prototype and
   refuses names libuci refuses; plugins answer their objects; log text is
   kept free of control characters. Uses a small synthetic mirror. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store, safe } = require('../dev/replay/store');

function mirror() {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-store-test-'));
	fs.mkdirSync(path.join(dir, 'browser-2026-01-01T00-00-00-000Z'));
	const rows = [
		{ at: 1, object: 'uci', method: 'get', args: { config: 'network' }, result: [ 0, { values: {
			lan: { '.anonymous': false, '.type': 'interface', '.name': 'lan', '.index': 0, proto: 'static' } } } ] },
		{ at: 2, object: 'system', method: 'board', args: {}, result: [ 0, { hostname: 'ap', model: 'Demo' } ] }
	];
	fs.writeFileSync(path.join(dir, 'browser-2026-01-01T00-00-00-000Z', 'rpc.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
	return dir;
}

test('store: uci overlay is prototype-safe and validates names like libuci', () => {
	const s = new Store(mirror(), { synthetic: false });
	const INVAL = { result: [ 2 ] };
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: '__proto__', values: { zz: 'x' } }), INVAL);
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: 'constructor', values: { zz: 'x' } }), INVAL);
	assert.deepEqual(s.call('uci', 'add', { config: '__proto__', type: 'x' }), INVAL);
	assert.deepEqual(s.call('uci', 'add', { config: 'network', type: 'x', name: 'prototype' }), INVAL);
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: 'lan', values: JSON.parse('{"__proto__":{"polluted":1}}') }), INVAL);
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: 'lan', values: { 'a.b': '1' } }), INVAL);
	assert.deepEqual(s.call('uci', 'delete', { config: 'network', section: 'lan', options: [ '__proto__' ] }), INVAL);
	assert.deepEqual(s.call('uci', 'rename', { config: 'network', section: 'lan', name: '__rt' }).result, [ 0 ], '__rt is a valid uci name');
	assert.deepEqual(s.call('uci', 'rename', { config: 'network', section: '__rt', name: 'lan' }).result, [ 0 ]);
	/* inherited names are not sections or options */
	assert.deepEqual(s.call('uci', 'get', { config: 'network', section: 'toString' }), { result: [ 4 ] });
	assert.deepEqual(s.call('uci', 'get', { config: 'network', section: 'lan', option: 'hasOwnProperty' }), { result: [ 4 ] });
	assert.deepEqual(s.call('uci', 'get', { config: 'toString' }).result, [ 4 ]);
	assert.equal(s.uciGet('network', 'lan', 'constructor'), null);
	assert.equal(({}).zz, undefined);
	assert.equal(({}).polluted, undefined);
	/* ordinary use still works */
	const add = s.call('uci', 'add', { config: 'network', type: 'route', values: { target: 'x' } });
	assert.equal(add.result[0], 0);
	assert.deepEqual(s.call('uci', 'set', { config: 'network', section: 'lan', values: { mtu: 1500, dns: [ 'a', 'b' ] } }), { result: [ 0 ] });
	assert.equal(s.call('uci', 'changes', { config: 'network' }).result[1].changes.length, 6);   /* 2 renames, add, 3 values */
	s.call('uci', 'commit', { config: 'network' });
	assert.equal(s.uciGet('network', 'lan', 'mtu'), '1500');
	assert.deepEqual(s.call('uci', 'get', { config: 'network', section: 'lan', option: 'dns' }), { result: [ 0, { value: [ 'a', 'b' ] } ] });
	assert.equal(s.uciSeed('__proto__', { x: {} }), false);
	assert.equal(s.uciSeed('extra', { main: { '.type': 'x', '.name': 'main', a: '1' } }), true);
	assert.equal(s.uciGet('extra', 'main', 'a'), '1');
});

test('store: plugins answer their objects and are listed', () => {
	const s = new Store(mirror(), { synthetic: false });
	const files = fs.readdirSync(path.join(__dirname, '../dev/replay')).filter(f => /-plugin\.js$/.test(f));
	for (const f of files) {
		const mod = require(path.join(__dirname, '../dev/replay', f));
		for (const o of Array.isArray(mod.OBJECTS) ? mod.OBJECTS : [ mod.OBJECT ]) {
			assert.ok(s.plugins.has(o), o);
			assert.ok(s.list().includes(o), o + ' listed');
		}
	}
	assert.equal(new Store(mirror(), { synthetic: false, plugins: false }).plugins.size, 0);
});

test('store: request-derived log text has no control characters', () => {
	assert.equal(safe('a\u001b]0;x\u0007b\n\u009b31m\u007f'), 'a\\x1b]0;x\\x07b\\x0a\\x9b31m\\x7f');
	const s = new Store(mirror(), { synthetic: false });
	const lines = [];
	const orig = console.error;
	console.error = (...a) => lines.push(a.join(' '));
	try { s.call('o\u001b]52;c;Y3VybA==\u0007', 'm\n[replay] apply (checked): FORGED', {}); }
	finally { console.error = orig; }
	assert.equal(lines.length, 1);
	assert.doesNotMatch(lines[0], /[\x00-\x1f\x7f-\x9f]/);
});
