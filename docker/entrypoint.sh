#!/bin/sh
set -eu

node docker/prepare-config.mjs

exec "$@"
