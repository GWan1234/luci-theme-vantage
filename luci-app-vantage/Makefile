#
# Vantage dashboard for LuCI: a live, read-only overview of the device,
# its uplink, radios, SSIDs and stations. The only write is the station
# alias, stored in /etc/config/vantage (own ACL group).
#
# This is free software, licensed under the Apache License 2.0.
#

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-vantage
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=Apache-2.0

LUCI_TITLE:=Vantage dashboard
LUCI_DESCRIPTION:=Live network dashboard (landing page under admin/dashboard): device, \
	uplink, radios, SSIDs and stations with health and experience scores. \
	Read-only except for station names, which are kept in /etc/config/vantage.
# rpcd-mod-iwinfo provides the station lists (iwinfo info/assoclist).
# Optional at runtime, degrade when absent: rpcd-mod-rrdns (reverse DNS
# names), umdns (mDNS names), hostapd ubus objects (WPS names, client
# capabilities).
LUCI_DEPENDS:=+luci-base +rpcd +rpcd-mod-iwinfo
LUCI_PKGARCH:=all
LUCI_MAINTAINER:=anothaDev <10740588+anothaDev@users.noreply.github.com>
LUCI_URL:=https://github.com/anothaDev/luci-theme-vantage

# app.css uses custom properties, color-mix() and container queries,
# which csstidy (a CSS2-era minifier) mangles; ship it byte for byte.
LUCI_MINIFY_CSS:=0

define Package/luci-app-vantage/conffiles
/etc/config/vantage
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
