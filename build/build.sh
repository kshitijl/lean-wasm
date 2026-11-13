#!/bin/bash
# Build lean.js and lean.wasm from $W/src (see checkout.sh), following doc/make/emscripten.md of
# that branch. Run inside the build root: ./enter.sh ./build.sh
set -euxo pipefail
W=$HOME_REAL/src/lean-wasm
source $W/emsdk/emsdk_env.sh
export PATH=$W/node26/bin:$PATH
EM=$W/emsdk/upstream/emscripten
mkdir -p $W/src/build && cd $W/src/build
test -f CMakeCache.txt || cmake .. --preset release -B . \
  -DCMAKE_C_COMPILER_WORKS=1 -DSTAGE0_USE_GMP=OFF \
  "-DSTAGE0_LEAN_EXTRA_CXX_FLAGS=-m32 -msse2 -mfpmath=sse -DLEAN_DEFAULT_THREAD_STACK_SIZE=33554432" \
  "-DSTAGE0_LEANC_OPTS=-m32 -msse2 -mfpmath=sse" -DSTAGE0_LEAN_EXTRA_LINKER_FLAGS=-m32 \
  -DSTAGE0_CMAKE_C_FLAGS=-m32 -DSTAGE0_CMAKE_CXX_COMPILER=clang++ -DSTAGE0_CMAKE_C_COMPILER=clang \
  -DSTAGE0_CMAKE_EXECUTABLE_SUFFIX= -DSTAGE0_PKG_CONFIG_EXECUTABLE=/usr/bin/i386-linux-gnu-pkg-config \
  -DSTAGE0_CMAKE_LIBRARY_PATH=/usr/lib/i386-linux-gnu/ -DUSE_GMP=OFF -DMMAP=OFF -DSTAGE0_MMAP=OFF \
  -DUSE_MIMALLOC=OFF -DCMAKE_AR=$EM/emar -DCMAKE_TOOLCHAIN_FILE=$EM/cmake/Modules/Platform/Emscripten.cmake \
  -DLEAN_INSTALL_SUFFIX=-linux_wasm32 -DLEAN_INSTALL_PREFIX=$W/src
time make stage1 -j$(nproc)
time make -C stage1 install
echo BUILD-DONE
