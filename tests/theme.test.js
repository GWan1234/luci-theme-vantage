'use strict';
/* menu-vantage.js pieces that decide what reaches the DOM: the SVG helper's
   closed tag/attribute sets, and Channel Analysis ownership (by BSSID,
   never by SSID text, which a neighbour controls). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'luci-theme-vantage/htdocs/luci-static/resources/menu-vantage.js');
const src = fs.readFileSync(FILE, 'utf8');

/* svgNode/svgAttr/svgEl and the ICONS table, evaluated with a recording document */
function svgKit() {
	const start = src.indexOf('function svgNode(');
	const end = src.indexOf('function svg(name, size)');
	assert.ok(start > 0 && end > start, 'found the SVG helpers');
	const icons = /\nconst ICONS = (\{[\s\S]*?\n\});\n/.exec(src);
	assert.ok(icons, 'found the ICONS table');
	const made = [];
	const document = {
		createElementNS: (ns, tag) => {
			const el = { tag, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } };
			made.push(el);
			return el;
		}
	};
	const kit = new Function('document', 'SVGNS', src.slice(start, end) + '\nreturn { svgEl, ICONS: ' + icons[1] + ' };')(document, 'http://www.w3.org/2000/svg');
	return Object.assign(kit, { made });
}

test('svgEl: builds every icon; any other tag or attribute throws', () => {
	const { svgEl, ICONS, made } = svgKit();
	for (const parts of Object.values(ICONS)) for (const [ tag, attrs ] of parts) svgEl(tag, attrs);
	svgEl('svg', { 'viewBox': '0 0 24 24', 'width': 20, 'height': 20, 'aria-hidden': 'true', 'focusable': 'false' });
	svgEl('linearGradient', { 'id': 'v-grad-1', 'class': 'v-grad', 'x1': '0', 'y1': '0', 'x2': '0', 'y2': '1' });
	svgEl('stop', { 'offset': '0', 'class': 'v-stop-top' });
	assert.ok(made.length > 30);
	assert.equal(made.find(e => e.tag === 'svg').attrs.width, '20', 'values are strings');
	for (const tag of [ 'script', 'a', 'foreignObject', 'animate', 'set', 'image', 'use', 'style', 'SVG', 'iframe' ])
		assert.throws(() => svgEl(tag, {}), /tag not allowed/, tag);
	for (const k of [ 'href', 'xlink:href', 'onclick', 'onload', 'style', 'attributeName', 'to', 'values', 'begin', '__proto__' ])
		assert.throws(() => svgEl('path', { [k]: 'x' }), /attribute not allowed/, k);
});

test('channel analysis: a row or hump is ours by BSSID only', () => {
	assert.doesNotMatch(src, /Local Interface'/, 'no SSID-text match (a neighbour can broadcast that SSID)');
	assert.match(src, /const mine = own\.has\(bssid\);/);
	assert.match(src, /const mine = mineByColour\.has\(colour\);/);
	/* own BSSIDs come from this device's interfaces */
	assert.match(src, /\[ i\.iwinfo && i\.iwinfo\.bssid, i\.config && i\.config\.macaddr \]/);
});
