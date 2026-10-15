import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',
  plugins: [react()],
  server: { host: '127.0.0.1', strictPort: true },
  build: {
    sourcemap: false,
    // The largest chunk is Shiki's C++ grammar (~780 KiB), loaded only when a C++ file is viewed.
    // Initial-route chunks stay well below this limit.
    chunkSizeWarningLimit: 850,
    rolldownOptions: {
      output: {
        strictExecutionOrder: true,
        codeSplitting: { groups: [{ name: 'react-vendor', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ }] },
      },
    },
  },
});
