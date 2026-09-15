/** Как называется товар в плитке и в списках.
 *
 *  Правило жило внутри ProductCard одной строкой и делало ровно одно —
 *  подставляло бренд, если его не было в названии. Теперь у него есть
 *  исключение, а правило с исключением обязано лежать отдельно и быть
 *  проверяемым: то же место, что у `cardBadges` и `sheetDrag`.
 *
 *  ===== Почему у Apple бренд убирается, а у Dyson нет =====
 *
 *  В названиях бренд стоит первым словом: «Apple iPhone 17 256 ГБ Black»,
 *  «Dyson V16 Piston Animal SV53». В плитке под текст остаётся 112px на узком
 *  телефоне, и «Apple » съедает из них около сорока, ничего не сообщая: слово
 *  «iPhone» уже называет производителя. Двадцать плиток подряд с одинаковой
 *  приставкой — это не бренд, это шум.
 *
 *  С Dyson так нельзя: «V16 Piston Animal SV53» без бренда не опознаётся
 *  никем, кроме тех, кто и так знает линейку. Разница не в размере компании, а
 *  в том, называет ли имя модели производителя само.
 *
 *  Отсюда список, а не вычисление. Это суждение о языке («опознаётся ли имя
 *  модели без бренда»), а не факт из данных, поэтому вывести его из базы
 *  нельзя — в отличие от категорий и брендов навигации, которые считаются из
 *  товаров и списка в коде иметь не должны. Добавлять сюда бренд стоит только
 *  тогда, когда его модели действительно узнаются без него.
 *
 *  ===== И почему «Apple Watch» остаётся целиком =====
 *
 *  У части линеек бренд — не приставка, а ЧАСТЬ имени. «Apple Watch Series 11»
 *  без бренда превращается в «Watch Series 11», а так эти часы не называет
 *  никто: слово «Watch» само по себе — просто «часы». То же у Apple TV, Apple
 *  Pencil и Apple Vision Pro. В каталоге таких 18 штук на момент правки,
 *  и без исключения они все читались бы сломанно.
 *
 *  Проверяется СЛЕДУЮЩЕЕ слово, а не весь хвост: «iPhone», «MacBook», «iMac»,
 *  «Mac», «iPad», «AirPods», «Studio Display», «Magic Keyboard» — все узнаются
 *  без бренда, и их 288 против 18.
 */

/** Бренды, чьи модели называют производителя сами.
 *
 *  Значение — слова, после которых бренд НЕ срезается, потому что он часть
 *  имени модели. Всё в нижнем регистре. */
const SELF_EVIDENT_BRANDS = new Map<string, ReadonlySet<string>>([
  ["apple", new Set(["watch", "tv", "pencil", "vision"])],
]);

type NamedCard = {
  title: string;
  title_clean?: string | null;
  brand?: string | null;
};

/** Начинается ли название с бренда как с ОТДЕЛЬНОГО слова.
 *
 *  Проверка на пробел после бренда обязательна: без неё «Applewatch» или
 *  гипотетический бренд-подстрока срезались бы по живому. */
function startsWithBrand(name: string, brand: string): boolean {
  const lower = name.toLowerCase();
  const b = brand.toLowerCase();
  return lower === b || lower.startsWith(`${b} `);
}

export function productName(card: NamedCard): string {
  // title_clean приходит с backend уже без кодов стран, но С пометками вроде
  // «SIM+eSIM» и «[ASIS]»: первые различают позиции, вторые объясняют цену
  // (ASIS — витринный образец, уценка). Ни то, ни другое здесь не трогаем.
  const name = (card.title_clean || card.title || "").trim();
  const brand = (card.brand || "").trim();
  if (!brand || !name) return name;

  const leading = startsWithBrand(name, brand);
  const keepBefore = SELF_EVIDENT_BRANDS.get(brand.toLowerCase());

  if (keepBefore) {
    if (!leading) return name;
    // Срезаем, только если после бренда что-то остаётся. «Apple» целиком как
    // название — вырожденный случай (так заведён товар в админке), и пустая
    // плитка хуже лишнего слова.
    const rest = name.slice(brand.length).trim();
    if (!rest) return name;
    // Бренд — часть имени модели («Apple Watch»): оставляем как есть.
    const next = rest.split(/\s+/, 1)[0].toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
    return keepBefore.has(next) ? name : rest;
  }

  // Бренд не самоочевиден: он обязан присутствовать. Если в названии его нет
  // вовсе — подставляем впереди, как было до появления исключения
  // («PlayStation 5 Pulse Elite» при бренде Sony).
  return name.toLowerCase().includes(brand.toLowerCase()) ? name : `${brand} ${name}`;
}
