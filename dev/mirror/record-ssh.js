#!/usr/bin/env node
'use strict';
/* Record time-series snapshots of the data the dashboard uses, over SSH.

   Runs a fixed, read-only command loop on the device (no argument from this
   side reaches the remote shell except the numeric sample count/interval):
   system/network/wireless/hostapd status every <interval> seconds. Output is
   parsed and sanitized (policy.js) locally before anything is written.

   usage: node record-ssh.js <ssh-target> <mirror-dir> [samples=180] [interval=5] [ssh options...] */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const policy = require('./policy');

const [ target, outRoot, samplesArg, intervalArg, ...sshOpts ] = process.argv.slice(2);
const samples = parseInt(samplesArg || '180', 10), interval = parseInt(intervalArg || '5', 10);
if (!target || !outRoot || !(samples > 0 && samples <= 5000) || !(interval >= 1 && interval <= 300)) {
	console.error('usage: record-ssh.js <ssh-target> <mirror-dir> [samples] [interval] [ssh options...]');
	process.exit(2);
}
const out = path.join(outRoot, 'ssh-' + new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(out, { recursive: true, mode: 0o700 });
const log = fs.openSync(path.join(out, 'snapshots.jsonl'), 'a', 0o600);

/* read-only loop; everything it runs is a query */
const remote = `
n=0
ubus call system board >/dev/null 2>&1 && { echo "@@C system board {}"; ubus call system board; }
while [ $n -lt ${samples} ]; do
  echo "@@T $(date +%s)"
  for c in "system info" "network.interface dump" "network.device status" "network.wireless status" "luci-rpc getWirelessDevices" "luci-rpc getHostHints"; do
    echo "@@C $c {}"; ubus call $c 2>/dev/null || echo '{"@@error":1}'
  done
  for d in $(ubus call luci-rpc getWirelessDevices 2>/dev/null | jsonfilter -e '@.*.interfaces[*].ifname' 2>/dev/null); do
    a="{\\"device\\":\\"$d\\"}"
    echo "@@C iwinfo assoclist $a"; ubus call iwinfo assoclist "$a" 2>/dev/null || echo '{"@@error":1}'
    echo "@@C iwinfo info $a"; ubus call iwinfo info "$a" 2>/dev/null || echo '{"@@error":1}'
    for m in get_status get_clients; do
      echo "@@C hostapd.$d $m {}"; ubus call hostapd.$d $m 2>/dev/null || echo '{"@@error":1}'
    done
  done
  echo "@@F /proc/stat"; head -n 9 /proc/stat
  echo "@@E"
  n=$((n+1)); [ $n -lt ${samples} ] && sleep ${interval}
done
`;

const ssh = spawn('ssh', [ ...sshOpts, '-o', 'BatchMode=yes', target, 'sh -s' ], { stdio: [ 'pipe', 'pipe', 'inherit' ] });
ssh.stdin.end(remote);

let t = null, cur = null, buf = [], count = 0, calls = 0;
function flush() {
	if (!cur) return;
	const text = buf.join('\n');
	if (cur.kind === 'file') {
		fs.writeSync(log, JSON.stringify({ at: t, object: 'file', method: 'read', args: { path: cur.path }, result: { data: policy.sanitize(text + '\n') } }) + '\n');
	} else {
		let result;
		try { result = JSON.parse(text); } catch (e) { result = undefined; }
		const error = !result || result['@@error'] ? true : undefined;
		fs.writeSync(log, JSON.stringify({ at: t, object: cur.object, method: cur.method, args: policy.sanitize(cur.args),
			result: error ? undefined : policy.sanitizeResult(cur.object, cur.method, cur.args, result), error }) + '\n');
	}
	calls++; cur = null; buf = [];
}

readline.createInterface({ input: ssh.stdout }).on('line', line => {
	let m;
	if ((m = /^@@T (\d+)$/.exec(line))) { flush(); t = +m[1] * 1000; }
	else if ((m = /^@@C (\S+) (\S+) (.*)$/.exec(line))) { flush(); let a = {}; try { a = JSON.parse(m[3]); } catch (e) {} cur = { object: m[1], method: m[2], args: a }; }
	else if ((m = /^@@F (\S+)$/.exec(line))) { flush(); cur = { kind: 'file', path: m[1] }; }
	else if (line === '@@E') { flush(); count++; if (count % 12 === 0) console.log('samples', count, 'calls', calls); }
	else if (cur) buf.push(line);
});
ssh.on('exit', code => {
	flush();
	fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ target: target.replace(/^.*@/, ''), samples: count, calls, interval, exit: code, finished: new Date().toISOString() }, null, 2), { mode: 0o600 });
	console.log('done', count, 'samples,', calls, 'calls, exit', code);
});
