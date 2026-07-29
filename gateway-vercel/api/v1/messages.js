import { timingSafeEqual } from "node:crypto";

/** Прозрачный прокси к Anthropic Messages API.
 *
 *  Зачем он вообще: `api.anthropic.com` отвечает 403 с прод-VPS — региональное
 *  ограничение на стороне Anthropic, оно срабатывает ДО проверки ключа (неверный
 *  ключ даёт 401). WARP не помогает: его выходной узел в том же закрытом
 *  регионе. Vercel исполняет функции в открытом регионе, поэтому запрос отсюда
 *  проходит.
 *
 *  Почему прокси, а не «умный» гейтвей со своим форматом: сборка промпта и
 *  JSON-схема ответа живут в backend (ai_anthropic.py) и собираются из тех же
 *  INTENTS/NEXT_ACTIONS, что валидируют ответ. Продублировать это здесь на JS
 *  значило бы завести вторую копию, которая рано или поздно разъедется с
 *  первой. Поэтому функция не знает ни про промпты, ни про схему, ни про модель:
 *  она передаёт тело как есть и возвращает ответ как есть. Вся логика —
 *  structured outputs, повтор без схемы, обработка refusal и max_tokens —
 *  остаётся в Python и работает без изменений.
 *
 *  Ключи: backend предъявляет GATEWAY_API_KEY, настоящий ANTHROPIC_API_KEY
 *  живёт только здесь. На VPS его нет, поэтому компрометация прода не даёт
 *  доступа к счёту Anthropic.
 */

// Инференс занимает 7-8с на 12 кандидатах, но бывает дольше. 60с — потолок
// Node-функции на Hobby; backend ждёт дольше и получит честный ответ, а не
// оборванное соединение.
export const config = { maxDuration: 60 };

/** Сравнение секретов без утечки по времени. Длины могут не совпадать —
 *  timingSafeEqual на таком бросает, поэтому проверяем длину отдельно. */
function secretMatches(presented, expected) {
  const a = Buffer.from(String(presented || ""), "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: { type: "method_not_allowed" } });
  }

  const gatewaySecret = process.env.GATEWAY_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!gatewaySecret || !anthropicKey) {
    // Не пишем в ответ, какой именно переменной нет: наружу это не нужно.
    console.error("[gateway] missing env: GATEWAY_API_KEY and/or ANTHROPIC_API_KEY");
    return res.status(503).json({ error: { type: "gateway_not_configured" } });
  }

  if (!secretMatches(req.headers["x-api-key"], gatewaySecret)) {
    return res.status(401).json({ error: { type: "unauthorized" } });
  }

  const started = Date.now();
  try {
    const upstream = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": anthropicKey,
        // Версию и beta-флаги задаёт клиент — прокси их не выдумывает.
        "anthropic-version": req.headers["anthropic-version"] || "2023-06-01",
        ...(req.headers["anthropic-beta"]
          ? { "anthropic-beta": req.headers["anthropic-beta"] }
          : {}),
      },
      body: JSON.stringify(req.body ?? {}),
    });

    const text = await upstream.text();
    // Ответ отдаём как есть, включая статус: SDK на той стороне сам разбирает
    // 429/5xx и ретраит. Подменять коды здесь — значит ломать его логику.
    console.log(`[gateway] upstream ${upstream.status} in ${Date.now() - started}ms`);
    res.status(upstream.status);
    res.setHeader("content-type", upstream.headers.get("content-type") || "application/json");
    return res.send(text);
  } catch (e) {
    // Тело запроса не логируем: там пользовательский текст и каталог.
    console.error(`[gateway] upstream unreachable: ${e.name}`);
    return res.status(502).json({ error: { type: "upstream_unreachable" } });
  }
}
