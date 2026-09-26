'use strict';
/* Recording policy for the LuCI data mirror.

   1. Only read-only RPC calls may reach the device while recording. Anything
      not on the allowlist is refused before it leaves the browser, so a stray
      click on Save, Apply, Reboot or a diagnostics button cannot change or
      disturb the device. Wi-Fi scans are refused too: they take radios off
      channel.
   2. Secrets are removed before anything is written to disk: Wi-Fi keys,
      RADIUS/WireGuard/DDNS secrets, password hashes, private keys, session
      tokens. The mirror keeps real MACs/IPs/hostnames (it lives outside the
      repo, mode 0700); fixtures that get committed go through pseudonymize. */

const READ = {
	'session': [ 'access', 'list' ],
	'system': [ 'board', 'info' ],
	'network': [ 'get_proto_handlers' ],
	'network.interface': [ 'dump', 'status' ],
	'network.device': [ 'status' ],
	'network.wireless': [ 'status' ],
	'uci': [ 'get', 'configs', 'changes', 'state' ],
	'iwinfo': [ 'info', 'assoclist', 'freqlist', 'txpowerlist', 'countrylist', 'devices', 'phyname', 'survey' ],
	'file': [ 'read', 'stat', 'list', 'md5' ],
	'rc': [ 'list' ],
	'service': [ 'list' ],
	'log': [ 'read' ],
	'dhcp': [ 'ipv4leases', 'ipv6leases' ]
};
/* whole objects whose getX methods are reads by LuCI convention */
const READ_PREFIX = { 'luci': /^get/, 'luci-rpc': /^get/ };
/* hostapd per-interface objects (hostapd.phy0-ap0 ...) */
const HOSTAPD_READ = [ 'get_status', 'get_clients', 'get_features', 'rrm_nr_get_own', 'get_bss_steering' ];

/* The only commands a page may run while recording: the exact read-only
   invocations LuCI's own status pages use (routing, firewall, kernel log).
   Compared as whole argument vectors, never as prefixes or patterns. */
const EXEC_READ = new Set([
	[ '/sbin/ip', '-4', 'neigh', 'show' ], [ '/sbin/ip', '-6', 'neigh', 'show' ],
	[ '/sbin/ip', '-4', 'route', 'show', 'table', 'all' ], [ '/sbin/ip', '-6', 'route', 'show', 'table', 'all' ],
	[ '/sbin/ip', '-4', 'rule', 'show' ], [ '/sbin/ip', '-6', 'rule', 'show' ],
	[ '/sbin/ip', '-4', '-j', 'neigh', 'show' ], [ '/sbin/ip', '-6', '-j', 'neigh', 'show' ],
	[ '/sbin/ip', '-4', '-j', 'route', 'show', 'table', 'all' ], [ '/sbin/ip', '-6', '-j', 'route', 'show', 'table', 'all' ],
	[ '/sbin/ip', '-4', '-j', 'rule', 'show' ], [ '/sbin/ip', '-6', '-j', 'rule', 'show' ],
	[ '/usr/sbin/nft', '--terse', '--json', 'list', 'ruleset' ],
	[ '/usr/sbin/iptables-save' ], [ '/usr/sbin/ip6tables-save' ],
	[ '/usr/sbin/iptables-legacy-save' ], [ '/usr/sbin/ip6tables-legacy-save' ],
	[ '/bin/dmesg', '-r' ]
].map(v => JSON.stringify(v)));

function execAllowed(argv) {
	return Array.isArray(argv) && argv.every(a => typeof a === 'string') && EXEC_READ.has(JSON.stringify(argv));
}

/* file.exec RPC arguments: { command, params } */
function execArgsAllowed(args) {
	if (!args || typeof args.command !== 'string') return false;
	if (args.env && Object.keys(args.env).length) return false;
	return execAllowed([ args.command ].concat(Array.isArray(args.params) ? args.params : []));
}

/* cgi-exec form body: command=<space-separated, backslash-escaped argv> */
function cgiExecArgv(body) {
	let cmd;
	try { cmd = new URLSearchParams(body).get('command'); } catch (e) { return null; }
	if (typeof cmd !== 'string') return null;
	const argv = []; let cur = '', esc = false;
	for (const ch of cmd) {
		if (esc) { cur += ch; esc = false; }
		else if (ch === '\\') esc = true;
		else if (ch === ' ') { argv.push(cur); cur = ''; }
		else cur += ch;
	}
	argv.push(cur);
	return argv;
}

/* HTTP endpoints besides /ubus that must never be hit while recording */
const BLOCKED_HTTP = [
	/\/cgi-bin\/cgi-(upload|exec|backup|download)\b/,
	/\/admin\/uci\/(apply|apply_rollback|apply_unchecked|confirm|revert)\b/,
	/\/admin\/system\/(flash|reboot)\/[a-z]/
];

function isReadCall(object, method, args) {
	if (typeof object !== 'string' || typeof method !== 'string') return false;
	if (object === 'file' && method === 'exec') return execArgsAllowed(args);
	if (Object.prototype.hasOwnProperty.call(READ, object)) return READ[object].indexOf(method) >= 0;
	if (Object.prototype.hasOwnProperty.call(READ_PREFIX, object)) return READ_PREFIX[object].test(method);
	if (/^hostapd\.[A-Za-z0-9_.-]+$/.test(object)) return HOSTAPD_READ.indexOf(method) >= 0;
	return false;
}

/* JSON-RPC body -> list of {object, method, args} or {list: true} */
function parseRpc(body) {
	let msgs;
	try { msgs = JSON.parse(body); } catch (e) { return null; }
	if (!Array.isArray(msgs)) msgs = [ msgs ];
	return msgs.map(function(m) {
		if (!m || typeof m !== 'object') return { bad: true };
		if (m.method === 'list') return { list: true, id: m.id };
		if (m.method !== 'call' || !Array.isArray(m.params)) return { bad: true };
		return { id: m.id, object: m.params[1], method: m.params[2], args: m.params[3] || {} };
	});
}

function rpcAllowed(body) {
	const calls = parseRpc(body);
	if (!calls) return { ok: false, why: 'unparseable RPC body' };
	for (const c of calls) {
		if (c.bad) return { ok: false, why: 'malformed RPC message' };
		if (c.list) continue;
		if (!isReadCall(c.object, c.method, c.args)) return { ok: false, why: c.object + '.' + c.method + ' is not on the read allowlist' };
	}
	return { ok: true, calls: calls };
}

function httpAllowed(url, method) {
	for (const re of BLOCKED_HTTP) if (re.test(url)) return { ok: false, why: 'blocked endpoint ' + url };
	return { ok: true };
}

/* ---------------------------------------------------------------- secrets */

const SECRET_KEY = /^(key[1-4]?|password|passwd|pass|psk|wpa_psk|sae_password|sae_pwe_secret|auth_secret|acct_secret|dae_secret|priv_key(_pwd)?|private_key|preshared_key|secret|token|ppsk|mesh_psk|ubus_rpc_session|sessionid|shared_secret|pin|wps_pin|client_secret|api_key|apikey)$/i;
const SECRET_FILE = /^(\/etc\/shadow|\/etc\/dropbear\/.*|\/root\/\.ssh\/.*|.*\.(key|pem|p12|pfx)|\/etc\/uhttpd\.(key|crt)|\/etc\/config\/(rpcd|wireguard.*))$/;
const SECRET_TEXT = [
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	/\$[1256y]\$[^\s:'"]+/g,                     /* crypt(3) password hashes */
	/\b(ssh-(ed25519|rsa|dss)|ecdsa-sha2-[a-z0-9-]+) AAAA[A-Za-z0-9+/=]+/g
];
const REDACTED = '<redacted>';

function scrubText(s) {
	let out = s;
	for (const re of SECRET_TEXT) out = out.replace(re, REDACTED);
	return out;
}

function sanitize(value, depth) {
	depth = depth || 0;
	if (depth > 64) return REDACTED;
	if (typeof value === 'string') return scrubText(value);
	if (Array.isArray(value)) return value.map(function(v) { return sanitize(v, depth + 1); });
	if (value && typeof value === 'object') {
		const out = {};
		for (const k of Object.keys(value)) {
			if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
			out[k] = SECRET_KEY.test(k) ? REDACTED : sanitize(value[k], depth + 1);
		}
		return out;
	}
	return value;
}

/* file.read of a sensitive path: keep the call, drop the content */
function sanitizeResult(object, method, args, result) {
	if (object === 'file' && args && typeof args.path === 'string' && SECRET_FILE.test(args.path))
		return Array.isArray(result) ? [ result[0], { data: REDACTED } ] : REDACTED;
	return sanitize(result);
}

module.exports = { execAllowed, cgiExecArgv, isReadCall, parseRpc, rpcAllowed, httpAllowed, sanitize, sanitizeResult, REDACTED };
