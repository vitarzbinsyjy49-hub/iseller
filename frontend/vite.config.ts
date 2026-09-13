import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],

  build: {
    rollupOptions: {
      output: {
        /** Библиотеки — отдельным чанком от кода приложения.
         *
         *  До этого React, роутер, react-query и zustand лежали в одном файле
         *  с каркасом и главной: 358 КБ, и ЛЮБОЙ релиз менял его хэш целиком.
         *  То есть каждый деплой заставлял всех скачивать заново и библиотеки,
         *  которые не менялись месяцами — а деплоим мы часто, и Mini App
         *  открывают по многу раз в неделю.
         *
         *  Разрезано по границе node_modules, без дробления на react/router/
         *  прочее: всё это нужно первому же кадру, и три запроса вместо одного
         *  здесь только добавили бы задержек. Смысл не в том, чтобы грузить
         *  меньше в первый раз, а в том, чтобы во второй не грузить вовсе.
         */
        manualChunks(id) {
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },

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
