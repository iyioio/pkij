#!/bin/bash

# This scripts installs pkij into /user/local/bin by creating a symlink from the local ./pkij.js file
# to /usr/local/bin/pkij. This will allow you to run the pkij command anywhere on your computer
# and updates to pkij.js will be instantly seen, no build required.

set -e
cd "$(dirname "$0")"

rm -rf /usr/local/bin/pkij
ln -s "$(pwd)/pkij.js" /usr/local/bin/pkij
chmod +x /usr/local/bin/pkij
