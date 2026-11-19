import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'

let commitHash = 'dev'
try {
  commitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
} catch {
  // Not a git checkout — the footer shows "dev" instead of a hash.
}
const buildDate = new Date().toISOString().slice(0, 10)

export default defineConfig({
  // Baked into the bundle so the footer can show which build is live.
  define: {
    __COMMIT_HASH__: JSON.stringify(commitHash),
    __BUILD_DATE__: JSON.stringify(buildDate),
  },
  server: {
    port: 5173,
  },
  preview: {
    port: 4173,
    strictPort: true,
  },
})
