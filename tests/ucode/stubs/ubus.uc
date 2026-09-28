// Test double for ucode's ubus module: replies from global STUB.ubus,
// keyed 'object method'.
'use strict';

function connect() {
	return {
		call: (obj, method, args) => global.STUB.ubus?.[`${obj} ${method}`]
	};
}

export { connect };
