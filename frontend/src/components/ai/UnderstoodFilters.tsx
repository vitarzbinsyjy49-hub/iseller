/** «Вот как я понял вашу фразу» — и переход в каталог с этими фильтрами.
 *
 *  Backend всё это время разбирал запрос на бюджет, бренд, категорию и
 *  состояние, отдавал разбор в `meta.state` — и разбор умирал вместе с ответом.
 *  Здесь он становится видимым и действующим: человек видит, что именно понято,
 *  и одним тапом открывает каталог с теми же фильтрами, где их можно снимать и
 *  сужать дальше. Рисовать воронку фильтров руками не нужно — её называет сам
 *  человек, а модель переводит.
 *
 *  Чипы здесь НЕ снимаются намеренно: снятие ничего бы не переспросило у
 *  модели, а сужение и так живёт в каталоге. Две разные воронки в двух местах
 *  разъехались бы, как уже разъезжались списки категорий в этом проекте.
 */
import { useNavigate } from "react-router-dom";
import { track } from "../../lib/analytics";
import { catalogHref, filterChips, type AiFilterState } from "../../lib/aiFilters";

export default function UnderstoodFilters({ state }: { state: AiFilterState | undefined }) {
  const navigate = useNavigate();
  const chips = filterChips(state);
  // Ничего не поняли — ничего и не показываем. Пустая плашка «понято:» хуже,
  // чем её отсутствие.
  if (chips.length === 0) return null;

  const href = catalogHref(state);

  return (
    <div className="mt-3 rounded-xl2 border border-border bg-surface px-3 py-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Понял так</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => (
          <span
            key={chip.key}
            className="rounded-full bg-mutedbg px-2.5 py-1 text-xs font-medium text-text"
          >
            {chip.label}
          </span>
        ))}
      </div>
      <button
        onClick={() => {
          track("ai_filters_to_catalog", { filters: chips.length });
          navigate(href);
        }}
        className="tap mt-2.5 inline-flex items-center gap-1 text-xs font-semibold text-accent"
      >
        Показать всё в каталоге
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor"
          strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
    </div>
  );
}
