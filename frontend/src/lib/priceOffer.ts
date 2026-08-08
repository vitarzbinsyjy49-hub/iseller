/** Сценарий «нашли дешевле»: ссылка на тот же товар у конкурента.
 *
 *  Клиентская проверка нужна не вместо серверной, а чтобы человек узнал об
 *  ошибке сразу, не отправляя форму. Правду по-прежнему говорит сервер
 *  (`services/offer_links.py`) — здесь только то, что можно проверить,
 *  не выходя в сеть.
 */

/** Тот же предел, что у сервера (`MAX_URL_LENGTH`) и у строки-адреса в
 *  metadata заявки. Расхождение означало бы, что форма пропускает ссылку,
 *  которую сервер молча обрежет или отвергнет. */
export const MAX_URL_LENGTH = 2048;

/** Потолок цены — граница правдоподобия, а не «правильная» цена. Совпадает с
 *  `MAX_COMPETITOR_PRICE` на сервере. */
export const MAX_PRICE = 100_000_000;

/** Ошибка ссылки или null, если она годится. */
export function validateOfferUrl(raw: string): string | null {
  const text = (raw || "").trim();
  if (!text) return "Вставьте ссылку на товар";
  if (text.length > MAX_URL_LENGTH) return "Ссылка слишком длинная";

  // Схему при копировании из строки браузера часто теряют — дописываем, как
  // это делает сервер, иначе форма отвергала бы нормальные адреса.
  const withScheme = text.includes("://") ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return "Не похоже на ссылку";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "Ссылка должна начинаться с http:// или https://";
  }
  const host = url.hostname.toLowerCase();
  if (!host.includes(".")) return "Не похоже на адрес магазина";
  if (host === "sslip.io" || host.endsWith(".sslip.io") || host === "t.me") {
    return "Это ссылка на наш же магазин";
  }
  return null;
}

/** Ошибка цены или null. Пусто — это НЕ ошибка: поле необязательное. */
export function validateOfferPrice(raw: string): string | null {
  const text = (raw || "").trim();
  if (!text) return null;
  const value = Number(text.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(value)) return "Цена — это число";
  if (value <= 0 || value > MAX_PRICE) return "Проверьте цифру";
  return null;
}

/** Цена для отправки: число либо undefined. Пустое поле не должно уезжать
 *  строкой — на сервере пустая строка неотличима от «ввели мусор». */
export function parseOfferPrice(raw: string): number | undefined {
  const text = (raw || "").trim();
  if (!text || validateOfferPrice(text)) return undefined;
  return Number(text.replace(/\s/g, "").replace(",", "."));
}

export type PriceOfferBody = {
  lead_type: "price_offer";
  source: "product";
  product_id: number;
  metadata: {
    competitor_url: string;
    origin: string;
    competitor_price?: number;
    comment?: string;
  };
};

export function buildPriceOfferBody(
  productId: number, url: string, price: string, comment?: string,
): PriceOfferBody {
  const competitorPrice = parseOfferPrice(price);
  return {
    lead_type: "price_offer",
    source: "product",
    product_id: productId,
    metadata: {
      competitor_url: url.trim(),
      origin: "product_price_offer",
      ...(competitorPrice === undefined ? {} : { competitor_price: competitorPrice }),
      ...(comment?.trim() ? { comment: comment.trim() } : {}),
    },
  };
}

/** Как показать раскрытие блока. Решение отделено от DOM намеренно: именно в
 *  нём пряталась ошибка, из-за которой блок оставался в разметке, но с нулевой
 *  высотой — то есть «кнопка не работает» с точки зрения человека. Проверить
 *  это глазами тяжело, а чистой функцией — тривиально. */
export type RevealPlan =
  | { kind: "instant" }
  | { kind: "fade" }
  | { kind: "move"; from: number; to: number };

export function planReveal(opts: {
  /** Измеренная высота содержимого. Ноль означает «измерить не удалось». */
  measured: number;
  /** Высота, на которой остановилась прошлая анимация. */
  previousHeight: number;
  /** Блок открывается сейчас, а не меняет содержимое внутри открытого. */
  openingNow: boolean;
  reducedMotion: boolean;
}): RevealPlan {
  const { measured, previousHeight, openingNow, reducedMotion } = opts;

  // Не измерили — показываем как есть. Потерять движение допустимо, потерять
  // сам блок нельзя: невидимый блок неотличим от сломанной кнопки.
  if (measured <= 0) return { kind: "instant" };

  // «Уменьшить движение» убирает движение, но не событие: при открытии
  // проявляем, при смене содержимого внутри — просто показываем.
  if (reducedMotion) return openingNow ? { kind: "fade" } : { kind: "instant" };

  const from = openingNow ? 0 : previousHeight;
  // Ехать некуда — не притворяемся, что едем.
  if (from === measured) return { kind: "instant" };
  return { kind: "move", from, to: measured };
}

/** Насколько дешевле у них — для подписи под формой. null, когда сравнивать
 *  нечего или у них не дешевле: обещать выгоду, которой нет, нельзя. */
export function priceGap(ourPrice: number | null | undefined, raw: string): number | null {
  const theirs = parseOfferPrice(raw);
  if (theirs === undefined || ourPrice == null) return null;
  const gap = ourPrice - theirs;
  return gap > 0 ? gap : null;
}
