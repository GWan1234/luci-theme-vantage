'use strict';
/* Data layer: CPU, memory breakdown, counters, uplink resolution, the
   assembled model. Fixtures are synthetic (documentation MAC/IP ranges)
   but keep the shapes of the real ubus replies of an ipq53xx AP. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./luci-stub');

const model = load('vantage.model');

test('parseStat: aggregate and per-core idle/total', () => {
	const s = model.parseStat('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 60 0 20 400 20 0 0 0\ncpu1 40 0 30 400 30 0 0 0\nintr 1 2\n');
	assert.deepEqual(s.all, { idle: 850, total: 1000 });
	assert.equal(s.cores.length, 2);
	assert.deepEqual(s.cores[1], { idle: 430, total: 500 });
	assert.equal(model.parseStat('garbage'), null);
	assert.equal(model.parseStat(null), null);
});

test('cpuUsage: percent from deltas, per core, null without progress', () => {
	const a = model.parseStat('cpu  100 0 0 900 0 0 0 0\ncpu0 50 0 0 450\ncpu1 50 0 0 450\n');
	const b = model.parseStat('cpu  150 0 0 950 0 0 0 0\ncpu0 100 0 0 450\ncpu1 50 0 0 500\n');
	const u = model.cpuUsage(a, b);
	assert.equal(u.pct, 50);
	assert.deepEqual(u.cores, [ 100, 0 ]);
	assert.equal(model.cpuUsage(a, a), null);
	assert.equal(model.cpuUsage(null, b), null);
});

test('memory: one bar of In use / Cache (reclaimable) / Free adding up to total', () => {
	const m = model.memory({ total: 1000, free: 300, available: 600, buffered: 10, cached: 200, shared: 5 });
	assert.equal(m.used, 400);
	assert.equal(m.cache, 300);
	assert.equal(m.free, 300);
	assert.equal(m.availPct, 60);
	assert.deepEqual(m.segments.map(s => s.label), [ 'In use', 'Cache (reclaimable)', 'Free' ]);
	assert.equal(m.segments.reduce((a, s) => a + s.bytes, 0), 1000);
	assert.equal(Math.round(m.segments.reduce((a, s) => a + s.pct, 0)), 100);
});

test('memory: without available, free + buffered + cached stands in', () => {
	const m = model.memory({ total: 1000, free: 300, buffered: 50, cached: 150 });
	assert.equal(m.available, 500);
	assert.equal(m.used, 500);
	assert.equal(m.cache, 200);
});

test('memory: inconsistent numbers are clamped, junk gives null', () => {
	const m = model.memory({ total: 1000, free: 1200, available: 900 });
	assert.equal(m.free, 1000);
	assert.equal(m.available, 1000);
	assert.equal(m.used, 0);
	assert.equal(model.memory({ total: 0 }), null);
	assert.equal(model.memory(null), null);
	/* available below free: never a negative cache segment */
	const n = model.memory({ total: 1000, free: 400, available: 300 });
	assert.equal(n.cache, 0);
	assert.equal(n.used, 600);
});

test('swap only when configured; mounts in bytes', () => {
	assert.equal(model.swap({ total: 0, free: 0 }), null);
	assert.deepEqual(model.swap({ total: 100, free: 25 }), { total: 100, free: 25, used: 75, usedPct: 75 });
	const r = model.mount({ total: 100, free: 90, used: 10, avail: 80 }, 'root');
	assert.equal(r.total, 102400);
	assert.equal(r.used, 10240);
	assert.equal(r.free, 81920);
	assert.equal(r.usedPct, 10);
	assert.equal(model.mount({}, 'x'), null);
});

test('counterRate: states and bit/s', () => {
	assert.equal(model.counterRate(null, { at: 1, rx: 0, tx: 0 }).state, 'first');
	assert.equal(model.counterRate({ at: 1000, rx: 0, tx: 0 }, { at: 1500, rx: 10, tx: 10 }).state, 'skip');
	assert.equal(model.counterRate({ at: 0, rx: 100, tx: 0 }, { at: 5000, rx: 50, tx: 0 }).state, 'reset');
	const r = model.counterRate({ at: 0, rx: 0, tx: 1000 }, { at: 5000, rx: 5000, tx: 1000 });
	assert.equal(r.state, 'ok');
	assert.equal(r.rx, 8000);
	assert.equal(r.tx, 0);
});

test('rates: keeps only present keys, skip keeps the old base', () => {
	const a = model.rates(null, { x: { rx: 0, tx: 0 }, y: { rx: 0, tx: 0 } }, 0);
	assert.deepEqual(Object.keys(a.rates), []);
	const b = model.rates(a.next, { x: { rx: 1000, tx: 0 } }, 500);
	assert.deepEqual(Object.keys(b.next), [ 'x' ]);
	assert.equal(b.next.x.at, 0);   /* too close: base kept */
	const c = model.rates(b.next, { x: { rx: 1000, tx: 0 } }, 1000);
	assert.equal(c.rates.x.rx, 8000);
});

const IFACES = [
	{ interface: 'loopback', up: true, l3_device: 'lo', device: 'lo' },
	{ interface: 'lan', up: true, l3_device: 'br-lan', device: 'br-lan', proto: 'static', uptime: 100,
	  'ipv4-address': [ { address: '192.0.2.10', mask: 24 } ],
	  route: [ { target: '0.0.0.0', mask: 0, nexthop: '192.0.2.1' } ], 'dns-server': [ '192.0.2.1' ] }
];
const DEVS = {
	'br-lan': { type: 'bridge', devtype: 'bridge', 'bridge-members': [ 'phy6g-ap0', 'eth0', 'phy2g-ap0' ] },
	'eth0': { devtype: 'ethernet', speed: '2500F', carrier: true, statistics: { rx_bytes: 1, tx_bytes: 2 } },
	'phy2g-ap0': { up: true }, 'phy6g-ap0': { up: true }
};

test('resolveUplink: AP bridge -> wired member, gateway and addresses', () => {
	const u = model.resolveUplink(IFACES, DEVS, [ 'phy2g-ap0', 'phy6g-ap0' ]);
	assert.equal(u.iface, 'lan');
	assert.equal(u.dev, 'eth0');
	assert.equal(u.isWan, false);
	assert.deepEqual(u.speed, { mbps: 2500, duplex: 'full' });
	assert.equal(u.gateway, '192.0.2.1');
	assert.deepEqual(u.ipv4, [ '192.0.2.10/24' ]);
	assert.equal(model.resolveUplink([], {}), null);
});

test('resolveUplink: router prefers wan, DSA offload uses conduit', () => {
	const u = model.resolveUplink([ ...IFACES, { interface: 'wan', up: true, l3_device: 'wan', device: 'wan' } ],
		{ wan: { devtype: 'dsa', 'hw-tc-offload': true, conduit: 'eth1' }, eth1: {} });
	assert.equal(u.iface, 'wan');
	assert.equal(u.isWan, true);
	assert.equal(u.statsDev, 'eth1');
});

test('deviceModel: board_name beats a reference-design model string', () => {
	assert.equal(model.deviceModel({ model: 'Qualcomm Technologies, Inc. IPQ5332/RDP442/AP-MI01.3', board_name: 'zyxel,nwa50be' }), 'Zyxel NWA50BE');
	assert.equal(model.deviceModel({ model: 'Example Router X1', board_name: 'example,x1' }), 'Example Router X1');
	assert.equal(model.deviceModel({}), null);
});

test('hintAddrs: IPv4 outside the uplink subnets is dropped', () => {
	const ips = model.hintAddrs({ ipaddrs: [ '192.0.2.44', '198.51.100.9', 'x' ], ip6addrs: [ 'fe80::1' ] }, [ '192.0.2.10/24' ]);
	assert.deepEqual(ips, [ '192.0.2.44', 'fe80::1' ]);
});

/* a two-radio AP: 2.4 GHz with two SSIDs, 6 GHz with one */
function raw() {
	return {
		board: { hostname: 'ap-test', model: 'Qualcomm Technologies, Inc. IPQ5332/RDP442', board_name: 'zyxel,nwa50be',
			release: { description: 'OpenWrt 25.12.3 r1', version: '25.12.3' } },
		info: { uptime: 5000, load: [ 65536, 0, 0 ], memory: { total: 1000, free: 300, available: 600 },
			root: { total: 100, used: 10, free: 90, avail: 80 }, tmp: { total: 50, used: 1, free: 49 }, swap: { total: 0, free: 0 } },
		ifaces: IFACES,
		devs: DEVS,
		wifi: {
			radio0: { up: true, config: { band: '2g', channel: '6', htmode: 'EHT20', txpower: 30 },
				iwinfo: { noise: -109, frequency: 2437, channel: 6, txpower: 19 },
				interfaces: [
					{ section: 'a', ifname: 'phy2g-ap0', config: { ssid: 'Home', encryption: 'sae-mixed', network: [ 'lan' ] }, iwinfo: {} },
					{ section: 'b', ifname: 'phy2g-ap1', config: { ssid: 'Legacy', encryption: 'psk2', network: [ 'lan' ] }, iwinfo: {} }
				] },
			radio1: { up: true, config: { band: '6g', channel: '5', htmode: 'EHT160' },
				iwinfo: { noise: -121, frequency: 5975 },
				interfaces: [ { section: 'c', ifname: 'phy6g-ap0', config: { ssid: 'Home', encryption: 'sae', network: [ 'lan' ] }, iwinfo: {} } ] }
		},
		iwinfo: {
			'phy2g-ap0': { channel: 6, center_chan1: 6, frequency: 2437, txpower: 19, noise: -87, htmode: 'EHT20' },
			'phy6g-ap0': { channel: 5, center_chan1: 15, frequency: 5975, txpower: 21, noise: -121, htmode: 'EHT160' }
		},
		assoc: {
			'phy2g-ap1': [ { mac: '00:00:5E:00:53:01', signal: -50, connected_time: 60, inactive: 100,
				rx: { rate: 1000, mhz: 20, bytes: 10, packets: 1 }, tx: { rate: 1000, mhz: 20, bytes: 20, packets: 100, failed: 1 } } ],
			'phy6g-ap0': [ { mac: '02:00:5E:00:53:02', signal: -81, noise: -121, connected_time: 999, inactive: 0,
				rx: { rate: 576400, mhz: 160, eht: true, mcs: 3, nss: 2, bytes: 5, packets: 5 }, tx: { rate: 720600, mhz: 160, eht: true, bytes: 7, packets: 5000, failed: 10 } } ]
		},
		hapd: {
			'phy2g-ap1': { clients: { '00:00:5e:00:53:01': { ht: true, signature: 'wifi4|probe:0,1,wps:Office_Printer_9|assoc:0,1' } } }
		},
		hints: { '00:00:5E:00:53:01': { ipaddrs: [ '192.0.2.44' ], ip6addrs: [] } },
		aliases: {}
	};
}

test('build: radios, SSIDs and stations with names, bands and generations', () => {
	const m = model.build(raw());
	assert.equal(m.device.model, 'Zyxel NWA50BE');
	assert.equal(m.device.memory.used, 400);
	assert.equal(m.uplink.dev, 'eth0');
	assert.deepEqual(m.radios.map(r => [ r.id, r.band, r.width, r.clients, r.gen ]), [ [ 'radio0', '2g', 20, 1, 'Wi-Fi 7' ], [ 'radio1', '6g', 160, 1, 'Wi-Fi 7' ] ]);
	assert.equal(m.radios[0].noise, -87);
	assert.equal(m.radios[1].noise, null, 'ath12k placeholder noise is unknown, not a number');
	assert.equal(m.radios[1].spectrum.centre, 6025);
	assert.deepEqual(m.ssids.map(s => [ s.ssid, s.security.short, s.clients ]), [ [ 'Home', 'WPA2/3', 0 ], [ 'Legacy', 'WPA2', 1 ], [ 'Home', 'WPA3', 1 ] ]);

	const [ printer, phone ] = m.clients;
	assert.equal(printer.name, 'Office Printer 9');
	assert.equal(printer.nameSource, 'wps');
	assert.equal(printer.icon, 'printer');
	assert.equal(printer.secondary, '192.0.2.44');
	assert.equal(printer.gen, 'Wi-Fi 4');
	assert.equal(printer.legacyOnRadio, true);
	assert.equal(m.radios[0].legacy, 1);
	assert.equal(phone.name, 'Private device · …00:53:02');
	assert.equal(phone.isPrivate, true);
	assert.equal(phone.secondary, '02:00:5E:00:53:02');
	assert.equal(phone.gen, 'Wi-Fi 7');
	assert.equal(phone.rx.label, '576 Mbit/s · 160 MHz · EHT');
	assert.equal(phone.level.level, 'crit');
});

test('build: user alias wins over every other source', () => {
	const r = raw();
	r.aliases = { '00:00:5e:00:53:01': { sid: 'cfg01', name: 'Hall printer', icon: 'printer' } };
	const c = model.build(r).clients[0];
	assert.equal(c.name, 'Hall printer');
	assert.equal(c.nameSource, 'alias');
	assert.equal(c.aliasSid, 'cfg01');
});

test('build: empty or broken replies give an empty model, not an exception', () => {
	const m = model.build({ wifi: { radio0: null }, assoc: { x: 'nope' }, info: 'junk' });
	assert.deepEqual(m.clients, []);
	assert.equal(m.uplink, null);
	assert.equal(m.device.memory, null);
	assert.deepEqual(model.build(undefined).radios, []);
});

test('groupSsids: same name and security across radios is one network', () => {
	const g = model.groupSsids([
		{ id: 'a', ssid: 'Home', security: { short: 'WPA3' }, band: '2g', radio: 'r0', clients: 1, up: true },
		{ id: 'b', ssid: 'Home', security: { short: 'WPA3' }, band: '6g', radio: 'r1', clients: 2, up: true },
		{ id: 'c', ssid: 'Home', security: { short: 'WPA2' }, band: '2g', radio: 'r0', clients: 0, up: true }
	]);
	assert.equal(g.length, 2);
	assert.deepEqual(g[0].bands, [ '2g', '6g' ]);
	assert.equal(g[0].clients, 3);
});

test('sampleClock: same device sample is skipped, drift uses device spacing', () => {
	const a = model.sampleClock(null, 10000, 500);
	assert.deepEqual(a, { at: 10000, local: 500 });
	/* normal: browser time */
	assert.deepEqual(model.sampleClock(a, 15020, 505), { at: 15020, local: 505 });
	/* the same snapshot again: dt 0 -> counterRate 'skip' */
	const s = model.sampleClock(a, 15020, 500);
	assert.equal(s.at, 10000);
	assert.equal(model.counterRate({ at: 10000, rx: 0, tx: 0 }, { at: s.at, rx: 5, tx: 5 }).state, 'skip');
	/* reply arrived 10 s later but the device advanced 5 s */
	assert.deepEqual(model.sampleClock(a, 20000, 505), { at: 15000, local: 505 });
	/* no localtime: browser time */
	assert.deepEqual(model.sampleClock(a, 12000, undefined), { at: 12000, local: null });
});
