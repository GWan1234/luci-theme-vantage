// Test double for ucode's uci module (tests/plugin.test.js): one config
// held in global STUB = { sections: [ ... ], seq, committed, fail_commit }.
'use strict';

function find(sid) {
	for (let s in global.STUB.sections)
		if (s['.name'] == sid)
			return s;

	return null;
}

function cursor() {
	return {
		load: (conf) => conf == 'vantage',

		foreach: function(conf, stype, fn) {
			for (let s in [ ...global.STUB.sections ])
				if (!stype || s['.type'] == stype)
					if (fn({ ...s }) === false)
						break;

			return true;
		},

		add: function(conf, stype) {
			let sid = sprintf('cfg%06x', ++global.STUB.seq);
			push(global.STUB.sections, { '.name': sid, '.type': stype, '.anonymous': true });
			return sid;
		},

		set: function(conf, sid, opt, val) {
			let s = find(sid);

			if (!s)
				return null;

			s[opt] = val;
			return true;
		},

		delete: function(conf, sid, opt) {
			if (opt != null) {
				let s = find(sid);

				if (s)
					delete s[opt];

				return !!s;
			}

			let before = length(global.STUB.sections);
			global.STUB.sections = filter(global.STUB.sections, (s) => s['.name'] != sid);
			return length(global.STUB.sections) < before;
		},

		commit: function(conf) {
			if (global.STUB.fail_commit)
				return null;

			global.STUB.committed = true;
			return true;
		}
	};
}

export { cursor };
