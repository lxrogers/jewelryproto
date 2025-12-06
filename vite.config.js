import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  // Use relative paths so the built site can be hosted from any subpath (e.g. GitHub Pages)
  base: './',
  plugins: [react()],
  worker: {
    format: 'es'
  },
  optimizeDeps: {
    exclude: ['replicad', 'manifold-3d']
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    rollupOptions: {
      // Build all HTML entry points so each demo page is included in the dist output
      input: {
        main: resolve(__dirname, 'index.html'),
        coinDemo: resolve(__dirname, 'coin-demo.html'),
        manifoldRing: resolve(__dirname, 'manifold-ring-demo.html'),
        ringConfigurator: resolve(__dirname, 'ring-configurator.html'),
        ringFillet: resolve(__dirname, 'ring-fillet-demo.html'),
        sdfRing: resolve(__dirname, 'sdf-ring-demo.html'),
        smoothingTest: resolve(__dirname, 'smoothing-test.html'),
        sunRing: resolve(__dirname, 'sun-ring.html'),
        sunRing2: resolve(__dirname, 'sun-ring2.html'),
      },
    },
  },
});
