/** «Спросить про этот товар» — короткий вопрос к AI прямо на странице товара.
 *
 *  Блок вторичный по отношению к покупке: без заливки акцентом, без тени
 *  «всплывшего» элемента, пока ответа нет — три чипа и строка ввода. Главное
 *  действие страницы остаётся одно — корзина.
 *
 *  Ответ рисуется ТЕМИ ЖЕ деталями, что в чате: реплика покупателя (Turn),
 *  след работы (WorkTrace), текст (AnswerBody + answer-voice), таблица различий
 *  (CompareTable). Отличие одно — карточки идут рядом прокрутки, а не сеткой:
 *  на странице товара сетка из шести плиток была бы второй витриной.
 *
 *  Движение — только мотором из lib/motion (через useEnter и useAnswerReveal):
 *  Telegram WebView гасит декларативную CSS-анимацию целиком, и всё, что
 *  держалось бы на ней, на телефоне просто не появилось бы. Скелетон при
 *  загрузке пульсирует CSS-ом и в WebView замирает — поэтому рядом тикает
 *  счётчик секунд WorkTrace: он на таймере и живой везде.
 *
 *  Логика (тело запроса, переходы, разбор отказа) — в lib/askInCard, с тестами.
 */
import { useEffect, useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { haptic } from "../lib/telegram";
import { normalizeAnswer } from "../lib/aiAnswer";
import { useAnswerReveal } from "../lib/useAnswerReveal";
import { enterRefCallback } from "../lib/useEnter";
import {
  ASK_FAILURE_TEXT,
  ASK_INITIAL,
  ASK_MAX_LEN,
  ASK_PRESETS,
  aiChatHref,
  askCardsRow,
  askFailureOf,
  askReducer,
  buildAskBody,
  type AskKind,
} from "../lib/askInCard";
import type { AiAnswer } from "./ai/types";
import Turn from "./ai/Turn";
import WorkTrace from "./ai/WorkTrace";
import CompareTable from "./ai/CompareTable";
import AnswerBody from "./AnswerBody";
import ProductCard from "./ProductCard";
import { Icon } from "./icons";

/** Тот же потолок, что у чата (AiSearch): больше backend-таймаута (65с),
 *  который покрывает очередь gateway + inference + сеть. Меньше — и мы бы
 *  бросали ответ, который вот-вот придёт. */
const ASK_TIMEOUT_MS = 75000;

/** Реплике покупателя в Turn обработчик действий не нужен — действия бывают
 *  только у ответа. Константа, а не стрелка в JSX: новая функция на каждый
 *  рендер ничего не сломала бы, но и смысла в ней нет. */
const noAction = () => undefined;

export default function ProductAskAi({ productId }: { productId: number }) {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(askReducer, ASK_INITIAL);
  const [value, setValue] = useState("");
  const { revealChars, startReveal } = useAnswerReveal();
  const inputRef = useRef<HTMLInputElement>(null);
  // Номер последнего вопроса и его запрос. В ref, а не в состоянии: проверка
  // «это ответ на актуальный вопрос?» идёт внутри async-функции, где state из
  // замыкания уже устарел.
  const seqRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // Ушли со страницы (или на соседний вариант — блок пересоздаётся по key) —
  // ответ больше некому показывать, а модель жжёт токены зря.
  useEffect(() => () => abortRef.current?.abort(), []);

  const loading = state.status === "loading";

  async function ask(question: string, kind: AskKind) {
    const body = buildAskBody(productId, question);
    if (!body) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const seq = ++seqRef.current;
    // Замер от нажатия, а не от ответа сервера: в след работы должно попасть
    // всё ожидание, которое пережил человек (как в чате).
    const begin = performance.now();
    dispatch({ type: "ask", seq, question: body.message, kind, startedAt: begin });
    track("ai_in_card_ask", { product_id: productId, kind });
    haptic("light");
    const timer = setTimeout(() => controller.abort(), ASK_TIMEOUT_MS);
    try {
      const raw = await api<Partial<AiAnswer>>("/ai/chat", {
        method: "POST",
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (seq !== seqRef.current) return;
      const answer = normalizeAnswer(raw);
      // Оба обновления в одном батче: первый кадр ответа уже с нулём
      // набранных символов, без мелькания готового текста.
      dispatch({ type: "answer", seq, answer, elapsedMs: performance.now() - begin });
      startReveal(answer.text);
    } catch (e) {
      // Прерван более новым вопросом — его место уже занято, молчим.
      if (seq !== seqRef.current) return;
      // Без тихого отката в поиск по каталогу, как в чате: там пустой экран
      // хуже любого ответа, а здесь под блоком весь товар, и честное «не
      // получилось» с повтором полезнее подборки, которую никто не просил.
      dispatch({ type: "fail", seq, failure: askFailureOf(e) });
    } finally {
      clearTimeout(timer);
    }
  }

  function submitCustom() {
    if (loading || !value.trim()) return;
    void ask(value, "custom");
    setValue("");
    // Клавиатура на телефоне закрывает половину экрана — ответ встал бы под
    // ней, и человек решил бы, что ничего не произошло.
    inputRef.current?.blur();
  }

  const isRevealing = revealChars !== null && state.status === "done";

  return (
    <section aria-labelledby="ask-ai-title" className="mt-4 rounded-xl2 bg-surface p-3.5 shadow-soft lg:mt-5">
      <h2 id="ask-ai-title" className="flex items-center gap-1.5 text-[14px] font-bold leading-5">
        <Icon name="sparkles" className="h-4 w-4 shrink-0 text-accent" />
        Спросить про этот товар
      </h2>

      {/* Чипы — реплики ПОКУПАТЕЛЯ, поэтому обведены акцентом, как быстрые
          ответы в чате (Turn): это его сторона разговора, а не действие
          магазина. Заливки нет — заливка на этой странице у корзины. */}
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {ASK_PRESETS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => void ask(q, "preset")}
            disabled={loading}
            className="tap rounded-full border border-accent bg-transparent px-3 py-1.5 text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>

      <form
        className="mt-2.5 flex gap-2"
        onSubmit={(e) => { e.preventDefault(); submitCustom(); }}
      >
        <input
          ref={inputRef}
          value={value}
          maxLength={ASK_MAX_LEN}
          onChange={(e) => setValue(e.target.value)}
          enterKeyHint="send"
          placeholder="Свой вопрос о товаре…"
          aria-label="Свой вопрос о товаре"
          className="min-w-0 flex-1 rounded-xl2 border border-border bg-mutedbg px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-muted focus:border-accent focus:bg-surface"
        />
        <button
          type="submit"
          disabled={loading || !value.trim()}
          aria-label="Спросить"
          className="tap flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl2 bg-accent text-white disabled:opacity-40"
        >
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" />
          </svg>
        </button>
      </form>

      {/* Без вопроса блока ниже нет вовсе — ни рамки, ни пустого места: пока
          человек не спросил, блок не толкает остальной контент.
          key по номеру вопроса: каждый новый вопрос проявляется заново, а не
          подменяет текст прежнего в том же узле. */}
      {state.status !== "idle" && (
        <div key={state.seq} ref={enterRefCallback("fade")} className="mt-3 border-t border-border pt-3">
          <Turn
            item={{ role: "user", text: state.question }}
            index={0} isLast={false} revealChars={null} loading={false} onAction={noAction}
          />

          {state.status === "loading" && (
            <div className="mt-3">
              <WorkTrace state="running" startedAt={state.startedAt} />
              <div className="mt-2.5 space-y-2" aria-hidden>
                <div className="skeleton h-3.5 w-11/12 rounded" />
                <div className="skeleton h-3.5 w-4/5 rounded" />
                <div className="skeleton h-3.5 w-3/5 rounded" />
              </div>
            </div>
          )}

          {state.status === "error" && (
            <div ref={enterRefCallback("fade")} role="alert" className="mt-3">
              <p className="text-[13px] leading-5 text-muted">{ASK_FAILURE_TEXT[state.failure]}</p>
              <button
                type="button"
                onClick={() => void ask(state.question, state.kind)}
                className="tap mt-2 rounded-full border border-border bg-surface px-3.5 py-1.5 text-xs font-medium text-text transition-colors hover:bg-mutedbg"
              >
                Попробовать ещё раз
              </button>
            </div>
          )}

          {state.status === "done" && (
            <AskAnswer
              answer={state.answer}
              elapsedMs={state.elapsedMs}
              productId={productId}
              revealChars={isRevealing ? revealChars : null}
              onContinue={() => navigate(aiChatHref(productId))}
            />
          )}
        </div>
      )}
    </section>
  );
}

function AskAnswer({ answer, elapsedMs, productId, revealChars, onContinue }: {
  answer: AiAnswer;
  elapsedMs: number;
  productId: number;
  /** Сколько символов показано; null — набор окончен. */
  revealChars: number | null;
  onContinue: () => void;
}) {
  const revealing = revealChars !== null;
  const row = askCardsRow(answer.cards, productId);

  return (
    <div ref={enterRefCallback("fade")} className="mt-3">
      <WorkTrace state="done" meta={answer.meta} elapsedMs={elapsedMs} />
      <div className="answer-voice">
        <AnswerBody text={answer.text} revealChars={revealChars} />
      </div>

      {/* Как в чате: таблица и карточки прикладываются ПОСЛЕ набора — сначала
          читаешь ответ, потом смотришь варианты. В таблицу открытый товар
          входит (сравнение с ним и есть ответ), в ряд карточек — нет. */}
      {!revealing && <CompareTable cards={answer.cards} />}

      {!revealing && row.length > 0 && (
        // -mx-3.5/px-3.5 — ряд прокручивается до краёв блока, как «Похожие
        // варианты» до краёв экрана. pt-0.5 — место под рамку плитки.
        <div className="no-scrollbar -mx-3.5 mt-3 flex gap-3 overflow-x-auto px-3.5 pb-1 pt-0.5 lg:mx-0 lg:grid lg:grid-cols-3 lg:overflow-visible lg:px-0">
          {row.map((c) => (
            <ProductCard
              key={c.id} card={c} compact
              onOpen={(card) => track("ai_product_card_clicked", { product_id: card.id, source: "in_card" })}
            />
          ))}
        </div>
      )}

      {/* История этого ответа в чат не переносится (YAGNI, см. спеку): чат
          откроется с тем же товаром, и вопрос можно продолжить оттуда. */}
      {!revealing && (
        <button
          type="button"
          onClick={onContinue}
          className="tap mt-3 inline-flex items-center gap-1 text-[13px] font-semibold text-accent"
        >
          Продолжить в чате
          <span aria-hidden>→</span>
        </button>
      )}
    </div>
  );
}
