/** Один ход диалога с AI: реплика покупателя ЛИБО ответ системы.
 *
 *  Пузырей здесь нет намеренно. Реплика человека остаётся справа, но спокойной
 *  рамкой, а не заливкой акцентом: это его слова, у них есть границы. Ответ
 *  ложится текстом прямо на страницу — это не реплика собеседника, а результат
 *  работы с карточками и ценами, и читаться он должен как текст, а не как
 *  сообщение в переписке.
 *
 *  Компонент получает готовый ход и НИЧЕГО не знает про запросы к backend —
 *  это остаётся в AiSearch.
 */
import ProductCard from "../ProductCard";
import AnswerBody from "../AnswerBody";
import WorkTrace from "./WorkTrace";
import CompareTable from "./CompareTable";
import { track } from "../../lib/analytics";
import { enterGridRefCallback, enterRefCallback } from "../../lib/useEnter";
import type { AiAction, AiAnswer, ChatItem } from "./types";

type Props = {
  item: ChatItem;
  /** Позиция в ленте: первый ход не отбивается линией сверху. */
  index: number;
  /** Последний ход в ленте: только у него набирается текст и живут кнопки. */
  isLast: boolean;
  /** Сколько символов ответа показано; null — показан весь. */
  revealChars: number | null;
  loading: boolean;
  onAction: (action: AiAction, answer: AiAnswer) => void;
};

export default function Turn({ item, index, isLast, revealChars, loading, onAction }: Props) {
  if (item.role === "user") {
    return (
      <div
        ref={enterGridRefCallback("fadeUp")}
        // Линия отбивает НАЧАЛО нового обмена, поэтому висит на реплике
        // покупателя, а не на ответе, и никогда — на самой первой.
        className={`flex justify-end${index > 0 ? " border-t border-border pt-5" : ""}`}
      >
        {/* Рамка, а не заливка акцентом, и БЕЗ тени: тень сделала бы реплику
            карточкой — объектом витрины. Здесь это слова человека. */}
        <div className="max-w-[80%] rounded-xl2 border border-border bg-surface px-3.5 py-2.5 text-sm lg:max-w-[560px]">
          {item.text}
        </div>
      </div>
    );
  }

  // Набирается только последний ответ: старые в истории диалога всегда показаны
  // целиком, иначе прокрутка назад запускала бы анимацию заново.
  const isRevealing = revealChars !== null && isLast;
  const cards = item.answer.cards ?? [];
  const actions = item.answer.actions ?? [];

  return (
    <div ref={enterGridRefCallback("fadeUp")}>
      {/* След работы стоит НАД ответом: сначала видно, что делалось, потом
          читается результат. */}
      <WorkTrace state="done" meta={item.answer.meta} elapsedMs={item.elapsed_ms} />

      {/* Ни фона, ни тени, ни скруглений — текст лежит на самой странице.
          answer-voice: засечный шрифт и щедрый интерлиньяж (index.css). Пузырь
          больше не отделяет ответ от интерфейса — это делает шрифт.
          max-w на desktop: строка во всю ширину монитора нечитаема. */}
      <div className="answer-voice lg:max-w-[760px]">
        <AnswerBody text={item.answer.text ?? ""} revealChars={isRevealing ? revealChars : null} />
      </div>

      {/* Чем товары отличаются — из карточек, а не из текста модели. Стоит между
          ответом и самими карточками: сначала «почему», потом «чем именно», и
          только потом сами товары. */}
      {!isRevealing && <CompareTable cards={cards} />}

      {/* Карточки и кнопки прикладываются ПОСЛЕ набора текста: сначала читаешь
          ответ, потом появляются варианты. */}
      {!isRevealing && cards.length > 0 && (
        <div className="stagger mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:gap-4 wide:grid-cols-4">
          {cards.slice(0, 6).map((c) => (
            <ProductCard
              key={c.id} card={c}
              onOpen={(card) => track("ai_product_card_clicked", { product_id: card.id })}
            />
          ))}
        </div>
      )}

      {/* Кнопки-действия: только у последнего ответа, чтобы старые не путали */}
      {!isRevealing && isLast && actions.length > 0 && (
        <div ref={enterRefCallback("fade")} className="mt-3 flex flex-wrap gap-2">
          {/* Быстрые ответы — реплики ПОКУПАТЕЛЯ, поэтому обведены акцентом:
              визуально это продолжение его стороны диалога, а не системное
              действие вроде «Позвать менеджера». */}
          {actions.map((a) => (
            <button
              key={`${a.type}-${a.label}`}
              onClick={() => onAction(a, item.answer)}
              disabled={loading}
              className={
                a.type === "quick_reply"
                  ? "tap rounded-full border border-accent bg-transparent px-3.5 py-2 text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
                  : "tap rounded-full bg-surface px-3.5 py-2 text-xs font-medium text-text shadow-soft transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
              }
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
