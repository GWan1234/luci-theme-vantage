#!/usr/bin/env node
'use strict';
/*
 * luci-app-vantage rpcd ACL policy.
 *
 *   node security-tests/test_acl_policy.js     (or node --test ...)
 *
 * The ACL is least privilege and in step with the shipped JavaScript:
 *
 * - exactly three groups: `luci-app-vantage` (read-only),
 *   `luci-app-vantage-rdns` (optional: network.rrdns lookup, which lets
 *   the holder point the device's DNS queries at any server and port) and
 *   `luci-app-vantage-names` (station aliases through the app's own rpcd
 *   plugin method luci.vantage set_alias);
 * - the read group grants exactly the allowlisted ubus methods below, no
 *   write section, no `*` object or method, no method glob; the one object
 *   glob is `hostapd.*`, because hostapd's ubus objects are named per
 *   interface (hostapd.phy0-ap0, ...), and it carries two read methods;
 * - Wi-Fi configuration comes from luci.vantage wireless (no keys):
 *   luci-rpc getWirelessDevices and network.wireless are granted nowhere;
 * - `file` is limited to the `read` method on /proc/stat: no exec, write,
 *   remove, list or stat, no cgi-io;
 * - uci is readable for `vantage` only and writable by nobody: no uci
 *   add/set/delete/commit/... method and no `uci` write list in any group;
 *   the only grant beyond reads is luci.vantage set_alias;
 * - the plugin (root/usr/share/rpcd/ucode/luci.vantage) registers exactly
 *   the luci.vantage methods the ACL grants, opens config `vantage` only,
 *   and imports nothing but uci and ubus (no fs, no process execution);
 * - every rpc.declare({ object, method }) in the app's JavaScript is
 *   granted, and every grant is used by a declare (no stale privilege);
 *   `session access` is the only call left to the platform (rpcd grants it
 *   to every session through its `unauthenticated` group);
 * - calls on uci objects name the `vantage` config literally; file.read
 *   calls name a granted path literally; no `fs` module, no fs.exec;
 * - the view probes exactly the names group (write) and the rdns group
 *   (read);
 * - the menu entry is gated by the read group.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

/* VANTAGE_APP_PKG: check another copy of the package (mutation tests) */
const PKG = path.resolve(process.env.VANTAGE_APP_PKG || path.join(__dirname, '..', 'luci-app-vantage'));
const HTDOCS = path.join(PKG, 'htdocs');
const ACL_FILE = path.join(PKG, 'root/usr/share/rpcd/acl.d/luci-app-vantage.json');
const MENU_FILE = path.join(PKG, 'root/usr/share/luci/menu.d/luci-app-vantage.json');
const PLUGIN_FILE = path.join(PKG, 'root/usr/share/rpcd/ucode/luci.vantage');

const READ_GROUP = 'luci-app-vantage';
const RDNS_GROUP = 'luci-app-vantage-rdns';
const WRITE_GROUP = 'luci-app-vantage-names';
const PLUGIN_OBJECT = 'luci.vantage';

/* the complete read allowlist: object -> methods */
const READ_UBUS = {
	'file': [ 'read' ],
	'system': [ 'board', 'info' ],
	'network.interface': [ 'dump' ],
	'network.device': [ 'status' ],
	'luci-rpc': [ 'getHostHints' ],
	'luci.vantage': [ 'wireless' ],
	'iwinfo': [ 'assoclist', 'info' ],
	'hostapd.*': [ 'get_clients', 'get_status' ],
	'umdns': [ 'hosts' ],
	'uci': [ 'get' ]
};
const READ_FILES = { '/proc/stat': [ 'read' ] };
const RDNS_UBUS = { 'network.rrdns': [ 'lookup' ] };
const WRITE_UBUS = { 'luci.vantage': [ 'set_alias' ] };
const OBJECT_GLOBS = new Set([ 'hostapd.*' ]);
const UCI_WRITE = /^(add|set|delete|commit|rename|order|apply|confirm|rollback|revert|changes)$/;
/* calls the platform grants to every session (rpcd acl.d/unauthenticated.json) */
const PLATFORM = new Set([ 'session access' ]);

const acl = JSON.parse(fs.readFileSync(ACL_FILE, 'utf8'));
const menu = JSON.parse(fs.readFileSync(MENU_FILE, 'utf8'));
const plugin = fs.readFileSync(PLUGIN_FILE, 'utf8');

function jsFiles(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) jsFiles(p, out);
		else if (e.name.endsWith('.js')) out.push(p);
	}
	return out.sort();
}
const sources = jsFiles(HTDOCS).map(f => ({ file: path.relative(PKG, f), text: fs.readFileSync(f, 'utf8') }));

function sorted(o) {
	const out = {};
	for (const k of Object.keys(o).sort()) out[k] = [ ...o[k] ].sort();
	return out;
}

function pairs(ubus) {
	const out = new Set();
	for (const [ obj, methods ] of Object.entries(ubus || {})) for (const m of methods) out.add(obj + ' ' + m);
	return out;
}

/* What the JavaScript calls. Literal declares: `var X = rpc.declare({
   object: 'o', method: 'm', ... })`. The one dynamic declare is the
   hostapd helper (object 'hostapd.' + ifname), whose methods are the
   literal second arguments of hostapd(ifname, 'method') calls. */
function analyse() {
	const declared = new Map();          /* 'obj method' -> [file] */
	const vars = new Map();              /* callVar -> { obj, method } */
	const problems = [];
	const DECL = /(?:var|let|const)\s+(\w+)\s*=\s*rpc\.declare\(\{\s*object:\s*'([^']+)',\s*method:\s*'([^']+)'/g;
	for (const { file, text } of sources) {
		const total = (text.match(/rpc\.declare\(/g) || []).length;
		let literal = 0, dynamic = 0;
		for (const m of text.matchAll(DECL)) {
			literal++;
			vars.set(m[1], { obj: m[2], method: m[3] });
			const k = m[2] + ' ' + m[3];
			declared.set(k, (declared.get(k) || []).concat(file));
		}
		/* the hostapd helper: object built from a validated prefix */
		const helper = /function hostapd\((\w+), (\w+)\) \{\s*var obj = 'hostapd\.' \+ \1,[^\n]*\n\s*if \(!HOSTAPD_OBJ\.test\(obj\)\) return[^\n]*\n\s*if \(!hostapdCalls\[key\]\) hostapdCalls\[key\] = rpc\.declare\(\{ object: obj, method: \2,/;
		if (helper.test(text)) {
			dynamic++;
			for (const m of text.matchAll(/\bhostapd\(\w+, '([A-Za-z_]+)'\)/g)) {
				const k = 'hostapd.* ' + m[1];
				declared.set(k, (declared.get(k) || []).concat(file));
			}
			for (const m of text.matchAll(/(?<!function )\bhostapd\(\w+, (?!')/g)) problems.push(`${file}: hostapd() with a non-literal method at ${m.index}`);
		}
		if (literal + dynamic !== total) problems.push(`${file}: ${total - literal - dynamic} rpc.declare() call(s) with a non-literal object or method`);
	}
	return { declared, vars, problems };
}

const { declared, vars, problems } = analyse();

test('exactly the three groups', () => {
	assert.deepEqual(Object.keys(acl).sort(), [ READ_GROUP, RDNS_GROUP, WRITE_GROUP ].sort());
});

test('read group: exactly the allowlisted read methods, nothing written', () => {
	const g = acl[READ_GROUP];
	assert.deepEqual(Object.keys(g).sort(), [ 'description', 'read' ]);
	assert.deepEqual(Object.keys(g.read).sort(), [ 'file', 'ubus', 'uci' ]);
	assert.deepEqual(sorted(g.read.ubus), sorted(READ_UBUS));
	assert.deepEqual(sorted(g.read.file), sorted(READ_FILES));
	assert.deepEqual(g.read.uci, [ 'vantage' ]);
});

test('no group can read Wi-Fi keys: wireless configuration only through luci.vantage wireless', () => {
	/* luci-rpc getWirelessDevices and network.wireless status return the
	   wifi-iface sections including key / SAE / RADIUS secrets */
	for (const [ name, g ] of Object.entries(acl)) for (const kind of [ 'read', 'write' ]) {
		const p = pairs((g[kind] || {}).ubus);
		assert.ok(!p.has('luci-rpc getWirelessDevices'), `${name}.${kind}: luci-rpc getWirelessDevices`);
		assert.ok(![ ...p ].some(k => /^network\.wireless /.test(k)), `${name}.${kind}: network.wireless`);
		assert.ok(!((g[kind] || {}).uci || []).includes('wireless'), `${name}.${kind}: uci wireless`);
	}
	assert.doesNotMatch(acl[READ_GROUP].description, /Wi-Fi keys/, 'the description no longer needs the warning');
});

test('rdns group: network.rrdns lookup only, described honestly', () => {
	const g = acl[RDNS_GROUP];
	assert.deepEqual(Object.keys(g).sort(), [ 'description', 'read' ]);
	assert.deepEqual(g.read, { ubus: RDNS_UBUS });
	assert.match(g.description, /DNS/);
	assert.match(g.description, /any DNS server and port/);
});

test('names group: luci.vantage set_alias, uci read on vantage, no uci write', () => {
	const g = acl[WRITE_GROUP];
	assert.deepEqual(Object.keys(g).sort(), [ 'description', 'read', 'write' ]);
	assert.deepEqual(g.read, { ubus: { uci: [ 'get' ] }, uci: [ 'vantage' ] });
	assert.deepEqual(g.write, { ubus: WRITE_UBUS });
});

test('no uci write grant anywhere; the only non-read grant is the plugin\'s set_alias', () => {
	const extra = [];
	for (const [ name, g ] of Object.entries(acl)) {
		for (const kind of [ 'read', 'write' ]) {
			const sec = g[kind] || {};
			for (const k of pairs(sec.ubus)) {
				const [ obj, m ] = k.split(' ');
				assert.ok(!(obj === 'uci' && UCI_WRITE.test(m)), `${name}.${kind}: uci ${m}`);
				if (!pairs(READ_UBUS).has(k) && !pairs(RDNS_UBUS).has(k)) extra.push(k);
			}
			if (kind === 'write') assert.equal(sec.uci, undefined, `${name}: uci write list`);
			if (kind === 'write') assert.equal(sec.file, undefined, `${name}: file write list`);
		}
	}
	assert.deepEqual(extra, [ 'luci.vantage set_alias' ]);
});

test('the plugin registers exactly the granted luci.vantage methods and touches config vantage only', () => {
	/* ubus object and methods (the file's last statement and its methods table) */
	assert.match(plugin, /^return \{ 'luci\.vantage': methods \};\s*$/m);
	const table = /^const methods = \{\n([\s\S]*?)\n\};$/m.exec(plugin);
	assert.ok(table, 'methods table');
	const methods = [ ...table[1].matchAll(/^\t([A-Za-z_]+): \{$/gm) ].map(m => m[1]).sort();
	const granted = new Set();
	for (const g of Object.values(acl)) for (const kind of [ 'read', 'write' ])
		for (const m of ((g[kind] || {}).ubus || {})[PLUGIN_OBJECT] || []) granted.add(m);
	assert.deepEqual(methods, [ ...granted ].sort());
	assert.deepEqual(methods, [ 'set_alias', 'wireless' ]);
	assert.ok(pairs(acl[READ_GROUP].read.ubus).has(PLUGIN_OBJECT + ' wireless'));
	assert.ok(pairs(acl[WRITE_GROUP].write.ubus).has(PLUGIN_OBJECT + ' set_alias'));

	/* imports: uci and ubus, nothing that reaches files or processes */
	const imports = [ ...plugin.matchAll(/^import .* from '([^']+)';$/gm) ].map(m => m[1]).sort();
	assert.deepEqual(imports, [ 'ubus', 'uci' ]);
	assert.doesNotMatch(plugin, /\b(system|popen|exec|require|loadfile|loadstring|include|render|writefile|unlink)\s*\(/);

	/* uci: every cursor call names CONFIG, and CONFIG is 'vantage' */
	assert.match(plugin, /^const CONFIG = 'vantage';$/m);
	const calls = [ ...plugin.matchAll(/\buci\.(\w+)\(([^,)]*)/g) ];
	assert.ok(calls.length >= 5, 'found the uci calls');
	for (const m of calls) assert.equal(m[2], 'CONFIG', `uci.${m[1]}(${m[2]})`);
	/* the only ubus call is network.wireless status */
	const ubus = [ ...plugin.matchAll(/\.call\('([^']+)', '([^']+)'/g) ].map(m => m[1] + ' ' + m[2]);
	assert.deepEqual(ubus, [ 'network.wireless status' ]);
});

test('no wildcards except the hostapd object glob; no method globs', () => {
	const GLOB = /[*?[\]]/;
	for (const [ name, g ] of Object.entries(acl)) for (const kind of [ 'read', 'write' ]) {
		const sec = g[kind];
		if (!sec) continue;
		for (const [ obj, methods ] of Object.entries(sec.ubus || {})) {
			assert.ok(!GLOB.test(obj) || OBJECT_GLOBS.has(obj), `${name}.${kind}: ubus object glob ${obj}`);
			assert.ok(Array.isArray(methods) && methods.length, `${name}.${kind}: ${obj} has no method list`);
			for (const m of methods) assert.ok(/^[A-Za-z_][A-Za-z0-9_]*$/.test(m), `${name}.${kind}: ${obj} method ${m}`);
		}
		for (const c of sec.uci || []) assert.ok(/^[a-z0-9_-]+$/.test(c), `${name}.${kind}: uci ${c}`);
		for (const p of Object.keys(sec.file || {})) assert.ok(!GLOB.test(p), `${name}.${kind}: file glob ${p}`);
	}
});

test('no file exec/write/remove, no cgi-io, no foreign sections', () => {
	for (const [ name, g ] of Object.entries(acl)) for (const kind of [ 'read', 'write' ]) {
		const sec = g[kind];
		if (!sec) continue;
		for (const k of Object.keys(sec)) assert.ok([ 'ubus', 'uci', 'file' ].includes(k), `${name}.${kind}: ${k}`);
		for (const m of (sec.ubus || {}).file || []) assert.equal(m, 'read', `${name}.${kind}: ubus file.${m}`);
		for (const [ p, ops ] of Object.entries(sec.file || {})) {
			assert.equal(kind, 'read', `${name}: file ${p} under ${kind}`);
			assert.deepEqual(ops, [ 'read' ], `${name}: file ${p}`);
		}
	}
	assert.doesNotMatch(JSON.stringify(acl), /"(exec|cgi-io|remove|upload)"/);
});

test('the JavaScript is analysable', () => {
	assert.deepEqual(problems, []);
	assert.ok(declared.size >= 10, 'found the declares');
});

test('every declared call is granted and every grant is used', () => {
	const granted = new Set([ ...pairs(acl[READ_GROUP].read.ubus), ...pairs(acl[RDNS_GROUP].read.ubus),
		...pairs(acl[WRITE_GROUP].read.ubus), ...pairs(acl[WRITE_GROUP].write.ubus) ]);
	const need = [ ...declared.keys() ].filter(k => !PLATFORM.has(k));
	assert.deepEqual(need.filter(k => !granted.has(k)).sort(), [], 'declared but not granted');
	assert.deepEqual([ ...granted ].filter(k => !declared.has(k)).sort(), [], 'granted but never declared');
	/* read grants are not write methods */
	for (const k of pairs(acl[READ_GROUP].read.ubus)) assert.ok(!/^uci (add|set|delete|commit|rename|order|apply|confirm|revert)$/.test(k), k);
});

test('uci calls name the vantage config; file.read names a granted path', () => {
	for (const { file, text } of sources) {
		for (const [ v, d ] of vars) {
			for (const m of text.matchAll(new RegExp('\\b' + v + '\\(([^,)]*)', 'g'))) {
				const arg = m[1].trim();
				if (d.obj === 'uci') assert.equal(arg, "'vantage'", `${file}: ${v}(${arg}) (uci ${d.method})`);
				if (d.obj === 'file') {
					assert.match(arg, /^'[^']+'$/, `${file}: ${v}(${arg}) with a non-literal path`);
					assert.ok(Object.prototype.hasOwnProperty.call(READ_FILES, arg.slice(1, -1)), `${file}: ${v}(${arg}) not granted`);
				}
			}
		}
		assert.doesNotMatch(text, /'require fs'|\bfs\.(exec|exec_direct|write|remove)\(/, `${file}: fs module`);
		assert.doesNotMatch(text, /\buci\.(load|set|add|remove|save|apply)\(/, `${file}: LuCI uci module`);
	}
});

test('the view probes the names and rdns groups; the menu is gated by the read group', () => {
	const view = sources.find(s => s.file.endsWith('view/vantage/overview.js')).text;
	const probes = [ ...view.matchAll(/callAccess\('access-group', '([^']+)', '(\w+)'\)/g) ].map(m => m[1] + ' ' + m[2]);
	assert.deepEqual(probes, [ WRITE_GROUP + ' write', RDNS_GROUP + ' read' ]);
	assert.deepEqual(Object.keys(menu), [ 'admin/dashboard' ]);
	assert.deepEqual(menu['admin/dashboard'].depends.acl, [ READ_GROUP ]);
});
