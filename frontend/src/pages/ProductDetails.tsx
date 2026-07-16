import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { ProductDetail } from "../components/ai/types";
import { formatPrice, discountPct } from "../lib/format";
import { ProductImage, Badge, FavButton } from "../components/ProductCard";
import LeadForm from "../components/LeadForm";

type Tab = "desc" | "specs" | "delivery";

export default function ProductDetails() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [p, setP] = useState<ProductDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [tab, setTab] = useState<Tab>("desc");
  const [shared, setShared] = useState(false);
  const [lead, setLead] = useState<{ source: string; preset?: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    api<ProductDetail>(`/catalog/product/${id}`)
      .then((d) => { setP(d); track("product_viewed", { product_id: d.id }); })
      .catch(() => setNotFound(true));
  }, [id]);

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

  if (notFound) return <div className="mx-auto max-w-md py-20 text-center text-muted">Товар не найден</div>;
  if (!p) return (
    <div className="mx-auto max-w-md">
      <div className="skeleton aspect-square rounded-xl2" />
      <div className="skeleton mt-4 h-6 w-2/3 rounded-lg" />
      <div className="skeleton mt-2 h-8 w-1/3 rounded-lg" />
    </div>
  );

  const disc = discountPct(p.price, p.old_price);
  const saving = p.old_price ? p.old_price - p.price : 0;

  const tabCls = (active: boolean) =>
    `tap flex-1 rounded-xl py-2 text-[13px] font-semibold transition-colors ${
      active ? "bg-surface text-text shadow-soft" : "text-muted"
    }`;

  return (
    // pb-40 (160px): контент никогда не перекрывается фиксированной CTA-зоной
    <div className="mx-auto max-w-md pb-40">
      {/* ===== Sticky top bar: назад / поиск / поделиться / избранное ===== */}
      <div className="sticky top-0 z-30 -mx-4 -mt-3 mb-3 flex items-center gap-2 bg-bg/90 px-4 py-2 backdrop-blur-lg">
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

      <p className="mt-4 text-xs text-muted">{p.brand}{p.category ? ` · ${p.category}` : ""}</p>
      <h1 className="mt-1 text-xl font-bold leading-6">{p.title}</h1>

      {/* Цена + выгода */}
      <div className="mt-2.5 flex items-center gap-2.5">
        <span className="text-[26px] font-bold leading-8">{formatPrice(p.price)}</span>
        {p.old_price && <span className="text-sm text-muted line-through">{formatPrice(p.old_price)}</span>}
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
          onClick={() => setLead({ source: "manager", preset: `Вопрос по товару: ${p.title}` })}
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

      {/* ===== Табы: Описание / Характеристики / Получение ===== */}
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
          {Object.keys(p.specs || {}).length > 0 ? (
            <div className="divide-y divide-border">
              {Object.entries(p.specs).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4 py-2 text-sm">
                  <span className="text-muted">{k}</span>
                  <span className="text-right font-medium">{String(v)}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">Характеристики уточняются у менеджера.</p>
          )}
        </div>
      )}

      {tab === "delivery" && (
        <div className="fade-in mt-3 space-y-2">
          <DeliveryRow icon="🏬" title="Самовывоз — Горбушка, Москва"
            subtitle={p.in_stock && p.is_available_today ? "Можно забрать сегодня, 10:00–21:00" : "Обычно на следующий день"} />
          <DeliveryRow icon="🚚" title="Доставка по Москве" subtitle="1–2 дня, детали уточнит менеджер" />
          <DeliveryRow icon="🛡️" title={`Гарантия ${p.warranty_months} мес.`} subtitle="Проверка товара при получении" />
        </div>
      )}

      {/* ===== Единственная закреплённая CTA — строго внизу, над BottomNav ===== */}
      <div className="fixed inset-x-0 bottom-[64px] z-30 border-t border-border bg-surface/95 px-4 py-2.5 backdrop-blur-lg">
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
