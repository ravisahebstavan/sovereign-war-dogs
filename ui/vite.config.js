import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// When building for GitHub Pages, set VITE_APP_BASE to the subpath.
// e.g. VITE_APP_BASE=/sovereign-war-dogs/app/
// In dev mode (npm run dev) this is always '/'.
const base = process.env.VITE_APP_BASE ?? '/'

export default defineConfig({
  base,
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ws': {
        target: 'ws://localhost:9001',
        ws: true,
      }
    }
  }
})