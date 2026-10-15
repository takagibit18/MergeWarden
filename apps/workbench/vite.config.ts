import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/',
  plugins: [react()],
  server: { host: '127.0.0.1', strictPort: true },
  build: {
    sourcemap: false,
    rolldownOptions: {
      output: {
        strictExecutionOrder: true,
        codeSplitting: { groups: [{ name: 'react-vendor', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/ }] },
      },
    },
  },
});
