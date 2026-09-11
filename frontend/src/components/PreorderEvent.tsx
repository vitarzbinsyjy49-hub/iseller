import { useNavigate } from "react-router-dom";
import { useEffect, useRef, type ReactNode } from "react";
import { ProductCard as TCard } from "./ai/types";
import ProductCard from "./ProductCard";
import { enterRefCallback } from "../lib/useEnter";
import { OVERLAY_HEADER, useOverlayTopColor } from "./AuroraBackground";

/** Шапка события — это баннер, который на него ведёт. Второго набора тех же
 *  полей в отдельной таблице нет намеренно: они бы разошлись. */
export type EventBanner = {
  id: number;
  title: string;
  subtitle?: string | null;
  image_url?: string | null;
  background_gradient?: string | null;
};

/** Экран события предзаказа.
 *
 *  Отдельный ЭКРАН, а не отдельное приложение — ровно по тем же причинам, что и
 *  у легендарного товара (см. LegendaryProduct): избранное, «поделиться»,
 *  аналитика и корзина остаются общими, и разойтись им негде.
 *
 *  Устроен не сеткой, а чередованием «описание устройства → его карточка».
 *  Шесть одинаковых плиток дали бы каталог; здесь же рассказ о событии, и
 *  человек читает про аппарат ровно перед тем, как решить.
 *
 *  Палитра снята пипеткой с самого баннера. Экран и кадр обязаны звучать в один
 *  тон — иначе баннер выглядит вставленным из чужого проекта.
 */
/** Карточка события = обычная карточка плюс описание: его показывает только
 *  этот экран, поэтому в общий to_card() оно не входит. */
export type EventItem = TCard & { description?: string };

export default function PreorderEvent({
  banner, items,
}: {
  banner: EventBanner | null;
  items: EventItem[];
}) {
  const navigate = useNavigate();

  // Верх Telegram — цветом этого экрана, а не витрины: экран занимает весь
  // вьюпорт и доходит до самой кромки, и светлая плашка над ним читалась бы
  // отдельной деталью. Возврат к цвету маршрута — на уходе (см. хук).
  useOverlayTopColor(OVERLAY_HEADER.preorder);

  return (
    // fixed inset-0 — тот же приём, что у афиши легендарного товара: экран
    // занимает вьюпорт и прокручивается внутри себя, а не пытается выйти из
    // отступов <main> отрицательными полями (на desktop это оставляло светлые
    // полосы по бокам, см. LegendaryProduct).
    <div
      className="fixed inset-0 z-50 overflow-y-auto overflow-x-hidden overscroll-contain"
      style={{
        paddingTop: "calc(var(--app-content-top-offset, env(safe-area-inset-top, 0px)) + 12px)",
      }}
    >
      <LiveBackdrop />

      <div className="relative z-10 mx-auto max-w-md px-4 pb-16 lg:max-w-[1100px] lg:px-8">
        <div className="-mx-1 mb-2 flex items-center">
          <RoundBtn onClick={() => navigate(-1)} label="Назад">
            <path d="M15 18l-6-6 6-6" />
          </RoundBtn>
        </div>

        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#6E2639]">
          Apple · 9 сентября
        </p>
        <h1 className="mt-2.5 text-[clamp(1.75rem,8vw,2.5rem)] font-black leading-[1.04] tracking-[-0.03em] [text-wrap:balance]">
          {banner?.title || "Новые устройства"}
        </h1>
        {banner?.subtitle && (
          <p className="mt-2.5 max-w-[34ch] text-[13.5px] leading-6 opacity-80 lg:text-[15px]">
            {banner.subtitle}
          </p>
        )}

        {banner?.image_url && (
          <img
            src={banner.image_url}
            alt={banner.title}
            ref={enterRefCallback("fadeUp")}
            decoding="async"
            className="mt-4 w-full rounded-hero shadow-float"
          />
        )}

        {items.length === 0 ? (
          // Группа пустеет сама, когда товары приехали и стали обычными. Это
          // штатный конец жизни события, а не ошибка — и сказать об этом надо
          // словами, а не пустым экраном.
          <div className="mt-10 rounded-xl2 bg-surface p-5 text-center shadow-card">
            <p className="text-[15px] font-semibold">Всё уже приехало</p>
            <p className="mt-1.5 text-[13px] text-muted">
              Устройства этого события больше не в предзаказе — ищите их в каталоге.
            </p>
            <button
              onClick={() => navigate("/catalog")}
              className="tap mt-4 h-11 w-full rounded-field bg-accent text-[13px] font-medium text-white"
            >
              Открыть каталог
            </button>
          </div>
        ) : (
          <div className="lg:grid lg:grid-cols-2 lg:gap-x-10">
            {items.map((card) => (
              <DeviceBlock key={card.id} card={card} />
            ))}
          </div>
        )}

        <p className="mt-10 text-[12px] leading-5 opacity-60">
          Цены и сроки предварительные: устройства ещё не поступили. Менеджер
          свяжется и подтвердит и то, и другое.
        </p>
      </div>
    </div>
  );
}

/** Один аппарат: описание, затем его карточка. Акцент берётся с товара и красит
 *  ровно два места — полоску и заголовок; всё остальное у блоков общее, иначе
 *  шесть разных цветов передрались бы между собой. */
function DeviceBlock({ card }: { card: EventItem }) {
  const accent = card.accent_color || "#6E2639";
  return (
    <section className="mt-8 border-t pt-6" style={{ borderColor: "rgba(43,31,46,.12)" }}>
      <span className="mb-3 block h-[3px] w-8 rounded-full" style={{ background: accent }} />
      <h2 className="text-[19px] font-bold leading-tight tracking-[-0.02em]">{card.title}</h2>
      {card.description && (
        <p className="mt-2.5 max-w-[62ch] text-[13.5px] leading-6 opacity-78 [text-wrap:pretty]">
          {card.description}
        </p>
      )}
      <div className="mt-4 max-w-[280px]">
        <ProductCard card={card} />
      </div>
    </section>
  );
}

/** Живой фон.
 *
 *  Канва рисуется в 48×88 пикселей и растягивается браузером — размытие
 *  получается даром от апскейла, поэтому кадр стоит околоноля работы.
 *
 *  НЕ CSS. Webview Telegram гасит декларативную анимацию целиком: `@keyframes`
 *  и `transition` не проигрываются, свойство применяется мгновенно, ошибки нет,
 *  и изнутри кода «не анимировалось» от «анимировалось быстро» не отличить (так
 *  уже перещёлкивались панель каталога и превращение кнопки в степпер). Поэтому
 *  движение идёт через requestAnimationFrame.
 *
 *  24 кадра в секунду: медленный перелив быстрее не становится, а батарея на
 *  телефоне расходуется заметно меньше. Мотор стоит при скрытой вкладке и не
 *  запускается вовсе при «уменьшить движение» — там один статичный кадр.
 */
const BLOBS = [
  { x: 0.82, y: 0.10, r: 0.80, c: "127,140,185", a: 0.95 },  // барвинок
  { x: 0.12, y: 0.06, r: 0.70, c: "201,187,205", a: 0.85 },  // мов
  { x: 0.20, y: 0.62, r: 0.85, c: "253,205,151", a: 0.95 },  // абрикос
  { x: 0.88, y: 0.82, r: 0.75, c: "248,188,149", a: 0.80 },  // персик
  { x: 0.50, y: 0.40, r: 0.45, c: "89,44,52", a: 0.10 },     // винный, еле слышно
];

function LiveBackdrop() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext("2d");
    if (!cv || !ctx) return;
    const W = 48, H = 88;
    cv.width = W;
    cv.height = H;

    const draw = (t: number) => {
      ctx.fillStyle = "#FBD0A4";
      ctx.fillRect(0, 0, W, H);
      BLOBS.forEach((b, i) => {
        // Фигуры Лиссажу со взаимно непериодичными периодами: рисунок не
        // зацикливается на глаз, и «шов» повтора не поймать.
        const x = (b.x + 0.1 * Math.sin(t * (0.07 + i * 0.013) + i)) * W;
        const y = (b.y + 0.08 * Math.cos(t * (0.05 + i * 0.017) + i * 1.7)) * H;
        const r = b.r * W * (1 + 0.1 * Math.sin(t * 0.04 + i));
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, `rgba(${b.c},${b.a})`);
        g.addColorStop(1, `rgba(${b.c},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
      });
    };

    draw(0);
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) return;

    let raf = 0;
    let last = 0;
    const MIN_MS = 1000 / 24;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < MIN_MS) return;
      last = now;
      draw(now / 1000);
    };
    const start = () => { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } };
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };
    const onVisibility = () => (document.hidden ? stop() : start());

    document.addEventListener("visibilitychange", onVisibility);
    start();
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, []);

  return (
    <canvas
      ref={ref}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 h-full w-full"
    />
  );
}

function RoundBtn({
  onClick, label, children,
}: {
  onClick: () => void; label: string; children: ReactNode;
}) {
  return (
    // Кружок 36px в области нажатия 44px — та же мера, что на карточке товара.
    <button onClick={onClick} aria-label={label}
      className="tap flex h-11 w-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white text-[#241C2E] shadow-card">
        <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {children}
        </svg>
      </span>
    </button>
  );
}

/** Состояние загрузки экрана — та же раскладка, что и у готового. */
export function PreorderSkeleton() {
  return (
    <div className="mx-auto max-w-md px-4 py-10 lg:max-w-[1100px]">
      <div className="skeleton h-8 w-2/3 rounded-xl2" />
      <div className="skeleton mt-4 aspect-[3/2] w-full rounded-hero" />
      <div className="skeleton mt-8 h-64 w-full rounded-xl2" />
    </div>
  );
}
