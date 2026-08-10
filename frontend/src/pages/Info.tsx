/** Информация о магазине: условия, которые покупатель вправе прочитать до заявки.
 *
 *  Раздел появился под запуск бота. Раньше строка «О магазине» в профиле была
 *  мёртвой — без onClick, — а условия жили россыпью: часть на карточке товара,
 *  часть в постах канала, часть нигде.
 *
 *  Правило содержания одно: здесь только то, что магазин действительно делает.
 *  Ни сроков доставки в днях, ни тарифов, ни процедур возврата, которых у нас
 *  нет, — каждая такая строка становится обязательством, которое кто-то
 *  предъявит. Где условие определяет менеджер, так и написано.
 *
 *  У каждой секции стабильный id: на них ведут якоря из постов канала
 *  (`/info#delivery`), поэтому переименовывать их нельзя — сломаются кнопки
 *  в уже опубликованных сообщениях.
 */
import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { usePublicConfig } from "../lib/appConfig";
import { openExternalLink } from "../lib/telegram";
import { Icon, type IconName } from "../components/icons";

type Section = {
  id: string;
  icon: IconName;
  title: string;
  /** Абзацы. Строка — обычный текст, массив — маркированный список. */
  blocks: (string | string[])[];
};

const SECTIONS: Section[] = [
  {
    id: "about",
    icon: "info",
    title: "О магазине",
    blocks: [
      "АйСеллер — техника Apple, Dyson и PlayStation с Горбушки по актуальным ценам. " +
        "Мы не гонимся за быстрой выгодой: отбираем то, за что готовы отвечать, " +
        "и говорим о товаре то, что есть на самом деле.",
      "Как это устроено:",
      [
        "в приложении — каталог с фото, характеристиками и ценами из наличия;",
        "AI-подбор: опишите задачу и бюджет, он предложит варианты из того, что есть;",
        "заявка оформляется в приложении, дальше с вами общается менеджер;",
        "в канале — постоянный прайс, он обновляется, а не публикуется заново.",
      ],
      "Приложение в бета-версии и продолжает развиваться. Магазин при этом " +
        "работает по-настоящему: заявки принимаются, техника выдаётся.",
    ],
  },
  {
    id: "delivery",
    icon: "truck",
    title: "Получение и доставка",
    blocks: [
      "Самовывоз — Горбушка, Москва. Ежедневно 10:00–21:00. " +
        "Технику проверяем вместе, оплата после проверки.",
      "Доставка по Москве — курьером.",
      "Доставка по России — СДЭК.",
      "Срок и стоимость доставки менеджер называет при подтверждении заявки: " +
        "они зависят от адреса, габаритов и способа отправки. Никаких «примерно» " +
        "до подтверждения мы не пишем — чтобы не назвать цифру, которая потом изменится.",
    ],
  },
  {
    id: "payment",
    icon: "card",
    title: "Оплата",
    blocks: [
      "Сейчас — наличными при получении: на самовывозе после проверки техники, " +
        "при доставке — курьеру.",
      "Оплата картой и через СБП появится позже — это ближайший пункт в планах " +
        "приложения. О любых изменениях менеджер скажет заранее.",
      "Цена в каталоге — итоговая для розницы. По опту и поставкам для компаний " +
        "условия отдельные, напишите менеджеру.",
    ],
  },
  {
    id: "warranty",
    icon: "shield",
    title: "Гарантия и проверка",
    blocks: [
      "Гарантия 1 месяц с момента покупки на всю технику из каталога.",
      "Проверка при вас. Перед оплатой вместе включаем устройство, смотрим " +
        "внешний вид, комплектацию и работу основных функций. Забирать «кота в " +
        "мешке» не нужно.",
      "Что важно знать до покупки:",
      [
        "регион поставки влияет на комплект и вариант SIM — он указан в карточке;",
        "наличие, комплектацию и итоговую стоимость менеджер подтверждает до оплаты;",
        "если у конкретного экземпляра есть особенности, менеджер скажет о них заранее.",
      ],
      "Основание для гарантии — документ о покупке, который вы получаете вместе с техникой.",
    ],
  },
  {
    id: "returns",
    icon: "refresh",
    title: "Обмен и возврат",
    blocks: [
      "Вопросы обмена и возврата решаются с менеджером — напишите ему, опишите " +
        "ситуацию, и он скажет, что делать дальше.",
      "Ваши права при этом определяет закон «О защите прав потребителей», " +
        "а не наши правила: они не могут его ухудшить. Для техники действует " +
        "перечень технически сложных товаров, для него закон устанавливает " +
        "отдельный порядок.",
      "Чтобы разговор шёл быстрее, сохраните упаковку, комплектацию и документ " +
        "о покупке.",
    ],
  },
];

export default function Info() {
  const config = usePublicConfig();
  const { hash } = useLocation();

  // Якорь из поста канала (/info#delivery) должен попасть в нужную секцию.
  // Скроллим после отрисовки: до неё элемента ещё нет.
  useEffect(() => {
    if (!hash) return;
    const el = document.getElementById(hash.slice(1));
    el?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [hash]);

  const phone = config.shop_phone;
  // Телефон показываем сгруппированным, а звоним по «сырому»: +7 999 123-45-67
  // в href ломает набор на части клиентов.
  const phoneLabel = phone.replace(/^(\+7)(\d{3})(\d{3})(\d{2})(\d{2})$/, "$1 $2 $3-$4-$5");

  return (
    <div className="mx-auto max-w-md lg:max-w-3xl">
      <h1 className="text-2xl font-bold">Информация</h1>
      <p className="mt-1 text-[13px] text-muted">
        Условия магазина: получение, оплата, гарантия и связь с нами.
      </p>

      <div className="stagger mt-4 space-y-3">
        {SECTIONS.map((section) => (
          <section
            key={section.id}
            id={section.id}
            // scroll-mt: под липкой шапкой якорь иначе встаёт под неё.
            className="card-appear scroll-mt-4 rounded-xl2 bg-surface p-4 shadow-soft"
          >
            <div className="flex items-center gap-2.5">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-field bg-accent/10 text-accent">
                <Icon name={section.icon} className="h-5 w-5" />
              </span>
              <h2 className="text-[15px] font-bold">{section.title}</h2>
            </div>

            <div className="mt-3 space-y-2">
              {section.blocks.map((block, i) =>
                Array.isArray(block) ? (
                  <ul key={i} className="space-y-1.5">
                    {block.map((item) => (
                      <li key={item} className="flex gap-2 text-[13px] leading-[1.5] text-muted">
                        <span aria-hidden className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-accent" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p key={i} className="text-[13px] leading-[1.5] text-muted">{block}</p>
                ),
              )}
            </div>
          </section>
        ))}

        {/* Контакты — отдельной секцией с действиями, а не текстом: телефон
            должен набираться тапом, а не выделяться и копироваться вручную. */}
        <section id="contacts" className="card-appear scroll-mt-4 rounded-xl2 bg-surface p-4 shadow-soft">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-field bg-accent/10 text-accent">
              <Icon name="chat" className="h-5 w-5" />
            </span>
            <h2 className="text-[15px] font-bold">Контакты</h2>
          </div>

          <p className="mt-3 text-[13px] leading-[1.5] text-muted">
            Пишите по любому вопросу — о наличии, сроках, гарантии или заказе
            модели, которой нет в каталоге.
          </p>

          <div className="mt-3 space-y-2">
            {phone && (
              <a
                href={`tel:${phone}`}
                className="tap flex min-h-[52px] items-center gap-3 rounded-field bg-mutedbg px-3.5 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Icon name="phone" className="h-5 w-5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold">{phoneLabel}</span>
                  <span className="block text-[12px] text-muted">Позвонить в магазин</span>
                </span>
              </a>
            )}

            {config.manager_retail_url && (
              <button
                onClick={() => openExternalLink(config.manager_retail_url)}
                className="tap flex min-h-[52px] w-full items-center gap-3 rounded-field bg-mutedbg px-3.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Icon name="chat" className="h-5 w-5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold">Написать менеджеру</span>
                  <span className="block text-[12px] text-muted">Личные сообщения в Telegram</span>
                </span>
              </button>
            )}

            {config.telegram_channel_url && (
              <button
                onClick={() => openExternalLink(config.telegram_channel_url)}
                className="tap flex min-h-[52px] w-full items-center gap-3 rounded-field bg-mutedbg px-3.5 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                <Icon name="box" className="h-5 w-5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold">Наша группа</span>
                  <span className="block text-[12px] text-muted">Прайс, новинки и разделы с условиями</span>
                </span>
              </button>
            )}
          </div>

          <p className="mt-3 text-[12px] leading-4 text-muted">
            Самовывоз — Горбушка, Москва, ежедневно 10:00–21:00. О приезде
            договоритесь с менеджером заранее.
          </p>
        </section>

        {/* Дисклеймер. Формулировки стандартные и относятся к нам буквально:
            цена и наличие подтверждаются менеджером, а торговые марки нам не
            принадлежат — мы ими только называем товар. */}
        <section className="rounded-xl2 bg-mutedbg p-4">
          <p className="text-[12px] leading-[1.5] text-muted">
            Информация в приложении носит справочный характер и не является
            публичной офертой. Наличие, комплектацию и итоговую стоимость
            подтверждает менеджер до оплаты. Все товарные знаки принадлежат их
            правообладателям и используются для обозначения товара. АйСеллер не
            является авторизованным партнёром Apple Inc. и других производителей,
            техника которых представлена в каталоге.
          </p>
        </section>
      </div>
    </div>
  );
}
