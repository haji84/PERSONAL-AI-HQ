#!/bin/sh
set -eu
cd "$(/usr/bin/dirname -- "$0")"
export PATH="${PATH:-/usr/bin:/bin}:/opt/homebrew/bin:/usr/local/bin"
umask 077
exec node app/server.mjs --open
