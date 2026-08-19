// Times three generations of src/wasm/distance.c against the same buffers in
// one process. scripts/bench-generations.sh extracts each generation from its
// commit and renames its two exported symbols to hc_gN/spc_gN so all three
// link together. Generation 3 is correctness work, so it has no column.
#include <math.h>
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
  const int V = 20;
  int defaults[] = {250, 500, 1000, 1500, 2000};
  int count = argc > 1 ? argc - 1 : (int)(sizeof(defaults) / sizeof(*defaults));

  printf("| N | 1. C port | 2. Lance-Williams | 4. cached NN | 1 -> 4 |\n");
  printf("| --- | ---: | ---: | ---: | ---: |\n");

  for (int s = 0; s < count; s++) {
    int n = argc > 1 ? atoi(argv[s + 1]) : defaults[s];
    if (n < 2) {
      fprintf(stderr, "N must be >= 2, got %d\n", n);
      return 1;
    }

    float* data = malloc((size_t)n * V * sizeof(float));
    float* heights = malloc((size_t)(n - 1) * sizeof(float));
    int* mergeA = malloc((size_t)(n - 1) * sizeof(int));
    int* mergeB = malloc((size_t)(n - 1) * sizeof(int));
    int* order = malloc((size_t)n * sizeof(int));
    if (!data || !heights || !mergeA || !mergeB || !order) {
      fprintf(stderr, "allocation failed at N=%d\n", n);
      return 1;
    }
    for (int i = 0; i < n; i++) {
      for (int j = 0; j < V; j++) {
        data[i * V + j] = (float)(sin(i * 31.0 + j * 7.0) * 100.0);
      }
    }

    double best[3] = {1e30, 1e30, 1e30};
    for (int r = 0; r < RUNS; r++) {
      double t;
      t = now_ms();
      hc_g1(data, n, V, heights, mergeA, mergeB, order);
      t = now_ms() - t;
      if (t < best[0]) best[0] = t;

      t = now_ms();
      hc_g2(data, n, V, heights, mergeA, mergeB, order);
      t = now_ms() - t;
      if (t < best[1]) best[1] = t;

      t = now_ms();
      hc_g4(data, n, V, heights, mergeA, mergeB);
      t = now_ms() - t;
      if (t < best[2]) best[2] = t;
    }

    printf("| %d | %.0f | %.0f | %.0f | %.0fx |\n", n, best[0], best[1],
           best[2], best[0] / best[2]);
    fflush(stdout);

    free(data);
    free(heights);
    free(mergeA);
    free(mergeB);
    free(order);
  }
  return 0;
}
