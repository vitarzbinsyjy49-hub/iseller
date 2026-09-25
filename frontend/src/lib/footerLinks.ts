/** Состав ссылок desktop-футера.
 *
 *  Зачем отдельный модуль. Футер — это перечисление того, что УЖЕ есть в
 *  приложении: разделы «Информации», сценарные заявки, контакты из конфига.
 *  Соблазн собрать такой список прямо в разметке велик, и ровно так в этом
 *  проекте однажды разъехались категории (см. CLAUDE.md: список был захардкожен
 *  в четырёх местах и перестал совпадать с базой). Список, вынесенный в чистую
 *  функцию, проверяется тестами в node без DOM — как navGlass и appSections.
 *
 *  Правило содержания то же, что у Info.tsx: здесь только то, что существует
 *  на самом деле. Ни соцсетей, которых у магазина нет, ни реквизитов, ни
 *  платёжных систем — онлайн-оплаты в проекте нет и быть не должно, сделка
 *  очная. Колонка, для которой не нашлось настоящего содержимого, не рисуется
 *  вовсе: пустая рубрика читается как поломка, а не как отсутствие контакта.
 */
import type { AppEvent } from "./analytics";
import type { ScenarioKey } from "./scenario";

/** Что делает клик. Внутренняя навигация и внешний Telegram разведены типом, а
 *  не догадкой по виду адреса: внешние ссылки в Mini App обязаны идти через
 *  openExternalLink, иначе WebView открывает их внутри себя и человек теряет
 *  приложение. */
export type FooterAction =
  | { kind: "route"; to: string }
  | { kind: "external"; url: string };

export type FooterLink = {
  key: string;
  label: string;
  action: FooterAction;
  /** Имя события аналитики или null — «подходящего имени нет».
   *
   *  Имена живут в allowlist бэкенда (ALLOWED_EVENTS в app/schemas/ai.py), и
   *  незнакомое получает 400. Заводить новое ради футера нельзя, а занимать
   *  чужое — хуже, чем молчать: подмена портит статистику того события, чьё имя
   *  взяли, и задним числом это не разделить. */
  event: AppEvent | null;
  /** Только безопасные метаданные — политика аналитики проекта. */
  payload: Record<string, string>;
};

export type FooterColumn = { key: string; title: string; links: FooterLink[] };

/** Ровно те поля публичного конфига, от которых зависит состав футера. Шире
 *  брать нечего, и узкий тип позволяет тестам обойтись двумя строками вместо
 *  всего PublicConfig. */
export type FooterConfig = {
  manager_retail_url: string;
  telegram_channel_url: string;
};

/** Источник кликов. Без него клик по «Написать менеджеру» из футера не
 *  отличить от такого же клика из шапки и сайдбара — то есть нельзя ответить,
 *  работает футер или просто занимает экран. */
export const FOOTER_SOURCE = "desktop_footer";

/** Разделы «Информации».
 *
 *  Названы здесь, а не выведены из Info.tsx, по двум причинам. Первая: Info —
 *  страничный компонент, и импорт его в lib утащил бы React в тесты, которые
 *  специально идут в node. Вторая, важнее: id секций зафиксированы контрактом —
 *  на них ведут кнопки УЖЕ опубликованных постов канала (/info#delivery), и
 *  переименовать их нельзя. Повтор стабильного идентификатора — не второй
 *  источник правды, а ссылка на неизменяемое; тест сверяет список целиком.
 *
 *  Подписи совпадают с заголовками секций: ссылка обязана называться так же,
 *  как то, куда она ведёт, иначе переход выглядит промахом. */
const INFO_SECTIONS: { id: string; label: string }[] = [
  { id: "about", label: "О магазине" },
  { id: "delivery", label: "Получение и доставка" },
  { id: "payment", label: "Оплата" },
  { id: "warranty", label: "Гарантия и проверка" },
  { id: "returns", label: "Обмен и возврат" },
  { id: "contacts", label: "Контакты" },
];

/** Услуги — те же три сценарные заявки, что в быстрых действиях сайдбара
 *  главной (HomeSidebar), с теми же подписями и тем же маршрутом /apply/<key>.
 *  Вход один и тот же, и называться на соседних экранах по-разному он не
 *  должен. */
const SERVICES: { scenario: ScenarioKey; label: string }[] = [
  { scenario: "wholesale", label: "Опт" },
  { scenario: "b2b", label: "Поставка для компании" },
  { scenario: "trade_in", label: "Trade-In" },
];

/** Колонки футера при данном конфиге. Чистая функция — весь смысл модуля
 *  проверяется без DOM и без браузера. */
export function footerColumns(config: FooterConfig): FooterColumn[] {
  const columns: FooterColumn[] = [
    {
      key: "info",
      title: "Информация",
      links: INFO_SECTIONS.map(({ id, label }) => ({
        key: `info-${id}`,
        label,
        action: { kind: "route", to: `/info#${id}` },
        // То же событие и то же поле `fact`, что у строки обещаний на главной:
        // вопрос «что человека беспокоит перед покупкой» один, и разбивать его
        // по местам нажатия — значит потерять ответ. Место говорит source.
        event: "trust_fact_opened",
        payload: { fact: id, source: FOOTER_SOURCE },
      })),
    },
    {
      key: "services",
      title: "Услуги",
      links: SERVICES.map(({ scenario, label }) => ({
        key: `service-${scenario}`,
        label,
        action: { kind: "route", to: `/apply/${scenario}` },
        event: "quick_scenario_clicked",
        payload: { scenario, source: FOOTER_SOURCE },
      })),
    },
  ];

  // «Связь» собирается из конфига и потому может не собраться вовсе: ссылки
  // задаются в .env бэкенда и при недоступном /config/public приходят пустыми.
  // Кнопка в никуда хуже отсутствия кнопки — она выглядит как поломка.
  const contact: FooterLink[] = [];
  if (config.manager_retail_url) {
    contact.push({
      key: "manager",
      label: "Написать менеджеру",
      action: { kind: "external", url: config.manager_retail_url },
      event: "manager_opened",
      payload: { source: FOOTER_SOURCE },
    });
  }
  if (config.telegram_channel_url) {
    contact.push({
      key: "channel",
      label: "Наша группа",
      action: { kind: "external", url: config.telegram_channel_url },
      event: null,
      payload: {},
    });
  }
  if (contact.length) columns.push({ key: "contact", title: "Связь", links: contact });

  return columns;
}
