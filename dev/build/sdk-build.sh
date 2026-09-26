#!/usr/bin/env bash
# Build the Vantage packages with the official OpenWrt SDK image in podman.
#
#   dev/build/sdk-build.sh [sdk-release=25.12.4] [git-rev=HEAD]
#
# Builds from a self-contained clone of <git-rev> (not the working tree and
# not a git worktree), so file timestamps come from git and the packages are
# byte-identical to any other build of the same commit. The SDK entrypoint is
# openwrt/gh-action-sdk's, pinned by hash. Output: dist/<release>/.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
release=${1:-25.12.4}
rev=$(git -C "$repo" rev-parse "${2:-HEAD}")
packages="luci-theme-vantage luci-app-vantage"

case $release in
	23.05.*|24.10.*|25.12.*) ;;
	*) echo "unsupported SDK release: $release" >&2; exit 2 ;;
esac

# openwrt/gh-action-sdk@f5813d30eeef3534b58ac7e79c5d8842b6035434 entrypoint.sh
echo "e78cc3ca3ffe9a15d47096e2e9a2aa07399a22a77acdca31f4e5aef2fa0e6a9c  $here/entrypoint.sh" | sha256sum -c --quiet

work=$(mktemp -d "${TMPDIR:-/tmp}/vantage-build.XXXXXX")
git clone --quiet --no-local "$repo" "$work/feed"
git -C "$work/feed" checkout --quiet --detach "$rev"
mkdir "$work/artifacts"

podman run --rm --userns=keep-id \
	-v "$work/feed:/feed:ro" \
	-v "$work/artifacts:/artifacts" \
	-v "$here/entrypoint.sh:/entrypoint.sh:ro" \
	-e FEEDNAME=vantage -e PACKAGES="$packages" -e V=s \
	--entrypoint /bin/bash \
	"ghcr.io/openwrt/sdk:x86_64-$release" /entrypoint.sh > "$work/build.log" 2>&1 || {
	echo "SDK build failed; log: $work/build.log" >&2
	tail -n 40 "$work/build.log" >&2
	exit 1
}

out="$repo/dist/$release"
mkdir -p "$out"
find "$work/artifacts/bin" -type f \( -name 'luci-*-vantage*.apk' -o -name 'luci-*-vantage*.ipk' \) -exec cp -v {} "$out/" \;
( cd "$out" && sha256sum -- *.apk *.ipk 2>/dev/null | tee SHA256SUMS )
echo "built $rev for OpenWrt $release -> $out (work dir: $work)"
