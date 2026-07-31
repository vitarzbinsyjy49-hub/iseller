import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { indexFromScroll } from "../lib/carousel";
import { track, trackProduct } from "../lib/analytics";
import { ProductCard as TCard, ProductDetail } from "../components/ai/types";
import ProductCardView from "../components/ProductCard";
import { formatPrice, discountPct } from "../lib/format";
import { ProductImage, Badge, FavButton } from "../components/ProductCard";
import { ErrorState } from "../components/StateViews";
import LeadForm from "../components/LeadForm";
import { haptic, isInsideTelegram, openExternalLink } from "../lib/telegram";
import { pickShareTarget } from "../lib/share";
import { usePublicConfig } from "../lib/appConfig";
import { toast } from "../lib/toast";
import { addToCart, removeCartItem, setItemQuantity, useCartEntry } from "../lib/cart";
import { canAddToCart } from "../lib/cartMath";
import { QuantityStepper } from "../components/QuantityStepper";

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
  // «Похожие варианты» — существующий каталог той же категории (без нового
  // endpoint), текущий товар исключён. Это НЕ персональная подборка.
  const [similar, setSimilar] = useState<TCard[]>([]);

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

  // Похожие: та же категория, популярные, минус текущий товар; показываем от 3.
  // AbortController отменяет запрос при уходе со страницы/смене товара.
  useEffect(() => {
    setSimilar([]);
    const category = p?.category;
    if (!p || !category) return;
    const controller = new AbortController();
    api<{ cards?: TCard[] }>(
      `/catalog/list?category=${encodeURIComponent(category)}&sort=popularity`,
      { signal: controller.signal },
    )
      .then((d) => {
        const cards = (Array.isArray(d.cards) ? d.cards : []).filter((c) => c.id !== p.id).slice(0, 8);
        setSimilar(cards.length >= 3 ? cards : []);
      })
      .catch(() => { /* секция просто не показывается */ });
    return () => controller.abort();
  }, [p?.id, p?.category]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Поделиться товаром.
   *
   *  Раньше отсюда уходил `window.location.href` — внутренний адрес Mini App.
   *  Получатель открывал его в обычном браузере, где нет Telegram-авторизации,
   *  и упирался в «Не удалось войти»: ссылка от друга вела в тупик, а выглядело
   *  это как сломанный магазин. Теперь делимся deep link'ом бота, который
   *  открывает Telegram и доводит до карточки (см. lib/share.ts).
   */
  async function share() {
    if (!p) return;
    const target = pickShareTarget({
      insideTelegram: isInsideTelegram(),
      botUsername: config.bot_username,
      productId: p.id,
      title: p.title,
      price: formatPrice(p.price),
      fallbackUrl: window.location.href,
      hasNativeShare: typeof navigator !== "undefined" && !!navigator.share,
    });
    track("product_shared", { product_id: p.id, target: target.kind });
    haptic("light");

    if (target.kind === "telegram") {
      openExternalLink(target.url);
      return;
    }
    try {
      if (target.kind === "native") {
        await navigator.share({ title: p.title, text: target.text, url: target.link });
        return;
      }
      await navigator.clipboard.writeText(target.link);
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
      {/* Фон СОЛИДНЫЙ (bg-bg, без /90 и backdrop-blur): галерея уходит строго ПОД
          непрозрачную панель — фото не просвечивает сквозь неё.
          -top-3 (не top-0): sticky-панель пиннится на -12px = −pt-3 у <main>, иначе
          она вставала по КОНТЕНТ-краю main, и в 12px-полосе его padding-top над
          панелью просвечивало фото (fullscreen, замер: IMG над баром). Теперь
          панель кроет эту полосу; скачка нет (rest == stuck). */}
      <div className="sticky -top-3 z-30 -mx-4 -mt-3 mb-3 flex items-center gap-2 bg-bg px-4 py-2 lg:hidden">
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
        images={(p.images && p.images.length ? p.images : p.image ? [p.image] : []).slice(0, 10)}
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

      {/* Остаток — только у товаров, помеченных в админке как лимитированные
          (is_limited). Малый складской остаток сам по себе дефицитом не считаем. */}
      {p.is_limited && p.in_stock && p.stock != null && p.stock > 0 && (
        <p className="mt-1.5 text-[13px] font-medium text-orange">Осталось {p.stock} шт — успейте забрать</p>
      )}

      {/* Социальное доказательство. Текст приходит с backend уже готовым и
          посчитанным по заявкам/избранному — здесь его только показывают.
          Спокойный, не «горящий» стиль намеренно: это факт о товаре, а не
          призыв торопиться, и рядом с оранжевым «Осталось N шт» он не должен
          выглядеть вторым таймером. */}
      {p.social_proof && (
        <p className="mt-1.5 flex items-center gap-1.5 text-[13px] font-medium text-muted">
          <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor"
            strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20" />
            <circle cx="10" cy="8" r="3.2" />
            <path d="M19 20v-1.5a3.5 3.5 0 0 0-2.6-3.4M15.5 5.2a3.2 3.2 0 0 1 0 5.6" />
          </svg>
          {p.social_proof}
        </p>
      )}

      {/* Быстрые действия — в потоке контента, ниже цены (не в fixed-зоне) */}
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => {
            // Prefill без авто-отправки: пользователь видит текст и жмёт сам.
            // Цену в prompt не вставляем — факты AI получает через backend.
            // ai_prefill_opened трекает сам AiSearch при потреблении ?q=.
            navigate(`/ai?q=${encodeURIComponent(`Сравни ${p.title} с подходящими альтернативами и объясни, кому он подойдёт`)}`);
          }}
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
      <div className="mt-5 hidden lg:block">
        <ProductCta product={p} onNotify={() => setLead({
          source: "product", preset: `Сообщите, когда появится: ${p.title}`,
        })} />
      </div>

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

      {/* ===== Похожие варианты: та же категория (существующий каталог), без
          претензии на персональность. Показываем только при ≥3 товарах. ===== */}
      {similar.length >= 3 && (
        <div className="mt-6">
          <div className="flex items-baseline justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-[17px] font-bold leading-5">Похожие варианты</h2>
              <p className="mt-0.5 text-xs text-muted">Из той же категории</p>
            </div>
            {p.category && (
              <button
                onClick={() => navigate(`/catalog?category=${encodeURIComponent(p.category!)}`)}
                className="shrink-0 text-xs font-medium text-accent"
              >
                Смотреть все
              </button>
            )}
          </div>
          <div className="no-scrollbar stagger -mx-4 mt-3 flex gap-3 overflow-x-auto px-4 pb-2 lg:mx-0 lg:grid lg:grid-cols-4 lg:gap-4 lg:overflow-visible lg:px-0 lg:pb-0 wide:grid-cols-5">
            {similar.map((c) => (
              <ProductCardView key={c.id} card={c} compact />
            ))}
          </div>
        </div>
      )}

      {/* ===== Фиксированная CTA — ТОЛЬКО mobile (на desktop CTA в правой колонке) =====
          cta-dock (index.css): панель прижата к низу, непрозрачный фон до самого низа
          (за навбаром), кнопка поднята на высоту навбара + 16px. Между кнопкой и
          навбаром — свой фон панели, а не сквозной скролл. Фон солидный (bg-surface,
          pt-2.5 сверху; нижний паддинг задаёт cta-dock). */}
      <div className="fixed inset-x-0 cta-dock z-30 border-t border-border bg-surface px-4 pt-2.5 lg:hidden">
        <div className="mx-auto max-w-md">
          <ProductCta product={p} onNotify={() => setLead({
            source: "product", preset: `Сообщите, когда появится: ${p.title}`,
          })} />
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

/** Основное действие карточки товара.
 *
 *  Один компонент на mobile-док и desktop-колонку: две копии этой логики
 *  разошлись бы в правилах доступности, а именно они решают, можно ли вообще
 *  оформить товар.
 *
 *  - обычный товар: «Добавить в корзину» -> степпер + «Перейти в корзину»;
 *  - «Купить сейчас» добавляет ТОЛЬКО этот товар и открывает оформление —
 *    заявку не отправляет: одно случайное нажатие не должно создавать заявку;
 *  - нет в наличии: добавления нет вовсе, вместо него «Узнать о поступлении»
 *    (обычная заявка с преднабранным текстом — отдельной подписки на
 *    поступление в проекте нет, и выдумывать её кнопкой нельзя);
 *  - предзаказ / под заказ: добавить можно, но подпись честно говорит, что это.
 */
function ProductCta({ product, onNotify }: { product: ProductDetail; onNotify: () => void }) {
  const navigate = useNavigate();
  const { item, busy } = useCartEntry(product.id);
  const [pending, setPending] = useState(false);
  const mode = product.availability_mode;
  const orderable = mode ? canAddToCart(mode) : product.in_stock !== false;
  const note = product.availability_note
    || (mode === "preorder" ? "Предзаказ — сроки подтвердит менеджер" : "");

  async function add(source: "cta" | "buy_now"): Promise<boolean> {
    setPending(true);
    haptic("light");
    track(source === "buy_now" ? "buy_now" : "cart_add", { product_id: product.id, source: "product" });
    try {
      await addToCart({
        id: product.id, title: product.title, price: product.price, image: product.image,
        sku: product.sku, brand: product.brand, category: product.category,
        max_quantity: product.max_quantity,
      });
      return true;
    } catch {
      toast("Не удалось добавить в корзину", "error");
      return false;
    } finally {
      setPending(false);
    }
  }

  async function change(next: number) {
    if (!item) return;
    haptic("light");
    try {
      if (next <= 0) await removeCartItem(item.id);
      else await setItemQuantity(item.id, next);
    } catch {
      toast("Не удалось обновить корзину", "error");
    }
  }

  async function buyNow() {
    // Уже в корзине — второй раз не добавляем, просто ведём к оформлению.
    if (item || await add("buy_now")) navigate("/cart?checkout=1&from=buy_now");
  }

  if (!orderable) {
    return (
      <div>
        <button
          onClick={onNotify}
          className="tap w-full rounded-xl2 bg-accent py-3 text-white transition-colors hover:bg-accentdark"
        >
          <span className="block text-[15px] font-bold leading-5">Узнать о поступлении</span>
          <span className="block text-[11px] font-medium text-white/80">Сообщим, когда появится</span>
        </button>
        <p className="mt-1.5 text-center text-[11px] text-muted">
          {product.availability_label || "Сейчас нет в наличии"}
        </p>
      </div>
    );
  }

  if (item) {
    return (
      <div>
        <div className="flex items-center gap-2.5">
          <div className="w-32 shrink-0">
            <QuantityStepper
              quantity={item.quantity} max={item.max_quantity} busy={busy}
              onChange={change} ariaLabel={`Количество: ${product.title}`}
            />
          </div>
          <button
            onClick={() => navigate("/cart?from=product")}
            className="tap h-11 flex-1 rounded-xl2 bg-accent text-[15px] font-bold text-white transition-colors hover:bg-accentdark"
          >
            Перейти в корзину
          </button>
        </div>
        <p className="mt-1.5 text-center text-[11px] text-muted">
          {note || "Итоговую стоимость подтвердит менеджер"}
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2.5">
        <button
          onClick={() => add("cta")}
          disabled={pending}
          className="tap h-11 flex-1 rounded-xl2 bg-accent text-[15px] font-bold text-white transition-opacity hover:bg-accentdark disabled:opacity-60"
        >
          {pending ? "Добавляем…" : "Добавить в корзину"}
        </button>
        <button
          onClick={buyNow}
          disabled={pending}
          className="tap h-11 shrink-0 rounded-xl2 border border-border bg-surface px-4 text-[13px] font-semibold text-text transition-opacity disabled:opacity-60"
        >
          Купить сейчас
        </button>
      </div>
      <p className="mt-1.5 text-center text-[11px] text-muted">
        {note || "Не оплата и не бронь — заявку подтвердит менеджер"}
      </p>
    </div>
  );
}

/** Карусель фото товара: горизонтальный свайп (scroll-snap) + кликабельные точки.
 *  Общая с ProductCard логика индекса (indexFromScroll). Максимум 10, битое фото
 *  безопасно (ProductImage), главная — первая. Точки листают скроллом. */
function Gallery({
  images, title, category, badges,
}: { images: string[]; title: string; category?: string | null; badges: ReactNode }) {
  const [idx, setIdx] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const slides = images.length ? images : [""];

  // Сброс при смене товара/набора фото (главная всегда первой).
  useEffect(() => { setIdx(0); scrollRef.current?.scrollTo({ left: 0 }); }, [images[0], images.length]);

  function goTo(i: number) {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ left: i * el.clientWidth, behavior: "smooth" });
    setIdx(i);
  }

  return (
    <div className="relative overflow-hidden rounded-xl2 shadow-soft">
      <div
        ref={scrollRef}
        className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        onScroll={(e) => {
          const el = e.currentTarget;
          const i = indexFromScroll(el.scrollLeft, el.clientWidth, slides.length);
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
        <div className="absolute inset-x-0 bottom-3 flex justify-center gap-1.5">
          {slides.map((_, i) => (
            <button
              key={i}
              type="button"
              aria-label={`Показать фото ${i + 1} из ${slides.length}`}
              aria-current={i === idx}
              onClick={() => goTo(i)}
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
