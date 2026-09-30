# Offline replay server

Serves the LuCI 25.12 web UI on `127.0.0.1` entirely from recorded data, so a
theme can be prototyped against real device data without touching the device.
Nothing is forwarded anywhere; there is no upstream.

    node dev/replay/server.js --mirror ../vantage-mirror [--port 8025] \
        [--theme-dir <pkg>/htdocs/luci-static/<name>] [--theme <name>] \
        [--templates <pkg>/ucode/template] [--rootfs <device rootfs dump>] \
        [--app-dir <luci-app package dir>]... [--keep-uniwrt] [--no-synthetic] \
        [--demo] [--lang <lang>]

Open <http://127.0.0.1:8025/>. Any username/password logs in; the session
lasts until the replay restarts (log in again after a restart).

## Trust model

The templates (`--templates`, `--theme-dir`, the theme and `--app-dir`
packages) and the `--rootfs` dump are **code**: `ut.js` compiles every
`.ut` file to a JavaScript function that runs in the replay's Node process
with your privileges, and nothing stops a template from reaching the file
system or starting programs. The scope handling in `ut.js` gives ucode
semantics; it is not a sandbox (a function literal alone leads to the
`Function` constructor). Use only themes and dumps you trust, such as your
own work, LuCI's, and a dump of your own device. For a third-party theme or
a dump of a device you do not control, run the replay in a disposable
container or as a separate unprivileged user, with the inputs mounted
read-only, only the 127.0.0.1 port reachable, and no credentials in the
environment. Recorded data and HTTP requests only ever reach templates as
values; they are never compiled.

## Requests the replay refuses

The replay listens on 127.0.0.1 only, and on top of that:

- Requests whose `Host` is not `127.0.0.1:<port>`, `localhost:<port>` or
  `[::1]:<port>` get `421` (DNS rebinding: a web page cannot re-point its
  own name at the replay and read it).
- POSTs that a browser marks as cross-site (`Sec-Fetch-Site` other than
  `same-origin`/`none`, or a foreign `Origin`) get `403` (CSRF).
- `/ubus` takes `Content-Type: application/json` only (what LuCI's `rpc.js`
  sends), so a cross-site `text/plain` "simple" request is not answered.
- ubus calls need the session id the login created, like rpcd; without it
  only rpcd's `unauthenticated` ACL of the rootfs applies
  (`session.access/login`, `luci.getFeatures`), everything else is
  `-32002 Access denied`. `/cgi-bin/cgi-exec` needs that session id too,
  and `/admin/uci/*` the login cookie or `?sid=`.
- uci names that libuci refuses (and `__proto__`, `constructor`,
  `prototype`) answer `[2]` (INVALID_ARGUMENT) and never touch the overlay.
- Every response has `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, a same-origin referrer policy and
  resource/opener policies; HTML pages get a CSP (`'self'`, with the inline
  and eval'd script LuCI needs, `frame-ancestors 'none'`). The 404 page
  shows the requested path entity-encoded, as upstream's dispatcher does.
- Paths with control characters get `400`, and every request-derived value
  on stderr has control characters escaped (`\x1b`), so a URL cannot drive
  your terminal (title, clipboard, fake log lines).

Inputs:

- `--mirror`: output of `dev/mirror/record-browser.js` / `record-ssh.js`.
  All `browser-*` and `ssh-*` directories are merged, newer wins.
- `--rootfs` (or `$VANTAGE_ROOTFS`, default: `../vantage-rootfs` next to
  the repository; a directory or symlink holding an unpacked OpenWrt 25.12
  root filesystem with LuCI installed): core templates
  (`usr/share/ucode/luci/template`), `www/luci-static` (bootstrap, views),
  `usr/share/luci/menu.d`, `etc/os-release`.
- `--theme-dir`: a theme's `htdocs/luci-static/<name>`. Served first under
  `/luci-static/<name>/`; its package `htdocs/luci-static/resources/` (e.g.
  `menu-<name>.js`) is served before the mirror. Templates are taken from
  `<pkg>/ucode/template/themes/<name>/` (or `--templates`). Files are read on
  every request, so edits show up on reload.
- `--app-dir` (repeatable): a `luci-app-*` package in the working tree
  (e.g. `luci-app-vantage`). Its `htdocs/luci-static/` is served after the
  theme and before the mirror; `root/usr/share/luci/menu.d/*.json` is
  merged into the recorded menu the way the device's dispatcher would
  (missing parents become `firstchild` nodes, so a top-level entry with a
  low `order` becomes the landing page); `root/etc/config/*` seeds the uci
  overlay for configs the mirror has not recorded, so the app's own config
  reads and writes (add/set/delete/commit) work for the session. Files are
  read on every request.

Default theme is `bootstrap` (from the rootfs). A theme without templates
gets a built-in minimal header/footer shell (`#topmenu`, `#tabmenu`,
`#indicators`, `#maincontent`, loads `menu-<name>.js` or falls back to
`menu-bootstrap.js`), so CSS/JS work can start before the templates exist.

## Page rendering

The replay renders templates with `ut.js`, which compiles `.ut` files to
JavaScript (a host `ucode` is not needed; `tests/plugin.test.js` can use
one through `$UCODE` to run the app's rpcd plugin for real): `{{ }}`, `{% %}`, `{# #}`, whitespace trimming, colon blocks
(`if:/elif/else/endif`, `for`, `while`, `function`), ucode `for-in`
semantics, JSON interpolation in template literals, `import {…} from`.
Unknown names read as `null`, like ucode. The real core `view.ut`,
`header.ut` (which emits `L.env`), `footer.ut`, `sysauth.ut`,
`admin_status/index.ut` and the theme's own templates are rendered this way,
so what the browser gets matches what the device would send. Verified with
bootstrap (rootfs) and material (LuCI feed). Theme templates must stay
within the JS-compatible subset of ucode (all upstream themes do).

Routing follows the device dispatcher: the recorded menu
(`/admin/menu`) resolves the path (`firstchild`, `alias`, `rewrite`,
`view`, `template`). Menu nodes blanked by the recorder's secret filter
(e.g. `admin/system/admin/password`) are restored from `menu.d`.

## ubus / HTTP replay

- JSON-RPC on `/ubus/` and `/cgi-bin/luci/admin/ubus*`, batches and `list`.
- `call`: ssh time series (exact args) cycle by wall clock, one sample per
  recorded interval, so pollers see changing data (`system.info` uptime and
  local time keep counting across wrap-arounds); then browser rows (exact
  args); then the same object/method with other args (not for `file`/`uci`).
  Unknown calls answer `[4]` (UBUS_STATUS_NOT_FOUND).
- `session access` is always granted.
- `uci`: an in-memory overlay seeded from recorded `uci get`;
  set/add/delete/rename/order stage changes, `uci changes` lists them,
  apply/commit/confirm/revert (RPC and `/admin/uci/*`) succeed. Save & Apply
  works for the session; restart to reset.
- `file.write/remove`, `rc.init`, `luci.set*`, `system.reboot`,
  `network(.interface)` actions answer success and are dropped.
- `file.exec` and `/cgi-bin/cgi-exec` answer from recorded outputs by exact
  argv; otherwise NOT_FOUND / 403. Other `/cgi-bin/cgi-*` are refused.
- Plugins: every `dev/replay/<name>-plugin.js` is loaded at start and
  answers the ubus object(s) it names, before the recording is consulted.
  A plugin stands in for an rpcd plugin the replay cannot run and exports
  `OBJECT` (or `OBJECTS: [...]`), `call(store, method, args)` returning
  `{ result: [ status, data? ] }`, and optionally `POLICY`
  (`{ method: { arg: type } }`, used for `list`). It may use the store's
  `data()`, `call()`, `uci()`, `uciGet()` and `uciSeed()`. The replay
  prints the loaded plugins at start
  (`vantage-plugin.js`: `luci.vantage`, luci-app-vantage's plugin).
- Mirrored static files that are uhttpd's 404 page are served as 404, as on
  the device (the recorder keeps bodies, not statuses).

stderr lists coverage gaps once each: `unknown call`, `approximate (args
differ)`, `unrecorded exec`, `write dropped`, `static not found`. Record the
missing pages again to fill them.

## Synthetic data (`--synthetic`, on by default)

Some pages need data the recorded device cannot give. `synthetic.js`
generates it; every generated call is logged once on stderr as
`[replay] synthetic: ...`. `--no-synthetic` turns all of it off (the
calls then answer from the recording or NOT_FOUND as before).

- `luci getRealtimeStats` (Status -> Realtime Graphs). The firmware has no
  working `luci-bwc` for load/conntrack, and recorded interface/wireless
  rows carry old timestamps, so a replayed graph would never advance.
  Replies use luci-bwc's exact shape: one row per second for the last 180
  seconds, `[ts, ...]` with
  - `load`: `load1, load5, load15` x100, from the recorded `system info`
    load averages (interpolated between the 5-s samples, looped);
  - `interface <dev>`: `rx_bytes, rx_packets, tx_bytes, tx_packets`
    counters, following the recorded `network.device status` statistics
    of that device (so the rates are the real ones, looped); devices
    without recorded counters get a small invented trickle;
  - `wireless <ifname>`: `rate` (kbit/s), `signal+256`, `noise+256`
    (luci-bwc's uint8 encoding, 0 = none) from the recorded `iwinfo info`
    bitrate/signal/noise of that interface, with a little jitter;
  - `conntrack`: `udp, tcp, other` counts, invented (smooth noise).
- `luci getConntrackList`: ~25-30 invented flows between documentation
  addresses (192.0.2.0/24 -> 198.51.100.0/24, 203.0.113.0/24,
  2001:db8::/32), in rpcd's field layout.
- `iwinfo scan <radio>` (Status -> Channel Analysis; the recorder blocks
  scans on purpose): the AP's own sibling BSSIDs on that radio (read from
  the recorded `network.wireless status` at run time, never written to the
  repo) plus 12 (2.4 GHz) / 7 (6 GHz, channels 1-93) invented neighbours
  with example SSIDs (`ExampleNet`, `Office-Demo`, ...) and locally
  administered `02:00:5E:xx:xx:xx` BSSIDs on realistic channels and widths
  (`ht_operation` / `he_operation` like rpcd-mod-iwinfo). Signals wobble a
  few dB between scans.
- `iwinfo info radioN` when the mirror only recorded it for the radio's
  first interface (`phy6g-ap0`): answered with that interface's recorded
  sample, as iwinfo itself resolves a radio name.

## Translation preview (`--lang`)

`--lang <lang>` runs the UI in a language, for translators: `<lang>` is a
LuCI language code (`de`, `zh_Hans`, the name of a `po/` directory) or its
package suffix (`zh-cn`); `dev/i18n/luci-languages.mk` lists them. The
replay then does what LuCI does with installed language packages:

- `dispatcher.lang` is the suffix, so pages load
  `/cgi-bin/luci/admin/translations/<suffix>` and carry `lang="<suffix>"`;
- that URL answers `window.TR={...};` in the format of luci-base's
  `action_translations`, keyed by LuCI's `sfh` hash: the recorded catalogue
  for the language (if the recording has one), then every
  `po/<lang>/*.po` of the theme package (three levels above
  `--theme-dir`) and of each `--app-dir`, compiled the way `po2lmo` does
  (`dev/i18n/catalog.js`, checked against real `.lmo` files in
  `tests/i18n.test.js`); the packages' entries win;
- the templates' `_()` looks strings up in the same catalogue, with LuCI's
  whitespace canonicalisation, and falls back to the English text.

The `.po` files are read on every request: save, reload, see the change.
`N_()` in templates keeps English plurals. LuCI's own strings stay English
unless the recording contains that language's catalogue.

```sh
node dev/replay/server.js --mirror ../vantage-mirror --port 8106 --demo \
    --theme-dir luci-theme-vantage/htdocs/luci-static/vantage --theme vantage \
    --app-dir luci-app-vantage --lang de
```

## Demo mode (`--demo`)

For screenshots, screen shares and bug reports: `--demo` pseudonymises the
recording when it is loaded (`demo.js`), before any reply, template or
synthetic generator can read it. Every JSON value, JSON key and text output
(ubus replies, `log read`, `dmesg`, `ip neigh/route`, the nft ruleset, the
process list) goes through the same mapping, which is deterministic for a
mirror and consistent within a run:

| Recorded | Served in demo mode |
|---|---|
| universal MAC / BSSID | `00:00:5E:00:53:xx` (RFC 7042 documentation range) |
| locally administered MAC | `02:00:5E:00:53:xx` (U/L bit kept: randomised clients still show as private) |
| multicast MAC | `01:00:5E:90:10:xx` |
| bare 12-digit form of a known MAC (bridge ids, DUIDs) | the same demo MAC |
| private IPv4, per /24 | first network `192.0.2.0/24`, second `198.51.100.0/24`, last octet kept (the gateway stays `.1`) |
| other IPv4 networks, public IPv4 | `203.0.113.x` |
| global IPv6 | `2001:db8:<n>::/48`, subnet id kept |
| unique-local IPv6 | `2001:db8:fd0<n>::/48` (there is no documentation ULA prefix) |
| long interface identifiers (EUI-64, random) | `::<n>`, so link-local addresses become short `fe80::<n>` |
| AP hostname | `vantage-ap` |
| SSIDs, by band in wireless config order | 2.4 GHz `Harbor`, `Harbor-IoT`, `Harbor-Guest`; 5 GHz `Harbor-5G`; 6 GHz `Harbor-6E` |
| client hostnames, WPS device names | generic names by device type (`office-printer` / `Office printer`, `phone`, `laptop`, ...), else `device-<n>` / `Wireless device <n>` |
| search domains | `home.arpa` |
| DUIDs | `0004 00005e0053xx...` |
| Wi-Fi country code | `US` (the country list marks US active); channel and power data stay as recorded |
| time zone | `UTC` / `UTC0` |
| SSH key fingerprints in logs | a fixed `SHA256:demo...` placeholder |
| `serial` / `serial_number` / `sn` fields | removed |
| client names only found in DHCP log lines (`DHCPACK`, `not giving name`) | generic names, like other clients |
| bridge ids (`8000.<mac>`), bare 12 digits after `mac`/`bssid`, a known MAC's last three bytes after `_`/`-` (`ESP_xxxxxx`), EUI-64 identifiers (`a65e60fffe112233`, colon form), solicited-node groups | the matching demo MAC / identifier |
| DUIDs in text (`DUID ...`, `duid=`, `client-id`) | `0004 00005e0053xx...` |
| `Serial :` lines, `SerialNumber:`, `serial=`/`sn=` in text | zeros |
| uci free text (default-deny): any string under an option not known to be technical (`description`, `notes`, firewall rule `name`, uhttpd `commonname`/`location`/`organization`, NTP servers outside `*.pool.ntp.org`/`*.openwrt.org`, ...) unless it looks technical itself | `<option>-<n>` or `host<n>.example.net`, also where the same text appears elsewhere (nft comments, logs); fw4's default rule names and the `luci` config are kept |

Kept: the device model and board name (the product), interface names,
firmware and kernel versions, counters, rates, signal and noise values.

Names are found the way `security-tests/check_private_addresses.js` finds
mirror identifiers (its list is merged in: names with spaces and quotes,
WPS names from hostapd client signatures, names from DHCP log lines).
`node --test tests/` asks every recorded call through a demo-mode store when
the mirror is present and requires zero findings from the checker's
detectors and zero recorded identifiers or replaced originals, in any
spelling, in the answers (`tests/demo.test.js`); a canary mirror in the same
test covers the shapes above without relying on the checker's list.

**Limits.** Identifiers are recognised by shape (addresses, MACs and what
is derived from them) and by where they are recorded (the keys and log
lines above); uci values are default-deny. Other free text, such as a
person's name typed into a log message, a process argument or an
interface description outside uci, is not recognised in general. Look at
a screenshot before you share it.

Files served from the mirror's `static/` directories (LuCI's own
JavaScript) are not rewritten; some stock views contain example addresses
such as placeholders in forms, which are LuCI's, not the device's.

    node dev/replay/server.js --mirror ../vantage-mirror --port 8106 --demo \
        --theme-dir luci-theme-vantage/htdocs/luci-static/vantage --theme vantage \
        --app-dir luci-app-vantage

The README screenshots (`docs/screenshots/`) were taken this way.

Theme package (`luci-theme-vantage/`; templates are picked up from its
`ucode/template/themes/vantage/`, `menu-vantage.js` and `vantage-theme/*.js`
from its `htdocs/luci-static/resources/`):

    node dev/replay/server.js --mirror ../vantage-mirror --port 8086 \
        --theme-dir luci-theme-vantage/htdocs/luci-static/vantage --theme vantage \
        --app-dir luci-app-vantage

Dashboard package (`luci-app-vantage/`) under the prototype theme and
under bootstrap (no `--theme-dir`):

    node dev/replay/server.js --mirror ../vantage-mirror --port 8096 \
        --theme-dir prototypes/graphite/htdocs/luci-static/graphite --theme graphite \
        --app-dir luci-app-vantage
    node dev/replay/server.js --mirror ../vantage-mirror --port 8097 \
        --app-dir luci-app-vantage

Dashboard prototype (`prototypes/app`, reference only) under both prototype
themes:

    node dev/replay/server.js --mirror ../vantage-mirror --port 8046 \
        --theme-dir prototypes/graphite/htdocs/luci-static/graphite --theme graphite \
        --app-dir prototypes/app
    node dev/replay/server.js --mirror ../vantage-mirror --port 8047 \
        --theme-dir prototypes/paper/htdocs/luci-static/paper --theme paper \
        --app-dir prototypes/app

The recorded device still runs the old UniWRT theme; its menu entries
(Dashboard, System → Vantage Theme) are views that only work with that
theme's CSS, so they are dropped from the menu unless `--keep-uniwrt`.

## Recording (`dev/mirror/`)

Do not run the recorders unless you mean to read your own device, over the
wired management path.

`record-browser.js` opens Chromium with a throwaway profile and a
browser-wide DevTools interceptor (a pipe, no TCP port): every request of
every tab, popup, worker and service worker is decided by
`dev/mirror/policy.js` before it leaves the browser. Reads on the allowlist
are forwarded with the body re-serialised exactly as checked and recorded;
writes, applies, scans, uploads, other hosts and other spellings of the
device are refused and listed in `blocked.log`. The profile is removed on
every exit (window closed, Ctrl+C, SIGTERM, SIGHUP, an error); if the
recorder is killed outright, the browser exits with it (the pipe closes),
but the profile stays in `$TMPDIR/vantage-rec-profile-*`.

It needs the device certificate's pin, obtained over SSH (whose host key
you have verified), never from the TLS connection itself:

    scp -O root@<device>:/etc/uhttpd.crt /tmp/device.crt
    node dev/mirror/record-browser.js --cert /tmp/device.crt https://<device> ../vantage-mirror

or, as a pin (`--spki` or `$VANTAGE_DEVICE_SPKI`; uhttpd's generated
certificate is DER, drop `-inform der` for a PEM one):

    ssh root@<device> cat /etc/uhttpd.crt | openssl x509 -inform der -pubkey -noout \
      | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | openssl base64

Chromium then accepts only that key (`--ignore-certificate-errors-spki-list`)
instead of ignoring certificate errors. Secrets are scrubbed before
anything is written (see the header of `policy.js`); `file.read` contents
are kept only for a short list of non-secret system files (`/proc`, `/sys`,
`board.json`, `rt_tables`, `sysupgrade.conf`, ...), so `rc.local` and
crontabs replay as `<redacted>`.

The recorder is an accident guard for a person clicking through stock
LuCI, not a sandbox for hostile page JavaScript: it does not see
WebSockets, for example. `tests/recorder-policy.test.js` covers the policy;
`VANTAGE_BROWSER_TESTS=1 node --test tests/recorder-browser.test.js` runs
the recorder against a local mock device in headless Chromium (second tab,
popup, workers, profile removal, the pin).
