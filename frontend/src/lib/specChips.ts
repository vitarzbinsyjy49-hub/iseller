/** Чипы ключевых характеристик под заголовком товара.
 *
 *  Значения приходят из РАЗНЫХ колонок (цвет, память, накопитель), и в прайсе
 *  `memory` и `storage` сплошь и рядом содержат одно и то же: «512 ГБ» и
 *  «512 ГБ». Без дедупа под заголовком висели два одинаковых чипа — выглядело
 *  как ошибка магазина, а React вдобавок ругался на повторяющийся `key`.
 *
 *  Дедуп по ЗНАЧЕНИЮ, а не по имени поля: если у товара накопитель и память
 *  правда разные, оба чипа обязаны остаться.
 *
 *  Чистая функция — тесты в node, как у cartMath и searchRoutes.
 */
export function specChips(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of values) {
    // Пробелы схлопываем: в выгрузке встречается «2  ТБ», и на витрине это
    // читается как опечатка. Тем же заодно ловится дубль «2 ТБ» / «2  ТБ».
    const value = (raw ?? "").split(/\s+/).filter(Boolean).join(" ");
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }

  return out;
}
