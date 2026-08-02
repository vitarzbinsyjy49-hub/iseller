/** Разбор ответа AI в блоки для аккуратного показа.
 *
 *  Модель отвечает мини-разметкой (промпт разрешает ровно три вещи: пустая
 *  строка между абзацами, `- ` для пунктов, `**жирный**`). Раньше ответ
 *  выводился одной строкой в `<div>`: переносы схлопывались браузером, и
 *  сравнение трёх моделей читалось как сплошная простыня.
 *
 *  Полноценный markdown сюда не тянем: библиотека умеет HTML, ссылки и
 *  картинки, а текст приходит из модели — то есть это недоверенный ввод,
 *  который пришлось бы санитизировать. Здесь разметки ровно столько, сколько
 *  разрешено промптом, и ничего исполняемого возникнуть не может.
 *
 *  Чистые функции, тесты в node — как cartMath, searchRoutes и specChips.
 */

export type Span = { text: string; bold: boolean };
export type AnswerBlock =
  | { kind: "para"; spans: Span[] }
  | { kind: "list"; items: Span[][] };

const BOLD_RE = /\*\*(.+?)\*\*/g;

/** Строка -> отрезки текста с пометкой «жирный». Непарные `**` остаются текстом. */
export function parseSpans(line: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const m of line.matchAll(BOLD_RE)) {
    const at = m.index ?? 0;
    if (at > last) spans.push({ text: line.slice(last, at), bold: false });
    spans.push({ text: m[1], bold: true });
    last = at + m[0].length;
  }
  if (last < line.length) spans.push({ text: line.slice(last), bold: false });
  return spans.filter((s) => s.text.length > 0);
}

/** Ответ модели -> список блоков. Пустой/пробельный текст даёт пустой список. */
export function parseAnswer(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let paragraph: string[] = [];
  let items: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    // КАЖДАЯ строка — свой абзац, соседние НЕ склеиваются. Модель разделяет
    // мысли одиночным переносом («A против B…\nA против C…»), и склейка по
    // правилам markdown возвращала ровно ту простыню, ради которой всё
    // затевалось. Мягкого переноса длинных строк модель не делает — она пишет
    // JSON, так что терять здесь нечего.
    for (const line of paragraph) {
      const spans = parseSpans(line);
      if (spans.length) blocks.push({ kind: "para", spans });
    }
    paragraph = [];
  };
  const flushList = () => {
    if (!items.length) return;
    blocks.push({ kind: "list", items: items.map(parseSpans) });
    items = [];
  };

  for (const raw of (text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) {
      // Пустая строка закрывает и абзац, и список: это граница блока.
      flushParagraph();
      flushList();
      continue;
    }
    // Пункт списка: «- », «— », «• ». Модель просят про «- », но человеческие
    // тире встречаются, и терять из-за них список глупо.
    const bullet = /^[-—•]\s+(.*)$/.exec(line);
    if (bullet) {
      flushParagraph();
      items.push(bullet[1]);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushParagraph();
  flushList();
  return blocks;
}

/** Текст без разметки — им меряется анимация набора и его читает скринридер. */
export function plainText(blocks: AnswerBlock[]): string {
  return blocks
    .map((b) =>
      b.kind === "para"
        ? b.spans.map((s) => s.text).join("")
        : b.items.map((it) => it.map((s) => s.text).join("")).join("\n"),
    )
    .join("\n");
}
