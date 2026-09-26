# Offline replay server

Serves the LuCI 25.12 web UI on `127.0.0.1` entirely from recorded data, so a
theme can be prototyped against real device data without touching the device.
Nothing is forwarded anywhere; there is no upstream.

    node dev/replay/server.js --mirror ../vantage-mirror [--port 8025] \
        [--theme-dir <pkg>/htdocs/luci-static/<name>] [--theme <name>] \
        [--templates <pkg>/ucode/template] [--rootfs <device rootfs dump>] \
        [--app-dir <luci-app package dir>]... [--keep-uniwrt] [--no-synthetic]

Open <http://127.0.0.1:8025/>. Any username/password logs in.

Inputs:

- `--mirror`: output of `dev/mirror/record-browser.js` / `record-ssh.js`.
  All `browser-*` and `ssh-*` directories are merged, newer wins.
- `--rootfs` (or `$VANTAGE_ROOTFS`, default: the flash dump in the sibling
  `zyxel-nwa50be-openwrt/work` tree): core templates
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

There is no `ucode` on the host, so `ut.js` compiles `.ut` templates to
JavaScript: `{{ }}`, `{% %}`, `{# #}`, whitespace trimming, colon blocks
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
