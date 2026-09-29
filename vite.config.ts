import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    build: {
      target: 'es2022',
      minify: 'esbuild',
      // No source maps in the shipped client bundle — they expose full
      // source to anyone opening devtools. (The server bundle keeps its
      // local .map for stack traces; it is never served.)
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            // Split heavy third-party code into cache-friendly chunks so a
            // React or chart dependency bump doesn't invalidate everything.
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/') || id.includes('/zustand/')) {
              return 'react-vendor';
            }
            if (id.includes('/recharts/') || id.includes('/d3-') || id.includes('/victory-vendor/')) {
              return 'charts';
            }
            if (id.includes('/motion/') || id.includes('/framer-motion/') || id.includes('/popmotion/') || id.includes('/motion-dom/') || id.includes('/motion-utils/')) {
              return 'motion';
            }
            if (id.includes('/lucide-react/')) return 'icons';
            return 'vendor';
          }
        }
      }
    },
    /* No `server` block: nothing reads it. `npm run dev` is `tsx server.ts`,
       which builds its own inline Vite config (server.ts) with its own fs.deny
       and watch.ignored, and `vite preview` reads `preview`, not `server`. The
       block that was here configured a DISABLE_HMR env var that nothing in the
       repo sets, and carried AI-Studio scaffold comments. */
  };
});
