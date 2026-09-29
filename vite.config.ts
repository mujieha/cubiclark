import { defineConfig } from 'vite'

export default defineConfig({
  root: 'src/client',
  // Relative asset URLs: the app is served under /<run-token>/, not at the origin root, so
  // every asset reference must be relative to the page rather than absolute from '/'.
  base: './',
  build: {
    outDir: '../../dist/client',
    emptyOutDir: true,
  },
})
