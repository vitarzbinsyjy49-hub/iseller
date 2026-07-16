import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const ALLOWED_HOSTS = [
  "localhost",
  "127.0.0.1",
  ".trycloudflare.com",
  ".ngrok-free.app",
];

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5174,
    allowedHosts: ALLOWED_HOSTS,
    proxy: { "/api": { target: "http://backend:8000", changeOrigin: true } },
  },
  preview: {
    host: true,
    port: 4174,
    allowedHosts: ALLOWED_HOSTS,
    proxy: { "/api": { target: "http://localhost:8000", changeOrigin: true } },
  },
});
