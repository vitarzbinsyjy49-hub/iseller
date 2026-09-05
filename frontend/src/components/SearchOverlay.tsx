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
import { searchAppSections } from "../lib/appSections";
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

  // Фокус ставим на следующем кадре после появления узла: на смонтированном в
  // этом же кадре элементе focus() на iOS не срабатывает — узла ещё нет в
  // раскладке. Клавиатура при этом может и не подняться: фокус программный, вне
  // пользовательского жеста. Строка в любом случае готова к вводу.
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  // Открытая панель забирает Escape и системную кнопку «назад»: закрыть поиск
  // человек ожидает раньше, чем уйти с экрана, поверх которого он открыт.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

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
      className="fixed inset-0 z-50 flex flex-col bg-bg lg:hidden"
      role="dialog"
      aria-modal="true"
      aria-label="Поиск"
      style={{ paddingTop: "var(--app-content-top-offset, 0px)" }}
    >
      <div className="flex items-center gap-2 px-4 pb-2 pt-3">
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

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
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
          onNavigate={go}
          onPickQuery={(q) => {
            setQuery(q);
            inputRef.current?.focus();
          }}
        />
      </div>
    </div>
  );
}
