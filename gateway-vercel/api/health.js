/** Проверка живости гейтвея без секретов и без обращения к Anthropic.
 *
 *  Отдаёт только факт наличия переменных окружения — не значения и не длины.
 *  Нужен, чтобы отличить «функция не задеплоилась» от «ключи не заданы» до
 *  того, как в дело пойдёт настоящий запрос.
 */
export default function handler(req, res) {
  return res.status(200).json({
    ok: true,
    service: "iseller-ai-gateway",
    gateway_key_set: Boolean(process.env.GATEWAY_API_KEY),
    anthropic_key_set: Boolean(process.env.ANTHROPIC_API_KEY),
  });
}
