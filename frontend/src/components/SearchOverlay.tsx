/** Поиск поверх экрана — то, что открывает круг в нижней навигации.
 *
 *  Зачем не переход в каталог. Круг раньше вёл на `/catalog?focus=search`, и со
 *  стороны это читалось как «кнопка просто открывает каталог»: экран сменился,
 *  строка где-то наверху, панели подсказок нет. Поиск, доступный с каждого
 *  экрана, обязан открываться НА этом экране — иначе он не поиск, а ещё одна
 *  ссылка на каталог. Так же он устроен и в Telegram, чей раскладке следует ряд.
 *
 *  Наполнение — тот же `SearchPanel`, что живёт под hero главной. Второй
 *  реализации подсказок, истории и live-результатов здесь нет и быть не должно:
 *  панель писалась content-only ровно затем, чтобы родитель решал, КОГДА и ГДЕ
 *  её показать. Здесь третий такой родитель после главной и desktop-шапки.
 *
 *  Что добавлено сверх панели — блок разделов приложения (`lib/appSections.ts`).
 *  Человек, открывший поиск с любого экрана, набирает в нём не только «iPhone»:
 *  «заявки», «баллы», «доставка» — такие же законные запросы, на которые
 *  товарный поиск честно отвечает «ничего не нашлось».
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import SearchPanel from "./SearchPanel";
import { Icon } from "./icons";
import { track } from "../lib/analytics";
import { setBackButton } from "../lib/telegram";
import { searchAppSections } from "../lib/appSections";
import { overlayViewportBox } from "../lib/viewport";
import { loadCachedCategories } from "../lib/categoryCache";
import { navTiles } from "../lib/navTiles";
import { pushSearchQuery } from "../lib/searchHistory";
import { catalogSearchRoute } from "../lib/searchRoutes";

/** Сколько категорий показываем чипами. Тот же предел, что у hero главной:
 *  ряд должен помещаться в две строки, а не превращаться в стену. */
const CHIP_LIMIT = 6;

export default function SearchOverlay({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Категории берём из того же localStorage-кэша, который наполняет главная.
  // Своего запроса панель не делает: она открывается поверх уже загруженного
  // экрана, и лишнее обращение к сети в момент открытия — это задержка ровно
  // там, где человек ждёт мгновенной реакции на нажатие.
  const chips = useMemo(() => {
    if (!open) return [];
    // home=null: панель открыта поверх произвольного экрана и плиток главной
    // под рукой не имеет. navTiles в этом случае строит чипы из кэша категорий,
    // что здесь и нужно.
    return navTiles("category", null, loadCachedCategories()).slice(0, CHIP_LIMIT);
  }, [open]);

  const sections = useMemo(() => searchAppSections(query), [query]);

  // Коробка панели считается по ВИДИМОЙ области, а не по окну.
  //
  // На iOS клавиатура не сжимает вебвью — она накрывает его. Панель на весь
  // экран занимала бы и ту его часть, что скрыта клавишами, а строка ввода,
  // прижатая к её низу, уезжала бы под клавиатуру ровно в момент набора.
  // Решение в чистом виде — overlayViewportBox (lib/viewport.ts, под тестами);
  // здесь только подписка и запись.
  //
  // Пишем прямо в стиль узла, а не через состояние: visualViewport стреляет
  // событиями пачками во время подъёма клавиатуры, и ре-рендер панели с живым
  // поиском на каждое из них — это подтормаживание ровно в момент движения.
  const boxRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = boxRef.current;
    if (!el) return;
    const vv = window.visualViewport;
    const apply = () => {
      const box = overlayViewportBox({
        vvHeight: vv?.height ?? null,
        vvOffsetTop: vv?.offsetTop ?? null,
        windowHeight: window.innerHeight,
      });
      el.style.top = `${box.top}px`;
      el.style.height = `${box.height}px`;
    };
    apply();
    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);
    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
    };
  }, [open]);

  // Фокус ставим на следующем кадре после появления узла: на смонтированном в
  // этом же кадре элементе focus() на iOS не срабатывает — узла ещё нет в
  // раскладке. Клавиатура при этом может и не подняться: фокус программный, вне
  // пользовательского жеста. Строка в любом случае готова к вводу.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Escape и кнопка «назад» Telegram закрывают панель, а не уводят с экрана
  // под ней: закрыть поиск человек ожидает раньше, чем уйти со страницы,
  // поверх которой он его открыл.
  //
  // setBackButton перевешивается на время жизни панели и возвращается назад
  // при закрытии: Layout вешает на неё goBack для нелистовых маршрутов, и без
  // перехвата «назад» увёл бы нижний экран, оставив панель висеть — со стороны
  // она выглядела бы зависшей.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    const restoreBack = setBackButton(onClose);
    return () => {
      window.removeEventListener("keydown", onKey);
      restoreBack();
    };
  }, [open, onClose]);

  // Открытие панели — отдельное событие. Без него нечем измерить, стали ли
  // поиском пользоваться после того, как круг перестал уводить в каталог.
  useEffect(() => { if (open) track("search_focused", { source: "overlay" }); }, [open]);

  // Запрос сбрасываем на закрытии, а не на открытии: иначе он мигает старым
  // текстом в первом кадре появления.
  useEffect(() => { if (!open) setQuery(""); }, [open]);

  if (!open) return null;

  function go(route: string) {
    onClose();
    navigate(route);
  }

  function submit() {
    const trimmed = query.trim();
    if (trimmed) pushSearchQuery(trimmed);
    track("search_query_submitted", { query_length: trimmed.length, source: "overlay" });
    go(catalogSearchRoute(trimmed));
  }

  return (
    <div
      ref={boxRef}
      className="fixed inset-x-0 top-0 z-50 flex flex-col bg-bg lg:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Поиск"
      // Фолбэк на env() обязателен: --app-content-top-offset ставится ТОЛЬКО
      // внутри Telegram, а панель позиционируется сама и из общего padding у
      // #root выпадает. Без фолбэка верх списка уезжает под чёлку в браузере.
      style={{ paddingTop: "var(--app-content-top-offset, env(safe-area-inset-top, 0px))" }}
    >
      {/* Прокрутка здесь ОДНА — внутренняя у SearchPanel отключена (prop fill).
          Вложенные области дали бы список внутри списка: панель считает себе
          высоту по формуле для выпадающего меню, а из полноэкранного оверлея
          её опоры (`<main>`, резерв под навигацию) не видно вовсе.
          overscroll-contain — чтобы протяжка за край не уводила страницу ПОД
          панелью: фон непрозрачен, и человек не увидел бы, что уехал.
          safe-area отсюда УБРАНА: у нижней кромки теперь стоит бар со строкой
          ввода, а не конец списка, и отступ принадлежит ему. Держать его в
          обоих местах значило бы посчитать вырез дважды. */}
      {/* Содержимое прижато к НИЗУ (mt-auto ниже), а не к верху. Строка ввода
          стоит у нижней кромки, и выдача, выровненная по верху, оставляла над
          ней экран пустоты — результаты оказывались дальше от пальца, чем до
          переноса строки. Прижатые, они растут вверх от строки, как в поиске
          Telegram.
          Именно mt-auto, а не justify-end: в прокручиваемом контейнере
          justify-content обрезает ВЕРХ содержимого при переполнении, и до
          первых результатов становится не добраться прокруткой вовсе. */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain pb-2">
        <div className="mt-auto">
        {/* Разделы идут ВЫШЕ товаров и намеренно.
            Их мало и они точные: человек, набравший «заявки», ищет именно
            раздел, и прятать его под ленту карточек значит отвечать не на тот
            вопрос. Товарная выдача при этом никуда не девается — она сразу под
            этим блоком. */}
        {sections.length > 0 && (
          <div className="px-4 pt-1">
            <p className="px-1 pb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">Разделы</p>
            <div className="overflow-hidden rounded-xl2 bg-surface shadow-soft">
              {sections.map((s, i) => (
                <button
                  key={s.key}
                  onClick={() => {
                    track("search_section_opened", { section: s.key });
                    go(s.route);
                  }}
                  className={`tap flex w-full items-center gap-3 px-4 py-3 text-left ${
                    i === sections.length - 1 ? "" : "border-b border-border"
                  }`}
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
                    <Icon name={s.icon} className="h-[18px] w-[18px]" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold">{s.label}</span>
                    <span className="mt-0.5 block truncate text-xs text-muted">{s.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Заголовок «Товары» появляется ТОЛЬКО когда выше показаны разделы.
            Без него получалось противоречие: раздел найден, а сразу под ним
            «Ничего не нашлось» — про товары, но читается как про весь запрос.
            Два заголовка превращают это в две группы, где вторая пуста.
            Постоянным его делать нельзя: при пустом запросе панель показывает
            историю и категории, и называть это «Товарами» было бы неправдой. */}
        {sections.length > 0 && (
          <p className="px-5 pb-1.5 pt-4 text-xs font-semibold uppercase tracking-wide text-muted">Товары</p>
        )}

        <SearchPanel
          query={query}
          chips={chips}
          fill
          onNavigate={go}
          onPickQuery={(q) => {
            setQuery(q);
            inputRef.current?.focus();
          }}
        />
        </div>
      </div>
      {/* Строка ввода — ВНИЗУ, вплотную над клавиатурой, как в поиске самого
          Telegram. Наверху она требовала тянуться через весь экран пальцем,
          который в этот момент уже лежит на клавишах. Высоту коробки под
          клавиатуру считает эффект выше; здесь бар просто последний в колонке.
          border-t — граница появляется только когда над баром что-то есть. */}
      <div
        className="flex shrink-0 items-center gap-2 border-t border-border px-4 pt-2"
        style={{ paddingBottom: "calc(0.5rem + var(--app-safe-bottom, env(safe-area-inset-bottom, 0px)))" }}
      >
        <div className="relative flex-1">
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
            <Icon name="search" className="h-5 w-5" />
          </span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
            placeholder="Товары и разделы"
            aria-label="Поиск по товарам и разделам"
            enterKeyHint="search"
            className="w-full rounded-full border border-border bg-surface py-3 pl-11 pr-4 text-base outline-none focus:border-accent"
          />
        </div>
        <button onClick={onClose} className="tap shrink-0 px-1 text-sm font-semibold text-accent">
          Отмена
        </button>
      </div>

    </div>
  );
}
