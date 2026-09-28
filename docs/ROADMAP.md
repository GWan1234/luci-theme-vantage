# Roadmap

Ideas and planned work, roughly in priority order. Nothing here is
promised; issues and pull requests for any of it are welcome.

## Next

### Search for clients, radios and networks (Ctrl+K)

The command palette searches pages only. The dashboard already knows every
client, radio, SSID and interface; it should register them with the
palette so that typing a name, MAC, IP or SSID jumps straight to it:

- clients by alias, resolved name, MAC or IP, opening the client inspector
  (`#client=<mac>`);
- radios by band, channel or name, opening the radio inspector
  (`#radio=<name>`);
- SSIDs, opening the dashboard filtered to that network;
- interfaces, opening their LuCI page.

The theme must keep working without the app, so the palette needs a small,
optional provider API (the app registers a provider if the theme is
present) and results must be built as text nodes like everything else.

## Later

- **One-click actions (v2):** restart a radio, disconnect or block a
  client, enable or disable an SSID. Each action gets its own narrow ACL
  group and a confirmation; the read-only dashboard stays the default.
- **Client names from DHCP:** a small service on the device that watches
  DHCP requests crossing the bridge and records the hostnames clients
  send. This is the only automatic name source that works on an access
  point that is not the DHCP server.
- **History and alerts:** an optional rpcd plugin that keeps a small ring
  buffer (signal, throughput, client counts) so charts survive a page
  reload, plus simple alerts (uplink down, client with weak signal for
  minutes).
- **Topology view:** gateway, access points and switches from LLDP and
  neighbour tables, not just the local path.
- **luci-app-statistics integration:** show collectd history in the
  dashboard when it is installed.
- **OpenWrt 24.10 support:** test the `.ipk` build and the widget
  differences listed in `docs/luci-contract.md`.
- **Translations:** the strings already go through `_()`; add `po/`
  catalogues.

## Upstream

- **LuCI core `L.env` on anonymous 404 pages:** LuCI's core `header.ut`
  prints the whole menu tree for visitors who are not logged in (see
  `SECURITY.md` and `docs/luci-contract.md`). A small patch to print only
  the fields `luci.js` uses would fix it for every theme.
