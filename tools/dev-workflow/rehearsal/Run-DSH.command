#!/bin/sh
set -eu
tool_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
[ "$#" -gt 0 ] || set -- launch
exec /usr/local/bin/node "$tool_dir/run.mjs" "$@"
