#!/usr/bin/env node
'use strict';
/* Record a real LuCI session read-only.

   Opens a visible Chromium window with a throwaway profile on the device's
   LuCI. You log in and click through pages. The recorder holds a
   browser-level DevTools session (over a pipe, no TCP port) with Fetch
   interception for every URL, so every request of every tab, popup, worker
   and service worker in that browser is paused and decided by policy.js
   before it leaves the browser:
     - JSON-RPC calls on the read allowlist are forwarded (re-serialised
       exactly as checked) and recorded,
     - cgi-exec of the few read-only commands LuCI's status pages run is
       forwarded (canonical body) and recorded,
     - the login form POST (exactly the two login fields) is forwarded but
       never recorded,
     - GETs of LuCI pages and static files are forwarded,
     - anything else (writes, applies, reboots, scans, uploads, backups,
       legacy form posts, other hosts or other spellings of the device) is
       refused.
   Responses are sanitized (policy.js) before being written. If the
   recorder dies, the browser is killed with it and the profile removed;
   while the recorder is not answering, paused requests stay paused.

   This is an accident guard for clicking through stock LuCI, not a sandbox
   for hostile page JavaScript (see policy.js).

   usage: node record-browser.js --spki <pin> <https://device> <mirror-dir>
          node record-browser.js --cert <device-cert-file> <https://device> <mirror-dir>

   The device's LuCI certificate is self-signed. Instead of ignoring
   certificate errors, the browser accepts only the device's own key: pass
   its SPKI pin (base64 SHA-256 of the DER public key) with --spki (or
   $VANTAGE_DEVICE_SPKI), or a copy of the certificate with --cert. Get
   either over SSH, whose host key you have already verified, never from
   the TLS connection itself:

     scp -O root@<device>:/etc/uhttpd.crt /tmp/device.crt
     node record-browser.js --cert /tmp/device.crt https://<device> ../vantage-mirror

   or compute the pin (uhttpd's generated certificate is DER; for a PEM one
   drop "-inform der"):

     ssh root@<device> cat /etc/uhttpd.crt | openssl x509 -inform der -pubkey -noout \
       | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64

   Record over the wired management path. http:// is accepted only for a
   loopback test server (127.0.0.1, localhost, [::1]).

   Close the browser window (or Ctrl+C) to finish. */

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('./policy');

const USAGE = 'usage: record-browser.js (--spki <base64 sha256 pin> | --cert <device cert file>) <https://device> <mirror-dir>';

function die(msg) {
	console.error(msg + '\n' + USAGE);
	process.exit(2);
}

function spkiOfCert(file) {
	const cert = new crypto.X509Certificate(fs.readFileSync(file));
	return crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
}

/* ------------------------------------------------------------ arguments */

const pos = [];
let pins = [];
{
	const argv = process.argv.slice(2);
	for (let i = 0; i < argv.length; i++) {
		const m = /^--(spki|cert)(?:=(.*))?$/.exec(argv[i]);
		if (!m) { if (argv[i].startsWith('--')) die('unknown option ' + argv[i]); pos.push(argv[i]); continue; }
		const v = m[2] !== undefined ? m[2] : argv[++i];
		if (v == null) die('--' + m[1] + ' needs a value');
		if (m[1] === 'spki') pins.push(...v.split(','));
		else {
			try { pins.push(spkiOfCert(v)); } catch (e) { die('--cert ' + v + ': ' + e.message); }
		}
	}
	if (!pins.length && process.env.VANTAGE_DEVICE_SPKI) pins = process.env.VANTAGE_DEVICE_SPKI.split(',');
	pins = pins.map(p => p.trim()).filter(Boolean);
}
const base = (pos[0] || '').replace(/\/+$/, '');
const outRoot = pos[1];
if (pos.length !== 2 || !outRoot) die('need a device URL and a mirror directory');
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/;
if (!/^https:\/\/[^/?#@\s]+$/.test(base) && !LOOPBACK.test(base))
	die('the device URL must be https://<host>[:port] (http:// only for a loopback test server)');
if (base.startsWith('https:')) {
	if (!pins.length) die('missing certificate pin: pass --spki or --cert (see the header of this file for getting it over SSH)');
	for (const p of pins) if (!/^[A-Za-z0-9+/]{43}=$/.test(p) || Buffer.from(p, 'base64').length !== 32) die('bad --spki pin (want base64 of a SHA-256 digest): ' + p);
}
const origin = new URL(base).origin;

/* ------------------------------------------------------------ output */

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(outRoot, 'browser-' + stamp);
const staticRoot = path.join(out, 'static');
fs.mkdirSync(staticRoot, { recursive: true, mode: 0o700 });
const PROFILE_PREFIX = path.join(os.tmpdir(), 'vantage-rec-profile-');
const profile = fs.mkdtempSync(PROFILE_PREFIX);
/* no saved passwords in the throwaway profile */
fs.mkdirSync(path.join(profile, 'Default'), { mode: 0o700 });
fs.writeFileSync(path.join(profile, 'Default', 'Preferences'),
	JSON.stringify({ credentials_enable_service: false, profile: { password_manager_enabled: false } }), { mode: 0o600 });
const rpcLog = fs.openSync(path.join(out, 'rpc.jsonl'), 'a', 0o600);
const httpLog = fs.openSync(path.join(out, 'http.jsonl'), 'a', 0o600);
const blockLog = fs.openSync(path.join(out, 'blocked.log'), 'a', 0o600);
const stats = { rpc: 0, http: 0, static: 0, blocked: 0, pages: 0, workers: 0 };

function write(fd, obj) { fs.writeSync(fd, JSON.stringify(obj) + '\n'); }
/* request-derived text on the terminal: no control characters */
const safe = s => String(s).replace(/[\x00-\x1f\x7f-\x9f]/g, c => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'));

/* ------------------------------------------------------------ cleanup */

let chrome = null, cleaned = false, finished = false, tick = null;

/* Is any live (non-zombie) process left in the browser's process group?
   Chromium's helpers keep writing into the profile for a moment after the
   browser process dies, so the profile is removed only once they are gone. */
function groupAlive(pgid) {
	let procs;
	try { procs = fs.readdirSync('/proc'); } catch (e) { try { process.kill(-pgid, 0); return true; } catch (e2) { return false; } }
	for (const p of procs) {
		if (!/^\d+$/.test(p)) continue;
		let st;
		try { st = fs.readFileSync(`/proc/${p}/stat`, 'utf8'); } catch (e) { continue; }
		const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
		if (+f[2] === pgid && f[0] !== 'Z') return true;
	}
	return false;
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function removeProfile() {
	/* the mkdtemp path above, nothing else */
	if (!profile.startsWith(PROFILE_PREFIX) || path.dirname(profile) !== os.tmpdir()) return;
	/* Chromium's singleton socket directory in $TMPDIR, linked from the profile */
	let single = null;
	try {
		const dir = path.dirname(fs.readlinkSync(path.join(profile, 'SingletonSocket')));
		if (path.dirname(dir) === os.tmpdir() && /^org\.chromium\.Chromium\.[A-Za-z0-9]{6}$/.test(path.basename(dir))) single = dir;
	} catch (e) {}
	for (const dir of [ profile, single ].filter(Boolean)) {
		try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
		catch (e) { console.error('could not remove ' + dir + ': ' + e.message); }
	}
}

/* idempotent and synchronous, so it also works from process 'exit' */
function cleanup() {
	if (cleaned) return;
	cleaned = true;
	if (tick) clearInterval(tick);
	if (chrome && chrome.pid) {
		try { process.kill(-chrome.pid, 'SIGKILL'); } catch (e) { try { chrome.kill('SIGKILL'); } catch (e2) {} }
		for (let i = 0; i < 100 && groupAlive(chrome.pid); i++) pause(50);
	}
	removeProfile();
	/* a helper that was still exiting may have recreated a directory */
	pause(200);
	if (fs.existsSync(profile)) removeProfile();
}

function finish(reason, code) {
	if (!finished) {
		finished = true;
		try {
			fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ base, stats, end: reason, finished: new Date().toISOString() }, null, 2), { mode: 0o600 });
		} catch (e) {}
		console.log('done (' + reason + ')', JSON.stringify(stats));
	}
	cleanup();
	process.exit(code);
}

process.on('exit', cleanup);
for (const [ sig, code ] of [ [ 'SIGINT', 130 ], [ 'SIGTERM', 143 ], [ 'SIGHUP', 129 ] ])
	process.on(sig, () => finish(sig, code));
process.on('uncaughtException', e => { console.error('recorder error:', e); finish('error', 1); });
process.on('unhandledRejection', e => { console.error('recorder error:', e); finish('error', 1); });

/* ------------------------------------------------------------ browser */

const flags = [
	'--user-data-dir=' + profile, '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
	'--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
	'--disable-extensions', '--password-store=basic'
];
if (pins.length) flags.push('--ignore-certificate-errors-spki-list=' + pins.join(','));
flags.push('about:blank');

/* own process group, so the whole browser can be killed at once; it also
   exits by itself when the DevTools pipe closes (the recorder died) */
chrome = spawn('chromium', flags, { stdio: [ 'ignore', 'ignore', 'ignore', 'pipe', 'pipe' ], detached: true });
chrome.on('error', e => { console.error('cannot start chromium: ' + e.message); finish('error', 1); });
chrome.on('exit', () => finish('browser closed', 0));

/* CDP over --remote-debugging-pipe: fd 3 to the browser, fd 4 from it,
   NUL-terminated JSON messages */
const toChrome = chrome.stdio[3], fromChrome = chrome.stdio[4];
let nextId = 0;
const pend = new Map();
function send(method, params, sessionId) {
	return new Promise((resolve, reject) => {
		const id = ++nextId;
		pend.set(id, { resolve, reject, method });
		const msg = { id, method, params: params || {} };
		if (sessionId) msg.sessionId = sessionId;
		toChrome.write(JSON.stringify(msg) + '\0');
	});
}
toChrome.on('error', () => {});
let inbuf = Buffer.alloc(0);
fromChrome.on('data', chunk => {
	inbuf = Buffer.concat([ inbuf, chunk ]);
	let z;
	while ((z = inbuf.indexOf(0)) >= 0) {
		const text = inbuf.subarray(0, z).toString('utf8');
		inbuf = inbuf.subarray(z + 1);
		let m;
		try { m = JSON.parse(text); } catch (e) { continue; }
		if (m.id && pend.has(m.id)) {
			const p = pend.get(m.id); pend.delete(m.id);
			if (m.error) p.reject(new Error(p.method + ': ' + m.error.message)); else p.resolve(m.result);
			continue;
		}
		onEvent(m).catch(failClosed);
	}
});
fromChrome.on('error', () => {});
fromChrome.on('end', () => finish('browser pipe closed', 0));

/* A paused request the browser has meanwhile cancelled (navigation, tab
   closed) makes Fetch.* answer with an error. That is harmless: nothing was
   forwarded. Any other failure of ours stops the browser. */
function settle(promise) {
	return promise.catch(e => { if (!/Invalid InterceptionId|Invalid state|not found/i.test(e.message)) console.error('devtools:', safe(e.message)); });
}

/* a bug here must not leave an unfiltered browser behind */
function failClosed(e) {
	console.error('recorder error, closing the browser:', e);
	finish('error', 1);
}

/* ------------------------------------------------------------ recording */

let ready = false;
const targets = new Map();   /* targetId -> { type, url } */
const tracked = new Map();   /* Fetch requestId -> { kind, url, calls, page } */

function pageOf(frameId) {
	const t = targets.get(frameId);
	if (!t || !t.url.startsWith(origin)) return '';
	return t.url.slice(origin.length).replace(/[?#].*$/, '');
}

function block(p, why) {
	stats.blocked++;
	fs.writeSync(blockLog, new Date().toISOString() + ' ' + safe(why) + '\n');
	console.log('BLOCKED', safe(why));
	return settle(send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }));
}

async function onEvent(m) {
	switch (m.method) {
	case 'Target.targetCreated':
	case 'Target.targetInfoChanged': {
		const t = m.params.targetInfo;
		if (!targets.has(t.targetId) && m.method === 'Target.targetCreated') {
			if (t.type === 'page') stats.pages++;
			else if (/worker/.test(t.type)) stats.workers++;
			if (ready && t.type === 'page') console.log('new tab or popup (filtered like the first)');
		}
		const was = targets.get(t.targetId);
		targets.set(t.targetId, { type: t.type, url: t.url });
		if (t.type === 'page' && t.url.startsWith(origin) && (!was || was.url !== t.url)) console.log('page', safe(t.url.slice(origin.length)));
		return;
	}
	case 'Target.targetDestroyed':
		targets.delete(m.params.targetId);
		return;
	case 'Fetch.requestPaused':
		return onPaused(m.params);
	}
}

async function onPaused(p) {
	/* response stage: record what an allowed request returned */
	if (p.responseStatusCode !== undefined || p.responseErrorReason !== undefined) {
		const t = tracked.get(p.requestId);
		tracked.delete(p.requestId);
		if (t && p.responseStatusCode !== undefined && !(p.responseStatusCode >= 300 && p.responseStatusCode < 400)) {
			let r = null;
			try { r = await send('Fetch.getResponseBody', { requestId: p.requestId }); } catch (e) {}
			if (r) record(t, r.base64Encoded ? Buffer.from(r.body, 'base64') : Buffer.from(r.body, 'utf8'));
		}
		return settle(send('Fetch.continueRequest', { requestId: p.requestId }));
	}

	/* request stage: decide */
	const req = p.request;
	let body = req.postData;
	if (body === undefined && Array.isArray(req.postDataEntries))
		body = Buffer.concat(req.postDataEntries.map(e => Buffer.from(e.bytes || '', 'base64'))).toString('utf8');
	if (body === undefined && req.hasPostData) return block(p, `${req.method} ${req.url}: request body not available`);
	const v = policy.classify({ url: req.url, method: req.method, headers: req.headers, postData: body }, base);
	if (!v.ok) return block(p, v.why);
	if (v.kind && v.kind !== 'login')
		tracked.set(p.requestId, { kind: v.kind, url: new URL(req.url).pathname, calls: v.calls, page: pageOf(p.frameId) });
	const cont = { requestId: p.requestId };
	if (v.postData !== undefined) cont.postData = Buffer.from(v.postData, 'utf8').toString('base64');
	return settle(send('Fetch.continueRequest', cont));
}

function record(t, buf) {
	const at = Date.now();
	if (t.kind === 'rpc') {
		let replies;
		try { replies = JSON.parse(buf.toString('utf8')); } catch (e) { return; }
		if (!Array.isArray(replies)) replies = [ replies ];
		const byId = new Map(replies.map(x => [ x && x.id, x ]));
		for (const c of t.calls) {
			if (c.list) continue;
			const reply = byId.get(c.id) || {};
			write(rpcLog, { at, page: t.page, object: c.object, method: c.method,
				args: policy.sanitize(c.args),
				result: reply.result !== undefined ? policy.sanitizeResult(c.object, c.method, c.args, reply.result) : undefined,
				error: reply.error });
			stats.rpc++;
		}
	}
	else if (t.kind === 'exec') {
		write(httpLog, { at, page: t.page, url: '/cgi-bin/cgi-exec', argv: t.calls, body: policy.sanitize(buf.toString('utf8')) });
		stats.http++;
	}
	else if (t.kind === 'http') {
		let body = buf.toString('utf8');
		try { body = policy.sanitize(JSON.parse(body)); } catch (e) { body = policy.sanitize(body); }
		write(httpLog, { at, page: t.page, url: t.url, body });
		stats.http++;
	}
	else if (t.kind === 'static') {
		let rel;
		try { rel = decodeURIComponent(t.url).replace(/^\/+/, ''); } catch (e) { return; }
		if (!rel || /(^|\/)\.\.?(\/|$)|[\0\\]/.test(rel) || rel.endsWith('/')) return;
		const file = path.join(staticRoot, rel);
		if (!file.startsWith(staticRoot + path.sep)) return;
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			fs.writeFileSync(file, buf, { mode: 0o600 });
			stats.static++;
		}
		catch (e) { console.error('static not saved:', safe(rel), e.code || e.message); }
	}
}

(async () => {
	await send('Target.setDiscoverTargets', { discover: true });
	/* browser-wide: every target of this browser, including ones created later */
	await send('Fetch.enable', { patterns: [
		{ urlPattern: '*', requestStage: 'Request' },
		{ urlPattern: origin + '/*', requestStage: 'Response' }
	] });
	/* the device page is only opened once interception is on */
	const blank = (await send('Target.getTargets')).targetInfos.filter(t => t.type === 'page');
	await send('Target.createTarget', { url: base + '/cgi-bin/luci/' });
	for (const t of blank) await send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
	ready = true;
	console.log('recording to', out, '- log in and browse; close the window when done');
	tick = setInterval(() => console.log('stats', JSON.stringify(stats)), 30000);
})().catch(failClosed);
