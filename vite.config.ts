import { defineConfig } from 'vite';

// 相対パスでビルドし、GitHub Pages のサブパス (https://<user>.github.io/581run/) でも動くようにする
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1000,
  },
});
