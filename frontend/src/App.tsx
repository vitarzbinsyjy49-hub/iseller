import { type ReactNode, useEffect, useState } from "react";
import { Route, Routes } from "react-router-dom";
import { api } from "./lib/api";
import { getTelegram, isInsideTelegram, initTelegramUi } from "./lib/telegram";
import { hydrateFavorites } from "./lib/favorites";
import { useAuthStore, User } from "./store/auth";
import ErrorBoundary from "./components/ErrorBoundary";
import Toaster from "./components/Toaster";
import Layout from "./components/Layout";
import Home from "./pages/Home";
import Catalog from "./pages/Catalog";
import ProductDetails from "./pages/ProductDetails";
import AiSearch from "./pages/AiSearch";
import Requests from "./pages/Requests";
import Profile from "./pages/Profile";
import Favorites from "./pages/Favorites";

export default function App() {
  const { setTokens, setUser } = useAuthStore();
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");

  // Вся инициализация Telegram UI (ready/expand/fullscreen/цвета/viewport
  // listeners) — в одном месте, с корректным снятием подписок.
  useEffect(() => initTelegramUi(), []);

  useEffect(() => {
    async function login() {
      try {
        const endpoint = isInsideTelegram() ? "/auth/telegram" : "/auth/dev";
        const body = isInsideTelegram() ? { init_data: getTelegram()!.initData } : {};
        const tokens = await api<{ access_token: string; refresh_token: string }>(endpoint, {
          method: "POST",
          body: JSON.stringify(body),
        });
        setTokens(tokens.access_token, tokens.refresh_token);
        const me = await api<User>("/users/me");
        setUser(me);
        // Избранное: сливаем локальное (гость/до входа) с серверным и берём
        // серверный список. Не блокируем готовность экрана — фоном.
        void hydrateFavorites();
        setStatus("ready");
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : "Неизвестная ошибка");
        setStatus("error");
      }
    }
    login();
  }, []);

  if (status === "loading") return <CenterScreen>Загрузка…</CenterScreen>;
  if (status === "error") {
    return (
      <CenterScreen>
        <p className="mb-2 font-medium">Не удалось войти</p>
        <p className="text-sm text-muted">{errorText}</p>
      </CenterScreen>
    );
  }

  return (
    <ErrorBoundary>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/catalog" element={<Catalog />} />
          <Route path="/product/:id" element={<ProductDetails />} />
          <Route path="/ai" element={<AiSearch />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/favorites" element={<Favorites />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
      <Toaster />
    </ErrorBoundary>
  );
}

function CenterScreen({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center px-6 text-center">{children}</div>;
}
