// Times three generations of src/wasm/distance.c against the same buffers in
// one process. scripts/bench-generations.sh extracts each generation from its
// commit and renames its two exported symbols to hc_gN/spc_gN so all three
// link together. Generation 3 is correctness work, so it has no column.
//
// Each argument is a matrix written by scripts/real-matrices.mjs: uint32 rows,
// uint32 columns, then float32 row-major.
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

int hc_g1(const float*, int, int, float*, int*, int*, int*);
int hc_g2(const float*, int, int, float*, int*, int*, int*);
int hc_g4(const float*, int, int, float*, int*, int*);

#define RUNS 3

static double now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return ts.tv_sec * 1000.0 + ts.tv_nsec / 1e6;
}

int main(int argc, char** argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: %s matrix.bin ...\n", argv[0]);
    return 1;
  }

  printf("| N × V | 1. C port | 2. Lance-Williams | 4. cached NN | 1 -> 4 |\n");
  printf("| --- | ---: | ---: | ---: | ---: |\n");

  for (int s = 1; s < argc; s++) {
    FILE* f = fopen(argv[s], "rb");
    uint32_t dims[2];
    if (!f || fread(dims, sizeof(uint32_t), 2, f) != 2) {
      fprintf(stderr, "cannot read %s\n", argv[s]);
      return 1;
    }
    int n = (int)dims[0];
    int v = (int)dims[1];
    float* data = malloc((size_t)n * v * sizeof(float));
    float* heights = malloc((size_t)(n - 1) * sizeof(float));
    int* mergeA = malloc((size_t)(n - 1) * sizeof(int));
    int* mergeB = malloc((size_t)(n - 1) * sizeof(int));
    int* order = malloc((size_t)n * sizeof(int));
    if (!data || !heights || !mergeA || !mergeB || !order) {
      fprintf(stderr, "allocation failed at %d x %d\n", n, v);
      return 1;
    }
    if (fread(data, sizeof(float), (size_t)n * v, f) != (size_t)n * v) {
      fprintf(stderr, "short read in %s\n", argv[s]);
      return 1;
    }
    fclose(f);

    double best[3] = {1e30, 1e30, 1e30};
    for (int r = 0; r < RUNS; r++) {
      double t;
      t = now_ms();
      hc_g1(data, n, v, heights, mergeA, mergeB, order);
      t = now_ms() - t;
      if (t < best[0]) best[0] = t;

      t = now_ms();
      hc_g2(data, n, v, heights, mergeA, mergeB, order);
      t = now_ms() - t;
      if (t < best[1]) best[1] = t;

      t = now_ms();
      hc_g4(data, n, v, heights, mergeA, mergeB);
      t = now_ms() - t;
      if (t < best[2]) best[2] = t;
    }

    printf("| %d × %d | %.0f | %.0f | %.0f | %.1fx |\n", n, v, best[0],
           best[1], best[2], best[0] / best[2]);
    fflush(stdout);

    free(data);
    free(heights);
    free(mergeA);
    free(mergeB);
    free(order);
  }
  return 0;
}
