// Stub emscripten.h, so each generation's src/wasm/distance.c compiles with a
// host cc. Only two things from the real header reach that file.
#ifndef HCLUST_BENCH_EMSCRIPTEN_H
#define HCLUST_BENCH_EMSCRIPTEN_H

#include <time.h>

#define EMSCRIPTEN_KEEPALIVE

static inline double emscripten_get_now(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

#endif
