import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { track } from "../lib/analytics";
import { ProductCard as TCard } from "./ai/types";
import { ProductImage } from "./ProductCard";
import { formatPrice } from "../lib/format";
import { useLiveSearch, MIN_QUERY_LEN } from "../lib/liveSearch";
import { clearSearchHistory, loadSearchHistory } from "../lib/searchHistory";
import { Icon } from "./icons";
import { dropdownMaxHeightPx } from "../lib/viewport";

/** Сценарные чипы поиска: только маршруты, которые каталог реально понимает
 *  (query/category/today) — никаких выдуманных фильтров. Консультационные
 *  сценарии (Trade-In, бизнес) живут в блоке сценариев на главной, здесь —
 *  быстрые товарные намерения. */
const SCENARIO_CHIPS: { label: string; route: string }[] = [
  { label: "iPhone", route: "/catalog?query=iPhone" },
  { label: "MacBook", route: "/catalog?query=MacBook" },
  { label: "AirPods", route: "/catalog?query=AirPods" },
  { label: "Забрать сегодня", route: "/catalog?today=1" },
  // Чипа «Аксессуары» здесь больше нет: он вёл в несуществующую категорию.
  // Оставшиеся — поисковые запросы по реальным моделям, они не могут протухнуть
  // так же, как ссылка на категорию. Настоящие категории приходят в prop chips.
];

/** Прокручиваемая оболочка панели: высота по реально доступному месту.
 *
 *  Раньше высоту задавал `max-h-[min(60vh,480px)]` — и только состоянию с
 *  пустым запросом; список результатов не ограничивался вовсе. Панель уходила
 *  нижним краем под клавиатуру и под нижнюю навигацию, а прокрутка внутри не
 *  помогала: закрыт был не низ списка, а низ экрана.
 *
 *  Границу считаем по двум опорам сразу, и обе намеренно разного рода:
 *
 *  - visualViewport — про клавиатуру. Он, в отличие от --app-height,
 *    сжимается вместе с ней (--app-height берётся из СТАБИЛЬНОЙ высоты, чтобы
 *    не дёргались шторки, — см. lib/telegram). Но полагаться на него одного
 *    нельзя: часть устройств кладёт клавиатуру ПОВЕРХ вебвью, ничего не сжимая.
 *  - нижний отступ скролл-контейнера — про навигацию. Это тот же резерв, из
 *    которого живёт вся раскладка (.pb-nav), он статичен и не зависит от того,
 *    показана навигация прямо сейчас или скрыта под html.kb-open.
 *
 *  Пересчёт вешаем и на resize, и на scroll видимой области: на iOS открытие
 *  клавиатуры сдвигает visualViewport, не меняя размера окна.
 *
 *  Даже с этим расчёт остаётся оценкой — устройства по-разному сообщают о
 *  клавиатуре, а часть не сообщает вовсе. Поэтому главное действие панели
 *  («Спросить AI») стоит в её НАЧАЛЕ: место в начале списка не зависит ни от
 *  какого замера. */
function PanelScroll({ depsKey, className = "", fill = false, children, ...rest }: {
  /** Всё, от чего зависит пересчёт высоты, — ОДНОЙ строкой.
   *
   *  Раньше сюда приходил `unknown[]`, который уходил прямо в массив
   *  зависимостей useLayoutEffect. Панель рендерится из двух веток (набранный
   *  запрос и пустой), в каждой свой набор зависимостей — и разной длины. Для
   *  React это один и тот же эффект в одной позиции дерева, которому между
   *  рендерами меняют РАЗМЕР массива зависимостей: поведение не определено, в
   *  консоли — «The final argument passed to useLayoutEffect changed size
   *  between renders». Строковый ключ делает арность постоянной по построению:
   *  сколько бы значений ветка ни складывала в ключ, зависимость всегда одна. */
  depsKey: string;
  className?: string;
  /** Панель занимает всю доступную высоту, а прокруткой управляет родитель.
   *
   *  Нужен полноэкранному оверлею поиска (components/SearchOverlay): расчёт
   *  ниже — про ВЫПАДАЮЩУЮ панель, он меряет расстояние до низа экрана и
   *  резерв под навигацию через `closest("main")`. Из оверлея этих опор нет
   *  вовсе: он сосед `<main>`, а не его потомок, резерв читается нулём, и
   *  панель получала бы собственный max-height внутри уже прокручиваемого
   *  контейнера — список внутри списка. Здесь ограничивать нечего: высоту
   *  задаёт сам оверлей. */
  fill?: boolean;
  children: ReactNode;
} & Record<string, unknown>) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || fill) return;
    const apply = () => {
      const vv = window.visualViewport;
      const offset = vv?.offsetTop ?? 0;
      // Нижнюю границу берём НЕ из замера самой навигации. Сначала здесь стоял
      // её getBoundingClientRect().top — и это оказалось опорой на случайный
      // момент времени: навигация то скрыта (html.kb-open), то нет, и стоило
      // замеру прийтись на скрытую, как панель решала, что снизу свободно до
      // самого края экрана. На устройстве это давало панель, которая уходит под
      // таб-бар и при этом даже не прокручивается — ей было некуда переполняться.
      //
      // Опора теперь — тот же резерв под навигацию, которым уже пользуется всё
      // приложение: нижний отступ скролл-контейнера (.pb-nav). Он вычислен из
      // высоты навбара и safe-area, не зависит от того, показана навигация прямо
      // сейчас или нет, и не может «мигнуть» между двумя замерами.
      const scroller = el.closest("main");
      const navClearance = scroller
        ? parseFloat(getComputedStyle(scroller).paddingBottom) || 0
        : 0;
      const limit = Math.min(
        vv?.height ?? window.innerHeight,
        window.innerHeight - navClearance,
      );
      const top = el.getBoundingClientRect().top - offset;
      el.style.maxHeight = `${dropdownMaxHeightPx(top, limit)}px`;
    };
    apply();
    const vv = window.visualViewport;
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
    };
  }, [depsKey, fill]);

  return (
    <div
      ref={ref}
      className={fill ? className : `overflow-y-auto overscroll-contain ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

type Props = {
  /** Текущий текст в поисковом инпуте (владелец инпута — родитель). */
  query: string;
  /** Навигация с закрытием панели (родитель делает navigate + close). */
  onNavigate: (to: string) => void;
  /** Подставить текст из истории в инпут (без немедленной навигации). */
  onPickQuery: (q: string) => void;
  /** Быстрые категории (родитель уже знает их — heroChips на главной). */
  chips?: { key: string; label: string; route: string }[];
  /** «Недавно смотрели» — данные уже загружены родителем, второй запрос не нужен. */
  recentlyViewed?: TCard[] | null;
  /** Показывать ли live-результаты (на desktop-шапке результаты рисует каталог). */
  withResults?: boolean;
  /** Высотой и прокруткой распоряжается родитель (полноэкранный оверлей). */
  fill?: boolean;
};

/** Содержимое умной поисковой панели. Родитель решает, КОГДА и ГДЕ её показать
 *  (dropdown под hero на mobile, компактный popover в шапке на desktop) —
 *  панель отвечает только за наполнение:
 *  - пустой запрос: история (localStorage) + сценарные чипы + недавно
 *    просмотренные + быстрые категории + «Спросить AI»;
 *  - есть запрос: live-результаты (/catalog/search, debounce + abort) либо
 *    «ничего не нашлось» с выходами в AI и каталог.
 *  Обычный поиск — детерминированный каталог; сложные запросы уходят в AI. */
export default function SearchPanel({
  query, onNavigate, onPickQuery, chips = [], recentlyViewed, withResults = true, fill = false,
}: Props) {
  const trimmed = query.trim();
  const typing = withResults && trimmed.length >= MIN_QUERY_LEN;
  const { results, searching } = useLiveSearch(withResults ? query : "");
  // Историю читаем на маунте панели и после очистки — между сессиями она в localStorage.
  const [history, setHistory] = useState<string[]>(() => loadSearchHistory());

  useEffect(() => {
    if (!typing) setHistory(loadSearchHistory());
  }, [typing]);

  function askAi() {
    track("search_ai_escalated", { query_length: trimmed.length });
    // auto=1 — одноразовая отправка: пользователь явно нажал «Спросить AI»
    // с конкретным запросом; пустой запрос — просто открываем AI-экран.
    onNavigate(trimmed ? `/ai?q=${encodeURIComponent(trimmed)}&auto=1` : "/ai");
  }

  if (typing) {
    return (
      <PanelScroll fill={fill} depsKey={`typing:${searching}:${results?.length ?? -1}`} role="listbox" aria-label="Результаты поиска">
        {searching && results === null ? (
          <p className="px-4 py-3.5 text-sm text-muted">Ищем…</p>
        ) : results && results.length > 0 ? (
          <>
            {results.map((c) => (
              <button
                key={c.id}
                role="option"
                aria-selected={false}
                onClick={() => {
                  track("search_result_clicked", { product_id: c.id });
                  onNavigate(`/product/${c.id}`);
                }}
                className="tap flex w-full items-center gap-3 border-b border-border px-3 py-2.5 text-left last:border-0"
              >
                <ProductImage src={c.image} title={c.title} category={c.category}
                  className="h-11 w-11 shrink-0 rounded-xl" compact />
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 block text-sm font-medium">{c.title}</span>
                  <span className={`text-[11px] font-medium ${c.in_stock ? "text-green" : "text-muted"}`}>
                    {c.in_stock ? "В наличии" : "Под заказ"}
                  </span>
                </span>
                <span className="shrink-0 text-sm font-bold">{formatPrice(c.price)}</span>
              </button>
            ))}
            <button
              onClick={() => {
                track("search_query_submitted", { query_length: trimmed.length, source: "all_results" });
                onNavigate(`/catalog?query=${encodeURIComponent(trimmed)}`);
              }}
              className="tap w-full bg-mutedbg px-4 py-3 text-center text-xs font-semibold text-accent"
            >
              Все результаты в каталоге →
            </button>
          </>
        ) : (
          <div className="px-4 py-4 text-center">
            <p className="text-sm font-semibold">Ничего не нашлось</p>
            <p className="mt-1 text-[13px] text-muted">
              Попробуйте изменить формулировку — например, «iPhone 15» или «MacBook Air».
            </p>
            <div className="mt-3 flex flex-col gap-2">
              <button onClick={askAi}
                className="tap flex items-center justify-center gap-1.5 rounded-field bg-accent px-4 py-2.5 text-[13px] font-semibold text-white">
                <Icon name="sparkles" className="h-4 w-4" strokeWidth={2} />
                Спросить AI «{trimmed.length > 28 ? `${trimmed.slice(0, 28)}…` : trimmed}»
              </button>
              <button onClick={() => onNavigate("/catalog")}
                className="tap rounded-field bg-mutedbg px-4 py-2.5 text-[13px] font-semibold text-text">
                Открыть каталог
              </button>
            </div>
          </div>
        )}
      </PanelScroll>
    );
  }

  // ===== Пустой запрос: полезное состояние вместо пустого дропдауна =====
  return (
    <PanelScroll fill={fill} depsKey={`empty:${history.length}:${chips.length}:${recentlyViewed?.length ?? -1}`} className="p-3">
      {/* «Спросить AI» стоит ПЕРВЫМ, а не последним.
          Внизу панели эта кнопка оказывалась недостижимой: снизу её закрывает
          то клавиатура, то нижняя навигация, и добраться прокруткой нельзя —
          закрыт не низ списка, а низ экрана. Никакой расчёт высоты этого до
          конца не гарантирует: устройства по-разному сообщают о клавиатуре, а
          часть не сообщает вовсе. Место в начале списка не зависит ни от чего.

          Это ещё и честнее по смыслу: человек открыл поиск, ничего не набрав, —
          и первое, что ему предлагают, это описать задачу словами вместо
          угадывания названия модели. История и подсказки остаются ниже, они
          нужны тому, кто уже знает, что ищет. */}
      <button
        onClick={askAi}
        className="tap flex w-full items-center gap-3 rounded-field bg-accent/10 px-3.5 py-3 text-left"
      >
        <Icon name="sparkles" className="h-5 w-5 shrink-0 text-accent" />
        <span className="min-w-0">
          <span className="block text-[13px] font-semibold text-accent">Спросить AI</span>
          <span className="block text-[12px] text-muted">Опишите задачу — подберём из реального наличия</span>
        </span>
      </button>

      {history.length > 0 && (
        <section aria-label="Недавние запросы" className="mt-3.5">
          <div className="flex items-baseline justify-between px-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Вы искали</p>
            <button
              onClick={() => { clearSearchHistory(); setHistory([]); }}
              className="text-xs font-medium text-muted transition-colors hover:text-text"
            >
              Очистить
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {history.map((h) => (
              <button
                key={h}
                onClick={() => onPickQuery(h)}
                className="tap max-w-full truncate rounded-full bg-mutedbg px-3 py-1.5 text-[13px] font-medium text-text"
              >
                {h}
              </button>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Популярные запросы" className="mt-3.5">
        <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Часто ищут</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {SCENARIO_CHIPS.map((s) => (
            <button
              key={s.label}
              onClick={() => onNavigate(s.route)}
              className="tap rounded-full border border-border bg-surface px-3 py-1.5 text-[13px] font-medium text-text"
            >
              {s.label}
            </button>
          ))}
        </div>
      </section>

      {recentlyViewed && recentlyViewed.length >= 2 && (
        <section aria-label="Недавно смотрели" className="mt-3.5">
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Недавно смотрели</p>
          <div className="no-scrollbar -mx-3 mt-2 flex gap-2 overflow-x-auto px-3">
            {recentlyViewed.slice(0, 8).map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  track("search_result_clicked", { product_id: c.id, source: "recently_viewed" });
                  onNavigate(`/product/${c.id}`);
                }}
                className="tap w-24 shrink-0 text-left"
              >
                <ProductImage src={c.image} title={c.title} category={c.category}
                  className="aspect-square w-full rounded-xl" compact />
                <span className="mt-1 line-clamp-2 block text-[11px] font-medium leading-[1.3]">{c.title}</span>
                <span className="block text-[11px] font-bold">{formatPrice(c.price)}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {chips.length > 0 && (
        <section aria-label="Категории" className="mt-3.5">
          <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">Категории</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {chips.map((c) => (
              <button
                key={c.key}
                onClick={() => onNavigate(c.route)}
                className="tap rounded-full bg-mutedbg px-3 py-1.5 text-[13px] font-medium text-text"
              >
                {c.label}
              </button>
            ))}
          </div>
        </section>
      )}

    </PanelScroll>
  );
}
