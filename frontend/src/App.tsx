import { lazy, Suspense, type ReactNode, useEffect, useState } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { api } from "./lib/api";
import { getStartParam, getTelegram, isInsideTelegram, initTelegramUi } from "./lib/telegram";
import { hydrateFavorites } from "./lib/favorites";
import { hydrateCart } from "./lib/cart";
import { shouldShowOnboarding } from "./lib/onboarding";
import { useOnboardingReplayStore } from "./store/onboardingReplay";
import { useAuthStore, User } from "./store/auth";
import ErrorBoundary from "./components/ErrorBoundary";
import Toaster from "./components/Toaster";
import Layout from "./components/Layout";
import { OnboardingStories } from "./components/onboarding/OnboardingStories";
import Home from "./pages/Home";
import { routeLoaders } from "./lib/routePreload";

// Главная остаётся в стартовом chunk: это первый экран почти каждого запуска.
// Остальные страницы загружаются по намерению пользователя/при навигации.
const Catalog = lazy(routeLoaders.catalog);
const ProductDetails = lazy(routeLoaders.product);
const AiSearch = lazy(routeLoaders.ai);
const ScenarioChat = lazy(routeLoaders.scenarioChat);
const SellItem = lazy(routeLoaders.sellItem);
const Marketplace = lazy(routeLoaders.marketplace);
const Requests = lazy(routeLoaders.requests);
const Profile = lazy(routeLoaders.profile);
const Favorites = lazy(routeLoaders.favorites);
const History = lazy(routeLoaders.history);
const Cart = lazy(routeLoaders.cart);
const Loyalty = lazy(routeLoaders.loyalty);
const Info = lazy(routeLoaders.info);

export default function App() {
  const { setTokens, setUser, user } = useAuthStore();
  const replayOnboarding = useOnboardingReplayStore((s) => s.active);
  const stopOnboardingReplay = useOnboardingReplayStore((s) => s.stop);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const navigate = useNavigate();

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
        // Корзина: локальный кэш уже отрисован, здесь берём серверное состояние
        // как истину — цены и наличие могли измениться между визитами.
        void hydrateCart();
        // Патч 2.0: запуск по t.me/<bot>/<app>?startapp=<payload> — кнопка
        // канала ведёт сразу в Mini App, минуя чат с ботом. Тот же payload,
        // что раньше нёс /start в бота, здесь приходит в start_param;
        // резолвит его тот же источник правды, что и сам бот для web_app-кнопок
        // (backend: resolve_payload_path). Неизвестный/устаревший payload —
        // остаёмся на главной, тихо, как и бот в этом случае падает в меню.
        const payload = getStartParam();
        if (payload) {
          try {
            const { route } = await api<{ route: string }>(`/deeplink/${encodeURIComponent(payload)}`);
            navigate(route, { replace: true });
          } catch {
            /* неизвестный payload — тихо остаёмся на главной */
          }
        }
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
          <Route path="/catalog" element={<DeferredPage><Catalog /></DeferredPage>} />
          <Route path="/product/:id" element={<DeferredPage><ProductDetails /></DeferredPage>} />
          <Route path="/ai" element={<DeferredPage><AiSearch /></DeferredPage>} />
          <Route path="/apply/:scenario" element={<DeferredPage><ScenarioChat /></DeferredPage>} />
          <Route path="/sell" element={<DeferredPage><SellItem /></DeferredPage>} />
          <Route path="/marketplace" element={<DeferredPage><Marketplace /></DeferredPage>} />
          <Route path="/requests" element={<DeferredPage><Requests /></DeferredPage>} />
          <Route path="/cart" element={<DeferredPage><Cart /></DeferredPage>} />
          <Route path="/favorites" element={<DeferredPage><Favorites /></DeferredPage>} />
          <Route path="/history" element={<DeferredPage><History /></DeferredPage>} />
          <Route path="/profile" element={<DeferredPage><Profile /></DeferredPage>} />
          <Route path="/loyalty" element={<DeferredPage><Loyalty /></DeferredPage>} />
          <Route path="/info" element={<DeferredPage><Info /></DeferredPage>} />
          <Route path="*" element={<Home />} />
        </Route>
      </Routes>
      <Toaster />
      {(shouldShowOnboarding(user) || replayOnboarding) && (
        <OnboardingStories onFinished={replayOnboarding ? stopOnboardingReplay : undefined} />
      )}
    </ErrorBoundary>
  );
}

function DeferredPage({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<RouteFallback />}>
      {children}
    </Suspense>
  );
}

/** Стабильная геометрия вместо полноэкранного спиннера: навигация остаётся на месте. */
function RouteFallback() {
  return (
    <div className="fade-in mx-auto max-w-md lg:max-w-none" aria-label="Загрузка страницы" aria-busy="true">
      <div className="skeleton h-7 w-36 rounded-lg" />
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-64 rounded-xl2" />)}
      </div>
    </div>
  );
}

function CenterScreen({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center px-6 text-center">{children}</div>;
}
