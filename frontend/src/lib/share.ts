/** Чистая логика «поделиться товаром» (патч 1.1, фича #5).
 *
 *  Здесь нет ни window, ни Telegram SDK — только строки. Решение о том, ЧЕМ
 *  делиться, важнее способа отправки и потому проверяется тестами отдельно.
 *
 *  ГЛАВНОЕ. Делиться внутренним адресом Mini App нельзя. Получатель откроет его
 *  в обычном браузере, где нет Telegram-авторизации, и увидит «Не удалось
 *  войти» — то есть ссылка от друга приводит в тупик, а выглядит это как
 *  сломанный магазин. Поэтому делимся deep link'ом бота:
 *
 *      https://t.me/<bot>?start=product_<id>
 *
 *  Такая ссылка открывает Telegram, приводит человека в чат с ботом, и бот
 *  отвечает web_app-кнопкой на нужную карточку. Тот же приём, что у кнопок в
 *  канале (см. price_posts.deep_link) — по той же причине.
 */

/** Ссылка на товар через бота. Пустой bot_username -> null: без него ссылку
 *  собрать нечем, и звать пользователя «поделиться» нечем тоже. */
export function productDeepLink(botUsername: string | null | undefined, productId: number): string | null {
  const bot = (botUsername ?? "").trim().replace(/^@/, "");
  if (!bot || !Number.isFinite(productId) || productId <= 0) return null;
  return `https://t.me/${bot}?start=product_${Math.trunc(productId)}`;
}

/** Текст сообщения. Цена включена намеренно: «смотри, iPhone за 94 000 ₽»
 *  пересылают, а голую ссылку — нет. Цена берётся из каталога на момент
 *  отправки и живёт в сообщении ОТПРАВИТЕЛЯ, а ссылка ведёт на живую карточку,
 *  где цена всегда актуальна. */
export function shareText(title: string, price: string): string {
  return price ? `${title} — ${price}` : title;
}

/** URL стандартного диалога пересылки Telegram. */
export function telegramShareUrl(link: string, text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
}

export type ShareTarget =
  /** Внутри Telegram: нативный диалог пересылки по контактам. */
  | { kind: "telegram"; url: string; link: string }
  /** Вне Telegram: системный share (мобильный браузер). */
  | { kind: "native"; link: string; text: string }
  /** Ни того, ни другого: копируем ссылку в буфер. */
  | { kind: "clipboard"; link: string };

/** Как делиться в текущих условиях.
 *
 *  Вне Telegram deep link всё равно предпочтительнее внутреннего адреса: он
 *  работает у ЛЮБОГО получателя, даже если отправитель сидит в вебе. Внутренний
 *  адрес остаётся запасным вариантом только когда бот не настроен вовсе.
 */
export function pickShareTarget(opts: {
  insideTelegram: boolean;
  botUsername: string | null | undefined;
  productId: number;
  title: string;
  price: string;
  fallbackUrl: string;
  hasNativeShare: boolean;
}): ShareTarget {
  const deep = productDeepLink(opts.botUsername, opts.productId);
  const link = deep ?? opts.fallbackUrl;
  const text = shareText(opts.title, opts.price);

  if (opts.insideTelegram && deep) {
    return { kind: "telegram", url: telegramShareUrl(deep, text), link: deep };
  }
  if (opts.hasNativeShare) return { kind: "native", link, text };
  return { kind: "clipboard", link };
}
