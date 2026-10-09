import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // 强制 IPv4：默认 localhost 可能只绑 [::1]（仅 IPv6），
    // WebView2 请求 localhost:1420 落在 127.0.0.1 上无监听 → 窗口黑屏
    host: "127.0.0.1",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    emptyOutDir: false,
    // 桌面端打成单包，减少启动时多次请求 chunk
    cssCodeSplit: false,
    target: "chrome105",
    minify: "esbuild",
    modulePreload: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
  },
});
