'use strict';
/* Demo mode (--demo): pseudonymise the recorded device data.

   The replay normally serves the mirror as recorded: real MAC addresses,
   LAN addresses, hostname, SSIDs, client names. With --demo every recorded
   reply is rewritten once, when the mirror is loaded and before anything
   (ubus JSON-RPC, cgi-exec text, server-side templates, the synthetic data
   derived from recorded series) can read it, so screenshots and screen
   shares carry no real identifiers. The mapping is deterministic for a
   given mirror and consistent within a run: the same real value always
   becomes the same demo value, in JSON values, JSON keys and free text.

     MAC / BSSID    universal  -> 00:00:5E:00:53:xx (RFC 7042 documentation
                                  range; 04:/08:/0C: first octets after 256)
                    local      -> 02:00:5E:00:53:xx (U/L bit kept, so
                                  randomised client MACs stay "private";
                                  06:/0A:/0E: after 256)
                    group      -> 01:00:5E:90:10:xx (documentation multicast)
                    00:00:00:00:00:00 and FF:FF:FF:FF:FF:FF are kept; the
                    bare 12-digit form of a known MAC (bridge ids, DUIDs) is
                    rewritten too
    IPv4           private/CGNAT/link-local, per /24: the first two
                    networks -> 192.0.2.0/24, 198.51.100.0/24 keeping the
                    last octet (the gateway stays .1); other networks and
                    public addresses -> 203.0.113.x
    IPv6           global -> 2001:db8:<n>::/48 (per real /48, subnet id
                    kept); unique-local -> 2001:db8:fd<n>::/48; long
                    interface identifiers (EUI-64, random) -> ::<n>, so
                    link-local addresses become short fe80::<n> forms
    AP hostname    -> vantage-ap
    SSIDs          by band, in wireless config order: 2.4 GHz Harbor,
                    Harbor-IoT, Harbor-Guest; 5 GHz Harbor-5G; 6 GHz
                    Harbor-6E (others Harbor-<n>)
    client names   hostnames and WPS device names -> generic names by
                    device type ("office-printer" / "Office printer",
                    otherwise device-<n> / "Wireless device <n>")
    domains        -> home.arpa
    DUIDs          -> 0004 00005e0053xx... (per DUID)
    country        -> US (wifi country codes; iwinfo countrylist marks US
                    active). Channel and power data stay as recorded.
    time zone      -> UTC (zonename), UTC0 (timezone); getTimezones marks
                    UTC active
    SSH key fingerprints (SHA256:/MD5: in logs) -> a fixed placeholder
    serial numbers (serial, serial_number, sn keys) are removed

   Names are found the way security-tests/check_private_addresses.js finds
   mirror identifiers (its list is merged in), plus names with spaces and
   WPS names from hostapd client signatures. Kept as is: the device model
   and board name (that is the product), interface names, firmware
   versions, counters, rates and signal values. */

const checker = require('../../security-tests/check_private_addresses');

const AP_HOSTNAME = 'vantage-ap';
const DEMO_COUNTRY = 'US';
const DEMO_ZONENAME = 'UTC', DEMO_TIMEZONE = 'UTC0';
const DEMO_DOMAIN = 'home.arpa';
const FINGERPRINT = 'SHA256:demo0demo0demo0demo0demo0demo0demo0demo0dem';
const SSIDS = {
	'2g': [ 'Harbor', 'Harbor-IoT', 'Harbor-Guest' ],
	'5g': [ 'Harbor-5G', 'Harbor-5G-IoT' ],
	'6g': [ 'Harbor-6E' ],
	'60g': [ 'Harbor-60G' ]
};
/* device-type guesses for client names: [ test, host name, device name ] */
const KINDS = [
	[ /print|envy|officejet|laserjet|deskjet|epson|brother|canon|pixma|kyocera|xerox/i, 'office-printer', 'Office printer' ],
	[ /(^|[^a-z])tv([^a-z]|$)|bravia|roku|chromecast|firetv|fire-tv|appletv|apple-tv|webos|tizen|shield/i, 'living-room-tv', 'Living room TV' ],
	[ /iphone|android|pixel|galaxy|phone|redmi|oneplus|xiaomi|motorola/i, 'phone', 'Phone' ],
	[ /ipad|tablet|kindle/i, 'tablet', 'Tablet' ],
	[ /macbook|laptop|thinkpad|notebook|surface|xps|zenbook|latitude/i, 'laptop', 'Laptop' ],
	[ /echo|sonos|homepod|nest|alexa|speaker/i, 'kitchen-speaker', 'Kitchen speaker' ],
	[ /cam|doorbell/i, 'doorbell-camera', 'Doorbell camera' ],
	[ /nas|synology|qnap|diskstation/i, 'nas', 'NAS' ],
	[ /desktop|workstation|imac/i, 'desktop', 'Desktop' ]
];

const HEX2 = n => n.toString(16).padStart(2, '0');
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/* RFC 5952 text form of 8 x 16-bit groups */
function v6text(g) {
	let best = -1, bestLen = 1;
	for (let i = 0; i < 8; i++) {
		if (g[i]) continue;
		let j = i;
		while (j < 8 && !g[j]) j++;
		if (j - i > bestLen) { best = i; bestLen = j - i; }
		i = j;
	}
	const h = g.map(x => x.toString(16));
	if (best < 0) return h.join(':');
	return h.slice(0, best).join(':') + '::' + h.slice(best + bestLen).join(':');
}

class Pseudonymiser {
	constructor() {
		this.macs = new Map();       /* 12 lowercase hex -> 12 lowercase hex */
		this.macCount = { u: 0, l: 0, g: 0 };
		this.v4nets = new Map();     /* 'a.b.c' -> 'x.y.z' */
		this.v4other = new Map();    /* 'a.b.c.d' -> '203.0.113.n' */
		this.v6nets = new Map();     /* '2a02:...:...' -> [ g0, g1, g2 ] */
		this.iids = new Map();       /* 'g4:g5:g6:g7' -> n */
		this.names = new Map();      /* lowercase real -> demo */
		this.kindCount = new Map();
		this.countries = new Set();
		this.duids = 0;
		this.literalRe = null;
		this.bareRe = null;
	}

	/* ------------------------------------------------------------ learning */

	/* every MAC in a string, so the bare hex form is known before use */
	learnText(s) {
		for (const m of s.matchAll(checker.MAC_SEP)) this.mac(m[1].replace(/[^0-9a-f]/gi, ''));
		for (const m of s.matchAll(checker.MAC_DOT)) this.mac(m[1].replace(/[^0-9a-f]/gi, ''));
	}

	name(real, kind) {
		if (typeof real !== 'string') return;
		let v = real.trim().replace(/\.$/, '');
		if (v.length < 3 || v.length > 100 || /^[\d.:]+$/.test(v) || checker.GENERIC.has(v.toLowerCase())) return;
		if (/^<redacted>$/.test(v)) return;
		const key = v.toLowerCase();
		if (this.names.has(key)) return;
		let demo;
		if (kind === 'ap') demo = AP_HOSTNAME;
		else if (kind === 'domain') demo = DEMO_DOMAIN;
		else if (kind === 'ssid') demo = this.next('ssid', n => 'Harbor-' + (n + 1));
		else if (kind === 'fqdn' && v.includes('.')) {
			this.name(v.split('.')[0], 'host');
			demo = (this.names.get(v.split('.')[0].toLowerCase()) || 'device') + '.' + DEMO_DOMAIN;
		}
		else {
			const device = kind === 'device', k = KINDS.find(x => x[0].test(v));
			const base = k ? (device ? k[2] : k[1]) : (device ? 'Wireless device' : 'device');
			const n = this.next((device ? 'D ' : 'H ') + base, n => n);
			demo = (k && n === 0) ? base : base + (device ? ' ' : '-') + (n + 1);
			/* hostapd writes WPS names with '_' for ' ' */
			if (device && /_/.test(v) && !/ /.test(v)) demo = demo.replace(/ /g, '_');
		}
		this.names.set(key, demo);
		if (kind === 'device') {
			/* the other spelling of a WPS name */
			const alt = /_/.test(v) ? v.replace(/_/g, ' ') : v.replace(/ /g, '_');
			if (!this.names.has(alt.toLowerCase())) this.names.set(alt.toLowerCase(), /_/.test(v) ? demo.replace(/_/g, ' ') : demo.replace(/ /g, '_'));
		}
		this.literalRe = null;
	}

	next(kind, fmt) {
		const n = this.kindCount.get(kind) || 0;
		this.kindCount.set(kind, n + 1);
		return fmt(n);
	}

	ssids(wireless) {
		/* uci wireless (or network.wireless status): SSIDs by band, in
		   section order */
		if (!wireless || typeof wireless !== 'object') return;
		const bands = {}, ifaces = [];
		for (const [ sid, s ] of Object.entries(wireless)) {
			if (!s || typeof s !== 'object') continue;
			if (s['.type'] === 'wifi-device') bands[sid] = s.band;
			else if (s['.type'] === 'wifi-iface' && typeof s.ssid === 'string') ifaces.push(s);
			else if (s.config && Array.isArray(s.interfaces)) {      /* network.wireless status */
				bands[sid] = s.config.band;
				for (const i of s.interfaces) if (i.config && typeof i.config.ssid === 'string') ifaces.push({ device: sid, ssid: i.config.ssid, '.index': ifaces.length });
			}
		}
		ifaces.sort((a, b) => (a['.index'] ?? 0) - (b['.index'] ?? 0));
		const used = {};
		for (const i of ifaces) {
			const key = i.ssid.trim().toLowerCase();
			if (!key || this.names.has(key)) continue;
			const band = bands[i.device] || '?';
			const list = SSIDS[band] || [];
			const n = used[band] = (used[band] || 0) + 1;
			const demo = list[n - 1] || (list[0] ? list[0] + '-' + n : null);
			if (demo) { this.names.set(key, demo); this.literalRe = null; }
		}
	}

	/* walk a recorded reply for names, countries, DUIDs and MACs */
	learn(x, key, ctx) {
		if (Array.isArray(x)) { for (const v of x) this.learn(v, key, ctx); return; }
		if (x && typeof x === 'object') {
			for (const [ k, v ] of Object.entries(x)) {
				this.learnText(k);
				if (ctx === 'umdns hosts' && v && typeof v === 'object') this.name(k, 'host');
				if (ctx === 'luci-rpc getDUIDHints') this.duid(k);
				this.learn(v, k, ctx);
			}
			return;
		}
		if (typeof x !== 'string') return;
		this.learnText(x);
		if (key === 'hostname') this.name(x, /^system (board|info)$/.test(ctx) || ctx === 'uci system' ? 'ap' : 'host');
		else if (key === 'ssid' || key === 'mesh_id') this.name(x, 'ssid');
		else if (key === 'domain' || key === 'dns_search' || key === 'dns-search') this.name(x, 'domain');
		else if (key === 'fqdn') this.name(x, 'fqdn');
		else if (key === 'wps_device_name' || key === 'device_name') this.name(x, 'device');
		else if (key === 'name' && /^(luci-rpc (getHostHints|getDHCPLeases)|dhcp ipv[46]leases|uci dhcp)$/.test(ctx)) this.name(x, 'host');
		else if (ctx === 'network.rrdns lookup') this.name(x, 'fqdn');
		else if (key === 'signature') {
			const m = /(?:^|[|,:])wps:([^|,]{1,64})/.exec(x);
			if (m) this.name(m[1], 'device');
		}
		else if (/duid/i.test(key || '') && /^[0-9a-f]{8,}$/i.test(x)) this.duid(x);
		else if (key === 'country' && /^[A-Z]{2}$/.test(x) && x !== '00' && x !== 'ZZ' && x !== DEMO_COUNTRY) this.countries.add(x);
		else if (key === 'data' && ctx === 'file read /proc/sys/kernel/hostname') this.name(x, 'ap');
	}

	duid(real) {
		if (typeof real !== 'string' || !/^[0-9a-f]{8,}$/i.test(real) || this.names.has(real.toLowerCase())) return;
		const n = ++this.duids;
		this.names.set(real.toLowerCase(), '0004' + ('00005e0053' + HEX2(n & 255)).padEnd(32, '0'));
		this.literalRe = null;
	}

	/* ------------------------------------------------------------- mapping */

	/* 12 hex digits -> 12 hex digits */
	mac(hex) {
		const h = hex.toLowerCase();
		if (/^0{12}$|^f{12}$/.test(h) || checker.MAC_ALLOWED.test(h.match(/../g).join(':'))) return h;
		let out = this.macs.get(h);
		if (out) return out;
		const o0 = parseInt(h.slice(0, 2), 16);
		if (o0 & 1) {
			const n = this.macCount.g++;
			out = '01005e9010' + HEX2(n & 255);
		}
		else {
			const local = !!(o0 & 2), c = local ? 'l' : 'u';
			const n = this.macCount[c]++;
			if (n < 1024) out = HEX2((local ? 0x02 : 0x00) | ((n >> 8) << 2)) + '005e0053' + HEX2(n & 255);
			else out = '02005e' + (0x010000 + n).toString(16).padStart(6, '0');   /* allowed local space */
		}
		this.macs.set(h, out);
		this.bareRe = null;
		return out;
	}

	v4(o) {
		const s = o.join('.');
		if (o.some(x => x > 255)) return s;
		const n = checker.v4int(o);
		const priv = !!checker.v4finding(o);
		if (!priv && (checker.PUBLIC_EXEMPT_V4.some(r => checker.inV4(n, r)) || n === 0xffffffff)) return s;
		if (priv) {
			const net24 = o.slice(0, 3).join('.');
			if (!this.v4nets.has(net24)) {
				const k = this.v4nets.size;
				this.v4nets.set(net24, [ '192.0.2', '198.51.100' ][k] || null);
			}
			const to = this.v4nets.get(net24);
			if (to) return to + '.' + o[3];
		}
		if (!this.v4other.has(s)) this.v4other.set(s, '203.0.113.' + (10 + this.v4other.size % 240));
		return this.v4other.get(s);
	}

	iid(g) {
		const k = g.slice(4).join(':');
		if (!this.iids.has(k)) this.iids.set(k, 0x10 + this.iids.size);
		return [ 0, 0, 0, this.iids.get(k) ];
	}

	v6(text) {
		const g = checker.v6groups(text);
		if (!g) return text;
		const lc = text.toLowerCase();
		if (lc === 'fd00::' || lc === 'fe80::') return text;
		const bigIid = !!(g[4] || g[5] || g[6]);
		let out = null;
		if ((g[0] & 0xe000) === 0x2000 && !(g[0] === 0x2001 && g[1] === 0x0db8)) {
			const k = g.slice(0, 3).join(':');
			if (!this.v6nets.has(k)) this.v6nets.set(k, [ 0x2001, 0x0db8, 1 + [ ...this.v6nets.values() ].filter(p => p[2] < 0xfd00).length ]);
			out = this.v6nets.get(k).concat(g[3], bigIid ? this.iid(g) : g.slice(4));
		}
		else if ((g[0] & 0xfe00) === 0xfc00) {
			const k = g.slice(0, 3).join(':');
			if (!this.v6nets.has(k)) this.v6nets.set(k, [ 0x2001, 0x0db8, 0xfd01 + [ ...this.v6nets.values() ].filter(p => p[2] >= 0xfd00).length ]);
			out = this.v6nets.get(k).concat(g[3], bigIid ? this.iid(g) : g.slice(4));
		}
		else if ((g[0] & 0xffc0) === 0xfe80 && bigIid) out = [ 0xfe80, 0, 0, 0 ].concat(this.iid(g));
		return out ? v6text(out) : text;
	}

	literals() {
		if (!this.literalRe) {
			const keys = [ ...this.names.keys() ].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
			this.literalRe = keys.length ? new RegExp('(?<![A-Za-z0-9])(' + keys.map(esc).join('|') + ')(?![A-Za-z0-9])', 'gi') : null;
		}
		return this.literalRe;
	}

	bare() {
		if (!this.bareRe) {
			const keys = [ ...this.macs.keys() ].filter(k => this.macs.get(k) !== k);
			this.bareRe = keys.length ? new RegExp('(' + keys.join('|') + ')', 'gi') : null;
		}
		return this.bareRe;
	}

	/* free text: logs, command output, any JSON string */
	text(s) {
		if (typeof s !== 'string' || !s) return s;
		s = s.replace(/\b(SHA256:[A-Za-z0-9+/=]{16,}|MD5:(?:[0-9a-f]{2}:){15}[0-9a-f]{2})/gi, FINGERPRINT);
		const lit = this.literals();
		if (lit) s = s.replace(lit, m => this.names.get(m.toLowerCase()) ?? m);
		const up = m => /[A-F]/.test(m) ? v => v.toUpperCase() : v => v;
		s = s.replace(checker.MAC_SEP, (m, mac, sep) => {
			const out = this.mac(m.replace(/[^0-9a-f]/gi, ''));
			return up(m)(out.match(/../g).join(sep));
		});
		s = s.replace(checker.MAC_DOT, m => up(m)(this.mac(m.replace(/\./g, '')).match(/.{4}/g).join('.')));
		const bare = this.bare();
		if (bare) s = s.replace(bare, m => up(m)(this.macs.get(m.toLowerCase())));
		s = s.replace(checker.IPV4, (m, a, b, c, d) => this.v4([ a, b, c, d ].map(Number)));
		s = s.replace(checker.IPV6, (m, addr, zone) => this.v6(addr) + (zone || ''));
		return s;
	}

	/* a JSON value; ctx is "object method" of the call it came from */
	value(x, key, ctx) {
		if (Array.isArray(x)) return x.map(v => this.value(v, key, ctx));
		if (x && typeof x === 'object') {
			const out = {};
			for (const [ k, v ] of Object.entries(x)) {
				if (/^(serial|serial_?number|sn)$/i.test(k)) continue;
				out[this.text(k)] = this.value(v, k, ctx);
			}
			if (ctx === 'iwinfo countrylist' && typeof out.code === 'string' && typeof out.active === 'boolean')
				out.active = (out.code === DEMO_COUNTRY);
			if (ctx === 'luci getTimezones' && key === undefined)
				for (const [ zone, z ] of Object.entries(out)) if (z && typeof z === 'object' && 'tzstring' in z) {
					if (zone === DEMO_ZONENAME) z.active = true; else delete z.active;
				}
			return out;
		}
		if (typeof x !== 'string') return x;
		if (key === 'country' && this.countries.has(x)) return DEMO_COUNTRY;
		if (key === 'zonename') return DEMO_ZONENAME;
		if (key === 'timezone') return DEMO_TIMEZONE;
		return this.text(x);
	}
}

/* Rewrite a loaded Store in place. `mirror` (optional) adds the identifier
   list of check_private_addresses.js. Returns the pseudonymiser. */
function pseudonymiseStore(store, mirror, argsKey) {
	const p = new Pseudonymiser();
	const ctxOf = key => { const [ o, m, a ] = key.split('\0'); return o === 'file' ? `${o} ${m} ${JSON.parse(a || '{}').path || ''}` : `${o} ${m}`; };
	const uciCtx = key => { const [ o, m, a ] = key.split('\0'); return (o === 'uci' && m === 'get') ? 'uci ' + (JSON.parse(a || '{}').config || '') : null; };
	const replyData = r => r && Array.isArray(r.result) ? r.result[1] : undefined;

	/* SSIDs first, so they get the band-ordered names */
	for (const [ key, reply ] of store.exact) if (uciCtx(key) === 'uci wireless') p.ssids((replyData(reply) || {}).values);
	for (const [ key, rows ] of store.series) if (key.startsWith('network.wireless\0status\0')) p.ssids(rows[rows.length - 1]);
	/* uci system hostname is the AP's */
	for (const [ key, reply ] of store.exact) if (uciCtx(key) === 'uci system') for (const s of Object.values((replyData(reply) || {}).values || {})) if (s && s['.type'] === 'system') p.name(s.hostname, 'ap');
	for (const [ key, reply ] of store.exact) p.learn(replyData(reply), undefined, uciCtx(key) || ctxOf(key));
	for (const [ key, rows ] of store.series) for (const r of rows) p.learn(r, undefined, ctxOf(key));
	for (const body of store.http.values()) typeof body === 'string' ? p.learnText(body) : p.learn(body, undefined, 'http');
	for (const out of store.exec.values()) p.learnText(out);
	if (mirror) {
		let ids = new Map();
		try { ids = checker.mirrorIdentifiers(mirror); } catch (e) {}
		for (const [ v, kind ] of ids) if (kind !== 'public IPv4') p.name(v, kind === 'SSID' ? 'ssid' : 'host');
	}

	const rekey = key => {
		const [ o, m, a ] = key.split('\0');
		let args;
		try { args = JSON.parse(a); } catch (e) { return key; }
		return `${o}\0${m}\0${argsKey(p.value(args, undefined, 'args'))}`;
	};
	const reply = (r, ctx) => r && r.result !== undefined ? { result: p.value(r.result, undefined, ctx) } : r;

	const exact = new Map();
	for (const [ key, r ] of store.exact) exact.set(rekey(key), reply(r, ctxOf(key)));
	store.exact = exact;
	for (const [ lk, r ] of store.loose) store.loose.set(lk, reply(r, lk.replace('\0', ' ')));
	const series = new Map(), seriesLoose = new Map();
	for (const [ key, rows ] of store.series) series.set(rekey(key), rows.map(r => p.value(r, undefined, ctxOf(key))));
	for (const [ lk, key ] of store.seriesLoose) seriesLoose.set(lk, rekey(key));
	store.series = series; store.seriesLoose = seriesLoose;
	for (const [ url, body ] of store.http) store.http.set(url, typeof body === 'string' ? p.text(body) : p.value(body, undefined, 'http'));
	const exec = new Map();
	for (const [ argv, out ] of store.exec) exec.set(p.text(argv), p.text(out));
	store.exec = exec;
	return p;
}

module.exports = { Pseudonymiser, pseudonymiseStore, v6text, AP_HOSTNAME, DEMO_COUNTRY, SSIDS };
