#!/bin/sh
# Run a command inside the Ubuntu 24.04 root (no Docker or sudo on this machine).
W=$HOME/src/lean-wasm
exec bwrap --bind $W/rootfs / --dev /dev --proc /proc --tmpfs /tmp \
  --bind $W $W --ro-bind /etc/resolv.conf /etc/resolv.conf \
  --unshare-user --uid 0 --gid 0 --share-net --die-with-parent \
  --setenv HOME /root --setenv HOME_REAL $HOME --setenv PATH /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  --setenv TAR_OPTIONS --no-same-owner --setenv LC_ALL C.UTF-8 --setenv DEBIAN_FRONTEND noninteractive --chdir "${CD:-$W}" "$@"
