'use strict';
/* keys/ holds the project's public signing key only, never a private key. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = path.join(__dirname, '..', 'keys');

test('keys/: only the public signing key, and it is a P-256 public key', () => {
	assert.deepStrictEqual(fs.readdirSync(DIR), [ 'vantage-signing.pem' ]);
	const pem = fs.readFileSync(path.join(DIR, 'vantage-signing.pem'), 'utf8');
	assert.doesNotMatch(pem, /PRIVATE KEY/);
	const key = crypto.createPublicKey(pem);
	assert.strictEqual(key.asymmetricKeyType, 'ec');
	assert.strictEqual(key.asymmetricKeyDetails.namedCurve, 'prime256v1');
});

test('keys/: the fingerprint in the docs matches the key file', () => {
	const sum = crypto.createHash('sha256').update(fs.readFileSync(path.join(DIR, 'vantage-signing.pem'))).digest('hex');
	for (const doc of [ 'README.md', 'docs/INSTALL.md', 'dev/build/repo-index.html' ])
		assert.match(fs.readFileSync(path.join(__dirname, '..', doc), 'utf8'), new RegExp(sum), doc);
});
