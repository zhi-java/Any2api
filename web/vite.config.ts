import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// 构建产物直接输出到 src/admin/dist，由 Express 以 /admin/ 静态目录托管，
// 部署形态仍只有本地与 Docker 两种，无需额外进程。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/admin/',
  build: {
    outDir: '../src/admin/dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/admin/api': 'http://localhost:3000',
      '/performance/api': 'http://localhost:3000',
    },
  },
});
