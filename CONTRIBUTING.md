# Contributing to Vantage

Issues and pull requests are welcome. Security problems are the exception:
report those privately as described in [SECURITY.md](SECURITY.md), not in a
public issue.

Using a coding agent? Point it at [AGENTS.md](AGENTS.md); it holds the same
rules in a compact form.

## Reporting a bug

Please include:

- your OpenWrt version: the output of `cat /etc/openwrt_release`
- the Vantage version (`apk list --installed | grep vantage`)
- your browser and its version
- what you did, what you expected, and what happened instead
- for a broken page, the browser console output (<kbd>F12</kbd>)

Screenshots help, but must not show your network. Take them with the
replay's `--demo` mode (below), or remove IP addresses, MAC addresses,
SSIDs, host names and device names before you post them.

## Development setup

The UI is developed offline against recorded device data, never against a
live router. You need Node.js (there are no dependencies to install) and,
to build packages, podman.

1. **Record** a device once with `dev/mirror/` (read-only: it refuses
   writes, and strips secrets before writing anything). Keep the
   recording outside this repository, e.g. in `../vantage-mirror`.
   The browser recorder pins the device's TLS certificate: copy it over
   SSH (`scp -O root@<device>:/etc/uhttpd.crt /tmp/device.crt`) and pass
   `--cert /tmp/device.crt` (or `--spki <pin>`; see the header of
   `dev/mirror/record-browser.js`).
2. **Replay** it with the theme and app from your working tree, plus a
   LuCI 25.12 root filesystem for LuCI's own templates and static files
   (`--rootfs`, see [`dev/replay/README.md`](dev/replay/README.md)):

   ```sh
   node dev/replay/server.js --mirror ../vantage-mirror --port 8106 --demo \
       --theme-dir luci-theme-vantage/htdocs/luci-static/vantage --theme vantage \
       --app-dir luci-app-vantage
   ```

   Open `http://127.0.0.1:8106/` (any login works) and reload after each
   edit.
3. **Demo mode** (`--demo`) replaces addresses, MACs, SSIDs and names with
   documentation values. Use it for every screenshot you share.

The dashboard must also work under Bootstrap: run the replay without
`--theme-dir` to check.

## Checks

Run these before opening a pull request; all must pass:

```sh
node --test tests/
node security-tests/check_dom_sinks.js
node security-tests/test_templates.js
node security-tests/test_acl_policy.js
node security-tests/check_private_addresses.js [--require-mirror --mirror ../vantage-mirror]
```

For changes to Makefiles, `root/` files or install scripts, also build the
packages (commit first; the script builds a clean clone of the commit):

```sh
dev/build/sdk-build.sh 25.12.4
```

## Rules

- **No real network data** in commits, tests, docs or screenshots. Use
  documentation addresses (`192.0.2.0/24`, `198.51.100.0/24`,
  `203.0.113.0/24`, `2001:db8::/32`) and MACs (`00:00:5E:00:53:xx`).
  `check_private_addresses.js` rejects anything else, including
  `192.168.x.x`.
- **No markup built from data.** Create DOM nodes with `E()` and pass text
  inside arrays; no `innerHTML` and friends. Templates escape everything
  with `entityencode()` and never echo the login name.
- **Least privilege.** A new ubus call needs its `rpc.declare`, an ACL
  entry and an allowlist entry in `security-tests/test_acl_policy.js`, with
  the reason in the pull request. The app stays read-only apart from its
  own `/etc/config/vantage`, which it writes only through its rpcd plugin
  (`luci.vantage set_alias`, validated on the device); no ACL group grants
  uci writes, and nothing reads Wi-Fi keys. Changes to the plugin's name
  rules go into `names.js` and `dev/replay/vantage-plugin.js` as well;
  `tests/plugin.test.js` compares them (the real plugin runs when
  `UCODE=/path/to/ucode` points at a host ucode binary).
- **Theme and app stay independent.** The app uses only the theme's
  `--v-*` custom properties (with fallbacks) and its own `vt-*` classes.

## Style

- Tabs, `'use strict';`, LuCI's `'require ...'` module headers and class
  idioms (`view.extend`, `baseclass.extend`, `rpc.declare`).
- The app's JavaScript is ES5 style (`var`, function expressions); the
  theme's uses `const`/`let` and arrow functions. Match the file you edit.
- No dependencies, CDNs or web fonts.
- Short comments that explain why.

## Commits and pull requests

- Imperative subject line (e.g. "Show uplink rate in the path view"), a
  blank line, then a body that says what changed and why.
- No AI attribution: no `Co-Authored-By` lines or "Generated with ..."
  notes for AI tools, in commits or pull requests.
- One topic per pull request. Mention anything that changes the ACL,
  the templates or the install scripts.

By contributing you agree that your contribution is licensed under the
GNU General Public License, version 3 or any later version
(GPL-3.0-or-later), like the rest of the project.
