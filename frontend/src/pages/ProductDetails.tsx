import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { track, trackProduct } from "../lib/analytics";
import { ProductDetail } from "../components/ai/types";
import { formatPrice, discountPct } from "../lib/format";
import { ProductImage, Badge, FavButton } from "../components/ProductCard";
import { ErrorState } from "../components/StateViews";
import LeadForm from "../components/LeadForm";
import { openExternalLink } from "../lib/telegram";
import { usePublicConfig } from "../lib/appConfig";

type Tab = "desc" | "specs" | "delivery";
type LoadState = "loading" | "ready" | "not_found" | "error";

export default function ProductDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const config = usePublicConfig();
  const [p, setP] = useState<ProductDetail | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [tab, setTab] = useState<Tab>("desc");
  const [shared, setShared] = useState(false);
  const [lead, setLead] = useState<{ source: string; preset?: string } | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    setState("loading");
    api<ProductDetail>(`/catalog/product/${id}`)
      .then((d) => {
        setP(d); setState("ready");
        track("product_viewed", { product_id: d.id });
        trackProduct("product_view", { product_id: d.id, category: d.category ?? undefined });
      })
      .catch((e) => {
        // 404 от API — «не найден»; сеть/5xx — временная ошибка с повтором
        setState(e instanceof ApiError && e.status === 404 ? "not_found" : "error");
      });
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function share() {
    if (!p) return;
    const url = window.location.href;
    try {
      if (navigator.share) {
        await navigator.share({ title: p.title, url });
        return;
      }
      await navigator.clipboard.writeText(url);
      setShared(true);
      setTimeout(() => setShared(false), 1500);
    } catch {
      /* пользователь отменил share — это не ошибка */
    }
  }

  if (state === "not_found") {
    return <div className="mx-auto max-w-md py-20 text-center text-muted">Товар не найден</div>;
  }
  if (state === "error") {
    return (
      <div className="mx-auto max-w-md py-10">
        <ErrorState message="Не удалось загрузить товар" onRetry={load} />
      </div>
    );
  }
  if (!p) return (
    <div className="mx-auto max-w-md">
      <div className="skeleton aspect-square rounded-xl2" />
      <div className="skeleton mt-4 h-6 w-2/3 rounded-lg" />
      <div className="skeleton mt-2 h-8 w-1/3 rounded-lg" />
    </div>
  );

  const disc = discountPct(p.price, p.old_price);
  const saving = p.old_price ? p.old_price - p.price : 0;
  // Характеристики: нормализованный список из backend (specs + структурные
  // колонки, человекочитаемые подписи); fallback на сырой specs для старого API.
  const specRows =
    p.specifications && p.specifications.length
      ? p.specifications
      : Object.entries(p.specs || {}).map(([label, value]) => ({ label, value: String(value) }));

  // Активная вкладка — белая поверхность с тонкой границей. Рамка есть у обеих
  // (у неактивной прозрачная), поэтому размеры одинаковые и ничего не «прыгает».
  // focus-visible задан явно: без него UA рисовал толстый тёмный outline,
  // который читался как чёрная рамка вокруг вкладки.
  const tabCls = (active: boolean) =>
    `tap flex-1 rounded-xl border py-2 text-[13px] font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
      active
        ? "border-border bg-surface text-text"
        : "border-transparent text-muted hover:text-text"
    }`;

  return (
    // pb-cta (mobile) — вычисляемый отступ под фиксированной CTA: позиция CTA над
    // навбаром (safe-area + зазор) + высота кнопки, см. index.css. Прежний хардкод
    // pb-40 (160px) не учитывал safe-area и на iPhone прятал низ контента под CTA.
    // На desktop CTA в правой колонке, поэтому lg:pb-12.
    <div className="mx-auto max-w-md pb-cta lg:max-w-[1440px] lg:pb-12">
      {/* ===== Mobile/tablet: компактный sticky-оверлей (поведение v5.2.3) =====
          На desktop он скрыт: один общий sticky-бар с z-30 обслуживал оба
          брейкпоинта и при скролле наезжал на галерею (замер: 52px), а кнопки
          не имели зарезервированного места в сетке. */}
      {/* Фон СОЛИДНЫЙ (bg-bg, без /90 и backdrop-blur): при скролле галерея уходит
          строго ПОД непрозрачную панель — фото не просвечивает сквозь неё.
          Примечание: bg-bg/90 у нас давал rgb(var(--app-bg)/.9) = невалидный цвет
          → фон становился ПОЛНОСТЬЮ прозрачным, и сквозь blur просвечивало фото. */}
      <div className="sticky top-0 z-30 -mx-4 -mt-3 mb-3 flex items-center gap-2 bg-bg px-4 py-2 lg:hidden">
        <TopBtn onClick={() => navigate(-1)} label="Назад">
          <path d="M15 18l-6-6 6-6" />
        </TopBtn>
        <div className="flex-1" />
        <TopBtn onClick={() => navigate("/catalog")} label="Поиск">
          <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>
        </TopBtn>
        <TopBtn onClick={share} label="Поделиться">
          <path d="M12 3v12M12 3 8 7M12 3l4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
        </TopBtn>
        <FavButton id={p.id} />
        {shared && (
          <span className="pop-in absolute right-4 top-12 rounded-full bg-text px-3 py-1.5 text-[11px] font-medium text-white">
            Ссылка скопирована
          </span>
        )}
      </div>

      {/* ===== Desktop: «Назад» — отдельная строка НАД карточкой, в потоке ===== */}
      <div className="hidden lg:mb-4 lg:block">
        <BackBtn onClick={() => navigate(-1)} />
      </div>

      {/* ===== Desktop: 2 колонки — media ~48% / контент ~52%, выравнивание сверху ===== */}
      <div className="lg:grid lg:grid-cols-[48fr_52fr] lg:items-start lg:gap-8 xl:gap-12">
      {/* Крупное изображение: карусель фото со свайпом + бейджи */}
      <Gallery
        images={p.images && p.images.length ? p.images : p.image ? [p.image] : []}
        title={p.title}
        category={p.category}
        badges={
          <>
            {p.is_hot && <Badge color="orange">🔥 Хит</Badge>}
            {p.in_stock && <Badge color="green">В наличии</Badge>}
            {disc && <Badge color="red">−{disc}%</Badge>}
          </>
        }
      />

      {/* Правая колонка (desktop) / продолжение потока (mobile) */}
      <div>
      {/* Desktop, первая строка: подпись категории слева, действия справа —
          обе в обычном потоке, поэтому заголовок ниже получает всю ширину.
          flex-wrap: на 1024–1199px группа действий переносится отдельной
          строкой над заголовком, а не сжимает его. */}
      <div className="relative hidden lg:mb-3 lg:flex lg:flex-wrap lg:items-center lg:justify-between lg:gap-x-4 lg:gap-y-2">
        <p className="text-xs text-muted">{p.brand}{p.category ? ` · ${p.category}` : ""}</p>
        <div className="flex shrink-0 items-center gap-2">
          <ActionBtn onClick={() => navigate("/catalog")} label="Поиск">
            <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>
          </ActionBtn>
          <ActionBtn onClick={share} label="Поделиться">
            <path d="M12 3v12M12 3 8 7M12 3l4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
          </ActionBtn>
          <FavButton id={p.id} className="h-[42px] w-[42px] border border-border" />
        </div>
        {shared && (
          <span className="pop-in absolute right-0 top-[52px] z-10 rounded-full bg-text px-3 py-1.5 text-[11px] font-medium text-white">
            Ссылка скопирована
          </span>
        )}
      </div>

      <p className="mt-4 text-xs text-muted lg:hidden">{p.brand}{p.category ? ` · ${p.category}` : ""}</p>
      {/* Заголовок занимает всю ширину колонки и переносится полностью:
          ни truncate, ни line-clamp — действия больше не стоят поверх него. */}
      <h1 className="mt-1 text-xl font-bold leading-6 lg:mt-0 lg:text-[28px] lg:leading-9">{p.title}</h1>

      {/* Состояние + ключевые характеристики одной строкой */}
      {(p.condition === "used" || p.condition === "refurbished" || p.color || p.memory || p.storage) && (
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {p.condition === "used" && (
            <span className="rounded-full bg-[#fff3d6] px-2 py-0.5 text-[11px] font-semibold text-[#a16207]">Б/у</span>
          )}
          {p.condition === "refurbished" && (
            <span className="rounded-full bg-[#e0f4f3] px-2 py-0.5 text-[11px] font-semibold text-[#0f766e]">Восстановленный</span>
          )}
          {[p.color, p.memory, p.storage].filter(Boolean).map((v) => (
            <span key={v as string} className="rounded-full bg-mutedbg px-2 py-0.5 text-[11px] font-medium text-muted">{v}</span>
          ))}
        </div>
      )}

      {/* Цена + выгода */}
      <div className="mt-2.5 flex items-center gap-2.5">
        <span className="text-[26px] font-bold leading-8">{formatPrice(p.price)}</span>
        {disc !== null && <span className="text-sm text-muted line-through">{formatPrice(p.old_price!)}</span>}
        {saving > 0 && (
          <span className="rounded-full bg-[#ffe9ec] px-2 py-1 text-xs font-semibold text-[#e0284f]">
            выгода {formatPrice(saving)}
          </span>
        )}
      </div>

      {/* Наличие: остаток на складе */}
      {p.in_stock && p.stock != null && p.stock > 0 && p.stock <= 5 && (
        <p className="mt-1.5 text-[13px] font-medium text-orange">Осталось {p.stock} шт — успейте забрать</p>
      )}

      {/* Быстрые действия — в потоке контента, ниже цены (не в fixed-зоне) */}
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => navigate(`/ai?q=${encodeURIComponent("Расскажи про " + p.title)}`)}
          className="tap flex-1 rounded-xl2 border border-border bg-surface py-2.5 text-xs font-medium text-muted"
        >
          ✨ Спросить AI
        </button>
        <button
          onClick={() => {
            // Прямой диалог с менеджером в Telegram; если ссылка не настроена
            // в .env backend'а — прежнее поведение (форма заявки source=manager)
            if (!openExternalLink(config.manager_retail_url)) {
              setLead({ source: "manager", preset: `Вопрос по товару: ${p.title}` });
            }
          }}
          className="tap flex-1 rounded-xl2 border border-border bg-surface py-2.5 text-xs font-medium text-muted"
        >
          💬 Написать менеджеру
        </button>
      </div>

      {/* Условия: наличие / гарантия / самовывоз / доставка */}
      <div className="stagger mt-4 grid grid-cols-2 gap-2">
        <InfoTile icon={p.in_stock ? "✅" : "🕐"} title={p.in_stock ? "В наличии" : "Под заказ"}
          subtitle={p.in_stock ? (p.is_available_today ? "Забрать сегодня" : "1–2 дня") : "Уточнит менеджер"} />
        <InfoTile icon="🛡️" title="Гарантия" subtitle={`${p.warranty_months} мес.`} />
        <InfoTile icon="🏬" title="Самовывоз" subtitle="Горбушка, Москва" />
        <InfoTile icon="🚚" title="Доставка" subtitle="По Москве" />
      </div>

      {/* Desktop CTA — обычный блок в правой колонке (sticky снизу не нужен: колонка компактная) */}
      <button
        onClick={() => setLead({ source: "product" })}
        className="mt-5 hidden w-full rounded-xl2 bg-accent py-3.5 text-white transition-colors hover:bg-accentdark lg:block"
      >
        <span className="block text-[15px] font-bold leading-5">Оставить заявку</span>
        <span className="block text-[11px] font-medium text-white/80">Менеджер свяжется сегодня</span>
      </button>

      </div>{/* /правая колонка */}
      </div>{/* /desktop 2 колонки */}

      {/* ===== Табы: Описание / Характеристики / Получение (на всю ширину) ===== */}
      <div className="mt-4 flex gap-1 rounded-xl2 bg-mutedbg p-1">
        <button onClick={() => setTab("desc")} className={tabCls(tab === "desc")}>Описание</button>
        <button onClick={() => setTab("specs")} className={tabCls(tab === "specs")}>Характеристики</button>
        <button onClick={() => setTab("delivery")} className={tabCls(tab === "delivery")}>Получение</button>
      </div>

      {tab === "desc" && (
        <div className="fade-in mt-3 rounded-xl2 bg-surface p-4 shadow-soft">
          <p className="text-sm leading-relaxed text-muted">
            {p.description || "Описание уточняется — задайте вопрос менеджеру, ответим быстро."}
          </p>
          {p.tags && p.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {p.tags.map((t) => (
                <span key={t} className="rounded-full bg-mutedbg px-2.5 py-1 text-[11px] font-medium text-muted">{t}</span>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "specs" && (
        <div className="fade-in mt-3 rounded-xl2 bg-surface p-4 shadow-soft">
          {specRows.length > 0 ? (
            <div className="divide-y divide-border">
              {specRows.map((s) => (
                <div key={s.label} className="flex justify-between gap-4 py-2 text-sm">
                  <span className="text-muted">{s.label}</span>
                  <span className="text-right font-medium">{s.value}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">Характеристики уточнит менеджер — задайте вопрос, ответим быстро.</p>
          )}
        </div>
      )}

      {tab === "delivery" && (
        <div className="fade-in mt-3 space-y-4">
          <section>
            <SubHead>Доставка и получение</SubHead>
            <div className="space-y-2">
              <DeliveryRow icon="🏬" title="Самовывоз — Горбушка, Москва"
                subtitle={p.in_stock && p.is_available_today ? "Можно забрать сегодня, 10:00–21:00" : "Обычно на следующий день, 10:00–21:00"} />
              <DeliveryRow icon="🚚" title="Доставка по Москве" subtitle="1–2 дня, сроки и стоимость уточнит менеджер" />
              <DeliveryRow icon="🌍" title="В другие города" subtitle="Отправка транспортной компанией — способ зависит от адреса" />
            </div>
          </section>
          <section>
            <SubHead>Гарантия</SubHead>
            <DeliveryRow icon="🛡️" title={`Гарантия ${p.warranty_months} мес.`}
              subtitle={p.condition === "used" ? "Проверка товара при получении" : "Проверка при вас, обмен по гарантии"} />
          </section>
          <section>
            <SubHead>Оплата</SubHead>
            <DeliveryRow icon="💳" title="Оплата при получении"
              subtitle="Наличными или переводом — удобный способ подскажет менеджер" />
          </section>
        </div>
      )}

      {/* ===== Фиксированная CTA — ТОЛЬКО mobile (на desktop CTA в правой колонке) =====
          above-bottom-nav (index.css): bottom = высота навбара + safe-area + 16px —
          кнопка всегда стоит на 16px выше навигации, без наезда. Фон солидный
          (bg-surface, без /95 и blur — прежний /95 давал прозрачный фон). */}
      <div className="fixed inset-x-0 above-bottom-nav z-30 border-t border-border bg-surface px-4 py-2.5 lg:hidden">
        <div className="mx-auto max-w-md">
          <button
            onClick={() => setLead({ source: "product" })}
            className="tap w-full rounded-xl2 bg-accent py-3 text-white"
          >
            <span className="block text-[15px] font-bold leading-5">Оставить заявку</span>
            <span className="block text-[11px] font-medium text-white/80">Менеджер свяжется сегодня</span>
          </button>
        </div>
      </div>

      {lead && (
        <LeadForm
          productId={p.id} productTitle={p.title} productPrice={p.price}
          source={lead.source} presetMessage={lead.preset}
          onClose={() => setLead(null)}
        />
      )}
    </div>
  );
}

/** Карусель фото товара: горизонтальный свайп (scroll-snap) + точки-индикаторы. */
function Gallery({
  images, title, category, badges,
}: { images: string[]; title: string; category?: string | null; badges: ReactNode }) {
  const [idx, setIdx] = useState(0);
  const slides = images.length ? images : [""];
  return (
    <div className="relative overflow-hidden rounded-xl2 shadow-soft">
      <div
        className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={(e) => {
          const el = e.currentTarget;
          const i = Math.round(el.scrollLeft / el.clientWidth);
          if (i !== idx) setIdx(i);
        }}
      >
        {slides.map((src, i) => (
          <div key={i} className="w-full flex-none snap-center">
            <ProductImage src={src} title={title} category={category} className="aspect-square w-full" />
          </div>
        ))}
      </div>

      <div className="pointer-events-none absolute left-3 top-3 flex gap-1.5">{badges}</div>

      {slides.length > 1 && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
          {slides.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full shadow-soft transition-all ${
                i === idx ? "w-4 bg-white" : "w-1.5 bg-white/60"
              }`}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TopBtn({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label}
      className="tap flex h-9 w-9 items-center justify-center rounded-full bg-surface shadow-soft">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

/** Desktop-действие в правой колонке: 42×42, в обычном потоке, с tooltip. */
function ActionBtn({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button
      onClick={onClick} aria-label={label} title={label}
      className="tap flex h-[42px] w-[42px] items-center justify-center rounded-full border border-border bg-surface text-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}

/** Desktop «Назад»: отдельная строка над карточкой, не поверх изображения. */
function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick} aria-label="Назад" title="Назад"
      className="tap inline-flex h-[42px] items-center gap-2 rounded-xl2 border border-border bg-surface px-4 text-sm font-medium text-muted transition-colors hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M15 18l-6-6 6-6" />
      </svg>
      Назад
    </button>
  );
}

function InfoTile({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div className="card-appear flex items-center gap-2.5 rounded-xl2 bg-surface px-3 py-2.5 shadow-soft">
      <span className="text-lg">{icon}</span>
      <div className="min-w-0">
        <p className="text-[13px] font-semibold leading-4">{title}</p>
        <p className="mt-0.5 truncate text-[11px] text-muted">{subtitle}</p>
      </div>
    </div>
  );
}

function SubHead({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 px-1 text-[13px] font-bold text-text">{children}</p>;
}

function DeliveryRow({ icon, title, subtitle }: { icon: string; title: string; subtitle: string }) {
  return (
    <div className="card-appear flex items-center gap-3 rounded-xl2 bg-surface px-4 py-3 shadow-soft">
      <span className="text-xl">{icon}</span>
      <div className="min-w-0">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-xs text-muted">{subtitle}</p>
      </div>
    </div>
  );
}
