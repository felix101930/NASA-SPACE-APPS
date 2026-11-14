import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Base path is configurable for GitHub Pages (e.g. BASE_PATH=/NASA-SPACE-APPS/) or Vercel (default "/").
const base: string = process.env.BASE_PATH ?? './';

export default defineConfig({
  base,
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    chunkSizeWarningLimit: 2500,
    rollupOptions: {
      output: {
        manualChunks(id: string): string | undefined {
          if (id.includes('node_modules/three') || id.includes('@react-three')) return 'three';
          if (id.includes('maplibre-gl')) return 'maplibre';
          if (id.includes('recharts') || id.includes('d3-')) return 'charts';
          return undefined;
        },
      },
    },
  },
});
