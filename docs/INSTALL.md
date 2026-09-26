# Installing Vantage

This guide covers installing the Vantage theme (`luci-theme-vantage`) and
dashboard (`luci-app-vantage`) on a router running OpenWrt, building them
into your own firmware, and undoing all of it again.

All examples use `192.0.2.1` for the router. That is a placeholder from the
documentation address range; replace it with your router's LAN address.

## Quick install

On OpenWrt 25.12, with the two `.apk` files and `SHA256SUMS` from a
[release](#from-a-github-release) (or your [own build](#build-from-source))
in the current directory on your computer:

```sh
sha256sum -c SHA256SUMS
scp -O luci-theme-vantage-*.apk luci-app-vantage-*.apk root@192.0.2.1:/tmp/
ssh root@192.0.2.1 'apk add --allow-untrusted /tmp/luci-theme-vantage-*.apk /tmp/luci-app-vantage-*.apk'
ssh root@192.0.2.1 'rm -f /tmp/luci-theme-vantage-*.apk /tmp/luci-app-vantage-*.apk'
```

Then **log out of LuCI and log in again**. The dashboard is now the first
page you see after login. Every step is explained below.

## Contents

- [Requirements](#requirements)
- [Get the packages](#get-the-packages)
  - [From a GitHub release](#from-a-github-release)
  - [Build from source](#build-from-source)
- [Install on the router](#install-on-the-router)
- [What the install changes](#what-the-install-changes)
- [Switch themes](#switch-themes)
- [Upgrade, downgrade, uninstall](#upgrade-downgrade-uninstall)
- [Build it into your firmware](#build-it-into-your-firmware)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [Agent-assisted install](#agent-assisted-install)

## Requirements

### OpenWrt

| OpenWrt | Package manager | Status |
|---|---|---|
| 25.12.x | apk (`.apk`) | Supported. Built with the 25.12 SDK and tested. |
| 24.10.x, 23.05.x | opkg (`.ipk`) | Untested. `dev/build/sdk-build.sh` can build `.ipk` files for these releases, but the LuCI differences have not been checked and nothing is guaranteed. |
| Snapshots | apk | Untested. |

Check what your router runs:

```sh
ssh root@192.0.2.1 'cat /etc/openwrt_release'
```

`DISTRIB_RELEASE` must start with `25.12`. Both packages are
architecture-independent (`noarch`), so the same two files install on every
target: MIPS, ARM, x86 and the rest.

### Packages on the router

Nothing to install beforehand on a standard OpenWrt image with LuCI. The
required packages are dependencies, so apk would fetch any that are missing
from your configured package feeds.

| Package | Needed by | Why | On standard LuCI images |
|---|---|---|---|
| `luci-base` | theme, app | LuCI itself | yes |
| `rpcd` | app | LuCI's backend for ubus calls | yes |
| `rpcd-mod-iwinfo` | app | lists radios and connected stations | yes (with `luci-mod-status`) |
| `rpcd-mod-rrdns` | app, optional | client names from reverse DNS | yes (with `luci-light`) |
| `umdns` | app, optional | client names from mDNS (`.local` announcements) | no |

When an optional package is missing, the dashboard leaves that name source
out and keeps working.

Space: the download is about 105 KB in total, and the two packages take
about 400 KB once installed (less on a compressed overlay).

### Browser

The theme and dashboard use current CSS (`:has()`, `color-mix()`, container
queries, subgrid). Any evergreen browser from 2023 or later works: Chrome
or Edge 117+, Firefox 121+, Safari 16.2+ (these minimum versions come from
the features the CSS uses; older browsers are not tested). No external
fonts, scripts or CDNs are loaded, so the UI works without internet access.

## Get the packages

You need three files: `luci-theme-vantage-<version>.apk`,
`luci-app-vantage-<version>.apk` and `SHA256SUMS`. Install either package
on its own or both together; the theme doesn't need the app, and the app
works under any LuCI theme.

### From a GitHub release

Releases are published at
<https://github.com/anothaDev/luci-theme-vantage/releases>.

> **Note:** at the time of writing, the repository and its releases may not be public
> yet. If the page above doesn't load, [build from source](#build-from-source).

Each release carries the two `.apk` files and a `SHA256SUMS` file listing
their SHA-256 hashes. Download all three from the release page, then check
them on your computer:

```sh
sha256sum -c SHA256SUMS            # Linux
shasum -a 256 -c SHA256SUMS        # macOS
```

Both files must report `OK`. On Windows, `Get-FileHash <file>` in
PowerShell prints the hash to compare by hand.

`SHA256SUMS` comes from the same place as the packages, so this check
catches damaged or incomplete downloads, not a tampered release. For an
independent check, rebuild the release yourself and compare hashes
([below](#verify-a-release-by-rebuilding-it)).

### Build from source

`dev/build/sdk-build.sh` builds both packages inside the official OpenWrt
SDK container image.

You need:

- Linux with **podman** (rootless is fine; the script runs the container
  with `--userns=keep-id`), `git` and `bash`. The script calls `podman`
  directly and does not use Docker.
- About **4 GB of disk** for the SDK image
  (`ghcr.io/openwrt/sdk:x86_64-25.12.4`, 3.6 GB) plus a few hundred MB while
  building. The container is removed afterwards; the image stays.
- **Network access**: the first run pulls the image, and every build clones
  OpenWrt's package feeds inside the container at the revisions the SDK
  pins.
- **Time**: pulling the image takes longest. The build itself takes a few
  minutes (about two on a current desktop).

```sh
git clone https://github.com/anothaDev/luci-theme-vantage.git
cd luci-theme-vantage
dev/build/sdk-build.sh              # SDK 25.12.4, current commit (HEAD)
dev/build/sdk-build.sh 25.12.4 <tag-or-commit>
```

The first argument is the SDK release (`25.12.*`, `24.10.*` or `23.05.*`),
the second any git revision. The packages and their `SHA256SUMS` land in
`dist/<release>/`. The script builds from a fresh clone of that commit, not
from your working tree, so uncommitted changes are not included. It keeps
its work directory (`vantage-build.XXXXXX` under `$TMPDIR`, or `/tmp`) with
the full `build.log`. Delete that directory once you no longer need the
log.

#### Verify a release by rebuilding it

A given commit and SDK release always produce byte-identical packages. To
confirm that a release's files were built from the source they claim, build
the release tag with the SDK release it was built with, then compare:

```sh
dev/build/sdk-build.sh 25.12.4 <tag>
diff dist/25.12.4/SHA256SUMS /path/to/downloaded/SHA256SUMS && echo identical
```

## Install on the router

### 1. Copy the files to the router

From your computer:

```sh
scp -O luci-theme-vantage-*.apk luci-app-vantage-*.apk SHA256SUMS root@192.0.2.1:/tmp/
```

`-O` makes scp use the classic SCP protocol. OpenWrt's SSH server
(Dropbear) has no SFTP server, and OpenSSH 9.0 and later use SFTP unless
told otherwise; without `-O` the copy fails with an error such as
`ash: /usr/libexec/sftp-server: not found` followed by
`scp: Connection closed`. On Windows, the built-in
`scp` accepts `-O` too; in WinSCP, choose the SCP protocol.

`/tmp` is RAM, so the files are gone after a reboot, which is fine: they
are only needed during installation.

**Or download on the router** once releases are public (OpenWrt's `wget`
follows GitHub's redirects over HTTPS). Take the tag and file names from
the release page:

```sh
cd /tmp
BASE='https://github.com/anothaDev/luci-theme-vantage/releases/download/<tag>'
for f in SHA256SUMS luci-theme-vantage-<version>.apk luci-app-vantage-<version>.apk; do
	wget -O "$f" "$BASE/$f" || break
done
```

### 2. Check the hashes on the router

```sh
ssh root@192.0.2.1
cd /tmp
sha256sum -c SHA256SUMS
```

When you copied only one of the packages, check just that one (`sha256sum
-c` fails for files that are listed but missing):

```sh
grep luci-theme-vantage SHA256SUMS | sha256sum -c
```

Continue only when every file says `OK`.

### 3. Install

Both packages:

```sh
apk add --allow-untrusted /tmp/luci-theme-vantage-*.apk /tmp/luci-app-vantage-*.apk
```

Theme only:

```sh
apk add --allow-untrusted /tmp/luci-theme-vantage-*.apk
```

Dashboard only (works under Bootstrap or any other theme):

```sh
apk add --allow-untrusted /tmp/luci-app-vantage-*.apk
```

**Why `--allow-untrusted`?** On OpenWrt 25.12, apk only installs packages
signed by a key in `/etc/apk/keys`, normally the OpenWrt release keys.
Vantage is not part of OpenWrt and its packages are not signed, so apk
refuses them (`UNTRUSTED signature`) unless you pass this flag. It turns off
signature checking for that command, which means:

- The hash check in step 2 is the only thing that tells you the files are
  the ones you meant to install. Do not skip it.
- The flag covers everything that command installs. If `luci-base`, `rpcd`
  or `rpcd-mod-iwinfo` is missing (unusual), install those first with a
  normal, signature-checked `apk update && apk add rpcd-mod-iwinfo`, then
  run the `--allow-untrusted` command with only the two Vantage files.

Check the result:

```sh
apk list --installed | grep vantage
```

### 4. Clean up and log in again

```sh
rm -f /tmp/luci-theme-vantage-*.apk /tmp/luci-app-vantage-*.apk /tmp/SHA256SUMS
```

In the browser, **log out and log in again** (or close the LuCI tab and open
a new one, then log in). Two reasons:

- rpcd gives a LuCI session its permissions at login. A session that
  started before the dashboard was installed doesn't have the dashboard's
  permissions, so the dashboard is missing from its menu.
- LuCI caches the menu for the session in the browser's `sessionStorage`.

## What the install changes

| | `luci-theme-vantage` | `luci-app-vantage` |
|---|---|---|
| Files | `/www/luci-static/vantage/` (CSS, icons, logo), `/www/luci-static/resources/menu-vantage.js`, `/www/luci-static/resources/vantage-theme/`, `/usr/share/ucode/luci/template/themes/vantage/` | `/www/luci-static/resources/view/vantage/`, `/www/luci-static/resources/vantage/`, `/usr/share/luci/menu.d/luci-app-vantage.json`, `/usr/share/rpcd/acl.d/luci-app-vantage.json`, `/etc/config/vantage` |
| Configuration | Registers the theme as `luci.themes.Vantage`. Makes it the active theme (`luci.main.mediaurlbase=/luci-static/vantage`) **only on a first install**, never on an upgrade or reinstall. | None besides its own `/etc/config/vantage` (client names). |
| Menu | – | Adds **Dashboard** (`admin/dashboard`) as the first menu entry, so it is the page LuCI opens after login. Status → Overview is unchanged. |
| After install | Clears LuCI's caches (`/tmp/luci-indexcache.*`, `/tmp/luci-modulecache/`) and reloads rpcd. | Same. |

Nothing else changes. Neither package adds a service, cron job or init
script, and neither touches network, wireless, firewall, DHCP or password
settings. The dashboard only reads status. Its one write is a name you give
a device, stored in `/etc/config/vantage`.

The dashboard's URL is `http://192.0.2.1/cgi-bin/luci/admin/dashboard`.

## Switch themes

In LuCI: **System → System → Language and Style → Design**, pick a theme,
then **Save & Apply**. Vantage is listed as `Vantage`. The light / dark /
auto switch in Vantage's top bar is a per-browser setting and doesn't
change the router's configuration.

From SSH:

```sh
uci set luci.main.mediaurlbase=/luci-static/vantage     # Vantage
uci set luci.main.mediaurlbase=/luci-static/bootstrap   # back to Bootstrap
uci commit luci
```

Reload the page afterwards. No service needs a restart.

## Upgrade, downgrade, uninstall

### Upgrade Vantage

Get the newer files, check their hashes as above, copy them to `/tmp`, then:

```sh
apk add --allow-untrusted /tmp/luci-theme-vantage-*.apk /tmp/luci-app-vantage-*.apk
```

apk replaces the installed version. Your theme choice is kept (the
upgrade never selects a theme), and so are your device names: when
`/etc/config/vantage` has been changed, apk keeps your file and saves the
packaged one next to it as `/etc/config/vantage.apk-new`, which you can
delete. Log out and in once after upgrading.

### Downgrade

Install the older files the same way. apk installs the exact file you
name, also when it is older than the installed version, and treats it as
an upgrade: theme choice and names are kept. If apk refuses, remove the
package first (below) and then install the older file; removing the theme
switches LuCI to Bootstrap, and the reinstall selects Vantage again.

### Uninstall

```sh
apk del luci-app-vantage luci-theme-vantage
```

Or name just one of them. What happens:

- **Theme:** if Vantage is the active theme, LuCI switches to Bootstrap (or,
  when Bootstrap isn't installed, to another installed theme), and the
  `Vantage` entry is removed from the theme list. LuCI also falls back to a
  working theme on its own if its theme ever goes missing, so you can't lock
  yourself out of the web interface this way.
- **Dashboard:** the Dashboard entry disappears and LuCI opens Status →
  Overview after login again. If you named devices, apk leaves your
  modified `/etc/config/vantage` in place; delete it with
  `rm /etc/config/vantage` if you don't want to keep it.

Log out and in afterwards to refresh the menu.

### Keep your device names

Device names live in `/etc/config/vantage` and nowhere else. LuCI's backup
(**System → Backup / Flash Firmware → Generate archive**) includes it. To
copy just that file:

```sh
scp -O root@192.0.2.1:/etc/config/vantage ./vantage.config        # back up
scp -O ./vantage.config root@192.0.2.1:/etc/config/vantage        # restore
```

### Upgrading OpenWrt itself

A firmware upgrade (sysupgrade) keeps your settings but not the packages
you installed with apk. After the upgrade LuCI can't find the Vantage theme
and falls back to Bootstrap on its own. Install the packages again as
above; since your settings, theme choice included, were kept, Vantage
becomes the active theme again and your device names are still there.

Attended Sysupgrade (the LuCI app or `owut`) requests a new image with your
installed packages from OpenWrt's build servers. Vantage is not in
OpenWrt's package feeds, so leave it out of that request (or uninstall it
first) and reinstall it afterwards.

## Build it into your firmware

### OpenWrt build system or SDK: add the feed

The repository is an OpenWrt package feed. In your OpenWrt source tree:

```sh
[ -f feeds.conf ] || cp feeds.conf.default feeds.conf
echo 'src-git vantage https://github.com/anothaDev/luci-theme-vantage.git' >> feeds.conf
./scripts/feeds update -a
./scripts/feeds install luci-theme-vantage luci-app-vantage
make menuconfig
```

In menuconfig, select **LuCI → Themes → luci-theme-vantage** and **LuCI →
Applications → luci-app-vantage** (`y` builds them into the image, `m` only
as packages). Or add them to your `.config`:

```
CONFIG_PACKAGE_luci-theme-vantage=y
CONFIG_PACKAGE_luci-app-vantage=y
```

The packages need the `luci` feed (the default feeds include it).

To pin a release, append `;<tag>` to the URL
(`https://github.com/anothaDev/luci-theme-vantage.git;<tag>`). While the
repository is private, `src-git` needs credentials; use a local clone
instead:

```sh
echo 'src-link vantage /path/to/luci-theme-vantage' >> feeds.conf
```

### ImageBuilder

With a 25.12 ImageBuilder, copy the two `.apk` files into its `packages/`
directory and name them in `PACKAGES`:

```sh
cp /path/to/luci-theme-vantage-*.apk /path/to/luci-app-vantage-*.apk packages/
make image PROFILE=<your-profile> PACKAGES="luci luci-theme-vantage luci-app-vantage"
```

The ImageBuilder indexes its `packages/` directory itself. The project has
not tested this route, so check the result before you flash it.

### Theme selection on first boot

In a firmware image, the theme registers and selects itself on the first
boot through `/etc/uci-defaults/30_luci-theme-vantage`. Scripts in
`/etc/uci-defaults/` run in alphabetical order, so a script that runs later
and sets the theme (some firmware projects force Bootstrap this way) wins.
To make sure Vantage is selected, add your own script that sorts last, for
example as `files/etc/uci-defaults/zzzz-vantage-theme` in the build tree
(or in the ImageBuilder's `FILES=` directory):

```sh
#!/bin/sh
uci set luci.main.mediaurlbase=/luci-static/vantage
uci commit luci
exit 0
```

The script runs once and is deleted after it succeeds. On a running router,
the two `uci` lines alone do the same.

## Troubleshooting

### Blank page or a spinner that never stops

1. Reload without the cache: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd>
   (<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> on macOS).
2. Log out and in again, or open LuCI in a new tab.
3. Clear LuCI's caches on the router and reload rpcd:

   ```sh
   rm -f /tmp/luci-indexcache.*
   rm -rf /tmp/luci-modulecache/
   /etc/init.d/rpcd reload
   ```

4. Check your browser version against the [requirements](#browser), and
   look at the browser console (<kbd>F12</kbd>) for errors.
5. Still broken? [Switch back to Bootstrap](#switch-themes) from SSH and
   open an issue with the console output.

### Vantage is not in the Design list

```sh
uci show luci.themes
```

must include `luci.themes.Vantage='/luci-static/vantage'`. If it doesn't,
check that the package is installed (`apk list --installed | grep vantage`)
and that `/usr/share/ucode/luci/template/themes/vantage/header.ut` exists,
then register the theme by hand:

```sh
uci set luci.themes.Vantage=/luci-static/vantage
uci commit luci
```

### The Dashboard is missing, or says permission denied

- Log out and in again. Permissions are fixed when a session starts.
- Check that `/usr/share/rpcd/acl.d/luci-app-vantage.json` exists, then run
  `/etc/init.d/rpcd reload`.
- `root` may use everything. Other LuCI users (set up in `/etc/config/rpcd`)
  see the Dashboard only when their `read` list includes `luci-app-vantage`
  (or `*`). To let them name devices, add `luci-app-vantage-names` to their
  `write` list. Without that, the dashboard works but offers no rename
  button.

### Realtime Graphs are empty

Status → Realtime Graphs is a stock LuCI page. It gets its data from the
`luci-bwc` program in `luci-mod-status`:

```sh
which luci-bwc          # normally /usr/bin/luci-bwc
```

If nothing is printed, your firmware image doesn't include it and the stock
graphs have no data under any theme. The Vantage dashboard doesn't use
`luci-bwc`; its throughput charts compute rates from interface counters
and work either way.

### Clients show no names

An access point that isn't the network's DHCP server knows little about its
clients. The dashboard tries, in order: your own name for the device, reverse
DNS, mDNS, DHCP host names (on the router that hands out addresses), the name
the device sends during WPS, the vendor from the MAC address, and finally
"Private device" for phones and laptops that use a randomised MAC address.
The source of each name is shown next to it.

- Reverse DNS needs `rpcd-mod-rrdns` and a DNS server that knows your
  clients. An OpenWrt router's dnsmasq answers for its DHCP leases.
- mDNS names need `umdns` (`apk add umdns`); names appear as devices
  announce themselves.
- Or name a device yourself: open it on the dashboard and choose **Name this
  device**. Names are saved in `/etc/config/vantage`.

### "not reported" next to noise, SNR or airtime

The Wi-Fi driver didn't report that value, or reported a placeholder.
Vantage says so instead of showing an invented number. Nothing needs fixing.

### Channel Analysis makes Wi-Fi stutter briefly

Status → Channel Analysis is a stock LuCI page. Its scan takes each radio
off its channel for a moment, so clients may notice a short hiccup while the
page is open. The Vantage dashboard never scans.

### Get back to Bootstrap from SSH

If the web interface is unusable, switch the theme without it:

```sh
uci set luci.main.mediaurlbase=/luci-static/bootstrap
uci commit luci
```

Then reload the page. To remove Vantage entirely, see
[Uninstall](#uninstall).

## Security notes

- **What the dashboard may do.** Its rpcd permissions (ACL) are read-only:
  system, network, radio and station status, host hints, reverse DNS,
  mDNS and `/proc/stat`. It cannot run commands. Its only write permission,
  in a separate group (`luci-app-vantage-names`), is to its own
  `/etc/config/vantage`. Details in the README's
  [Security](../README.md#security) section.
- **Wi-Fi keys.** The dashboard's read group (`luci-app-vantage`) includes
  `luci-rpc getWirelessDevices`, which returns the wireless configuration,
  including Wi-Fi passwords. LuCI's own Status and Wireless pages use the
  same call. If you give a restricted LuCI user the dashboard, that user can
  read the Wi-Fi keys.
- **The theme** shows logged-out visitors (the login page, error pages)
  nothing about the device, and loads nothing from the internet.
- **Unsigned packages.** Installing with `--allow-untrusted` means apk
  doesn't check who made the files. Check the SHA-256 hashes every time,
  and rebuild the release if you want independent proof of what it
  contains.

## Agent-assisted install

If you use a coding agent that can run shell commands on your computer (and
SSH to the router), you can have it do the installation. The prompt below
sets the rules. Fill in the three lines at the top, and read its plan before
you say yes.

```text
Install the Vantage LuCI theme and dashboard on my OpenWrt router.

Router:   root@192.0.2.1   (SSH; copy files with `scp -O`, the router has no SFTP)
Packages: <folder on my computer, or the release page URL> with
      luci-theme-vantage-*.apk, luci-app-vantage-*.apk and SHA256SUMS
Install:  <both | theme only | dashboard only>

Guide: docs/INSTALL.md in https://github.com/anothaDev/luci-theme-vantage
(sections "Install on the router" and "Uninstall").

Rules. Follow every one; if one gets in the way, stop and ask me.
1. Check first, change nothing: run `cat /etc/openwrt_release` and
   `apk --version` on the router. Stop and tell me if DISTRIB_RELEASE does
   not start with 25.12 or apk is missing.
2. Verify with `sha256sum -c` against SHA256SUMS on my computer, and again
   on the router after copying to /tmp. Stop on any mismatch or missing
   file. Never install a file whose hash you have not checked.
3. Before changing anything, back up LuCI's settings:
   `cp /etc/config/luci /tmp/luci.pre-vantage`, and copy that file to my
   computer with `scp -O`.
4. Show me the exact install commands and wait for my "yes" before any
   `apk add` or `apk del`. Install only with
   `apk add --allow-untrusted <exact /tmp paths of the Vantage files>`.
   If a dependency (luci-base, rpcd, rpcd-mod-iwinfo) is missing, ask me,
   then install it with a plain `apk add` without --allow-untrusted.
5. Never run sysupgrade, firstboot, reboot, mtd or anything that flashes
   firmware. Never change passwords, SSH keys, or the network, wireless,
   firewall or DHCP configuration. Do not run `uci set`/`uci commit`
   except the theme selection in the guide, and only if I ask for it.
6. Delete only files you created in /tmp (the copied .apk files and
   SHA256SUMS), by exact name. No `rm -r`, no deleting anything else.
7. If a command fails, stop and show me its output. Do not improvise
   fixes. To roll back: `apk del luci-app-vantage luci-theme-vantage`
   (LuCI switches back to Bootstrap by itself); restoring
   /tmp/luci.pre-vantage to /etc/config/luci is only needed if my LuCI
   settings changed in some other way, and only after I agree.

When done, report the checklist below and remind me to log out of LuCI
and log in again.
```

The agent's report should include:

- OpenWrt release and target (from `/etc/openwrt_release`)
- The hash check result for every file, on the computer and on the router
- Where the backup of `/etc/config/luci` is, on the router and on your
  computer
- Every command that changed something, with its output (at least the
  `apk add` output)
- `apk list --installed | grep vantage`
- `uci get luci.main.mediaurlbase` and `uci show luci.themes`
- Anything it skipped, any warning, and which temporary files it deleted
