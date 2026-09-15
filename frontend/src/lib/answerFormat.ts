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
/** Пункт списка, приклеенный к концу предыдущей фразы -> отдельные строки.
 *
 *  Промпт просит начинать пункт с новой строки, но модель регулярно приписывает
 *  ПЕРВЫЙ пункт к последнему предложению абзаца: «…работаете с файлами. - 256
 *  ГБ — повседневное…». Следующие пункты при этом идут строками как надо, и на
 *  экране получался список, у которого первый пункт растворился в тексте.
 *
 *  Правило намеренно узкое, чтобы не рвать нормальную речь:
 *  - маркер только «-» и «•». ДЛИННОЕ ТИРЕ сюда не входит: «Берите 512 ГБ. —
 *    так надёжнее» это обычная русская пунктуация, а не список;
 *  - перед маркером обязателен конец предложения (`.`, `:`, `!`, `?`), поэтому
 *    дефис внутри фразы («iPhone 17 - отличный выбор») абзац не рвёт.
 *
 *  Хвост прогоняется снова: модель умеет склеить и несколько пунктов подряд.
 */
function splitInlineBullets(line: string): string[] {
  const m = /^(.*?[.:!?])\s+([-•]\s+.+)$/.exec(line);
  if (!m) return [line];
  return [m[1], ...splitInlineBullets(m[2])];
}

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

  // Пункт, приклеенный моделью к концу фразы, разворачивается в свою строку
  // ДО разбора — дальше он идёт обычным путём и ничего про склейку не знает.
  const lines = (text ?? "").split("\n").flatMap((raw) => splitInlineBullets(raw.trim()));
  for (const raw of lines) {
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

/** Максимум символов в первой фразе, которую стоит поднять до вывода. Длиннее —
 *  это уже обычный абзац, и крупный кегль делает из него стену. */
const LEAD_MAX_CHARS = 140;

/** Годится ли первый блок на роль ВЫВОДА — короткой фразы крупнее остального.
 *
 *  Три условия разом: это абзац (не список), он короткий, и за ним есть ещё
 *  текст. Единственный абзац поднимать нельзя: тогда крупным станет весь ответ,
 *  и выделение перестанет что-либо значить.
 */
export function hasLead(blocks: AnswerBlock[]): boolean {
  if (blocks.length < 2) return false;
  const first = blocks[0];
  if (first.kind !== "para") return false;
  const length = first.spans.reduce((n, s) => n + s.text.length, 0);
  return length > 0 && length <= LEAD_MAX_CHARS;
}
