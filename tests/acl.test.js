'use strict';
/* Package wiring of luci-app-vantage: the rpcd ACL policy
   (security-tests/test_acl_policy.js, run here as part of the suite), the
   menu entry, the view's lack of HTML sinks and save buttons, and the
   default config. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

require('../security-tests/test_acl_policy.js');

const APP = path.join(__dirname, '..', 'luci-app-vantage');
const view = fs.readFileSync(path.join(APP, 'htdocs/luci-static/resources/view/vantage/overview.js'), 'utf8');
const menu = JSON.parse(fs.readFileSync(path.join(APP, 'root/usr/share/luci/menu.d/luci-app-vantage.json'), 'utf8'));
const makefile = fs.readFileSync(path.join(APP, 'Makefile'), 'utf8');
const config = fs.readFileSync(path.join(APP, 'root/etc/config/vantage'), 'utf8');

test('menu: top-level dashboard, first by order, gated by the app ACL', () => {
	const d = menu['admin/dashboard'];
	assert.equal(d.order, 1);
	assert.deepEqual(d.action, { type: 'view', path: 'vantage/overview' });
	assert.deepEqual(d.depends.acl, [ 'luci-app-vantage' ]);
});

test('view: no HTML sinks and no save/apply buttons', () => {
	assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(view));
	for (const k of [ 'handleSave', 'handleSaveApply', 'handleReset' ]) assert.match(view, new RegExp(k + ': null'));
});

test('view: aliases are written only through names.aliasOp', () => {
	assert.match(view, /names\.aliasOp\(/);
	for (const m of view.matchAll(/callUci(Add|Set|Delete)\(([^)]*)\)/g))
		assert.match(m[2], /^'vantage', (op\.sid|'client')(, op\.values)?$/, m[0]);
});

test('Makefile: feed-buildable LuCI app, config is a conffile', () => {
	assert.match(makefile, /^include \$\(TOPDIR\)\/rules\.mk$/m);
	assert.match(makefile, /^include \$\(TOPDIR\)\/feeds\/luci\/luci\.mk$/m);
	assert.match(makefile, /^# call BuildPackage - OpenWrt buildroot signature$/m);
	assert.match(makefile, /^PKG_VERSION:=1\.0\.0$/m);
	assert.match(makefile, /^PKG_RELEASE:=1$/m);
	assert.match(makefile, /^PKG_LICENSE:=Apache-2\.0$/m);
	assert.match(makefile, /^LUCI_TITLE:=Vantage dashboard$/m);
	assert.match(makefile, /^LUCI_DEPENDS:=\+luci-base \+rpcd( |$)/m);
	assert.doesNotMatch(makefile, /rrdns[^\n]*DEPENDS|DEPENDS[^\n]*rrdns|DEPENDS[^\n]*umdns/, 'reverse DNS and mDNS stay optional');
	assert.match(makefile, /^LUCI_MINIFY_CSS:=0$/m);
	assert.match(makefile, /define Package\/luci-app-vantage\/conffiles\n\/etc\/config\/vantage\nendef/);
	assert.ok(!fs.existsSync(path.join(APP, 'luasrc')), 'no Lua (would pull luci-lua-runtime)');
});

test('default config: one named main section, no client entries', () => {
	const live = config.split('\n').filter(l => l.trim() && !/^\s*#/.test(l));
	assert.deepEqual(live, [ "config vantage 'main'" ]);
});
