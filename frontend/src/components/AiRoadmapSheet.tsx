/** Роудмап AI-подбора (патч 1.2).
 *
 *  Открывается по бейджу «Powered by Claude» на экране AI. Показывает, куда
 *  движется помощник магазина, — и заодно честно объясняет, чего он НЕ делает.
 *
 *  Все пункты — планы МАГАЗИНА, а не Anthropic. Сроков здесь намеренно нет:
 *  дата в роудмапе — это обещание, а обещание, которое некому обеспечить,
 *  хуже его отсутствия. Порядок отражает приоритет, не календарь.
 */
import { SheetShell } from "./ScenarioSheet";
import { ClaudeMark, CLAUDE_ORANGE } from "./ClaudeMark";

type Step = {
  title: string;
  body: string;
  /** Ближайший шаг — ровно один. Два «следующих» шага не бывает. */
  next?: boolean;
};

const STEPS: Step[] = [
  {
    title: "Посты для канала — черновиком",
    body:
      "Claude собирает свежее и полезное для владельцев техники, пишет короткий пост " +
      "и предлагает подходящую кнопку. Менеджер читает, правит, добавляет фото и " +
      "решает, публиковать ли. Ничего не уходит в канал само.",
    next: true,
  },
  {
    title: "Вопрос прямо в карточке товара",
    body:
      "«Поместится в ручную кладь?», «Хватит ли памяти под фото за пять лет?» — " +
      "ответ рядом с товаром, без перехода на отдельный экран и без потери контекста.",
  },
  {
    title: "Понимает фото",
    body:
      "Снимок вашего устройства для оценки Trade-In или скриншот с чужого сайта, " +
      "чтобы найти то же самое у нас.",
  },
  {
    title: "Сравнение вариантов таблицей",
    body:
      "Две-три модели рядом по тем характеристикам, которые важны именно в вашей " +
      "задаче. Строго из карточек каталога: недостающее поле останется пустым, а не " +
      "будет придумано.",
  },
  {
    title: "Подсказка менеджеру, а не вместо него",
    body:
      "К заявке готовится черновик ответа и короткая выжимка по товарам. " +
      "Отправляет человек — он же решает, что изменить.",
  },
  {
    title: "Осмысленные поводы вернуться",
    body:
      "Сейчас магазин пишет о снижении цены и поступлении. Дальше — почему это " +
      "важно именно вам: вышла новая версия, подешевел аксессуар к вашей покупке.",
  },
  {
    title: "Длинный разговор и голос",
    body:
      "Надиктовать задачу вслух и продолжить подбор через неделю с того места, " +
      "где остановились.",
  },
];

export default function AiRoadmapSheet({ model, onClose }: {
  model?: string;
  onClose: () => void;
}) {
  return (
    <SheetShell onClose={onClose} labelledBy="ai-roadmap-title">
      {(close) => (
        <>
          <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />

          <div className="flex items-start gap-3 px-5 pb-3 pt-4">
            <span
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-field"
              style={{ backgroundColor: `${CLAUDE_ORANGE}1a` }}
            >
              <ClaudeMark className="h-6 w-6" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="ai-roadmap-title" className="text-[17px] font-bold leading-6">
                AI-подбор работает на Claude
              </h2>
              <p className="mt-0.5 text-[12px] leading-4 text-muted">
                {model ? `Модель ${model} от Anthropic` : "Модель от Anthropic"}
              </p>
            </div>
            <button
              onClick={() => close()}
              aria-label="Закрыть"
              className="tap -mr-1 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mutedbg"
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor"
                strokeWidth="2.2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>

          {/* Как это устроено — до планов. Обещать будущее, не объяснив настоящее,
              значит просить доверия авансом. */}
          <div className="mx-5 rounded-field bg-mutedbg px-3.5 py-3">
            <p className="text-[12px] font-semibold">Как это устроено</p>
            <p className="mt-1 text-[12px] leading-[1.45] text-muted">
              Товары и цены модель не придумывает: она выбирает из того, что backend
              нашёл в каталоге. Наличие и цену вы видите те же, что в карточке.
            </p>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">
              Что будет дальше
            </p>

            <ol className="mt-3 space-y-3">
              {STEPS.map((step, i) => (
                <li key={step.title} className="flex gap-3">
                  <span
                    className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-bold"
                    style={
                      step.next
                        ? { backgroundColor: CLAUDE_ORANGE, color: "#fff" }
                        : { backgroundColor: `${CLAUDE_ORANGE}1a`, color: CLAUDE_ORANGE }
                    }
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-x-2 text-[14px] font-semibold leading-5">
                      {step.title}
                      {step.next && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                          style={{ backgroundColor: `${CLAUDE_ORANGE}1a`, color: CLAUDE_ORANGE }}
                        >
                          следующий
                        </span>
                      )}
                    </p>
                    <p className="mt-1 text-[12.5px] leading-[1.45] text-muted">{step.body}</p>
                  </div>
                </li>
              ))}
            </ol>

            <p className="mt-5 text-[11px] leading-4 text-muted">
              Планы магазина, а не Anthropic. Порядок отражает приоритет — сроков мы
              намеренно не называем.
            </p>
          </div>
        </>
      )}
    </SheetShell>
  );
}
