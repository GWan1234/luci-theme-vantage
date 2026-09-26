'use strict';
/* Recorded device data for the replay server.

   Loads every browser-* and ssh-* directory of a mirror (oldest first, so
   newer recordings win for identical keys) and answers ubus calls:
     1. uci.*          in-memory overlay seeded from recorded uci.get, so
                       Save/Apply visibly work for the session
     2. session.access always granted
     2b. synthetic     (unless opts.synthetic === false) generated replies
                       for what the device cannot provide: getRealtimeStats,
                       getConntrackList, iwinfo scan (see synthetic.js)
     3. ssh series     exact object/method/args: cycles through samples by
                       wall clock, so pollers see changing data
     4. browser rows   exact object/method/args
     5. loose match    same object/method, other args (not for file/uci,
                       whose args select the resource)
     6. dropped writes known state-changing calls answer success
     7. anything else  [ 4 ] (UBUS_STATUS_NOT_FOUND), logged once
   Nothing is ever forwarded: there is no upstream. */

const fs = require('fs');
const path = require('path');
const { Synthetic } = require('./synthetic');

const NOT_FOUND = 4;

/* state-changing calls a page may make on Save/Apply; answered with
   success and dropped */
const WRITES = {
	'file': [ 'write', 'remove' ],
	'luci': [ 'setInitAction', 'setLocaltime', 'setPassword' ],
	'rc': [ 'init' ],
	'system': [ 'reboot' ],
	'network': [ 'reload', 'restart' ],
	'network.interface': [ 'up', 'down', 'renew' ],
	'session': [ 'set', 'destroy' ]
};

/* stable key: sorted object keys, ubus_rpc_session ignored */
function canon(v) {
	if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
	if (v && typeof v === 'object')
		return '{' + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
	return JSON.stringify(v === undefined ? null : v);
}
function argsKey(args) {
	const a = Object.assign({}, args || {});
	delete a.ubus_rpc_session;
	return canon(a);
}

function readJsonl(file) {
	let text;
	try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return []; }
	const rows = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		try { rows.push(JSON.parse(line)); } catch (e) {}   /* tolerate a half-written last line */
	}
	return rows;
}

const clone = v => (v === undefined) ? undefined : JSON.parse(JSON.stringify(v));

class Store {
	constructor(mirror, opts) {
		this.opts = opts || {};
		this.exact = new Map();     /* obj\0method\0args -> { result } | { error } */
		this.loose = new Map();     /* obj\0method -> latest reply */
		this.series = new Map();    /* obj\0method\0args -> [ data, ... ] */
		this.seriesLoose = new Map();
		this.http = new Map();      /* url path -> body */
		this.exec = new Map();      /* argv json -> stdout */
		this.objects = new Map();   /* obj -> method -> { arg: type } (for `list`) */
		this.staticDirs = [];
		this.warned = new Set();
		this.interval = 5000;
		this.t0 = Date.now();
		this.load(mirror);
		this.uciInit();
		this.synthetic = (this.opts.synthetic === false) ? null : new Synthetic(this);
	}

	load(mirror) {
		const dirs = fs.readdirSync(mirror).filter(d => /^(browser|ssh)-/.test(d)).sort((a, b) => a.replace(/^\w+-/, '').localeCompare(b.replace(/^\w+-/, '')));
		const stamps = [];
		for (const d of dirs) {
			const dir = path.join(mirror, d);
			if (d.startsWith('browser-')) {
				for (const r of readJsonl(path.join(dir, 'rpc.jsonl')).sort((a, b) => (a.at || 0) - (b.at || 0))) {
					if (typeof r.object !== 'string' || typeof r.method !== 'string') continue;
					const reply = (r.result !== undefined) ? { result: r.result } : r.error ? { error: r.error } : null;
					if (!reply) continue;
					this.exact.set(`${r.object}\0${r.method}\0${argsKey(r.args)}`, reply);
					this.loose.set(`${r.object}\0${r.method}`, reply);
					this.note(r.object, r.method, r.args);
				}
				for (const r of readJsonl(path.join(dir, 'http.jsonl')).sort((a, b) => (a.at || 0) - (b.at || 0))) {
					if (typeof r.url !== 'string') continue;
					if (Array.isArray(r.argv)) this.exec.set(JSON.stringify(r.argv), String(r.body ?? ''));
					else this.http.set(r.url.replace(/[?#].*$/, ''), r.body);
				}
				if (fs.existsSync(path.join(dir, 'static'))) this.staticDirs.unshift(path.join(dir, 'static'));
			}
			else {
				const byKey = new Map();
				for (const r of readJsonl(path.join(dir, 'snapshots.jsonl'))) {
					if (typeof r.object !== 'string' || typeof r.method !== 'string' || r.error || r.result === undefined) continue;
					const key = `${r.object}\0${r.method}\0${argsKey(r.args)}`;
					if (!byKey.has(key)) byKey.set(key, []);
					byKey.get(key).push(r);
					if (r.at) stamps.push(r.at);
					this.note(r.object, r.method, r.args);
				}
				for (const [ key, rows ] of byKey) {
					rows.sort((a, b) => (a.at || 0) - (b.at || 0));
					this.series.set(key, rows.map(r => r.result));
					this.seriesLoose.set(key.split('\0', 2).join('\0'), key);
				}
			}
		}
		/* sample spacing: median gap between distinct snapshot times */
		const t = [ ...new Set(stamps) ].sort((a, b) => a - b);
		const gaps = t.slice(1).map((v, i) => v - t[i]).sort((a, b) => a - b);
		if (gaps.length) this.interval = Math.max(gaps[gaps.length >> 1], 1000);
	}

	note(object, method, args) {
		if (!this.objects.has(object)) this.objects.set(object, new Map());
		const m = this.objects.get(object);
		if (!m.has(method)) m.set(method, {});
		const sig = m.get(method);
		for (const [ k, v ] of Object.entries(args || {}))
			sig[k] = Array.isArray(v) ? 'array' : (v === null) ? 'unknown' : typeof v;
	}

	warn(kind, what) {
		const k = kind + ' ' + what;
		if (this.warned.has(k)) return;
		this.warned.add(k);
		console.error(`[replay] ${kind}: ${what}`);
	}

	/* current sample of a series; system.info keeps uptime/localtime moving
	   forward across wrap-arounds */
	sample(key) {
		const rows = this.series.get(key);
		const tick = Math.floor((Date.now() - this.t0) / this.interval);
		const data = clone(rows[tick % rows.length]);
		const lap = Math.floor(tick / rows.length);
		if (lap && key.startsWith('system\0info\0') && data) {
			const add = Math.round(lap * rows.length * this.interval / 1000);
			if (typeof data.uptime === 'number') data.uptime += add;
			if (typeof data.localtime === 'number') data.localtime += add;
		}
		return data;
	}

	/* JSON-RPC reply body for one ubus call: { result } or { error } */
	call(object, method, args) {
		args = (args && typeof args === 'object') ? args : {};
		const sig = `${object}.${method} ${argsKey(args)}`;
		if (object === 'uci') return this.uci(method, args);
		if (object === 'session' && method === 'access') return { result: [ 0, { access: true } ] };
		if (this.synthetic) {
			const syn = this.synthetic.call(object, method, args);
			if (syn) return syn;
		}

		const key = `${object}\0${method}\0${argsKey(args)}`;
		if (this.series.has(key)) return { result: [ 0, this.sample(key) ] };
		if (this.exact.has(key)) return clone(this.exact.get(key));

		if (object === 'file' && method === 'exec') {
			const argv = [ args.command ].concat(Array.isArray(args.params) ? args.params : []);
			const out = this.exec.get(JSON.stringify(argv));
			if (out != null) return { result: [ 0, { code: 0, stdout: out } ] };
			this.warn('unrecorded exec (answered NOT_FOUND)', JSON.stringify(argv));
			return { result: [ NOT_FOUND ] };
		}

		if (WRITES[object] && WRITES[object].includes(method)) {
			this.warn('write dropped (answered OK)', sig);
			return { result: [ 0 ] };
		}

		if (object !== 'file' && object !== 'uci') {
			const lk = `${object}\0${method}`;
			if (this.loose.has(lk)) { this.warn('approximate (args differ)', sig); return clone(this.loose.get(lk)); }
			if (this.seriesLoose.has(lk)) { this.warn('approximate (args differ)', sig); return { result: [ 0, this.sample(this.seriesLoose.get(lk)) ] }; }
		}

		this.warn('unknown call (answered NOT_FOUND)', sig);
		return { result: [ NOT_FOUND ] };
	}

	/* plain data for server-side template code (ubus.call in .ut files) */
	data(object, method, args) {
		const r = this.call(object, method, args);
		return (r.result && r.result[0] === 0) ? (r.result[1] ?? null) : null;
	}

	list(params) {
		if (!Array.isArray(params) || !params.length)
			return [ ...new Set([ ...this.objects.keys(), 'session', 'uci' ]) ].sort();
		const rv = {};
		for (const o of params) {
			const m = this.objects.get(o);
			if (!m) continue;
			rv[o] = {};
			for (const [ name, sig ] of m) rv[o][name] = Object.assign({}, sig);
		}
		return rv;
	}

	menu() { return clone(this.http.get('/cgi-bin/luci/admin/menu')); }

	translations(lang) {
		const body = this.http.get('/cgi-bin/luci/admin/translations/' + lang);
		return (typeof body === 'string') ? body : 'window.TR={};';
	}

	execText(argv) {
		const out = this.exec.get(JSON.stringify(argv));
		return (out == null) ? null : out;
	}

	/* ---------------------------------------------------------- uci overlay */

	uciInit() {
		this.uciCommitted = {};
		for (const [ key, reply ] of this.exact) {
			const [ obj, method, a ] = key.split('\0');
			if (obj !== 'uci' || method !== 'get') continue;
			const args = JSON.parse(a);
			if (Object.keys(args).length !== 1 || typeof args.config !== 'string') continue;
			const r = reply.result;
			if (Array.isArray(r) && r[0] === 0 && r[1] && r[1].values) this.uciCommitted[args.config] = r[1].values;
		}
		this.uciStaged = clone(this.uciCommitted);
		this.uciChanges = {};
	}

	/* a config a package ships (e.g. /etc/config/vantage) and the mirror
	   has not recorded: known from now on, so 'uci get' answers it */
	uciSeed(config, values) {
		if (this.uciCommitted[config] || !values || typeof values !== 'object') return false;
		this.uciCommitted[config] = clone(values);
		this.uciStaged[config] = clone(values);
		return true;
	}

	uciPending() {
		let n = 0;
		for (const c of Object.values(this.uciChanges)) n += c.length;
		return n;
	}

	uciChange(config, entry) {
		(this.uciChanges[config] = this.uciChanges[config] || []).push(entry);
	}

	uciCommit(config) {
		for (const c of config ? [ config ] : Object.keys(this.uciChanges)) {
			if (this.uciStaged[c]) this.uciCommitted[c] = clone(this.uciStaged[c]);
			delete this.uciChanges[c];
		}
	}

	uciRevert(config) {
		for (const c of config ? [ config ] : Object.keys(this.uciChanges)) {
			if (this.uciCommitted[c]) this.uciStaged[c] = clone(this.uciCommitted[c]);
			delete this.uciChanges[c];
		}
	}

	/* committed values, for server-side templates */
	uciGet(config, section, option) {
		const c = this.uciCommitted[config];
		if (!c) return null;
		if (section == null) return c;
		const s = c[section] || Object.values(c).find(x => x['.name'] === section);
		if (!s) return null;
		return (option == null) ? s : (s[option] ?? null);
	}

	uci(method, a) {
		const ok = data => ({ result: data === undefined ? [ 0 ] : [ 0, data ] });
		const nf = () => ({ result: [ NOT_FOUND ] });
		const conf = this.uciStaged[a.config];

		switch (method) {
		case 'configs':
			return ok({ configs: Object.keys(this.uciStaged).sort() });

		case 'get':
		case 'state': {
			if (!conf) {
				const rec = this.exact.get(`uci\0get\0${argsKey(a)}`);
				if (rec) return clone(rec);
				this.warn('unknown call (answered NOT_FOUND)', `uci.${method} ${argsKey(a)}`);
				return nf();
			}
			if (a.section != null) {
				const s = conf[a.section];
				if (!s) return nf();
				if (a.option != null) return (s[a.option] === undefined) ? nf() : ok({ value: clone(s[a.option]) });
				return ok({ values: clone(s) });
			}
			const values = {};
			for (const [ sid, s ] of Object.entries(conf))
				if (a.type == null || s['.type'] === a.type) values[sid] = clone(s);
			return ok({ values });
		}

		case 'changes':
			if (a.config != null) return ok({ changes: clone(this.uciChanges[a.config] || []) });
			return ok({ changes: clone(this.uciChanges) });

		case 'add': {
			if (!conf || typeof a.type !== 'string') return nf();
			let sid = a.name;
			if (typeof sid !== 'string' || !sid) {
				do sid = 'cfg' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
				while (conf[sid]);
			}
			conf[sid] = { '.anonymous': !a.name, '.type': a.type, '.name': sid, '.index': Object.keys(conf).length };
			this.uciChange(a.config, [ 'add', sid, a.type ]);
			this.uciSetValues(a.config, sid, a.values);
			return ok({ section: sid });
		}

		case 'set':
			if (!conf || !conf[a.section]) return nf();
			this.uciSetValues(a.config, a.section, a.values);
			return ok();

		case 'delete': {
			if (!conf || !conf[a.section]) return nf();
			const opts = (a.option != null) ? [ a.option ] : Array.isArray(a.options) ? a.options : null;
			if (opts) {
				for (const o of opts) {
					delete conf[a.section][o];
					this.uciChange(a.config, [ 'remove', a.section, o ]);
				}
			}
			else {
				delete conf[a.section];
				this.uciChange(a.config, [ 'remove', a.section ]);
			}
			return ok();
		}

		case 'rename': {
			if (!conf || !conf[a.section] || typeof a.name !== 'string') return nf();
			if (a.option != null) {
				const s = conf[a.section];
				s[a.name] = s[a.option]; delete s[a.option];
				this.uciChange(a.config, [ 'rename', a.section, a.option, a.name ]);
			}
			else {
				const s = conf[a.section];
				delete conf[a.section];
				s['.name'] = a.name; s['.anonymous'] = false;
				conf[a.name] = s;
				this.uciChange(a.config, [ 'rename', a.section, a.name ]);
			}
			return ok();
		}

		case 'order':
			if (!conf || !Array.isArray(a.sections)) return nf();
			a.sections.forEach((sid, i) => {
				if (!conf[sid]) return;
				conf[sid]['.index'] = i;
				this.uciChange(a.config, [ 'order', sid, i ]);
			});
			return ok();

		case 'commit':
			this.uciCommit(a.config);
			return ok();

		case 'revert':
			this.uciRevert(a.config);
			return ok();

		case 'apply':
			this.uciCommit();
			return ok();

		case 'confirm':
		case 'rollback':
			return ok();
		}

		this.warn('unknown call (answered NOT_FOUND)', `uci.${method} ${argsKey(a)}`);
		return nf();
	}

	uciSetValues(config, sid, values) {
		const s = this.uciStaged[config][sid];
		for (const [ k, v ] of Object.entries(values || {})) {
			if (k.startsWith('.')) continue;
			if (v === '' || v == null || (Array.isArray(v) && !v.length)) {
				delete s[k];
				this.uciChange(config, [ 'remove', sid, k ]);
			}
			else {
				s[k] = Array.isArray(v) ? v.map(String) : String(v);
				this.uciChange(config, [ 'set', sid, k, s[k] ]);
			}
		}
	}
}

module.exports = { Store, canon, argsKey };
