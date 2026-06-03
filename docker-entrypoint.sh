#!/bin/sh
set -eu

mkdir -p "${CONFIG_DIR:-/config}/keys"
mkdir -p "${LOCAL_FILE_ROOT:-${CONFIG_DIR:-/config}/files}"

if [ "$(id -u)" = '0' ]; then
  chown -R node:node "${CONFIG_DIR:-/config}" "${LOCAL_FILE_ROOT:-${CONFIG_DIR:-/config}/files}"
  chmod 700 "${CONFIG_DIR:-/config}" "${CONFIG_DIR:-/config}/keys" "${LOCAL_FILE_ROOT:-${CONFIG_DIR:-/config}/files}"
  find "${CONFIG_DIR:-/config}" -type d -exec chmod 700 {} \;
  find "${CONFIG_DIR:-/config}" -type f -exec chmod 600 {} \;
  exec su node -s /bin/sh -c 'exec "$@"' sh "$@"
fi

chmod 700 "${CONFIG_DIR:-/config}/keys" "${LOCAL_FILE_ROOT:-${CONFIG_DIR:-/config}/files}"

exec "$@"
