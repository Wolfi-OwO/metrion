import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// The footer's version comes from package.json rather than a second copy that
// would drift the first time someone bumps one and forgets the other.
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as {
  version: string;
};

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), tailwindcss()],
  build: {
    /**
     * Measured, not guessed: after the second redesign (hand-laid dependency
     * graph, chart legend and axis code, light theme, code highlighter) the JS
     * bundle is 700 kB raw / 208 kB gzipped, up from 668 kB / 198 kB after the
     * first one and 566 kB / 169 kB before either. Vite's default 500 kB
     * warning would fire on every build, and a warning that always fires is a
     * warning nobody reads - so the limit is moved deliberately to 750, which
     * leaves room for one more feature before it has to be moved again.
     *
     * ponytail: accepted, not solved. Express serves this bundle from the same
     * scale-to-zero container as the API, so it is fetched during the same
     * 5-15s cold start it is competing with - a second of transfer against
     * fifteen of container start, and cached from then on. Upgrade path if it
     * ever matters: drop recharts for hand-drawn SVG polylines, which is what
     * these strip charts actually are, before reaching for code splitting -
     * splitting moves the bytes, it does not remove them.
     */
    chunkSizeWarningLimit: 750,
    // Task 13 serves this directory from the Express app itself, so the output
    // stays inside the client workspace rather than being written up into the
    // server's tree - one build, one owner of the folder it writes.
    outDir: 'dist',
    // Off, not 'hidden': there's no error reporter wired up in this app yet
    // to consume a hidden map, so shipping one (even unlinked) would just be
    // full source sitting on the server for no reader. Revisit if/when one
    // lands.
    sourcemap: false,
  },
  server: {
    port: 5173,
    // Same-origin in dev, exactly as it will be in production once Express
    // serves `dist/`. No CORS config to keep in sync, and no base URL: every
    // request in `src/api/client.ts` is a bare `/api/...` path.
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
});
