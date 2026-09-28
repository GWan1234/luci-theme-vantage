'use strict';
const mkTmp = require('./tmpdir');
/* dev/mirror/record-browser.js end to end, against a local mock device in
   headless Chromium: requests from a second tab, a popup, a dedicated
   worker and a service worker are refused like the first tab's; the device
   gets the canonical bodies; the profile is removed on close and on
   SIGTERM; the certificate pin admits the right key only.

   Starts one browser at a time, so it is opt-in:
     VANTAGE_BROWSER_TESTS=1 node --test tests/recorder-browser.test.js
   Needs chromium on PATH (and openssl for the pin test). Uses ports
   8220-8239 on 127.0.0.1 only. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const https = require('https');
const net = require('net');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const RECORDER = path.join(ROOT, 'dev/mirror/record-browser.js');
const which = b => { try { return execFileSync('sh', [ '-c', 'command -v ' + b ]).toString().trim(); } catch (e) { return null; } };
const CHROMIUM = which('chromium');
const enabled = process.env.VANTAGE_BROWSER_TESTS === '1' && CHROMIUM;
const skip = !enabled && 'set VANTAGE_BROWSER_TESTS=1 (and have chromium on PATH) to run';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function freePort() {
	for (let p = 8220; p <= 8239; p++) {
		const ok = await new Promise(res => {
			const s = net.createServer().once('error', () => res(false)).listen(p, '127.0.0.1', () => s.close(() => res(true)));
		});
		if (ok) return p;
	}
	throw new Error('no free port in 8220-8239');
}

const SID = 'ab'.repeat(16);
const rpc = (id, object, method, args) => ({ jsonrpc: '2.0', id, method: 'call', params: [ SID, object, method, args || {} ] });
const READ_BODY = JSON.stringify([ rpc(1, 'session', 'list') ]);
const WRITE = name => JSON.stringify([ rpc(7, 'system', 'reboot', { from: name }) ]);

/* mock device: logs every request that reaches it */
function mockDevice(tls) {
	const seen = [];
	const handler = (req, res) => {
		const chunks = [];
		req.on('data', c => chunks.push(c));
		req.on('end', () => {
			const body = Buffer.concat(chunks).toString('utf8');
			const p = req.url.replace(/\?.*$/, '');
			seen.push({ method: req.method, path: p, body, type: req.headers['content-type'] || '' });
			if (p === '/ubus/' || p === '/ubus') {
				let msgs = [];
				try { msgs = JSON.parse(body); } catch (e) {}
				const reply = (Array.isArray(msgs) ? msgs : [ msgs ]).map(m => ({ jsonrpc: '2.0', id: m && m.id, result: [ 0, { mock: 'reply', password: 'hunter2' } ] }));
				res.writeHead(200, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify(reply));
			}
			if (p === '/cgi-bin/cgi-exec') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('kernel log line\n'); }
			if (req.method === 'POST' && p.startsWith('/cgi-bin/luci')) {
				res.writeHead(302, { Location: '/cgi-bin/luci/', 'Set-Cookie': 'sysauth_https=' + SID + '; path=/cgi-bin/luci/' });
				return res.end();
			}
			if (p === '/worker.js') {
				res.writeHead(200, { 'Content-Type': 'application/javascript' });
				return res.end(`onmessage = e => fetch('/ubus/', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: e.data })
					.then(r => postMessage('status ' + r.status), () => postMessage('blocked'));`);
			}
			if (p === '/sw.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end('self.addEventListener("fetch", () => {});'); }
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end('<!doctype html><title>mock</title><p>mock luci ' + p + '</p>');
		});
	};
	const server = tls ? https.createServer(tls, handler) : http.createServer(handler);
	return { server, seen };
}

/* the recorder, with chromium made headless and given a debugging port for
   this test's own driver (the recorder itself only uses the pipe) */
function startRecorder(tmp, args) {
	const bin = path.join(tmp, 'bin');
	fs.mkdirSync(bin, { recursive: true });
	fs.writeFileSync(path.join(bin, 'chromium'), `#!/bin/sh\nexec ${CHROMIUM} --headless=new --remote-debugging-port=0 "$@"\n`, { mode: 0o755 });
	const ptmp = path.join(tmp, 'ptmp');
	fs.mkdirSync(ptmp, { recursive: true });
	const env = Object.assign({}, process.env, { PATH: bin + ':' + process.env.PATH, TMPDIR: ptmp });
	delete env.VANTAGE_DEVICE_SPKI;
	const child = spawn(process.execPath, [ RECORDER, ...args ], { env, stdio: [ 'ignore', 'pipe', 'pipe' ] });
	let log = '';
	child.stdout.on('data', d => { log += d; });
	child.stderr.on('data', d => { log += d; });
	const exited = new Promise(r => child.on('exit', (code, sig) => r({ code, sig })));
	return { child, exited, ptmp, log: () => log };
}

function profileDirs(ptmp) {
	return fs.readdirSync(ptmp).filter(d => d.startsWith('vantage-rec-profile-')).map(d => path.join(ptmp, d));
}

/* CDP client for the test driver */
async function driver(ptmp) {
	let port, bpath;
	for (let i = 0; i < 100 && !port; i++) {
		const dirs = profileDirs(ptmp);
		try { [ port, bpath ] = fs.readFileSync(path.join(dirs[0], 'DevToolsActivePort'), 'utf8').split('\n'); } catch (e) { await sleep(100); }
	}
	assert.ok(port, 'debugging port of the test browser');
	const ws = new WebSocket(`ws://127.0.0.1:${port}${bpath}`);
	await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
	let id = 0;
	const pend = new Map();
	ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
	const send = (method, params, sessionId) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {}, sessionId })); });
	const evaluate = async (sessionId, expression, userGesture) => {
		const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: !!userGesture }, sessionId);
		if (r.error) throw new Error(r.error.message);
		return r.result.result.value;
	};
	return { ws, send, evaluate };
}

async function waitFor(fn, ms, what) {
	for (let t = 0; t < ms; t += 100) { const v = await fn(); if (v) return v; await sleep(100); }
	throw new Error('timed out waiting for ' + what);
}

const post = (url, body, type) => `fetch(${JSON.stringify(url)}, { method: 'POST', headers: { 'Content-Type': ${JSON.stringify(type || 'application/json')} }, body: ${JSON.stringify(body)} }).then(r => 'status ' + r.status, () => 'blocked')`;

test('recorder: every tab, popup and worker is filtered; canonical bodies; profile removed', { skip, timeout: 90000 }, async () => {
	const tmp = mkTmp('vantage-rec-test-');
	const port = await freePort();
	const { server, seen } = mockDevice(null);
	await new Promise(r => server.listen(port, '127.0.0.1', r));
	const B = `http://127.0.0.1:${port}`;
	const mirror = path.join(tmp, 'mirror');
	const rec = startRecorder(tmp, [ B, mirror ]);
	try {
		await waitFor(() => seen.some(s => s.path === '/cgi-bin/luci/'), 20000, 'the device page');
		const d = await driver(rec.ptmp);
		const pages = (await d.send('Target.getTargets')).result.targetInfos.filter(t => t.type === 'page' && t.url.startsWith(B));
		assert.equal(pages.length, 1);
		const s1 = (await d.send('Target.attachToTarget', { targetId: pages[0].targetId, flatten: true })).result.sessionId;

		/* first tab: a read goes through (re-serialised), a write does not */
		assert.equal(await d.evaluate(s1, post(B + '/ubus/', '[ ' + READ_BODY.slice(1))), 'status 200', rec.log());
		assert.equal(await d.evaluate(s1, post(B + '/ubus/', WRITE('tab1'))), 'blocked');
		/* duplicate keys, NUL-suffixed keys, REST ubus, other spellings of the device */
		assert.equal(await d.evaluate(s1, post(B + '/ubus/', '{"jsonrpc":"2.0","id":1,"method":"call","params":["x","session","list",{}],"params":["x","system","reboot",{}]}')), 'blocked');
		assert.equal(await d.evaluate(s1, post(B + '/ubus/', '{"jsonrpc":"2.0","id":1,"method":"call","params":["x","session","list",{}],"params\\u0000":["x","system","reboot",{}]}')), 'blocked');
		assert.equal(await d.evaluate(s1, post(B + '/ubus/call/system', '{"jsonrpc":"2.0","id":1,"method":"call","params":["x","system","reboot",{}]}')), 'blocked');
		assert.equal(await d.evaluate(s1, post(`http://localhost:${port}/ubus/`, WRITE('alias'))), 'blocked');
		/* login: exactly the two fields, form encoded */
		assert.equal(await d.evaluate(s1, post(B + '/cgi-bin/luci/admin/status', 'luci_username=root&luci_password=pw', 'application/x-www-form-urlencoded')), 'status 200');
		assert.equal(await d.evaluate(s1, post(B + '/cgi-bin/luci/admin/system/flash', 'luci_username=root&luci_password=pw&reset=1', 'application/x-www-form-urlencoded')), 'blocked');
		assert.equal(await d.evaluate(s1, post(B + '/cgi-bin/cgi-exec/x', 'luci_username=&luci_password=&sessionid=' + SID + '&command=/sbin/reboot', 'application/x-www-form-urlencoded')), 'blocked');
		/* cgi-exec: allowlisted argv in canonical form only */
		assert.equal(await d.evaluate(s1, post(B + '/cgi-bin/cgi-exec', `sessionid=${SID}&command=%2Fbin%2Fdmesg%20-r&stderr=0`, 'application/x-www-form-urlencoded')), 'status 200');
		assert.equal(await d.evaluate(s1, post(B + '/cgi-bin/cgi-exec', `sessionid=${SID}&command=/usr/sbin/iptables-save&command=/sbin/reboot`, 'application/x-www-form-urlencoded')), 'blocked');

		/* popup opened by the page */
		await d.evaluate(s1, `window.__p = window.open(${JSON.stringify(B + '/cgi-bin/luci/admin/popup')}); !!window.__p`, true);
		await waitFor(() => seen.some(s => s.path === '/cgi-bin/luci/admin/popup'), 10000, 'the popup');
		assert.equal(await d.evaluate(s1, `window.__p.${post(B + '/ubus/', WRITE('popup'))}`), 'blocked');

		/* a new tab (Ctrl+T, middle click, target=_blank) */
		const nt = (await d.send('Target.createTarget', { url: B + '/cgi-bin/luci/admin/newtab' })).result.targetId;
		await waitFor(() => seen.some(s => s.path === '/cgi-bin/luci/admin/newtab'), 10000, 'the new tab');
		const s2 = (await d.send('Target.attachToTarget', { targetId: nt, flatten: true })).result.sessionId;
		assert.equal(await d.evaluate(s2, post(B + '/ubus/', WRITE('newtab'))), 'blocked');
		assert.equal(await d.evaluate(s2, post(B + '/cgi-bin/luci/admin/system/flash', 'reset=1', 'application/x-www-form-urlencoded')), 'blocked');

		/* dedicated worker and service worker */
		assert.equal(await d.evaluate(s2, `new Promise(r => { const w = new Worker('/worker.js'); w.onmessage = e => r(e.data); w.onerror = () => r('worker failed'); w.postMessage(${JSON.stringify(WRITE('worker'))}); })`), 'blocked');
		assert.equal(await d.evaluate(s2, `navigator.serviceWorker.register('/sw.js').then(() => 'registered', () => 'refused')`), 'refused');

		/* what reached the device */
		const bodies = seen.map(s => s.body).join('\n');
		assert.doesNotMatch(bodies, /reboot|reset=1/, 'no write reached the device');
		const rpcs = seen.filter(s => s.path === '/ubus/');
		assert.deepEqual(rpcs.map(s => s.body), [ READ_BODY ], 'the checked, re-serialised body');
		const exec = seen.filter(s => s.path === '/cgi-bin/cgi-exec');
		assert.deepEqual(exec.map(s => s.body), [ `sessionid=${SID}&command=%2Fbin%2Fdmesg%20-r&stderr=0` ]);
		assert.ok(!seen.some(s => s.path === '/sw.js'), 'service worker script not fetched');

		await d.send('Browser.close');
		d.ws.close();
		const ex = await rec.exited;
		assert.equal(ex.code, 0, rec.log());
		assert.deepEqual(profileDirs(rec.ptmp), [], 'browser profile removed');
		const [ run ] = fs.readdirSync(mirror);
		const summary = JSON.parse(fs.readFileSync(path.join(mirror, run, 'summary.json'), 'utf8'));
		assert.ok(summary.stats.blocked >= 12, JSON.stringify(summary.stats));
		assert.ok(summary.stats.pages >= 3, JSON.stringify(summary.stats));
		const rows = fs.readFileSync(path.join(mirror, run, 'rpc.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
		assert.deepEqual(rows.map(r => r.object + '.' + r.method), [ 'session.list' ]);
		assert.equal(rows[0].result[1].password, '<redacted>');
		assert.match(fs.readFileSync(path.join(mirror, run, 'http.jsonl'), 'utf8'), /"argv":\["\/bin\/dmesg","-r"\]/);
	}
	finally {
		rec.child.kill('SIGKILL');
		await new Promise(r => server.close(r));
	}
});

test('recorder: SIGTERM kills the browser and removes the profile', { skip, timeout: 60000 }, async () => {
	const tmp = mkTmp('vantage-rec-test-');
	const port = await freePort();
	const { server, seen } = mockDevice(null);
	await new Promise(r => server.listen(port, '127.0.0.1', r));
	const rec = startRecorder(tmp, [ `http://127.0.0.1:${port}`, path.join(tmp, 'mirror') ]);
	try {
		await waitFor(() => seen.some(s => s.path === '/cgi-bin/luci/'), 20000, 'the device page');
		const [ prof ] = profileDirs(rec.ptmp);
		rec.child.kill('SIGTERM');
		const ex = await rec.exited;
		assert.equal(ex.code, 143, rec.log());
		assert.ok(!fs.existsSync(prof), 'profile removed');
		await sleep(500);
		const alive = fs.readdirSync('/proc').filter(p => /^\d+$/.test(p)).some(p => {
			try { return fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes('--user-data-dir=' + prof); } catch (e) { return false; }
		});
		assert.ok(!alive, 'no browser process left');
	}
	finally {
		rec.child.kill('SIGKILL');
		await new Promise(r => server.close(r));
	}
});

test('recorder: https needs a pin, and only the pinned key is accepted', { skip: skip || (!which('openssl') && 'no openssl'), timeout: 90000 }, async () => {
	const tmp = mkTmp('vantage-rec-test-');
	const key = path.join(tmp, 'k.pem'), crt = path.join(tmp, 'c.pem');
	execFileSync('openssl', [ 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-keyout', key, '-out', crt,
		'-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1' ], { stdio: 'ignore' });
	const port = await freePort();
	const { server, seen } = mockDevice({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) });
	await new Promise(r => server.listen(port, '127.0.0.1', r));
	const B = `https://127.0.0.1:${port}`;
	try {
		/* no pin: refused before a browser starts */
		const none = startRecorder(tmp, [ B, path.join(tmp, 'm0') ]);
		assert.equal((await none.exited).code, 2);
		assert.match(none.log(), /missing certificate pin/);

		/* wrong pin: the page never loads */
		const wrong = startRecorder(tmp, [ '--spki', Buffer.alloc(32, 7).toString('base64'), B, path.join(tmp, 'm1') ]);
		await sleep(5000);
		assert.equal(seen.length, 0, 'no request with a wrong pin');
		wrong.child.kill('SIGTERM');
		await wrong.exited;

		/* the device's own certificate */
		const right = startRecorder(tmp, [ '--cert', crt, B, path.join(tmp, 'm2') ]);
		await waitFor(() => seen.some(s => s.path === '/cgi-bin/luci/'), 20000, 'the pinned page');
		right.child.kill('SIGTERM');
		await right.exited;
		assert.deepEqual(profileDirs(right.ptmp), [], wrong.log() + right.log());
	}
	finally {
		await new Promise(r => server.close(r));
	}
});
