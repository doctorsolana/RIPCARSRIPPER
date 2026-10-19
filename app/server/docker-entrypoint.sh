#!/bin/sh
# The image's entrypoint (Dockerfile): a fresh volume mounts owned by root, so as root it gives DATA_DIR to the node
# user, then runs the server as node - never as root. (Started as another user already: runs it as is.)
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  chown -R node:node "${DATA_DIR:-/data}"
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
