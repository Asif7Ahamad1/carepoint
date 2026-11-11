import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: process.env.GITHUB_PAGES === "true" ? "/carepoint/" : "/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
});
