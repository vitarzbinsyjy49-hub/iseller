import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { useAuthStore } from "../store/auth";
import { ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import LeadForm from "../components/LeadForm";

type Category = { key: string; label: string; icon: string; count: number };
type Feed = { hot: TCard[]; available_today: TCard[]; recommended: TCard[] };

/** Управляемая главная (v4): баннеры и кнопки категорий приходят из /api/home. */
type HomeBanner = {
  id: number; title: string; subtitle?: string | null; emoji?: string | null;
  image_url?: string | null; background_gradient?: string | null;
  action_type: string; action_value?: string | null;
};
type HomeCat = {
  id: number; title: string; emoji?: string | null; icon_url?: string | null;
  background_gradient?: string | null; action_type: string; action_value?: string | null;
};
type HomeData = { banners: HomeBanner[]; categories: HomeCat[] };

/** Куда ведёт клик по баннеру/категории (общая маршрутизация action-ов). */
function actionRoute(type: string, value?: string | null): string {
  const v = (value ?? "").trim();
  switch (type) {
    case "category": return `/catalog?category=${encodeURIComponent(v)}`;
    case "search": return `/catalog?query=${encodeURIComponent(v)}`;
    case "product": return `/product/${v}`;
    case "collection": return `/catalog?collection=${encodeURIComponent(v)}`;
    case "ai": return v ? `/ai?q=${encodeURIComponent(v)}` : "/ai";
    default: return "/catalog";
  }
}

/** Запасные промо-блоки, если /api/home недоступен (backend старой версии). */
const FALLBACK_PROMOS: HomeBanner[] = [
  { id: -1, emoji: "🔥", title: "Горячие предложения", subtitle: "Лучшие цены этой недели", background_gradient: "linear-gradient(135deg,#f43f5e,#d97706)", action_type: "category", action_value: "__sale__" },
  { id: -2, emoji: "⚡", title: "Забрать сегодня", subtitle: "В наличии на Горбушке", background_gradient: "linear-gradient(135deg,#0e9f6e,#0694a2)", action_type: "collection", action_value: "today" },
  { id: -3, emoji: "🤖", title: "Подберём технику", subtitle: "Расскажите AI, что нужно", background_gradient: "linear-gradient(135deg,#1a7fd4,#6d5ae0)", action_type: "ai", action_value: "" },
];

export default function Home() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const [categories, setCategories] = useState<Category[]>([]);
  const [home, setHome] = useState<HomeData | null>(null);
  const [feed, setFeed] = useState<Feed | null>(null);
  const [lead, setLead] = useState<TCard | null>(null);
  const [search, setSearch] = useState("");
  // Live-поиск: null — панель скрыта, [] — «ничего не нашлось», иначе подсказки
  const [results, setResults] = useState<TCard[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    track("app_opened");
    api<HomeData>("/home")
      .then((d) => setHome(d))
      .catch(() => setHome({ banners: FALLBACK_PROMOS, categories: [] }));
    api<{ categories: Category[] }>("/catalog/categories").then((d) => setCategories(d.categories)).catch(() => {});
    api<Feed>("/catalog/feed").then(setFeed).catch(() => {});
  }, []);

  // Debounce 250ms: ищем по мере ввода, без Enter
  useEffect(() => {
    const q = search.trim();
    if (q.length < 2) { setResults(null); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(() => {
      api<{ cards?: TCard[] }>(`/catalog/search?query=${encodeURIComponent(q)}&limit=5`)
        .then((d) => setResults(Array.isArray(d.cards) ? d.cards : []))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  function goSearch() {
    const q = search.trim();
    navigate(q ? `/catalog?query=${encodeURIComponent(q)}` : "/catalog");
  }

  return (
    <div className="mx-auto max-w-md">
      {/* ===== Градиентный header: бренд + точка выдачи + поиск (marketplace-style) ===== */}
      <div className="-mx-4 -mt-3 rounded-b-3xl bg-gradient-to-br from-[#1a7fd4] via-[#2aabee] to-[#6d5ae0] px-4 pb-5 pt-4 text-white">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl2 bg-white/15 text-sm font-extrabold tracking-tight backdrop-blur">AI</div>
            <div>
              <p className="text-[15px] font-bold leading-4">AI Seller</p>
              <p className="mt-0.5 flex items-center gap-1 text-xs text-white/80">
                📍 Горбушка · Москва
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => navigate("/ai")}
              className="tap rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold backdrop-blur"
            >
              ✨ AI-подбор
            </button>
            <button
              onClick={() => navigate("/profile")}
              className="tap flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-base backdrop-blur"
              aria-label="Профиль"
            >
              {user?.first_name?.[0]?.toUpperCase() ?? "👤"}
            </button>
          </div>
        </div>

        {/* Крупный белый поиск + AI (relative — под ним панель live-подсказок) */}
        <div className="relative mt-4 flex gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl2 bg-white px-4 text-text shadow-soft">
            <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && goSearch()}
              placeholder="Найти iPhone, MacBook, PlayStation..."
              className="min-w-0 flex-1 bg-transparent py-3.5 text-sm outline-none placeholder:text-muted"
            />
            {/* Декоративная иконка сканера (как в marketplace-приложениях) */}
            <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
              <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M7 12h10" />
            </svg>
          </div>
          <button
            onClick={() => navigate("/ai")}
            className="tap shrink-0 rounded-xl2 bg-white px-4 text-sm font-bold text-accent shadow-soft"
          >
            AI
          </button>

          {/* Панель live-подсказок */}
          {(results !== null || searching) && (
            <div className="fade-in absolute inset-x-0 top-full z-40 mt-2 overflow-hidden rounded-xl2 bg-white text-text shadow-sheet">
              {searching && results === null ? (
                <p className="px-4 py-3.5 text-sm text-muted">Ищем…</p>
              ) : results && results.length > 0 ? (
                <>
                  {results.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => { setSearch(""); setResults(null); navigate(`/product/${c.id}`); }}
                      className="tap flex w-full items-center justify-between gap-3 border-b border-border px-4 py-3 text-left last:border-0"
                    >
                      <span className="min-w-0">
                        <span className="line-clamp-1 block text-sm font-medium">{c.title}</span>
                        <span className={`text-[11px] font-medium ${c.in_stock ? "text-green" : "text-muted"}`}>
                          {c.in_stock ? "В наличии" : "Под заказ"}
                        </span>
                      </span>
                      <span className="shrink-0 text-sm font-bold">
                        {new Intl.NumberFormat("ru-RU").format(Math.round(c.price))} ₽
                      </span>
                    </button>
                  ))}
                  <button
                    onClick={goSearch}
                    className="tap w-full bg-mutedbg px-4 py-3 text-center text-xs font-semibold text-accent"
                  >
                    Все результаты в каталоге →
                  </button>
                </>
              ) : (
                <div className="px-4 py-5 text-center">
                  <span className="text-2xl">🔍</span>
                  <p className="mt-1.5 text-sm text-muted">
                    По запросу «{search.trim()}» ничего не нашлось.
                    Попробуйте иначе — например, «iPhone» или «MacBook».
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ===== Hero-баннеры (управляются из админки) ===== */}
      <div className="no-scrollbar -mx-4 mt-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-1">
        {(home ? home.banners : Array.from({ length: 2 }, () => null)).map((b, i) =>
          b ? (
            <button
              key={b.id}
              onClick={() => {
                if (b.action_type === "external" && b.action_value) { window.open(b.action_value, "_blank"); return; }
                navigate(actionRoute(b.action_type, b.action_value));
              }}
              className="tap relative h-[120px] w-[280px] shrink-0 snap-start overflow-hidden rounded-xl2 p-4 text-left text-white shadow-soft"
              style={{ background: b.background_gradient || "linear-gradient(135deg,#1a7fd4,#6d5ae0)" }}
            >
              {b.image_url && (
                <img src={b.image_url} alt="" loading="lazy"
                  className="absolute inset-0 h-full w-full object-cover" />
              )}
              <div className="relative z-10 flex h-full flex-col justify-between">
                <span className="text-2xl drop-shadow">{b.emoji}</span>
                <div>
                  <p className="text-[15px] font-bold leading-5 drop-shadow">{b.title}</p>
                  {b.subtitle && <p className="mt-0.5 text-xs text-white/85 drop-shadow">{b.subtitle}</p>}
                </div>
              </div>
              {b.image_url && <div className="absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-transparent" />}
            </button>
          ) : (
            <div key={i} className="skeleton h-[120px] w-[280px] shrink-0 rounded-xl2" />
          ),
        )}
      </div>

      {/* ===== Кнопки категорий (управляются из админки; fallback на /catalog/categories) ===== */}
      <div className="stagger mt-5 grid grid-cols-4 gap-2">
        {home && home.categories.length > 0
          ? home.categories.map((c) => (
              <button
                key={c.id}
                onClick={() => navigate(actionRoute(c.action_type, c.action_value))}
                className="card-appear tap flex flex-col items-center gap-1.5 rounded-xl2 py-3 shadow-soft"
                style={{ background: c.background_gradient || "#fff" }}
              >
                {c.icon_url
                  ? <img src={c.icon_url} alt="" className="h-8 w-8 rounded-lg object-cover" loading="lazy" />
                  : <span className="text-2xl">{c.emoji || "🛍️"}</span>}
                <span className="text-[11px] font-medium leading-3">{c.title}</span>
              </button>
            ))
          : (categories.length ? categories : Array.from({ length: 8 }, () => null)).map((c, i) =>
              c ? (
                <button
                  key={c.key}
                  onClick={() => navigate(`/catalog?category=${encodeURIComponent(c.key)}`)}
                  className="card-appear tap flex flex-col items-center gap-1.5 rounded-xl2 bg-surface py-3 shadow-soft"
                >
                  <span className="text-2xl">{c.icon}</span>
                  <span className="text-[11px] font-medium leading-3">{c.label}</span>
                </button>
              ) : (
                <div key={i} className="skeleton h-[74px] rounded-xl2" />
              ),
            )}
      </div>

      {/* ===== Секции товаров: ленты + сетка 2 колонки ===== */}
      <Section title="Хиты продаж" cards={feed?.hot} onLead={setLead}
        onAll={() => navigate("/catalog")} />
      <Section title="Забрать сегодня" cards={feed?.available_today} onLead={setLead}
        onAll={() => navigate("/catalog?today=1")} />
      <Section title="Рекомендуем" cards={feed?.recommended} onLead={setLead}
        onAll={() => navigate("/catalog")} grid />

      {lead && (
        <LeadForm
          productId={lead.id} productTitle={lead.title} productPrice={lead.price}
          source="home" onClose={() => setLead(null)}
        />
      )}
    </div>
  );
}

function Section({
  title, cards, onLead, onAll, grid,
}: { title: string; cards?: TCard[]; onLead: (c: TCard) => void; onAll: () => void; grid?: boolean }) {
  if (!cards) return <SectionSkeleton title={title} />;
  if (cards.length === 0) return null;
  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[17px] font-bold">{title}</h2>
        <button onClick={onAll} className="text-xs font-medium text-accent">Смотреть все</button>
      </div>
      {grid ? (
        <div className="stagger mt-3 grid grid-cols-2 gap-3">
          {cards.map((c) => <ProductCard key={c.id} card={c} onLead={onLead} />)}
        </div>
      ) : (
        <div className="no-scrollbar stagger -mx-4 mt-3 flex gap-3 overflow-x-auto px-4 pb-2">
          {cards.map((c) => <ProductCard key={c.id} card={c} onLead={onLead} compact />)}
        </div>
      )}
    </div>
  );
}

function SectionSkeleton({ title }: { title: string }) {
  return (
    <div className="mt-6">
      <h2 className="text-[17px] font-bold">{title}</h2>
      <div className="no-scrollbar -mx-4 mt-3 flex gap-3 overflow-x-auto px-4 pb-2">
        {[0, 1, 2].map((i) => <div key={i} className="skeleton h-64 w-40 shrink-0 rounded-xl2" />)}
      </div>
    </div>
  );
}
