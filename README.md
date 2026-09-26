# Vantage

A LuCI theme and live dashboard for OpenWrt 25.12, built from scratch.

- **`luci-theme-vantage`** — the shell: icon rail with category panels,
  breadcrumb, Ctrl+K page search, unsaved-changes badge, light/dark/auto,
  a login page, restyled stock pages and charts, and its own icon set.
- **`luci-app-vantage`** — the dashboard at `admin/dashboard` (landing
  page): health verdict, network path, radios, SSIDs, clients with names,
  experience scores and live throughput, top talkers, system tile. It
  reads status only; the one thing it writes is client names to its own
  `/etc/config/vantage`.

The app works under any theme; the theme is useful without the app.

## Build

With podman and the official OpenWrt SDK image:

    dev/build/sdk-build.sh 25.12.4          # builds HEAD into dist/25.12.4/

The script builds from a clean clone of the commit, so the same commit
always produces byte-identical packages.

Install on a device (OpenWrt 25.12, apk):

    apk add --allow-untrusted ./luci-theme-vantage-*.apk ./luci-app-vantage-*.apk

## Develop

LuCI is prototyped offline against recorded device data, never against
the live device:

- `dev/mirror/` records a real LuCI session read-only (browser + SSH
  snapshots). Recordings stay outside the repository.
- `dev/replay/` serves the full LuCI UI from a recording, with the theme
  and app loaded from this tree. See `dev/replay/README.md`.
- `dev/icons/build.js` generates the status icon set.

Checks:

    node --test tests/
    node security-tests/check_dom_sinks.js
    node security-tests/check_private_addresses.js
    node security-tests/test_templates.js
    node security-tests/test_acl_policy.js

`docs/SPEC.md` describes the product, `docs/luci-contract.md` what LuCI
expects from a theme. `prototypes/` holds the design prototypes the
packages were made from.

## License

Apache License 2.0, see `LICENSE` and `luci-theme-vantage/NOTICE`.
