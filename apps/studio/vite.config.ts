import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Vite requires a default export for its config file (the repo's named-exports rule does not apply here).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The studio talks to `/api/v1` (VITE_BRIAR_API overrides); in dev, forward it to a local server.
    proxy: { "/api": { target: process.env.BRIAR_SERVER ?? "http://localhost:3000", changeOrigin: true } },
  },
  preview: {
    proxy: { "/api": { target: process.env.BRIAR_SERVER ?? "http://localhost:3000", changeOrigin: true } },
  },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 1500 },
});
