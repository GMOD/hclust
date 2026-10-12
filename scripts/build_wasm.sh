#!/bin/bash
set -e

cd "$(dirname "$0")/.."
EXPECTED_EMCC_VERSION="$(cat .emscripten-version)"

source "${EMSDK:-$HOME/emsdk}/emsdk_env.sh"

EMCC_VERSION="$(emcc --version 2>/dev/null | head -1 | sed -E 's/.* ([0-9]+\.[0-9]+\.[0-9]+) .*/\1/')"
if [ "$EMCC_VERSION" != "$EXPECTED_EMCC_VERSION" ]; then
  echo "Error: emcc $EMCC_VERSION found, but .emscripten-version pins $EXPECTED_EMCC_VERSION." >&2
  echo "Install it with: ~/emsdk/emsdk install $EXPECTED_EMCC_VERSION && ~/emsdk/emsdk activate $EXPECTED_EMCC_VERSION" >&2
  exit 1
fi

echo "Building WASM module for clustering with emcc $EMCC_VERSION..."

cd src/wasm

emcc distance.c \
  -O3 \
  -msimd128 \
  -s WASM=1 \
  -s EXPORTED_RUNTIME_METHODS='["HEAPF32","HEAP32"]' \
  -s EXPORTED_FUNCTIONS='["_clusterBeginRows","_clusterBeginMatrix","_clusterInput","_clusterStep","_clusterProgress","_clusterMerges","_clusterFree"]' \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=64MB \
  -s MAXIMUM_MEMORY=2GB \
  -s MODULARIZE=1 \
  -s EXPORT_ES6=1 \
  -s EXPORT_NAME='createClusteringModule' \
  -s ENVIRONMENT='web,worker' \
  -s SINGLE_FILE=1 \
  -o distance.js

SCRIPT_NAME='var _scriptName=import\.meta\.url;'
if ! grep -q "$SCRIPT_NAME" distance.js; then
  echo "Error: distance.js has no '$SCRIPT_NAME' to patch; emscripten's output changed." >&2
  exit 1
fi
sed -i.bak "s/$SCRIPT_NAME/var _scriptName=\"\";/" distance.js
rm distance.js.bak

echo "Built src/wasm/distance.js"
