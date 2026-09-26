# LuCI 25.12 theme contract

What the LuCI core expects from a theme on OpenWrt 25.12, and the places
where a theme is load-bearing rather than cosmetic. Written from reading the
LuCI sources (luci-base `ucode/runtime.uc`, `ucode/dispatcher.uc`,
`ucode/template/{header,footer,view,sysauth}.ut`, `htdocs/luci-static/resources/{luci,ui,form,cbi,validation}.js`)
at LuCI 26.124.63982~650a6ca. Line references are to that tree.

## 1. Selection and templates

- `luci.main.mediaurlbase` selects the theme. The runtime compiles
  `themes/<basename(mediaurlbase)>/header`; if that fails it falls back to
  the first `luci.themes.*` entry whose header compiles (`runtime.uc:156-183`).
  Only the header is compile-checked.
- Template directory name == last path component of the media URL.
  Assets live in `www/luci-static/<name>/`.
- Required: `themes/<name>/header.ut`, `themes/<name>/footer.ut`.
  Optional: `themes/<name>/sysauth.ut` (rendered with `{duser, fuser}`;
  if missing the core sysauth includes the full theme header and footer).
- Render order: theme header → core `luci.js` script + `L = new LuCI({env})`
  → page body (`#view` with spinner) → core footer (apply handlers,
  theme-fallback indicator) → theme footer.
- The theme is global (System → Language and Style); no per-user theme.
- `error500` never uses the theme. `error404` and `csrftoken` do, **also
  for visitors who are not logged in**.

### Header must

- doctype, `<html lang="{{ dispatcher.lang }}">`, charset, viewport, CSS;
- load `admin/translations/<lang>` (defines `window.TR`) and then
  **`{{ resource }}/cbi.js` before `luci.js`** — otherwise `luci-loaded`
  never fires and every view spins forever;
- `<body data-page="{{ entityencode(join('-', ctx.request_path), true) }}">`
  (tab and sort state are keyed by it);
- provide `#indicators` and leave **`#maincontent` open** (Save/Reset and
  notifications need it). Never emit `#view` (core does).

### Footer must

- close `#maincontent` and the layout;
- only when `ctx.authsession && !blank_page`: `L.require('menu-<name>')`.

### Template scope

`http`, `ubus`, `uci` (root!), `ctx` (`path`, `request_path`,
`request_args`, `authsession`, `authtoken`, `authuser`, `authacl`),
`dispatched`, `version`, `config`, `dispatcher.{lang, build_url,
is_authenticated, menu_json, rollback_pending}`, `striptags`,
`entityencode`, `_`, `media`, `theme`, `resource`, `include`,
`media_error`, per-render `blank_page`, `css`, `fuser`/`duser`.
`node` and `rollback_token` are never set on the ucode path.

## 2. Security of templates

- `{{ }}` does **not** escape. Use `entityencode(v, true)`; `striptags()`
  for titles; JSON in scripts via `%J` or with `/` → `\/`.
- Attacker-controlled: `ctx.request_path`/`request_args` (reach unauth
  404 pages), `http.getenv(PATH_INFO|REQUEST_URI|HTTP_HOST|HTTP_REFERER|QUERY_STRING)`,
  every `http.formvalue()`, and **`fuser`** on the login page (formvalue
  reads the query string too). Never echo `fuser`; show a generic error.
- Templates run as root with full ubus/uci even unauthenticated: gate
  system info and menus on `ctx.authsession`.
- Login form: `method="post"`, **no `action`**, fields `luci_username`,
  `luci_password`, autocomplete `username` / `current-password`.
- No CSP from core; keep inline script minimal and data-free.

## 3. DOM hooks

| Hook | Owner | Notes |
|---|---|---|
| `#maincontent` | theme | Save/Reset, notifications, early errors |
| `#view` | core | must sit inside `#maincontent` |
| `#indicators` | theme | `uci-changes` (only UI entry to pending changes), `poll-status`, `media_error` |
| `body > #modal_overlay > .modal` | core | don't move it (`form.js:3736` selector) |
| `div.cbi-tooltip` | core | global floating tooltip |
| menu containers | theme | free-form, only the theme's menu script uses them |

## 4. Menu

`ui.menu.load()` (cached in sessionStorage, ACL-filtered server side),
`ui.menu.getChildren(node)` (drops unsatisfied/untitled, resolves alias,
sorts by `order`), `L.env.dispatchpath` (resolved), `L.env.requestpath`
(literal), `L.url(...)`. Tabs: when `dispatchpath.length >= 3` render the
children of the level-3 node. Log out is the menu node `admin/logout`.

## 5. CSS that is functionally required

The widget JS sets state; only the theme CSS hides or shows. Missing any
of these breaks behaviour, not just looks.

- `.hidden{display:none}` (dependencies), keep `[hidden]{display:none}`.
- `.td.cbi-value-field.inactive` (hidden field in table rows).
- `#modal_overlay` hidden unless `body.modal-overlay-active`; fixed,
  full viewport, scrollable. Variants: `.modal.cbi-modal`,
  `.modal.uci-dialog`, **`.modal.alert-message.notice|warning(.spinning)`**
  (apply countdown / rollback — blank without styling).
- `.cbi-tooltip` at rest invisible/off-screen, `position:absolute`, high
  z-index; also used inline in `.cbi-tooltip-container` (reveal on hover).
- Tabs: hide `[data-tab-title]:not([data-tab-active="true"])` — not
  `[data-tab]`, that also matches the `li`s. `.cbi-tab` vs `.cbi-tab-disabled`,
  `li[data-errors]` badge.
- `.cbi-dropdown` state machine: `position:relative`; closed shows only
  `li[display]`; `[open] > ul.dropdown` absolute, scrollable, above
  content; `ul.preview` visible when open; `li[placeholder]` only when
  `[optional]` and open; `[more]`/`[multiple][empty]` show `.more`;
  `[multiple]` shows `li > form` when open; `.hide-open`/`.hide-close`;
  a real transition on `ul.dropdown` (focus moves on `transitionend`);
  `li[selected]`, `li.focus`, `[disabled]`.
- ComboButton: `.cbi-dropdown.btn|.cbi-button` looks like a button,
  `.more` hidden, list hidden while `.spinning`.
- `.cbi-dynlist > .item::after` must have a real width (mouse removal
  hit-tests it).
- `.cbi-filebrowser` hidden unless `.open`.
- `.alert-message.fade-out` needs a real `transition` on opacity (node is
  removed on `transitionend`).
- `.cbi-progressbar > div` needs height/colour; text only exists in
  `title` → `::before{content:attr(title)}`.
- `.table/.tr/.th/.td` need table display for `div` markup too.
- `.spinning` on div/em/button/.modal/.cbi-dropdown.btn.
- `.cbi-input-invalid` visibly distinct.

## 6. Markup reference

- Map: `div.cbi-map > h2 + .cbi-map-descr + [.cbi-map-tabbed] > .cbi-section`.
- Section: `.cbi-section > h3, .cbi-section-descr, .cbi-section-node[.cbi-section-node-tabbed]`
  (`.cbi-section-node` also appears standalone), create row
  `.cbi-section-create > input.cbi-section-create-name + .cbi-button-add`.
- Option: `.cbi-value > label.cbi-value-title + .cbi-value-field > widget + .cbi-value-description`
  (no title → no field wrapper).
- Table section: `.cbi-tblsection > table.table.cbi-section-table`
  (`thead/tbody/tfoot`, `tr.cbi-section-table-titles`, `.cbi-section-table-row[data-sid]`,
  `td.cbi-value-field[data-title]`, `.cbi-section-actions`, `.drag-handle`,
  `.drag-over-above|below`, `.placeholder`).
- `ui.Table`: `table.table > tr.tr.table-titles > th.th[data-sortable-row][data-sort-direction]`,
  `td.td[data-title]`, `.cbi-rowstyle-1|2`, `tr.placeholder`.
- Page actions: `.cbi-page-actions` with Save & Apply ComboButton, Save, Reset.
- Widgets: `input.cbi-input-text`, `.control-group` (password + reveal),
  `textarea.cbi-input-textarea`, `.cbi-checkbox > input + label[for]`,
  `select.cbi-input-select`, `.cbi-range-slider`, dynlist `.cbi-dynlist`,
  file `.cbi-filebrowser`.
- Buttons: `.btn`, `.cbi-button` + `-action -apply -neutral -positive -negative -remove -reset -save -add -edit -reload`,
  `.important`, `.primary`, `[disabled]`, `div.btn` used as button.
- Notifications: `div.alert-message(.error|info|warning|danger|success|notice)`
  as first child of `#maincontent`, dismiss adds `.fade-out`.
- Changes dialog: `.uci-change-legend`, `.uci-change-list` with `ins`, `del`, `var`.
- Badges: `.ifacebadge(.large|-active)`, `.zonebadge` (inline
  `--zone-color-rgb`), `.ifacebox(-head|-body)`, `.network-status-table`, `.assoclist`.
- Utilities: `.left .right .center .top .middle .nowrap .hide-xs .flash
  .button-row .control-group .important .primary`; Escape looks for the
  close button in `.right`.
- Mobile: cells carry `data-title` for card layouts; prefer width-based
  media queries.

## 7. Dark mode

No core API. Convention: `<html data-darkmode="true|false">` set from
`prefers-color-scheme` in `<head>` before CSS. Inline colours to handle:
`.zonebadge[style]`, `.ifacebox-head[style]`, realtime graph SVG (white).

Status icons are `<img src="…/resources/icons/<name>.svg">` owned by
luci-base (built with `L.resource()`, re-created on every poll). A theme
swaps them with `img[src*="/resources/icons/<name>.svg"]{content:url(…)}`
(element replacement: Chrome 28, Firefox 63, Safari 9); LuCI's size and
title stay on the `<img>`. Colours are baked per mode because an external
SVG cannot see page CSS. Vantage generates both from `dev/icons/build.js`.

## 8. Packaging

- `luci-theme-<x>`, `LUCI_DEPENDS:=+luci-base`, `include ../../luci.mk`
  (or `$(TOPDIR)/feeds/luci/luci.mk`). No `luasrc` (pulls lua runtime).
- `ucode/` → `/usr/share/ucode/luci/`, `htdocs/` → `/www/`, `root/` → `/`.
- Write asset URLs as `"{{ media }}/x.css"` / `"{{ resource }}/x.js"` to
  get `?v=` cache busting from `SubstituteVersion`.
- `LUCI_MINIFY_CSS:=0` if CSS uses modern syntax csstidy may mangle.
- `root/etc/uci-defaults/30_luci-theme-<x>`: register `luci.themes.<Label>`,
  select only on fresh install (`PKG_UPGRADE != 1`); `postrm` removes it.
- NWA50BE firmware: `overlay/etc/uci-defaults/zzzz-nwa50be-community:150`
  forces bootstrap on first boot and runs after `30_*`.

## 9. 24.10

Unverified — no 24.10 LuCI tree was checked. Likely differences: dynlist
drag/drop and `::after` removal, table filter row, action column width,
`addTimeLimitedNotification`.
