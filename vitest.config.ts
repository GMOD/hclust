import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // a live agent worktree under .claude/ is another checkout of this
    // repo, and vitest's include glob matches dotfolders
    exclude: [...configDefaults.exclude, '**/.claude/**'],
    globals: true,
    environment: 'node',
  },
})
