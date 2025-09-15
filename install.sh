#!/bin/bash
set -e
cd "$(dirname "$0")"

rm -rf /usr/local/bin/pkij
ln -s "$(pwd)/pkij.js" /usr/local/bin/pkij
chmod +x /usr/local/bin/pkij
