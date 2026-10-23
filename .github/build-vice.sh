#!/bin/sh
# Builds VICE's headless emulators (x64sc, x128, c1541; no window, ROMs
# included) into $1, for the VICE tests in CI.
# usage: .github/build-vice.sh prefix [version]
set -eu
prefix=$1
version=${2:-3.10}
work=$(mktemp -d)
cd "$work"
curl -fsSL --retry 5 -o vice.tar.gz "https://downloads.sourceforge.net/project/vice-emu/releases/vice-$version.tar.gz"
tar -xzf vice.tar.gz
cd "vice-$version"
./configure --prefix="$prefix" --enable-headlessui --disable-html-docs --disable-realdevice \
  --disable-hardsid --without-pulse --without-alsa --without-png --without-libcurl >configure.log 2>&1 \
  || { tail -40 configure.log; exit 1; }
make -j"$(nproc 2>/dev/null || sysctl -n hw.ncpu)" >make.log 2>&1 || { tail -60 make.log; exit 1; }
make install >install.log 2>&1 || { tail -40 install.log; exit 1; }
rm -rf "$work"
