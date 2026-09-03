import { defineConfig } from 'vite';

/**
 * - base './'      : サブパス配置（例 https://host/sub/）でも assets を相対参照で解決する
 * - target es2022  : MapLibre v6（ESM / WebGL2）前提。iOS 15+ / Chrome 94+ 相当
 * - worker         : src/main.ts は `maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` を
 *                    setWorkerUrl() に渡す。Vite は worker を `dist/assets/maplibre-gl-worker-*.js`
 *                    として出力し、URL は `new URL(..., import.meta.url)` で解決されるため
 *                    サブパス配置でも同一ディレクトリから 200 で取得できる（scripts/check-endpoints.mjs
 *                    と README「MapLibre v6 Worker」参照）
 * - ports          : dev 5291 / preview 5295（DATA_CONTRACT §6・MapLibre 版）（strictPort で衝突時は失敗させる）
 */
export default defineConfig({
  base: './',
  server: { host: true, port: 5291, strictPort: true },
  preview: { host: true, port: 5295, strictPort: true },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 1000, // maplibre-gl 本体は ~950 kB（警告抑止）
    assetsInlineLimit: 0, // worker / アイコンを data: URL に埋め込まない（Worker は同一オリジン URL が必要）
    rollupOptions: {
      output: {
        manualChunks: {
          maplibre: ['maplibre-gl'],
          pmtiles: ['pmtiles'],
        },
      },
    },
  },
});
