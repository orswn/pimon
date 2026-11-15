#!/usr/bin/env bash
# Puts the a2a-hub binary that scripts/a2a-hub.pin names at .hub/a2a-hub for the tests.
#
# Usage: scripts/fetch-hub.sh [image|local]
#   image: extracts the binary from ghcr.io/orswn/a2a-hub by digest with docker. The default when CI=true.
#          With GHCR_TOKEN set, it logs in to ghcr.io as GITHUB_ACTOR first.
#   local: builds the binary from a shallow clone of the pinned ref over SSH with mise and Go. The default otherwise.
# With HUB_BIN set, the tests run that binary and this script does nothing.
set -euo pipefail

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# shellcheck source=a2a-hub.pin
. "$repo/scripts/a2a-hub.pin"

out_dir="$repo/.hub"
out="$out_dir/a2a-hub"
stamp="$out_dir/a2a-hub.pin"
image="ghcr.io/orswn/a2a-hub"
source_url="git@github.com:orswn/a2a-hub.git"

if [[ "${CI:-}" == "true" ]]; then mode=${1:-image}; else mode=${1:-local}; fi
want="$mode $A2A_HUB_REF $A2A_HUB_DIGEST"

if [[ -n "${HUB_BIN:-}" ]]; then
	echo "HUB_BIN is set: the tests run $HUB_BIN. Nothing fetched."
	exit 0
fi
if [[ -x "$out" && -f "$stamp" && "$(cat "$stamp")" == "$want" ]]; then
	echo "$out is already a2a-hub $A2A_HUB_REF ($mode)."
	exit 0
fi

work=$(mktemp -d)
cleanup() {
	if [[ -n "${container:-}" ]]; then docker rm "$container" > /dev/null || true; fi
	if [[ -n "${logged_in:-}" ]]; then docker logout ghcr.io > /dev/null || true; fi
	rm -rf "$work"
}
trap cleanup EXIT

case "$mode" in
image)
	if [[ -z "$A2A_HUB_DIGEST" ]]; then
		echo "scripts/a2a-hub.pin has no image digest for $A2A_HUB_REF. Use: scripts/fetch-hub.sh local" >&2
		exit 1
	fi
	if [[ -n "${GHCR_TOKEN:-}" ]]; then
		docker login ghcr.io -u "${GITHUB_ACTOR:?GITHUB_ACTOR is needed with GHCR_TOKEN}" --password-stdin <<< "$GHCR_TOKEN"
		logged_in=1
	fi
	container=$(docker create "$image:$A2A_HUB_REF@$A2A_HUB_DIGEST")
	docker cp "$container:/a2a-hub" "$work/a2a-hub"
	;;
local)
	git -C "$work" init -q src
	git -C "$work/src" remote add origin "$source_url"
	git -C "$work/src" fetch -q --depth 1 origin "$A2A_HUB_REF"
	git -C "$work/src" checkout -q FETCH_HEAD
	# The image build reports a tag without its leading v.
	(cd "$work/src" && CGO_ENABLED=0 mise exec "go@$A2A_HUB_GO" -- go build -trimpath \
		-ldflags "-s -w -X main.version=${A2A_HUB_REF#v}" -o "$work/a2a-hub" ./cmd/a2a-hub)
	;;
*)
	echo "unknown mode $mode: use image or local" >&2
	exit 2
	;;
esac

mkdir -p "$out_dir"
install -m 755 "$work/a2a-hub" "$out.tmp"
mv -f "$out.tmp" "$out"
echo "$want" > "$stamp"
echo "$out is a2a-hub $A2A_HUB_REF ($mode)."
