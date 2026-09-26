# Vantage — v1 specification

Status: **draft for approval**. Nothing here is built yet except the dev
tooling in `dev/`.

Vantage is a LuCI theme plus a companion dashboard app for OpenWrt. It
takes its cues from the *functionality* of managed-network consoles —
seeing the whole network at a glance, drilling into any client, radio or
port in one click, finding anything by typing — not from their look.

## 1. Goals

1. Every stock LuCI page works and looks deliberate under Vantage: no
   unstyled widget, no broken dropdown, no stuck spinner (see
   `docs/luci-contract.md`).
2. Navigation is fast: any page is two clicks or one Ctrl+K away.
3. The dashboard answers "is my network OK, and if not, where?" within a
   glance, on real devices with real quirks (APs without DHCP, missing
   noise values, placeholder model strings).
4. Safe by construction: app in v1 writes only its own config, narrow ACLs, template and
   DOM security checks in CI.
5. Small and offline: no CDNs, no web fonts, no frameworks, works on a
   128 MB device, first paint under 1 s on the device's own web server.

### Non-goals (v1)

- Replacing LuCI's forms or views; Vantage styles and wraps them.
- Device-changing actions from the dashboard (v2, behind their own ACLs).
- History/graphs (v2 plugin), topology maps (later).
- 24.10 support (after 25.12 is solid; contract differences are unverified).

## 2. Packages

| Package | Contents | Depends |
|---|---|---|
| `luci-theme-vantage` | ucode templates, CSS, icons, `menu-vantage.js` (shell: rail, top bar, palette, tabs, indicators), login page | `+luci-base` |
| `luci-app-vantage` | dashboard + inspector views under `admin/dashboard` (landing page), its rpcd ACL (reads + its own config only), `/etc/config/vantage` | `+luci-base +rpcd +rpcd-mod-iwinfo`; reverse DNS (`rpcd-mod-rrdns`), mDNS (`umdns`) and hostapd's ubus objects are optional and degrade |

The theme is useful alone; the app works under any theme but is designed
for Vantage. Names used everywhere: theme dir `vantage`, media URL
`/luci-static/vantage`, uci `luci.themes.Vantage`, config `/etc/config/vantage`.

## 3. Theme v1

### Shell

- **Icon rail** (left, 56 px) with the top-level categories from
  `ui.menu`; hover/click opens a **flyout** of that category's pages;
  the rail can be pinned open with labels (remembered per browser).
- **Top bar**: breadcrumb (Category › Page › Tab), **command palette**
  (Ctrl+K or `/`): fuzzy search over every menu page, recent pages first;
  later the app registers entities (clients, interfaces, radios) into it.
- **Indicators** as pills; the unsaved-changes count is prominent and
  opens the changes dialog.
- **Host chip**: hostname · model (board name when the model string is a
  placeholder), from `system board` via rpc in the menu script.
- **Theme toggle**: auto / light / dark, stored in `localStorage`, applied
  in `<head>` before CSS (no flash), exposed as `html[data-darkmode]`.
- **Tabs** (depth ≥ 3) under the top bar.
- **Mobile** (≤ 720 px): rail becomes a drawer/bottom bar, tables become
  cards using `td[data-title]`, forms stack.

### Pages

- Own **login** (`sysauth.ut`): brand, hostname, generic error, contract-
  correct form. No system information for unauthenticated visitors.
- All core widgets per contract §5 (dropdown state machine, tabs, modals
  incl. apply countdown, tooltips, dynlist, progress bars, file browser,
  notifications with real fade-out transition, changes dialog).
- 404 / CSRF pages render in the theme without leaking anything.

### Visual identity

**Chosen: Graphite** (2026-09-26). Paper stays in `prototypes/paper` as a
reference only.

- **Graphite** — dark-first technical console, graphite neutrals,
  signal-lime accent, monospace tabular values, compact.
- **Paper** — light-first editorial, warm paper neutrals, vermilion
  accent, typography-led, softer.

Either way: one accent colour only, status colours distinct from it,
system font stacks, self-drawn SVG icons, WCAG AA contrast in both modes,
visible focus, reduced-motion respected.

## 4. App v1 (`luci-app-vantage`)

- **Overview**: device card (model, firmware, uptime, CPU, memory, temp
  if available), uplink card (resolved uplink interface, address, rate),
  radios card (band, channel, width, tx power, utilisation, client count),
  clients card (count by band, weakest signals), health score.
- **Inspectors** (drawer or page, deep-linkable):
  client (MAC, host hint, IP, radio/SSID, signal history for the session,
  rates, inactive time), radio (channel, width, noise when real, clients),
  interface (proto, addresses, counters, rates).
- **Client names**: every client gets a human label, resolved in order:
  user alias (rename in the inspector, stored in `/etc/config/vantage`),
  reverse DNS (`network.rrdns`), mDNS (`umdns`, when running), IP from host
  hints, vendor from a small built-in OUI table, or "Private Wi-Fi
  address" for randomised MACs. Never "?". The source is shown.
- **Insight over decoration**: per-client experience score with a reason,
  Wi-Fi generation badges and legacy-client flags, top talkers by live
  throughput, new/recently-gone clients, busiest radio; each insight links
  to the LuCI page that fixes it.
- **Entity search**: clients, interfaces, radios, SSIDs injected into the
  command palette.
- **Health**: simple, explainable scores (e.g. signal < −75 dBm, uplink
  down, memory > 90 %, radio disabled) each with a one-line reason and a
  link to the page that fixes it.
- Polling via `poll.add` with sane intervals; pauses when the tab is hidden.
- ACL: read-only ubus methods only (`system info/board`, `network.*
  status/dump`, `network.wireless status`, `iwinfo info/assoclist`,
  `hostapd.* get_status/get_clients`, `luci-rpc getHostHints/getWirelessDevices`,
  `network.rrdns lookup`, `umdns hosts`, `file read` of `/proc/stat`,
  `uci get` for `vantage`), no `file.exec`. The only write is `uci` on the
  app's own `vantage` config (client aliases), in a separate ACL group.
  `getWirelessDevices` returns the wifi-iface sections including keys, so
  the read group's description says it exposes Wi-Fi keys.

## 5. Later

- **v2**: one-click actions (restart radio, kick/ban client, toggle SSID)
  each behind a separate narrow write ACL and a confirmation;
  optional rpcd plugin keeping a small ring buffer for history, alerts.
- **v3**: topology view, luci-app-statistics integration, 24.10 support.

## 6. Security requirements

- Templates escape everything request-derived; never echo `fuser`;
  unauthenticated renders expose nothing about the device.
- No `innerHTML`/`insertAdjacentHTML`/string-built DOM with data; `E()`
  and text nodes only (checked by `security-tests/check_dom_sinks.js`).
- ACL test: the app's ACL grants only the listed read methods and every
  `rpc.declare` in the app is covered, nothing unused is granted
  (`security-tests/test_acl_policy.js`, also run by `node --test tests/`).
  The one object glob is `hostapd.*` (hostapd's ubus objects are named per
  interface), limited to `get_clients`/`get_status`.
- No private addresses or MACs in committed files
  (`security-tests/check_private_addresses.js`, which also looks for the
  hostnames/SSIDs recorded in the mirror when it is present); fixtures are
  pseudonymised from the mirror (MAC → 00:00:5E:00:53:xx, IPv4 →
  192.0.2.x/198.51.100.x, IPv6 → 2001:db8::/32, hostnames → client-NN).
  Invented locally administered MACs use the 02:00:5E:xx:xx:xx prefix
  (IANA OUI with the U/L bit set; e.g. the replay's synthetic BSSIDs);
  no other MACs pass.
- Built-package verification (`verify_built_apk.py`) and reproducible
  release manifests as in the previous project.

## 7. Development workflow

- `dev/mirror/`: read-only recorders (browser + SSH). Private data stays in
  `~/Work/vantage-mirror` (mode 0700), never in the repo.
- `dev/replay/`: offline LuCI served from the mirror; `--theme-dir` loads
  the theme from the working tree, reload to see edits.
- Tests: node unit tests for data logic, headless screenshot suite over a
  fixed page list (light/dark/mobile) for visual review.
- Build: OpenWrt SDK 25.12 in podman, same reproducible pipeline as before.
- Deploy to the AP only when explicitly asked; the AP stays on its current
  theme until Vantage is approved.

## 8. Decisions needed

1. ~~Visual direction~~ — decided: Graphite.
2. Mobile nav: bottom bar vs drawer (prototypes may show both).
3. Anything to add or cut from theme v1 / app v1 above.
