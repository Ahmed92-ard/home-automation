import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Run from the project root: vite --config web/vite.config.mts
// Dev-only proxy: /api -> the Worker on :8787. Production origin checks are untouched.
const WORKER = 'http://localhost:8787'

export default defineConfig({
  root: 'web',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: WORKER,
        changeOrigin: true,
        // The browser sends Origin: http://localhost:5173. Present the Worker's own origin instead so
        // its origin check passes in dev, without changing the Worker or weakening production.
        headers: { Origin: WORKER },
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt', // new versions wait for the user to tap "Update"
      includeAssets: ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'Home Control',
        short_name: 'Home Control',
        description: 'Control your 8-channel ESP32 relay board.',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#000000',
        theme_color: '#000000',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
        // Never cache API traffic: login, session, state and relay commands always hit the network.
        runtimeCaching: [{ urlPattern: ({ url }) => url.pathname.startsWith('/api/'), handler: 'NetworkOnly' }],
      },
    }),
  ],
})
