import { useNavigate } from "react-router-dom";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ProductDetail } from "./ai/types";
import { ProductImage, FavButton } from "./ProductCard";
import { formatPrice } from "../lib/format";
import { bundleItems } from "../lib/bundle";
import { indexFromScroll } from "../lib/carousel";
import { openExternalLink } from "../lib/telegram";
import { usePublicConfig } from "../lib/appConfig";

/** Событийная страница легендарного товара.
 *
 *  Отдельный ЭКРАН, а не отдельный роут: корзина, избранное, «поделиться»,
 *  аналитика и вопрос к AI остаются теми же самыми (см. ProductDetails). Своя
 *  страница по своему адресу неизбежно завела бы вторую корзину и вторую
 *  аналитику, и со временем они разошлись бы с основными.
 *
 *  Тема намеренно не берёт токены приложения (--app-bg и прочие): магазин
 *  светлый, а событие должно выключать свет и читаться как афиша. Палитра
 *  снята с постера и с оформления rockstargames.com/VI — тёмно-синий фон и
 *  ОДИН розовый акцент на всё; вторая по важности вещь на такой странице
 *  просто не нужна. Контраст: #FFFFFF и #A9A5BD на #0D0D16 — 18:1 и 7,4:1,
 *  тёмный текст на розовой кнопке — 11:1.
 *
 *  Своего шрифта не тащим. Постер набран лицензионным ArtDeco студии, а тянуть
 *  ради одной страницы веб-шрифт в Mini App — это лишние сотни килобайт на
 *  мобильном интернете. Характер держим весом, размером и регистром.
 */
export default function LegendaryProduct({
  product, cta, onShare, shared, onAskAi,
}: {
  product: ProductDetail;
  /** Кнопка покупки — общая с обычной страницей (ProductCta), приходит готовой:
   *  правила доступности и корзины обязаны быть одни на весь магазин. */
  cta: ReactNode;
  onShare: () => void;
  shared: boolean;
  onAskAi: () => void;
}) {
  const navigate = useNavigate();
  const config = usePublicConfig();
  const items = bundleItems(product.specs);
  const photos = (product.images && product.images.length
    ? product.images
    : product.image ? [product.image] : []).slice(0, 10);
  // Строку, из которой собран блок «Что в комплекте», в таблице характеристик
  // не повторяем: развёрнутый список и та же строка через экран друг от друга —
  // это один и тот же факт, сказанный дважды.
  const specRows = (product.specifications?.length
    ? product.specifications
    : Object.entries(product.specs || {}).map(([label, value]) => ({ label, value: String(value) }))
  ).filter((s) => !(items.length > 0 && s.label.trim().toLowerCase() === "в комплекте"));

  return (
    // Выход из отступов <main> (px-4 pt-3): тёмное полотно должно доходить до
    // краёв экрана, иначе по бокам светятся полосы светлого магазина.
    <div
      className="-mx-4 -mt-3 min-h-full px-4 pb-cta pt-3 text-white lg:-mx-8 lg:px-8"
      style={{ background: "#0D0D16" }}
    >
      <div className="mx-auto max-w-md lg:max-w-[1100px]">
        <div className="mb-3 flex items-center gap-2">
          <RoundBtn onClick={() => navigate(-1)} label="Назад">
            <path d="M15 18l-6-6 6-6" />
          </RoundBtn>
          <div className="flex-1" />
          <RoundBtn onClick={onShare} label="Поделиться">
            <path d="M12 3v12M12 3 8 7M12 3l4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
          </RoundBtn>
          <FavButton id={product.id} className="h-9 w-9" />
          {shared && (
            <span className="pop-in absolute right-4 top-14 z-10 rounded-full bg-white px-3 py-1.5 text-[11px] font-medium text-[#241C2E]">
              Ссылка скопирована
            </span>
          )}
        </div>

        {/* Афиша во всю ширину. Подписей поверх не рисуем: макет уже содержит и
            заголовок, и цену, и наш текст спорил бы с картинкой. Заголовок
            страницы стоит НИЖЕ — он же остаётся в alt для screen reader. */}
        {product.poster_url && (
          <img
            src={product.poster_url}
            alt={product.title}
            // Афишу не режем нигде: заголовок и цена набраны в самом макете, и
            // любой кроп их отъедает. На desktop вместо этого ограничиваем
            // ширину — иначе 4:3 разворачивается на 800+ пикселей высоты и
            // уводит цену с кнопкой за сгиб.
            className="card-appear -mx-4 w-[calc(100%+2rem)] max-w-none lg:mx-0 lg:w-full lg:max-w-[720px] lg:rounded-hero"
            decoding="async"
          />
        )}

        {/* minmax(0,1fr), а не 1fr: у колонки с длинным заголовком min-content
            больше трека, и на 1fr сетка расползалась вправо за экран. */}
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-12">
          <div>
            <h1 className="mt-6 text-[clamp(2rem,9vw,3.25rem)] font-black uppercase leading-[0.92] tracking-[-0.03em] [text-wrap:balance]">
              {product.title}
            </h1>

            <p className="mt-4 text-[clamp(1.75rem,7vw,2.75rem)] font-black leading-none">
              {formatPrice(product.price)}
            </p>

            {product.description && (
              <p className="mt-5 max-w-[62ch] text-[15px] leading-7 text-[#A9A5BD] [text-wrap:pretty] lg:text-base">
                {product.description}
              </p>
            )}

            {/* Состав комплекта — обычные строки с волосяными линейками, а не
                сетка одинаковых карточек: это перечисление, а не каталог. */}
            {items.length > 0 && (
              <section className="mt-9">
                <h2 className="text-lg font-bold">Что в комплекте</h2>
                <ul className="stagger mt-3">
                  {items.map((item, i) => (
                    <li
                      key={item}
                      className="card-appear flex items-baseline gap-4 border-t py-3.5 text-[15px] leading-6"
                      style={{ borderColor: "rgba(255,255,255,0.10)" }}
                    >
                      <span className="w-5 shrink-0 text-[13px] font-semibold" style={{ color: "#FFB0C4" }}>
                        {i + 1}
                      </span>
                      <span className="font-medium">{item}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {photos.length > 0 && <Photos photos={photos} title={product.title} category={product.category} />}

            {specRows.length > 0 && (
              <section className="mt-9">
                <h2 className="text-lg font-bold">Характеристики</h2>
                <dl className="mt-3">
                  {specRows.map((s) => (
                    <div
                      key={s.label}
                      className="flex justify-between gap-6 border-t py-3 text-[15px]"
                      style={{ borderColor: "rgba(255,255,255,0.10)" }}
                    >
                      <dt className="text-[#A9A5BD]">{s.label}</dt>
                      <dd className="text-right font-medium">{s.value}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            <section className="mt-9">
              <h2 className="text-lg font-bold">Как получить</h2>
              <div className="mt-3">
                <Term title="Самовывоз — Горбушка, Москва"
                  note={product.is_available_today ? "Сегодня, 10:00–21:00" : "Обычно на следующий день, 10:00–21:00"} />
                <Term title="Доставка по Москве" note="1–2 дня, стоимость уточнит менеджер" />
                <Term title="В другие города" note="Транспортной компанией, способ зависит от адреса" />
                <Term title={product.warranty_months > 0 ? `Гарантия ${product.warranty_months} мес.` : "Гарантия магазина"}
                  note="Проверка при вас, обмен по гарантии" />
              </div>
            </section>

            <div className="mt-8 flex flex-wrap gap-2">
              <GhostBtn onClick={onAskAi}>✨ Спросить AI</GhostBtn>
              <GhostBtn onClick={() => openExternalLink(config.manager_retail_url)}>💬 Написать менеджеру</GhostBtn>
            </div>
          </div>

          {/* Desktop: покупка стоит рядом с описанием и не уезжает вниз. */}
          <div className="mt-8 hidden lg:sticky lg:top-6 lg:mt-6 lg:block">
            <div className="rounded-hero p-5" style={{ background: "rgba(255,255,255,0.06)" }}>
              {cta}
            </div>
          </div>
        </div>
      </div>

      {/* Mobile: та же кнопка в доке. Фон дока — фон страницы, чтобы под ним не
          просвечивала светлая полоса магазина. */}
      <div
        className="fixed inset-x-0 cta-dock z-30 border-t px-4 pt-2.5 lg:hidden"
        style={{ background: "#0D0D16", borderColor: "rgba(255,255,255,0.10)" }}
      >
        <div className="mx-auto max-w-md">{cta}</div>
      </div>
    </div>
  );
}

/** Фотографии товара — лента со свайпом. Снимки студийные, на белом фоне:
 *  светлые плитки на тёмном полотне читаются как выложенный на стол товар. */
function Photos({ photos, title, category }: { photos: string[]; title: string; category?: string | null }) {
  const [idx, setIdx] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setIdx(0); ref.current?.scrollTo({ left: 0 }); }, [photos[0], photos.length]);

  return (
    <section className="mt-9">
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const i = indexFromScroll(el.scrollLeft, el.clientWidth, photos.length);
          if (i !== idx) setIdx(i);
        }}
        className="no-scrollbar -mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 lg:mx-0 lg:px-0"
      >
        {photos.map((src, i) => (
          <div key={i} className="w-[78%] shrink-0 snap-center lg:w-[300px]">
            <ProductImage src={src} title={title} category={category} className="aspect-square w-full rounded-xl2" />
          </div>
        ))}
      </div>
      {photos.length > 1 && (
        <div className="mt-3 flex justify-center gap-1.5" aria-hidden>
          {photos.map((_, i) => (
            <span
              key={i}
              className={`h-1.5 rounded-full transition-[width,background-color] duration-150 ${i === idx ? "w-4" : "w-1.5"}`}
              style={{ background: i === idx ? "#FFB0C4" : "rgba(255,255,255,0.28)" }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Term({ title, note }: { title: string; note: string }) {
  return (
    <div className="border-t py-3" style={{ borderColor: "rgba(255,255,255,0.10)" }}>
      <p className="text-[15px] font-medium">{title}</p>
      <p className="mt-0.5 text-[13px] text-[#A9A5BD]">{note}</p>
    </div>
  );
}

function GhostBtn({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="tap flex-1 rounded-field border px-4 py-2.5 text-[13px] font-medium text-white"
      style={{ borderColor: "rgba(255,255,255,0.22)" }}
    >
      {children}
    </button>
  );
}

function RoundBtn({ onClick, label, children }: { onClick: () => void; label: string; children: ReactNode }) {
  return (
    <button onClick={onClick} aria-label={label}
      className="tap flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#241C2E]">
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor"
        strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </button>
  );
}
