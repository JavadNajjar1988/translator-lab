#!/bin/sh
set -eu

mkdir -p /app/config
chown node:node /app/config

exec runuser -u node -- node server/index.mjs
