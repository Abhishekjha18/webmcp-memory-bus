import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  base: '/webmcp-memory-bus/',
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        // The app itself, plus the headless bridge the companion extension
        // frames so that ambient tool calls land in this origin's store.
        main: resolve(import.meta.dirname, 'index.html'),
        bridge: resolve(import.meta.dirname, 'bridge.html'),
      },
    },
  },
})
