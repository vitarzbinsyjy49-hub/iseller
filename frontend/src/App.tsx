import { lazy, Suspense, type ReactNode, useEffect, useState } from "react";
import { enterRefCallback } from "./lib/useEnter";
import { Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api } from "./lib/api";
import { getStartParam, getTelegram, isInsideTelegram, initTelegramUi } from "./lib/telegram";
import { hydrateFavorites } from "./lib/favorites";
import { hydrateCart } from "./lib/cart";
import { shouldShowOnboarding } from "./lib/onboarding";
import { useOnboardingReplayStore } from "./store/onboardingReplay";
import { useAuthStore, User } from "./store/auth";
import ErrorBoundary from "./components/ErrorBoundary";
import Toaster from "./components/Toaster";
import { ProductSkeleton } from "./components/StateViews";
import Layout from "./components/Layout";
import { OnboardingStories } from "./components/onboarding/OnboardingStories";
import Home from "./pages/Home";
import { routeLoaders, warmRouteData } from "./lib/routePreload";
import { useRouteTransition } from "./lib/useRouteTransition";
import { hideSplash, shouldHideSplash } from "./lib/splash";

// Главная остаётся в стартовом chunk: это первый экран почти каждого запуска.
// Остальные страницы загружаются по намерению пользователя/при навигации.
const Catalog = lazy(routeLoaders.catalog);
const ProductDetails = lazy(routeLoaders.product);
const AiSearch = lazy(routeLoaders.ai);
const ScenarioChat = lazy(routeLoaders.scenarioChat);
const SellItem = lazy(routeLoaders.sellItem);
const Marketplace = lazy(routeLoaders.marketplace);
const Preorder = lazy(routeLoaders.preorder);
const Requests = lazy(routeLoaders.requests);
const Profile = lazy(routeLoaders.profile);
const Favorites = lazy(routeLoaders.favorites);
const History = lazy(routeLoaders.history);
const Cart = lazy(routeLoaders.cart);
const Loyalty = lazy(routeLoaders.loyalty);
const Info = lazy(routeLoaders.info);
// Форма отзыва: открывается из бота по кнопке «Оценить заказ», в обычной
// навигации её нет — поэтому чанк отдельный и грузится только по этому пути.
const ReviewForm = lazy(routeLoaders.reviewForm);

export default function App() {
  const { setTokens, setUser, user } = useAuthStore();
  const replayOnboarding = useOnboardingReplayStore((s) => s.active);
  const stopOnboardingReplay = useOnboardingReplayStore((s) => s.stop);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [errorText, setErrorText] = useState("");
  const navigate = useNavigate();
  // Показываем не сам адрес, а «уже показанный» маршрут: он отстаёт от роутера
  // ровно на один рендер, и в этот зазор снимается кадр уходящего экрана.
  // Без такой задержки старого DOM к моменту эффекта уже нет, и переход
  // остаётся тем самым щелчком (lib/useRouteTransition).
  const displayedLocation = useRouteTransition(useLocation());

  // Вся инициализация Telegram UI (ready/expand/fullscreen/цвета/viewport
  // listeners) — в одном месте, с корректным снятием подписок.
  useEffect(() => initTelegramUi(), []);

  useEffect(() => {
    async function login() {
      try {
        const endpoint = isInsideTelegram() ? "/auth/telegram" : "/auth/dev";
        // start_param читаем здесь же, ДО запроса: это тот самый ad_<канал> из
        // t.me/<bot>/<app>?startapp=..., и бэкенду он нужен один раз — при
        // создании пользователя, — чтобы записать источник первого прихода
        // (см. app/api/auth.py). Дальше он же используется ниже для навигации.
        const startParam = getStartParam();
        const body = isInsideTelegram()
          ? { init_data: getTelegram()!.initData, start_param: startParam ?? undefined }
          : {};
        const tokens = await api<{ access_token: string; refresh_token: string }>(endpoint, {
          method: "POST",
          body: JSON.stringify(body),
        });
        setTokens(tokens.access_token, tokens.refresh_token);

        // Данные пользователя, избранное и корзина — ФОНОМ, показ их не ждёт.
        //
        // Раньше готовность упиралась в ответ /users/me, то есть каркас не
        // рисовался, пока не съездит ещё один круг по сети. А нужен этот ответ
        // ровно двум местам: чипу профиля (он и с null рисуется — инициалы
        // вместо имени, размер тот же, без скачка раскладки) и решению про
        // онбординг. Ни то, ни другое не стоит лишней секунды белого экрана на
        // мобильной сети.
        void api<User>("/users/me").then(setUser).catch(() => {
          /* профиль подгрузится при следующем запросе; экран уже работает */
        });
        // Избранное: сливаем локальное (гость/до входа) с серверным и берём
        // серверный список.
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
        //
        // Это ЕДИНСТВЕННЫЙ случай, когда показ ждёт ещё один запрос, и ждёт
        // осознанно: пункт назначения ещё неизвестен. Показать главную и через
        // мгновение подменить её нужным экраном — это видимый рывок на ровном
        // месте, и вдобавок прогрев ушёл бы не туда. Заставка для того и
        // нужна: пауза под ней читается как запуск, а не как сбой.
        const payload = startParam;
        if (payload) {
          let target: string | null = null;
          try {
            ({ route: target } = await api<{ route: string }>(`/deeplink/${encodeURIComponent(payload)}`));
          } catch {
            /* неизвестный payload — тихо остаёмся на главной */
          }
          // Прогрев по фактическому адресу: ответ ляжет в тот же кэш, из
          // которого его возьмёт экран (lib/apiCache).
          warmRouteData(target ?? window.location.pathname);
          if (target) navigate(target, { replace: true });
        } else {
          // Запросы витрины уходят ЗДЕСЬ, а не на экране: пока идёт вход, ни
          // одна страница не смонтирована, значит, данных никто не просит.
          // Токен получен строкой выше — больше витрине ничего не нужно.
          warmRouteData(window.location.pathname);
        }
        setStatus("ready");
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : "Неизвестная ошибка");
        setStatus("error");
      }
    }
    login();
  }, []);

  // Заставка снимается ПОСЛЕ того, как React отрисовал экран: класс вешается в
  // эффекте, то есть в том же кадре, где закоммичен новый DOM. Получается
  // перекрёстное затухание — заставка тает, под ней уже готовый экран, — а не
  // подмена одного другим встык.
  //
  // «Ошибка» здесь так же обязательна, как «готово»: без неё сообщение о
  // неудачном входе осталось бы под вечно бегающей полосой (lib/splash.ts).
  useEffect(() => {
    if (shouldHideSplash(status)) hideSplash();
  }, [status]);

  // Экрана загрузки в React больше нет: пока идёт вход, на экране заставка из
  // index.html — она появилась с первым байтом документа, задолго до того, как
  // этот компонент вообще смог бы что-то нарисовать. Отрисовать здесь «ещё
  // одну» загрузку значило бы положить её ПОД заставку, где её никто не увидит.
  if (status === "loading") return null;
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
      <Routes location={displayedLocation}>
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/catalog" element={<DeferredPage><Catalog /></DeferredPage>} />
          <Route path="/product/:id" element={<DeferredPage fallback={<ProductSkeleton />}><ProductDetails /></DeferredPage>} />
          <Route path="/ai" element={<DeferredPage><AiSearch /></DeferredPage>} />
          <Route path="/apply/:scenario" element={<DeferredPage><ScenarioChat /></DeferredPage>} />
          <Route path="/sell" element={<DeferredPage><SellItem /></DeferredPage>} />
          <Route path="/marketplace" element={<DeferredPage><Marketplace /></DeferredPage>} />
          <Route path="/preorder/:group" element={<DeferredPage><Preorder /></DeferredPage>} />
          <Route path="/requests" element={<DeferredPage><Requests /></DeferredPage>} />
          <Route path="/cart" element={<DeferredPage><Cart /></DeferredPage>} />
          <Route path="/favorites" element={<DeferredPage><Favorites /></DeferredPage>} />
          <Route path="/history" element={<DeferredPage><History /></DeferredPage>} />
          <Route path="/profile" element={<DeferredPage><Profile /></DeferredPage>} />
          <Route path="/loyalty" element={<DeferredPage><Loyalty /></DeferredPage>} />
          <Route path="/info" element={<DeferredPage><Info /></DeferredPage>} />
          <Route path="/review/:leadId" element={<DeferredPage><ReviewForm /></DeferredPage>} />
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

/** `fallback` — запасной экран на время загрузки чанка.
 *
 *  По умолчанию нейтральная сетка: она годится списочным экранам, которых
 *  большинство. Но карточке товара она НЕ годится — там своя раскладка, и
 *  показать сетку каталога значит показать форму, которая через мгновение
 *  сменится другой. Прыжок раскладки читается как рывок анимации, хотя
 *  анимация ни при чём. */
function DeferredPage({ children, fallback }: { children: ReactNode; fallback?: ReactNode }) {
  return (
    <Suspense fallback={fallback ?? <RouteFallback />}>
      {children}
    </Suspense>
  );
}

/** Стабильная геометрия вместо полноэкранного спиннера: навигация остаётся на месте. */
function RouteFallback() {
  return (
    <div ref={enterRefCallback("fade")} className="mx-auto max-w-md lg:max-w-none" aria-label="Загрузка страницы" aria-busy="true">
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
