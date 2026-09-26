#!/usr/bin/env node
'use strict';
/* Record a real LuCI session read-only.

   Opens a visible Chromium window with a throwaway profile on the device's
   LuCI. You log in and click through pages; every request to the device goes
   through the DevTools Fetch interceptor:
     - JSON-RPC calls on the read allowlist are forwarded and recorded,
     - anything else (writes, applies, reboots, scans, exec, uploads,
       backups, legacy form posts) is refused before it leaves the browser,
     - the login form POST is forwarded but never recorded.
   Responses are sanitized (policy.js) before being written.

   usage: node record-browser.js <https://device> <mirror-dir>
   Close the browser window (or Ctrl+C) to finish. */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const policy = require('./policy');

const base = (process.argv[2] || '').replace(/\/+$/, '');
const outRoot = process.argv[3];
if (!/^https?:\/\/[^/]+$/.test(base) || !outRoot) {
	console.error('usage: record-browser.js <https://device> <mirror-dir>');
	process.exit(2);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.join(outRoot, 'browser-' + stamp);
fs.mkdirSync(path.join(out, 'static'), { recursive: true, mode: 0o700 });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vantage-rec-profile-'));
const rpcLog = fs.openSync(path.join(out, 'rpc.jsonl'), 'a', 0o600);
const httpLog = fs.openSync(path.join(out, 'http.jsonl'), 'a', 0o600);
const blockLog = fs.openSync(path.join(out, 'blocked.log'), 'a', 0o600);
const stats = { rpc: 0, http: 0, static: 0, blocked: 0 };

const chrome = spawn('chromium', [
	'--user-data-dir=' + profile, '--remote-debugging-port=0', '--no-first-run',
	'--no-default-browser-check', '--ignore-certificate-errors', '--new-window',
	base + '/cgi-bin/luci/'
], { stdio: [ 'ignore', 'ignore', 'pipe' ] });

const sleep = ms => new Promise(r => setTimeout(r, ms));
function write(fd, obj) { fs.writeSync(fd, JSON.stringify(obj) + '\n'); }

(async () => {
	let port = null;
	for (let i = 0; i < 100 && !port; i++) {
		try { port = +fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch (e) { await sleep(100); }
	}
	let target = null;
	for (let i = 0; i < 100 && !target; i++) {
		try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch (e) {}
		if (!target) await sleep(100);
	}
	const ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise(r => { ws.onopen = r; });
	let id = 0; const pend = {};
	const send = (method, params) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
	const tracked = new Map();   /* requestId -> { kind, url, calls, page } */
	let page = '';

	ws.onmessage = async ev => {
		const m = JSON.parse(ev.data);
		if (m.id && pend[m.id]) { pend[m.id](m.result || { error: m.error }); delete pend[m.id]; return; }

		if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) {
			page = m.params.frame.url.replace(base, '').replace(/[?#].*$/, '');
			console.log('page', page);
		}

		if (m.method === 'Fetch.requestPaused') {
			const p = m.params, url = p.request.url, verb = p.request.method;
			const body = p.request.postData || '';
			let verdict = { ok: true }, kind = null, calls = null;
			if (/\/ubus\/?(\?|$)/.test(url.replace(base, '')) && verb === 'POST') {
				verdict = policy.rpcAllowed(body); kind = 'rpc'; calls = verdict.calls;
			} else if (verb === 'POST' && /\/cgi-bin\/cgi-exec(\?|$)/.test(url)) {
				/* read-only commands only; the body carries the session id, never stored */
				const argv = policy.cgiExecArgv(body);
				verdict = policy.execAllowed(argv) ? { ok: true } : { ok: false, why: 'cgi-exec ' + JSON.stringify(argv) };
				if (verdict.ok) { kind = 'exec'; calls = argv; }
			} else if (verb !== 'GET' && verb !== 'HEAD') {
				/* the only non-GET page request allowed is the login form */
				const login = /(^|&)luci_username=/.test(body) && /(^|&)luci_password=/.test(body);
				verdict = login ? { ok: true } : { ok: false, why: verb + ' ' + url.replace(base, '') };
				kind = login ? 'login' : null;
			} else {
				verdict = policy.httpAllowed(url, verb);
				if (/\/luci-static\//.test(url)) kind = 'static';
				else if (/\/cgi-bin\/luci\/admin\/(menu|translations)/.test(url)) kind = 'http';
			}
			if (!verdict.ok) {
				stats.blocked++;
				fs.writeSync(blockLog, new Date().toISOString() + ' ' + verdict.why + '\n');
				console.log('BLOCKED', verdict.why);
				await send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' });
				return;
			}
			if (kind && kind !== 'login' && p.networkId) tracked.set(p.networkId, { kind, url: url.replace(base, ''), calls, page });
			await send('Fetch.continueRequest', { requestId: p.requestId });
		}

		if (m.method === 'Network.loadingFinished' && tracked.has(m.params.requestId)) {
			const t = tracked.get(m.params.requestId); tracked.delete(m.params.requestId);
			const r = await send('Network.getResponseBody', { requestId: m.params.requestId });
			if (!r || r.error) return;
			const text = r.base64Encoded ? Buffer.from(r.body, 'base64') : r.body;
			const at = Date.now();
			if (t.kind === 'rpc') {
				let replies; try { replies = JSON.parse(text); } catch (e) { return; }
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
			} else if (t.kind === 'exec') {
				write(httpLog, { at, page: t.page, url: '/cgi-bin/cgi-exec', argv: t.calls, body: policy.sanitize(String(text)) });
				stats.http++;
			} else if (t.kind === 'http') {
				let body = String(text);
				try { body = policy.sanitize(JSON.parse(body)); } catch (e) { body = policy.sanitize(body); }
				write(httpLog, { at, page: t.page, url: t.url, body });
				stats.http++;
			} else if (t.kind === 'static') {
				const rel = t.url.replace(/[?#].*$/, '').replace(/^\/+/, '');
				if (!/\.\.|^\//.test(rel)) {
					const file = path.join(out, 'static', rel);
					fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
					fs.writeFileSync(file, text, { mode: 0o600 });
					stats.static++;
				}
			}
		}
	};

	await send('Network.enable', { maxResourceBufferSize: 8 << 20, maxTotalBufferSize: 64 << 20 });
	await send('Page.enable');
	await send('Fetch.enable', { patterns: [ { urlPattern: base + '/*', requestStage: 'Request' } ] });
	console.log('recording to', out, '— log in and browse; close the window when done');
	const tick = setInterval(() => console.log('stats', JSON.stringify(stats)), 30000);
	chrome.on('exit', () => finish(tick));
	process.on('SIGINT', () => { chrome.kill(); });
})().catch(e => { console.error(e); chrome.kill(); process.exit(1); });

function finish(tick) {
	clearInterval(tick);
	fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ base, stats, finished: new Date().toISOString() }, null, 2), { mode: 0o600 });
	console.log('done', JSON.stringify(stats));
	/* throwaway browser profile (holds the session cookie): created above by mkdtemp */
	if (profile.startsWith(path.join(os.tmpdir(), 'vantage-rec-profile-'))) fs.rmSync(profile, { recursive: true, force: true });
	process.exit(0);
}
