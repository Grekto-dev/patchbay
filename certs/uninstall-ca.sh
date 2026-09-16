#!/usr/bin/env bash
# Removes the local CA from the system trust store (Linux / macOS).
# The PEM files under certs/ are left alone, so it can be reinstalled later.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
CN="Claude-DS Proxy CA"
OS="$(uname -s)"

# The panel runs this without a terminal, so a sudo password prompt would hang
# forever. Bail out with the command to run by hand instead.
if [ "$(id -u)" -ne 0 ] && ! sudo -n true 2>/dev/null; then
  echo "This needs sudo, and sudo wants a password."
  echo "Run it yourself in a terminal:"
  echo "  sudo bash \"$DIR/uninstall-ca.sh\""
  exit 1
fi

if [ "$OS" = "Darwin" ]; then
  if sudo security find-certificate -c "$CN" /Library/Keychains/System.keychain >/dev/null 2>&1; then
    sudo security delete-certificate -c "$CN" /Library/Keychains/System.keychain
    echo "CA removed from the System keychain."
  else
    echo "Nothing to remove: no '$CN' in the System keychain."
  fi

elif [ "$OS" = "Linux" ]; then
  removed=0
  for f in /usr/local/share/ca-certificates/claude-proxy-ca.crt \
           /etc/pki/ca-trust/source/anchors/claude-proxy-ca.pem; do
    if [ -f "$f" ]; then
      sudo rm -f "$f"
      removed=1
      echo "Removed $f"
    fi
  done
  if [ "$removed" = "1" ]; then
    if command -v update-ca-certificates &>/dev/null; then
      sudo update-ca-certificates --fresh >/dev/null
    elif command -v update-ca-trust &>/dev/null; then
      sudo update-ca-trust extract
    fi
    echo "CA removed from the system bundle."
  else
    echo "Nothing to remove: the CA is not in the system bundle."
  fi

else
  echo "Unsupported OS: $OS"
  exit 1
fi

echo "Claude Desktop will refuse the gateway until the CA is trusted again."
