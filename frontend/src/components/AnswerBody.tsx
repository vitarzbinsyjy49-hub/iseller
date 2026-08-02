/** Тело ответа AI: абзацы, списки и выделения вместо сплошной строки.
 *
 *  Совмещено с посимвольным набором. Ненабранный хвост остаётся в разметке
 *  прозрачным — он держит финальный размер пузыря. Без этого текст
 *  перевёрстывался на каждом кадре, пузырь рос скачками, а карточки под ним
 *  дёргались; скринридеру при этом сразу доступен весь ответ.
 *
 *  Смещения считаются РОВНО так же, как их склеивает `plainText`: блоки и
 *  пункты списка разделены `\n`. Иначе счётчик набора разъехался бы с
 *  разметкой, и хвост обрывался бы не там.
 */
import { useMemo } from "react";
import { parseAnswer, type Span } from "../lib/answerFormat";

type Props = {
  text: string;
  /** Сколько символов показано; null — показать всё (набор окончен). */
  revealChars: number | null;
};

/** Курсор по plainText: одно изменяемое число на весь рендер ответа. */
type Cursor = { at: number };

function SpanText({ span, cursor, revealChars }: {
  span: Span; cursor: Cursor; revealChars: number | null;
}) {
  const start = cursor.at;
  cursor.at += span.text.length;

  const shownLen = revealChars === null
    ? span.text.length
    : Math.max(0, Math.min(span.text.length, revealChars - start));
  const visible = span.text.slice(0, shownLen);
  const hidden = span.text.slice(shownLen);

  const content = (
    <>
      {visible}
      {hidden && <span className="opacity-0">{hidden}</span>}
    </>
  );
  return span.bold ? <strong className="font-semibold">{content}</strong> : content;
}

export default function AnswerBody({ text, revealChars }: Props) {
  const blocks = useMemo(() => parseAnswer(text), [text]);
  // Пересоздаётся на каждый рендер намеренно: курсор — состояние ОДНОГО прохода
  // по блокам, а не памяти между кадрами.
  const cursor: Cursor = { at: 0 };

  if (!blocks.length) return null;

  return (
    <div className="space-y-2.5">
      {blocks.map((block, bi) => {
        if (bi > 0) cursor.at += 1; // «\n» между блоками в plainText
        if (block.kind === "para") {
          return (
            <p key={bi} className="leading-relaxed">
              {block.spans.map((span, si) => (
                <SpanText key={si} span={span} cursor={cursor} revealChars={revealChars} />
              ))}
            </p>
          );
        }
        return (
          <ul key={bi} className="space-y-1.5">
            {block.items.map((spans, ii) => {
              if (ii > 0) cursor.at += 1; // «\n» между пунктами
              return (
                <li key={ii} className="flex gap-2 leading-relaxed">
                  {/* Маркер — не текст ответа: в счётчик набора он не входит и
                      появляется сразу, иначе пункты «выползали» бы с задержкой. */}
                  <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-muted" />
                  <span className="min-w-0 flex-1">
                    {spans.map((span, si) => (
                      <SpanText key={si} span={span} cursor={cursor} revealChars={revealChars} />
                    ))}
                  </span>
                </li>
              );
            })}
          </ul>
        );
      })}
    </div>
  );
}
