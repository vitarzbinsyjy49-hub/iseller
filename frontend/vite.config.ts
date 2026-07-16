import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  server: {
    host: true,
    port: 5173,
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      ".trycloudflare.com",
      ".ngrok-free.app",
    ],
    proxy: {
      "/api": { target: "http://backend:8000", changeOrigin: true },
    },
  },

  // Проверка production-сборки: vite preview --port 4173 (бэкенд на localhost:8000)
  preview: {
    host: true,
    port: 4173,
    allowedHosts: [
      "localhost",
      "127.0.0.1",
      ".trycloudflare.com",
      ".ngrok-free.app",
    ],
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true },
    },
  },
});
