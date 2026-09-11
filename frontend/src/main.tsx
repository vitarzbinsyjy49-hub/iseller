import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { queryClient } from "./lib/apiCache";
import "./index.css";

/* Сам клиент живёт в lib/apiCache вместе с правилами кэширования: им
   пользуются не только компоненты через провайдер, но и `cachedApi` из
   обычного кода загрузки экранов. Держать его здесь значило бы, что половина
   приложения берёт кэш из React-контекста, а половина — из импорта, и это два
   разных кэша. */
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
