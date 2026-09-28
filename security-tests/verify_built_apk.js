#!/usr/bin/env node
'use strict';
/*
 * Check that built Vantage packages contain the reviewed source and nothing
 * else.
 *
 * Usage
 *   node security-tests/verify_built_apk.js [options] <package or directory>...
 *
 *   --src <dir>         source tree the packages were built from (a checkout
 *                       holding luci-theme-vantage/ and luci-app-vantage/)
 *   --rev <git-rev>     use `git archive <rev>` of this repository as source
 *                       (default: the rev in BUILDINFO next to the packages)
 *   --apk-tool <path>   apk-tools 3 binary (default: $VANTAGE_APK, then
 *                       dist/.tools/<release>/apk left by sdk-build.sh, then
 *                       `apk` in PATH)
 *   --jsmin <path>      LuCI's jsmin (default: $VANTAGE_JSMIN, then
 *                       dist/.tools/<release>/jsmin)
 *   --luci-config <f>   CONFIG_LUCI_* lines of the build's .config
 *                       (default: dist/.tools/<release>/luci.config)
 *   --index <file>      signed apk index (packages.adb) to check as well
 *   --keys-dir <dir>    public key(s) the index must verify against
 *   --mirror <dir>      private data mirror for check_private_addresses
 *                       (default: $VANTAGE_MIRROR, then ../vantage-mirror)
 *   --require-tools     fail instead of skipping when apk or jsmin is missing
 *                       (sdk-build.sh passes this)
 *
 * A directory argument means every *.apk / *.ipk in it (not recursive); a
 * SHA256SUMS file there must then list exactly those packages, correctly.
 *
 * Per package, expectations come from the package's Makefile and files in
 * the source tree, never from the package itself:
 *   - integrity: `apk verify` (apk); the ipk outer/inner tar archives unpack
 *   - metadata: name, version (PKG_VERSION-rPKG_RELEASE), arch noarch/all,
 *     license, depends exactly libc + LUCI_DEPENDS, provides only
 *     <name>-any, no other info fields (no triggers, replaces, ...)
 *   - scripts: exactly the ones OpenWrt's package-pack.mk generates from the
 *     Makefile's postinst/preinst/prerm/postrm (or luci.mk's default
 *     postinst), byte for byte
 *   - file list: the source files mapped as luci.mk installs them
 *     (htdocs/ -> www/, root/ -> /, ucode/ -> usr/share/ucode/luci/,
 *     luasrc/ -> usr/lib/lua/luci/) plus apk's own lib/apk/packages/
 *     <name>.list (and .conffiles, .conffiles_static when the Makefile
 *     declares conffiles); no other file, directory or symlink
 *   - modes: directories 0755, files 0644 or 0755 as in git, uci-defaults
 *     scripts 0755; owner root:root; never setuid/setgid/sticky or group- or
 *     world-writable
 *   - contents: byte-identical to the source after luci.mk's transforms:
 *     templates get "?v=<PKG_VERSION>" on {{ media }} / {{ resource }}
 *     .js/.css links, JavaScript goes through jsmin when CONFIG_LUCI_JSMIN
 *     is set, everything else is copied as is (LUCI_MINIFY_CSS:=0); every
 *     packaged .js must parse; conffiles lists match the Makefile and the
 *     packaged file hashes
 *   - no private addresses or recorded device identifiers
 *     (check_private_addresses.js detectors) in any packaged text or script
 *
 * The .ipk path (OpenWrt 23.05/24.10) follows the same rules but has not
 * been exercised against a real build of those releases.
 *
 * Exit status: 0 pass (or skipped: no apk tool and no --require-tools),
 * 1 verification failure, 2 usage or tool error.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PACKAGES = [ 'luci-theme-vantage', 'luci-app-vantage' ];

/* ------------------------------------------------------------ Makefile */

function unescapeMake(text, where) {
	const out = text.replace(/\$\$/g, '\0');
	if (out.includes('$'))
		throw new Error(`${where}: make expansion ($...) is not supported by the verifier; write the value literally`);
	return out.replace(/\0/g, '$');
}

function parseMakefile(text, file) {
	const lines = text.split('\n');
	const vars = {}, hooks = {};
	for (let i = 0; i < lines.length; i++) {
		const def = lines[i].match(/^define\s+Package\/([A-Za-z0-9._-]+)\/(\w+)\s*$/);
		if (def) {
			const body = [];
			for (i++; i < lines.length && !/^endef\s*$/.test(lines[i]); i++) body.push(lines[i]);
			if (i >= lines.length) throw new Error(`${file}: define without endef`);
			hooks[def[2]] = { pkg: def[1], text: body.join('\n') };
			continue;
		}
		const m = lines[i].match(/^([A-Z_]+)\s*:?=\s*(.*)$/);
		if (!m) continue;
		let value = m[2];
		while (value.endsWith('\\') && i + 1 < lines.length) value = value.slice(0, -1) + ' ' + lines[++i].trim();
		vars[m[1]] = value.trim();
	}
	const name = vars.PKG_NAME;
	if (!name || !PACKAGES.includes(name)) throw new Error(`${file}: unexpected PKG_NAME ${name}`);
	for (const [ hook, h ] of Object.entries(hooks))
		if (h.pkg !== name) throw new Error(`${file}: hook Package/${h.pkg}/${hook} is not for ${name}`);
	const version = vars.PKG_VERSION, release = vars.PKG_RELEASE;
	if (!/^[0-9A-Za-z.+~]+$/.test(version || '') || !/^[0-9]+$/.test(release || ''))
		throw new Error(`${file}: PKG_VERSION/PKG_RELEASE missing or unusual (${version}/${release})`);
	const depends = (vars.LUCI_DEPENDS || '').split(/\s+/).filter(Boolean).map(d => {
		if (!/^\+[A-Za-z0-9._-]+$/.test(d))
			throw new Error(`${file}: LUCI_DEPENDS entry ${d} is not a plain +package; extend the verifier`);
		return d.slice(1);
	});
	if (vars.LUCI_PKGARCH && vars.LUCI_PKGARCH !== 'all') throw new Error(`${file}: LUCI_PKGARCH must be all`);
	const script = {};
	for (const hook of [ 'preinst', 'postinst', 'prerm', 'postrm' ])
		if (hooks[hook]) script[hook] = unescapeMake(hooks[hook].text, `${file} Package/${name}/${hook}`);
	const conffiles = hooks.conffiles
		? unescapeMake(hooks.conffiles.text, `${file} conffiles`).split('\n').map(s => s.trim()).filter(Boolean)
		: null;
	for (const known of [ 'description', 'install', 'config' ])
		if (hooks[known]) throw new Error(`${file}: Package/${name}/${known} overrides luci.mk; extend the verifier`);
	for (const hook of Object.keys(hooks))
		if (![ 'preinst', 'postinst', 'prerm', 'postrm', 'conffiles' ].includes(hook))
			throw new Error(`${file}: unknown hook Package/${name}/${hook}`);
	return { name, version, release, fullVersion: `${version}-r${release}`, license: vars.PKG_LICENSE || '',
		depends, script, conffiles, minifyCss: vars.LUCI_MINIFY_CSS !== '0' };
}

/* ------------------------------------------------ expected scripts (OpenWrt) */

/* luci.mk's postinst when the Makefile has none */
const LUCI_POSTINST = '[ -n "${IPKG_INSTROOT}" ] || { rm -f /tmp/luci-indexcache.*\n' +
	'\trm -rf /tmp/luci-modulecache/\n\t/etc/init.d/rpcd reload 2>/dev/null\n\texit 0\n}\n';

const dropShebangs = s => s.split('\n').filter(l => !/^\s*#!/.test(l)).join('\n');

/* include/package-pack.mk (25.12): scripts apk mkpkg receives */
function expectedApkScripts(mk) {
	const name = mk.name;
	const postinstPkg = mk.script.postinst != null ? mk.script.postinst + '\n' : LUCI_POSTINST;
	const lib = '[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0\n. ${IPKG_INSTROOT}/lib/functions.sh\n' +
		'export root="${IPKG_INSTROOT}"\n' + `export pkgname="${name}"\n`;
	const s = {};
	if (mk.script.preinst != null) {
		s['pre-install'] = mk.script.preinst + '\n';
		s['pre-upgrade'] = '#!/bin/sh\nexport PKG_UPGRADE=1\n' + dropShebangs(mk.script.preinst + '\n');
	}
	s['post-install'] = '#!/bin/sh\n[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0\n' + lib +
		'add_group_and_user\ndefault_postinst\n' + dropShebangs(postinstPkg);
	s['post-upgrade'] = '#!/bin/sh\nexport PKG_UPGRADE=1\n' + dropShebangs(s['post-install']);
	s['pre-deinstall'] = '#!/bin/sh\n' + lib + 'default_prerm\n' +
		(mk.script.prerm != null ? dropShebangs(mk.script.prerm + '\n') : '');
	if (mk.script.postrm != null) s['post-deinstall'] = (mk.script.postrm + '\n').replace(/^\s*#!/, '#!');
	return s;
}

/* same file, opkg branch (untested against a real 23.05/24.10 build) */
function expectedIpkScripts(mk) {
	const s = {
		postinst: '#!/bin/sh\n[ "${IPKG_NO_SCRIPT}" = "1" ] && exit 0\n[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0\n' +
			'. ${IPKG_INSTROOT}/lib/functions.sh\ndefault_postinst $0 $@\n',
		prerm: '#!/bin/sh\n[ -s ${IPKG_INSTROOT}/lib/functions.sh ] || exit 0\n. ${IPKG_INSTROOT}/lib/functions.sh\n' +
			'default_prerm $0 $@\n',
		'postinst-pkg': mk.script.postinst != null ? mk.script.postinst + '\n' : LUCI_POSTINST,
	};
	if (mk.script.prerm != null) s['prerm-pkg'] = mk.script.prerm + '\n';
	if (mk.script.preinst != null) s.preinst = mk.script.preinst + '\n';
	if (mk.script.postrm != null) s.postrm = mk.script.postrm + '\n';
	return s;
}

/* ------------------------------------------------------- source payload */

const INSTALL_MAP = [ [ 'htdocs', 'www' ], [ 'root', '' ], [ 'ucode', 'usr/share/ucode/luci' ], [ 'luasrc', 'usr/lib/lua/luci' ] ];

/* Map install path -> { src, mode } the way luci.mk's Package/install copies */
function sourcePayload(pkgDir) {
	if (fs.existsSync(path.join(pkgDir, 'src'))) throw new Error(`${pkgDir}/src: compiled payload is not supported by the verifier`);
	const out = new Map();
	for (const [ from, to ] of INSTALL_MAP) {
		const base = path.join(pkgDir, from);
		if (!fs.existsSync(base)) continue;
		(function walk(dir) {
			for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
				const abs = path.join(dir, e.name);
				const st = fs.lstatSync(abs);
				if (st.isSymbolicLink()) throw new Error(`symlink in the source tree: ${abs}`);
				if (st.isDirectory()) { walk(abs); continue; }
				if (!st.isFile()) throw new Error(`special file in the source tree: ${abs}`);
				if (from === 'luasrc' && e.name.endsWith('.luadoc')) continue;
				const rel = path.relative(base, abs).split(path.sep).join('/');
				out.set(to ? `${to}/${rel}` : rel, { src: abs, mode: (st.mode & 0o111) ? 0o755 : 0o644 });
			}
		})(base);
	}
	return out;
}

/* luci.mk SubstituteVersion (sed, line by line) */
function substituteVersion(text, file, version) {
	if (file.endsWith('.ut'))
		return text.replace(/\{# *([^ \n]*)PKG_VERSION *#\}/g, `$1${version}`)
			.replace(/"(\{\{ *(media|resource) *\}\}[^"\n]*\.(js|css))"/g, `"$1?v=${version}"`);
	if (file.endsWith('.htm'))
		return text.replace(/<%# *([^ \n]*)PKG_VERSION *%>/g, `$1${version}`)
			.replace(/"(<%= *(media|resource) *%>[^"\n]*\.(js|css))"/g, `"$1?v=${version}"`);
	return text;
}

const TEMPLATE_ASSET = /"(?:\{\{ *(?:media|resource) *\}\}|<%= *(?:media|resource) *%>)[^"\n]*"/g;

function parseJs(code, file) {
	try {
		/* LuCI modules return at top level; compile inside a function, never run */
		new vm.Script('(function () {' + code + '\n})', { filename: file });
		return null;
	} catch (e) { return `${file}: packaged JavaScript does not parse: ${e.message}`; }
}

/* ------------------------------------------------------------- tooling */

function run(cmd, args, opts) {
	const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8', maxBuffer: 64 << 20 }, opts));
	if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
	return r;
}

function apkVersion(tool) {
	try {
		const r = spawnSync(tool, [ '--version' ], { encoding: 'utf8' });
		return !r.error && /apk-tools 3\./.test(r.stdout) ? r.stdout.trim() : null;
	} catch (e) { return null; }
}

function findApk(explicit, release) {
	const cands = [ explicit, process.env.VANTAGE_APK, release && path.join(ROOT, 'dist', '.tools', release, 'apk'), 'apk' ];
	for (const c of cands.filter(Boolean)) if (apkVersion(c)) return c;
	return null;
}

function firstExisting(...cands) {
	return cands.find(c => c && fs.existsSync(c)) || null;
}

/* jsmin setting of the build: true, false or null (unknown) */
function jsminSetting(file) {
	if (!file || !fs.existsSync(file)) return null;
	const t = fs.readFileSync(file, 'utf8');
	if (/^CONFIG_LUCI_JSMIN=y$/m.test(t)) return true;
	if (/^# CONFIG_LUCI_JSMIN is not set$/m.test(t)) return false;
	return null;
}

function mkTemp(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/* remove a directory this process created with mkTemp, nothing else */
function rmTemp(dir) {
	const tmp = fs.realpathSync(os.tmpdir());
	const real = fs.realpathSync(dir);
	if (path.dirname(real) === tmp && /^vantage-verify-/.test(path.basename(real))) fs.rmSync(real, { recursive: true, force: true });
}

/* --------------------------------------------------------- read packages */

function modeFromString(s) {
	/* s: 9 permission chars from `tar -tv` */
	let m = 0;
	const bit = (c, v) => (c !== '-' && c !== 'S' && c !== 'T' ? v : 0);
	m |= bit(s[0], 0o400) | bit(s[1], 0o200) | bit(s[2], 0o100);
	m |= bit(s[3], 0o40) | bit(s[4], 0o20) | bit(s[5], 0o10);
	m |= bit(s[6], 0o4) | bit(s[7], 0o2) | bit(s[8], 0o1);
	if (/[sS]/.test(s[2])) m |= 0o4000;
	if (/[sS]/.test(s[5])) m |= 0o2000;
	if (/[tT]/.test(s[8])) m |= 0o1000;
	return m;
}

function readApk(file, apk, dest) {
	const errors = [];
	const v = run(apk, [ '--allow-untrusted', 'verify', file ]);
	if (v.status !== 0) errors.push(`apk verify failed: ${(v.stdout + v.stderr).trim()}`);
	const d = run(apk, [ 'adbdump', '--format', 'json', file ]);
	if (d.status !== 0) throw new Error(`apk adbdump ${file}: ${d.stderr.trim()}`);
	const dump = JSON.parse(d.stdout);
	const x = run(apk, [ '--allow-untrusted', 'extract', '--no-chown', '--destination', dest, file ]);
	if (x.status !== 0) throw new Error(`apk extract ${file}: ${(x.stdout + x.stderr).trim()}`);
	const entries = [];
	for (const p of dump.paths || []) {
		const dir = p.name || '';
		for (const k of Object.keys(p)) if (![ 'name', 'acl', 'files' ].includes(k)) errors.push(`directory /${dir}: unexpected field ${k}`);
		entries.push({ path: dir, dir: true, mode: p.acl.mode, user: p.acl.user, group: p.acl.group, extra: Object.keys(p.acl).filter(k => ![ 'mode', 'user', 'group' ].includes(k)) });
		for (const f of p.files || []) {
			const full = dir ? `${dir}/${f.name}` : f.name;
			for (const k of Object.keys(f)) if (![ 'name', 'acl', 'size', 'mtime', 'hash' ].includes(k)) errors.push(`/${full}: unexpected field ${k} (symlink or special file?)`);
			entries.push({ path: full, dir: false, mode: f.acl.mode, user: f.acl.user, group: f.acl.group, extra: Object.keys(f.acl).filter(k => ![ 'mode', 'user', 'group' ].includes(k)) });
		}
	}
	return { format: 'apk', info: dump.info || {}, scripts: dump.scripts || {}, entries, errors, extraKeys: Object.keys(dump).filter(k => ![ 'info', 'paths', 'scripts' ].includes(k)) };
}

function tarList(archive) {
	const r = run('tar', [ '--numeric-owner', '-tvzf', archive ]);
	if (r.status !== 0) throw new Error(`tar -t ${archive}: ${r.stderr.trim()}`);
	return r.stdout.split('\n').filter(Boolean).map(line => {
		const m = line.match(/^([-dlcbps])([rwxsStT-]{9})\s+(\S+)\/(\S+)\s+\d+\s+\S+\s+\S+\s+(.*)$/);
		if (!m) throw new Error(`cannot parse tar listing: ${line}`);
		return { type: m[1], mode: modeFromString(m[2]), user: m[3], group: m[4], path: m[5].replace(/^\.\//, '').replace(/\/$/, '') };
	});
}

function readIpk(file, dest) {
	const errors = [];
	const outer = mkTemp('vantage-verify-');
	try {
		const r = run('tar', [ '-xzf', file, '-C', outer ]);
		if (r.status !== 0) throw new Error(`tar -x ${file}: ${r.stderr.trim()}`);
		const members = fs.readdirSync(outer).sort();
		if (members.join(',') !== 'control.tar.gz,data.tar.gz,debian-binary') errors.push(`unexpected ipk members: ${members.join(', ')}`);
		const entries = tarList(path.join(outer, 'data.tar.gz')).map(e => {
			const o = { path: e.path === '.' ? '' : e.path, dir: e.type === 'd', mode: e.mode, user: e.user === '0' ? 'root' : e.user, group: e.group === '0' ? 'root' : e.group, extra: [] };
			if (e.type !== 'd' && e.type !== '-') errors.push(`/${o.path}: not a regular file (${e.type})`);
			return o;
		});
		const x = run('tar', [ '-xzf', path.join(outer, 'data.tar.gz'), '-C', dest ]);
		if (x.status !== 0) throw new Error(`tar -x data: ${x.stderr.trim()}`);
		const ctl = path.join(outer, 'control');
		fs.mkdirSync(ctl);
		const c = run('tar', [ '-xzf', path.join(outer, 'control.tar.gz'), '-C', ctl ]);
		if (c.status !== 0) throw new Error(`tar -x control: ${c.stderr.trim()}`);
		const control = {};
		const ctext = fs.readFileSync(path.join(ctl, 'control'), 'utf8');
		for (const line of ctext.split('\n')) {
			const m = line.match(/^([A-Za-z-]+):\s?(.*)$/);
			if (m) control[m[1]] = m[2];
		}
		const scripts = {};
		let conffiles = null;
		for (const f of fs.readdirSync(ctl)) {
			if (f === 'control') continue;
			if (f === 'conffiles') { conffiles = fs.readFileSync(path.join(ctl, f), 'utf8'); continue; }
			scripts[f] = fs.readFileSync(path.join(ctl, f), 'utf8');
		}
		const info = {
			name: control.Package, version: control.Version, arch: control.Architecture, license: control.License,
			depends: (control.Depends || '').split(',').map(s => s.trim()).filter(Boolean),
			provides: (control.Provides || '').split(',').map(s => s.trim()).filter(Boolean),
		};
		return { format: 'ipk', info, control, scripts, conffiles, entries, errors, extraKeys: [] };
	} finally { rmTemp(outer); }
}

/* ------------------------------------------------------------- checking */

const APK_INFO_KEYS = new Set([ 'name', 'version', 'hashes', 'description', 'arch', 'license', 'origin', 'maintainer', 'url', 'installed-size', 'depends', 'provides' ]);
const IPK_CONTROL_KEYS = new Set([ 'Package', 'Version', 'Depends', 'Provides', 'Source', 'SourceName', 'License', 'Section', 'SourceDateEpoch', 'URL', 'Maintainer', 'Architecture', 'Installed-Size', 'Description' ]);

const sameList = (a, b) => JSON.stringify([ ...a ].sort()) === JSON.stringify([ ...b ].sort());

/*
 * pkg: normalised package (readApk/readIpk), root: its extracted payload,
 * srcRoot: source tree, ctx: { jsmin, jsminOn, identifiers, findings }
 */
function checkPackage(pkg, root, srcRoot, ctx) {
	const errors = [ ...pkg.errors ];
	const notes = [];
	const name = pkg.info.name;
	if (!PACKAGES.includes(name)) return { errors: [ `unexpected package name ${name}` ], notes };
	const mk = parseMakefile(fs.readFileSync(path.join(srcRoot, name, 'Makefile'), 'utf8'), `${name}/Makefile`);
	const payload = sourcePayload(path.join(srcRoot, name));

	/* metadata */
	const ipk = pkg.format === 'ipk';
	if (pkg.info.version !== mk.fullVersion && !(ipk && pkg.info.version === `${mk.version}-${mk.release}`))
		errors.push(`version ${pkg.info.version}, Makefile says ${mk.fullVersion}`);
	if (pkg.info.arch !== (ipk ? 'all' : 'noarch')) errors.push(`arch ${pkg.info.arch}, expected ${ipk ? 'all' : 'noarch'}`);
	if (mk.license && pkg.info.license !== mk.license) errors.push(`license ${pkg.info.license}, Makefile says ${mk.license}`);
	const wantDeps = [ 'libc', ...mk.depends ];
	if (!sameList(pkg.info.depends || [], wantDeps)) errors.push(`depends [${(pkg.info.depends || []).join(', ')}], expected [${wantDeps.join(', ')}]`);
	const prov = pkg.info.provides || [];
	if (!(prov.length === 0 || (prov.length === 1 && prov[0] === `${name}-any`))) errors.push(`provides [${prov.join(', ')}]`);
	if (ipk) {
		for (const k of Object.keys(pkg.control)) if (!IPK_CONTROL_KEYS.has(k)) errors.push(`unexpected control field ${k}`);
	} else {
		for (const k of Object.keys(pkg.info)) if (!APK_INFO_KEYS.has(k)) errors.push(`unexpected info field ${k}`);
		for (const k of pkg.extraKeys) errors.push(`unexpected package section ${k}`);
	}

	/* scripts */
	const wantScripts = ipk ? expectedIpkScripts(mk) : expectedApkScripts(mk);
	for (const k of new Set([ ...Object.keys(wantScripts), ...Object.keys(pkg.scripts) ])) {
		if (!(k in pkg.scripts)) errors.push(`script ${k} missing`);
		else if (!(k in wantScripts)) errors.push(`unexpected script ${k}`);
		else if (pkg.scripts[k] !== wantScripts[k]) errors.push(`script ${k} differs from what the Makefile/luci.mk generate`);
	}

	/* expected file set */
	const meta = new Map();
	if (!ipk) {
		meta.set(`lib/apk/packages/${name}.list`, 'list');
		if (mk.conffiles) {
			meta.set(`lib/apk/packages/${name}.conffiles`, 'conffiles');
			meta.set(`lib/apk/packages/${name}.conffiles_static`, 'conffiles_static');
		}
	}
	const wantFiles = new Set([ ...payload.keys(), ...meta.keys() ]);
	const wantDirs = new Set([ '' ]);
	for (const f of wantFiles) for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) wantDirs.add(d);
	const gotFiles = new Set(), gotDirs = new Set();
	for (const e of pkg.entries) {
		const where = `/${e.path}`;
		if (e.dir) gotDirs.add(e.path); else gotFiles.add(e.path);
		if (e.user !== 'root' || e.group !== 'root') errors.push(`${where}: owner ${e.user}:${e.group}`);
		if (e.extra && e.extra.length) errors.push(`${where}: extra attributes ${e.extra.join(', ')}`);
		if (e.mode & 0o7000) errors.push(`${where}: setuid/setgid/sticky mode ${e.mode.toString(8)}`);
		if (e.mode & 0o022) errors.push(`${where}: group- or world-writable mode ${e.mode.toString(8)}`);
		let want;
		if (e.dir) want = 0o755;
		else if (payload.has(e.path)) want = /^etc\/uci-defaults\//.test(e.path) ? 0o755 : payload.get(e.path).mode;
		else want = 0o644;
		if ((e.mode & 0o7777) !== want) errors.push(`${where}: mode ${(e.mode & 0o7777).toString(8)}, expected ${want.toString(8)}`);
	}
	for (const f of gotFiles) if (!wantFiles.has(f)) errors.push(`/${f}: in the package but not in the source`);
	for (const f of wantFiles) if (!gotFiles.has(f)) errors.push(`/${f}: missing from the package`);
	for (const d of gotDirs) if (!wantDirs.has(d)) errors.push(`/${d}/: unexpected directory`);
	for (const f of payload.keys()) if (/^etc\/uci-defaults\//.test(f) && payload.get(f).mode !== 0o755)
		notes.push(`/${f} is 0644 in git; the package must still ship it 0755`);

	/* contents */
	let templates = 0, versioned = 0, jsChecked = 0, jsUncompared = 0;
	for (const [ rel, s ] of payload) {
		const file = path.join(root, rel);
		if (!gotFiles.has(rel) || !fs.existsSync(file)) continue;
		const got = fs.readFileSync(file);
		const src = fs.readFileSync(s.src);
		let ok;
		if (/\.(ut|htm)$/.test(rel)) {
			templates++;
			ok = got.equals(Buffer.from(substituteVersion(src.toString('utf8'), rel, mk.version), 'utf8'));
			const text = got.toString('utf8');
			for (const m of text.matchAll(TEMPLATE_ASSET)) {
				if (!/\.(js|css)(\?|")/.test(m[0])) continue;
				if (m[0].includes(`?v=${mk.version}"`)) versioned++;
				else errors.push(`/${rel}: asset link without ?v=${mk.version}: ${m[0]}`);
			}
		} else if (rel.endsWith('.js') && rel.startsWith('www/')) {
			jsChecked++;
			const perr = parseJs(got.toString('utf8'), `/${rel}`);
			if (perr) errors.push(perr);
			if (got.equals(src)) ok = ctx.jsminOn !== true;
			else if (ctx.jsmin && ctx.jsminOn !== false) {
				const r = spawnSync(ctx.jsmin, [], { input: src, maxBuffer: 64 << 20 });
				if (r.error || r.status !== 0) { errors.push(`jsmin failed on ${s.src}`); ok = true; }
				else ok = got.equals(r.stdout);
			} else { ok = true; jsUncompared++; }
		} else ok = got.equals(src);
		if (!ok) errors.push(`/${rel}: content differs from the source (after luci.mk transforms)`);
	}
	if (jsUncompared) notes.push(`${jsUncompared} minified .js file(s) parsed but not compared byte for byte (no jsmin)`);
	if (templates && !versioned && [ ...payload.keys() ].some(k => /\.(ut|htm)$/.test(k)))
		notes.push('templates carry no {{ media }}/{{ resource }} asset links');

	/* apk metadata files */
	if (!ipk) {
		const listFile = path.join(root, `lib/apk/packages/${name}.list`);
		if (fs.existsSync(listFile)) {
			const listed = fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean);
			if (!sameList(listed, [ ...payload.keys() ].map(p => '/' + p))) errors.push(`${name}.list does not list exactly the payload files`);
		}
		if (mk.conffiles) {
			const cf = path.join(root, `lib/apk/packages/${name}.conffiles`);
			if (fs.existsSync(cf) && fs.readFileSync(cf, 'utf8') !== mk.conffiles.join('\n') + '\n')
				errors.push(`${name}.conffiles differs from the Makefile's conffiles`);
			const cs = path.join(root, `lib/apk/packages/${name}.conffiles_static`);
			if (fs.existsSync(cs)) {
				const want = mk.conffiles.filter(c => payload.has(c.replace(/^\//, ''))).map(c =>
					`${c} ${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, c))).digest('hex')}`).join('\n') + '\n';
				if (fs.readFileSync(cs, 'utf8') !== want) errors.push(`${name}.conffiles_static does not match the packaged conffiles`);
			}
		}
	} else {
		const want = mk.conffiles ? mk.conffiles.join('\n') + '\n' : null;
		if (pkg.conffiles !== want) errors.push(`conffiles ${JSON.stringify(pkg.conffiles)}, expected ${JSON.stringify(want)}`);
	}

	/* private addresses and recorded identifiers */
	const texts = [ ...Object.entries(pkg.scripts).map(([ k, v ]) => [ `script ${k}`, v ]) ];
	for (const f of gotFiles) {
		const abs = path.join(root, f);
		if (!fs.existsSync(abs)) continue;
		const buf = fs.readFileSync(abs);
		if (!buf.includes(0)) texts.push([ `/${f}`, buf.toString('utf8') ]);
	}
	if (ctx.findings) for (const [ where, text ] of texts)
		for (const [ line, what ] of ctx.findings(text, ctx.identifiers)) errors.push(`${where}:${line}: ${what}`);

	return { errors, notes, name, version: pkg.info.version, files: gotFiles.size, jsChecked, templates };
}

function checkIndex(index, keysDir, apk, pkgFiles) {
	const errors = [];
	/* apk resolves --keys-dir against --root (/), so pass it absolute */
	const v = run(apk, [ '--keys-dir', path.resolve(keysDir), 'verify', index ]);
	if (v.status !== 0) errors.push(`index signature does not verify against ${keysDir}: ${(v.stdout + v.stderr).trim()}`);
	/* the index must describe exactly these package files: rebuild an
	   unsigned index from them and compare name, version and package hash */
	const entries = file => {
		const d = run(apk, [ 'adbdump', '--format', 'json', file ]);
		if (d.status !== 0) throw new Error(`apk adbdump ${file}: ${d.stderr.trim()}`);
		return (JSON.parse(d.stdout).packages || []).map(p => `${p.name} ${p.version} ${p.hashes}`);
	};
	const tmp = mkTemp('vantage-verify-');
	try {
		const ref = path.join(tmp, 'ref.adb');
		const m = run(apk, [ 'mkndx', '--allow-untrusted', '--output', ref, ...pkgFiles.map(f => path.resolve(f)) ]);
		if (m.status !== 0) return errors.concat(`apk mkndx: ${(m.stdout + m.stderr).trim()}`);
		const listed = entries(index), want = entries(ref);
		if (!sameList(listed, want)) errors.push(`index lists [${listed.join('; ')}], the packages give [${want.join('; ')}]`);
	} finally { rmTemp(tmp); }
	return errors;
}

/* ---------------------------------------------------------------- main */

function parseArgs(argv) {
	const o = { files: [] };
	const withValue = { '--src': 'src', '--rev': 'rev', '--apk-tool': 'apk', '--jsmin': 'jsmin', '--luci-config': 'luciConfig',
		'--index': 'index', '--keys-dir': 'keysDir', '--mirror': 'mirror' };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (withValue[a]) { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); o[withValue[a]] = argv[++i]; }
		else if (a === '--require-tools') o.requireTools = true;
		else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
		else o.files.push(a);
	}
	if (!o.files.length) throw new Error('no packages given');
	if (o.src && o.rev) throw new Error('--src and --rev are exclusive');
	if (!!o.index !== !!o.keysDir) throw new Error('--index and --keys-dir go together');
	return o;
}

function collect(files) {
	const pkgs = [], dirs = [];
	for (const f of files) {
		const st = fs.statSync(f);
		if (st.isDirectory()) {
			dirs.push(f);
			for (const e of fs.readdirSync(f).sort()) if (/\.(apk|ipk)$/.test(e)) pkgs.push(path.join(f, e));
		} else pkgs.push(f);
	}
	return { pkgs, dirs };
}

function readBuildinfo(dir) {
	const f = path.join(dir, 'BUILDINFO');
	if (!fs.existsSync(f)) return {};
	const o = {};
	for (const line of fs.readFileSync(f, 'utf8').split('\n')) { const m = line.match(/^([a-z_]+)=(.*)$/); if (m && !(m[1] in o)) o[m[1]] = m[2]; }
	return o;
}

function checkSums(dir, pkgs) {
	const f = path.join(dir, 'SHA256SUMS');
	if (!fs.existsSync(f)) return [];
	const errors = [];
	const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
	const listed = new Map(lines.map(l => { const m = l.match(/^([0-9a-f]{64}) [ *](.+)$/); return m ? [ m[2], m[1] ] : [ l, null ]; }));
	const here = pkgs.filter(p => path.dirname(p) === dir).map(p => path.basename(p));
	if (!sameList(listed.keys(), here)) errors.push(`${f} lists [${[ ...listed.keys() ].join(', ')}], directory has [${here.join(', ')}]`);
	for (const [ name, sum ] of listed) {
		const p = path.join(dir, name);
		if (!sum || !fs.existsSync(p)) continue;
		if (crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') !== sum) errors.push(`${f}: hash mismatch for ${name}`);
	}
	return errors;
}

function main(argv) {
	let o;
	try { o = parseArgs(argv); } catch (e) { console.error(`verify_built_apk: ${e.message}`); return 2; }
	const { pkgs, dirs } = collect(o.files);
	if (!pkgs.length) { console.error('verify_built_apk: no .apk/.ipk files found'); return 2; }
	for (const p of pkgs) if (!PACKAGES.some(n => path.basename(p).startsWith(n + '-') || path.basename(p).startsWith(n + '_'))) {
		console.error(`verify_built_apk: not a Vantage package: ${p}`); return 1;
	}
	const pkgDir = path.dirname(path.resolve(pkgs[0]));
	const release = /^\d+\.\d+\.\d+$/.test(path.basename(pkgDir)) ? path.basename(pkgDir) : null;
	const tools = release ? path.join(ROOT, 'dist', '.tools', release) : null;
	const needApk = pkgs.some(p => p.endsWith('.apk')) || o.index;
	const apk = needApk ? findApk(o.apk, release) : null;
	if (needApk && !apk) {
		const msg = 'no apk-tools 3 binary (pass --apk-tool, set VANTAGE_APK, or build once with dev/build/sdk-build.sh, which leaves the SDK\'s apk in dist/.tools/<release>/)';
		if (o.requireTools) { console.error(`verify_built_apk: ${msg}`); return 2; }
		console.log(`SKIP: ${msg}`);
		return 0;
	}
	const jsmin = firstExisting(o.jsmin, process.env.VANTAGE_JSMIN, tools && path.join(tools, 'jsmin'));
	const jsminOn = jsminSetting(firstExisting(o.luciConfig, tools && path.join(tools, 'luci.config')));
	if (o.requireTools && jsminOn !== false && !jsmin) { console.error('verify_built_apk: no jsmin to reproduce the minified JavaScript'); return 2; }

	let findings = null, identifiers = null;
	try {
		const cpa = require('./check_private_addresses.js');
		findings = cpa.findings;
		const mirror = o.mirror || process.env.VANTAGE_MIRROR || path.resolve(ROOT, '..', 'vantage-mirror');
		if (fs.existsSync(mirror) && typeof cpa.mirrorIdentifiers === 'function') identifiers = cpa.mirrorIdentifiers(mirror);
		else console.log('note: no private mirror, recorded identifiers not checked (addresses are)');
	} catch (e) { console.error(`verify_built_apk: cannot load check_private_addresses.js: ${e.message}`); return 2; }

	let srcRoot = o.src ? path.resolve(o.src) : null, srcTemp = null;
	const rev = o.rev || (!o.src && readBuildinfo(pkgDir).rev);
	if (!srcRoot && !rev) { console.error('verify_built_apk: pass --src or --rev (no BUILDINFO with rev= next to the packages)'); return 2; }
	const temps = [];
	let failed = false;
	try {
		if (!srcRoot) {
			srcTemp = mkTemp('vantage-verify-'); temps.push(srcTemp);
			const tarFile = path.join(srcTemp, 'src.tar');
			const a = run('git', [ '-C', ROOT, 'archive', '--format=tar', '-o', tarFile, rev, ...PACKAGES ]);
			if (a.status !== 0) { console.error(`verify_built_apk: git archive ${rev}: ${a.stderr.trim()}`); return 2; }
			const x = run('tar', [ '-xf', tarFile, '-C', srcTemp ]);
			if (x.status !== 0) { console.error(`verify_built_apk: tar: ${x.stderr.trim()}`); return 2; }
			srcRoot = srcTemp;
		}
		const ctx = { jsmin, jsminOn, identifiers, findings };
		const read = [];
		for (const p of pkgs) {
			const dest = mkTemp('vantage-verify-'); temps.push(dest);
			let pkg, res;
			try {
				pkg = p.endsWith('.apk') ? readApk(p, apk, dest) : readIpk(p, dest);
				res = checkPackage(pkg, dest, srcRoot, ctx);
			} catch (e) { res = { errors: [ e.message ], notes: [] }; }
			if (pkg) read.push(pkg);
			const label = path.basename(p);
			if (res.errors.length) {
				failed = true;
				console.log(`FAIL ${label}`);
				for (const e of res.errors) console.log(`  - ${e}`);
			} else console.log(`ok   ${label}: ${res.files} files, ${res.jsChecked} scripts parsed, ${res.templates} templates, scripts and metadata as expected`);
			for (const n of res.notes) console.log(`     note: ${n}`);
		}
		const names = read.map(p => p.info.name);
		if (new Set(names).size !== names.length) { failed = true; console.log(`FAIL more than one version of a package: ${names.join(', ')}`); }
		for (const d of dirs) for (const e of checkSums(d, pkgs)) { failed = true; console.log(`FAIL ${e}`); }
		if (o.index) {
			const errs = checkIndex(o.index, o.keysDir, apk, pkgs);
			for (const e of errs) console.log(`FAIL ${e}`);
			if (errs.length) failed = true; else console.log(`ok   ${path.basename(o.index)}: signature verifies, lists exactly these packages`);
		}
	} finally { for (const t of temps) rmTemp(t); }
	if (!jsmin && jsminOn !== false) console.log('note: jsmin not available; minified JavaScript was parsed, not compared (sdk-build.sh compares it)');
	console.log(failed ? 'verify_built_apk: FAILED' : 'verify_built_apk: all packages verified');
	return failed ? 1 : 0;
}

module.exports = { parseMakefile, expectedApkScripts, expectedIpkScripts, sourcePayload, substituteVersion, parseJs,
	modeFromString, checkPackage, LUCI_POSTINST, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
