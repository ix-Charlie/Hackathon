import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import viteCompression from 'vite-plugin-compression';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const isProd = mode === 'production';

    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
        proxy: {
          // Proxy API requests to backend during development
          '/api': {
            target: env.VITE_BACKEND_API_URL || env.BACKEND_API_URL || 'http://localhost:3001',
            changeOrigin: true,
            secure: false,
          },
        },
      },
      plugins: [
        react(),
        // Gzip compression for production
        ...(isProd ? [
          viteCompression({
            algorithm: 'gzip',
            ext: '.gz',
            threshold: 1024,
          }),
          viteCompression({
            algorithm: 'brotliCompress',
            ext: '.br',
            threshold: 1024,
          }),
        ] : []),
      ],
      define: {
        // Only expose safe public keys to the browser
        'process.env.SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL || env.SUPABASE_URL),
        'process.env.SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY),
        'process.env.APP_DOMAIN': JSON.stringify(env.VITE_APP_DOMAIN || env.APP_DOMAIN),
        'process.env.BACKEND_API_URL': JSON.stringify(env.VITE_BACKEND_API_URL || env.BACKEND_API_URL || 'http://localhost:3001'),
        // OPENAI_API_KEY is NOT exposed - it's only used in Edge Functions
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      },
      build: {
        target: 'es2020',
        sourcemap: false,
        minify: 'terser',
        terserOptions: {
          compress: {
            drop_console: true,
            drop_debugger: true,
          },
        },
        cssMinify: true,
        chunkSizeWarningLimit: 500,
        rollupOptions: {
          output: {
            manualChunks: {
              'react-vendor': ['react', 'react-dom'],
              'supabase': ['@supabase/supabase-js'],
              'markdown': ['react-markdown'],
              'recharts': ['recharts'],
            },
          },
        },
      },
    };
});
