import { Link } from "react-router-dom";
import { usePublicConfig } from "../lib/appConfig";
import { openExternalLink } from "../lib/telegram";
import { track } from "../lib/analytics";
import { footerColumns, type FooterLink } from "../lib/footerLinks";
import { PICKUP_ADDRESS, PICKUP_HOURS } from "../lib/pickup";
import { BrandWordmark } from "./BrandMark";

/** Desktop-футер (>=1024px): знак бренда, разделы «Информации», услуги, связь.
 *
 *  Только на lg+, и это не «мобильную версию сделаем потом». На телефоне низ
 *  экрана уже занят: там нижняя навигация и ссылка «О сервисе» в конце главной.
 *  Футер добавил бы экран прокрутки ради ссылок, до которых на мобильном
 *  добираются другим путём, — длина на телефоне стоит дороже, чем на desktop.
 *
 *  Состав ссылок сюда не зашит: его считает footerColumns (lib/footerLinks),
 *  покрытая тестами. Здесь остаётся только вёрстка и отправка события.
 *
 *  px-8 висит на самом футере, а внутренний max-w-[1320px] идёт БЕЗ собственных
 *  отступов — та же расстановка, что в DesktopHeader, и по той же причине: пока
 *  коробка складывает ширину и padding, её содержимое живёт в 1256px против
 *  1320px у контента, и колонки не сходятся с шапкой на десятки пикселей. Две
 *  коробки — две сетки; сетка должна быть одна.
 *
 *  -mx-8 гасит padding <main>, внутри которого футер и лежит (лежать он обязан
 *  именно там: <main> — единственный прокручиваемый контейнер, а футер должен
 *  приходить ПОСЛЕ контента, а не висеть прибитым к экрану). Без этого верхняя
 *  линия футера обрывалась бы, не доходя 32px до краёв окна.
 */
export default function DesktopFooter() {
  const config = usePublicConfig();
  const columns = footerColumns(config);

  function activate(link: FooterLink) {
    if (link.event) track(link.event, link.payload);
    if (link.action.kind === "external") openExternalLink(link.action.url);
  }

  // Тень футеру не положена: он лежит в потоке, а не всплывает над ним.
  // Разделяют поверхности пространство и контраст — здесь это верхняя граница.
  return (
    <footer className="hidden -mx-8 mt-16 border-t border-border px-8 lg:block">
      <div className="mx-auto w-full max-w-[1320px] py-10">
        {/* Колонка бренда шире остальных: в ней связный текст, а не список из
            двух слов. Остальные три равны между собой — они однородны. */}
        <div className="grid grid-cols-[minmax(0,1.5fr)_repeat(3,minmax(0,1fr))] gap-8">
          <div>
            <BrandWordmark size={26} />
            {/* Только то, что магазин действительно делает: та же формулировка,
                что в разделе «О магазине», и те же константы самовывоза, что в
                «Информации» (lib/pickup) — второй адрес завести неоткуда. */}
            <p className="mt-3 max-w-[34ch] text-footnote text-muted">
              Техника Apple, Dyson и PlayStation по актуальным ценам. Проверяем вместе,
              оплата после проверки.
            </p>
            <p className="mt-2 max-w-[34ch] text-footnote text-muted">
              Самовывоз — {PICKUP_ADDRESS}, ежедневно {PICKUP_HOURS}.
            </p>
          </div>

          {columns.map((column) => (
            <nav key={column.key} aria-label={column.title}>
              <p className="text-caption font-semibold uppercase tracking-wide text-muted">
                {column.title}
              </p>
              <ul className="mt-3 space-y-2">
                {column.links.map((link) => (
                  <li key={link.key}>
                    {link.action.kind === "route" ? (
                      // Внутренние переходы — обычным Link: футер не должен
                      // перезагружать приложение там, где роутер справляется.
                      <Link
                        to={link.action.to}
                        onClick={() => activate(link)}
                        className={LINK_CLASS}
                      >
                        {link.label}
                      </Link>
                    ) : (
                      // Внешний Telegram — только через openExternalLink: в
                      // WebView обычная ссылка открылась бы ВНУТРИ Mini App, и
                      // человек потерял бы магазин, из которого пришёл.
                      <button type="button" onClick={() => activate(link)} className={LINK_CLASS}>
                        {link.label}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>

        {/* Юридическая строка. Формулировки не новые: это те же обязательства,
            что уже даны в дисклеймере «Информации», укороченные до одной
            строки. Новое условие здесь завести нельзя — каждая такая строка
            становится обещанием, которое кто-то предъявит. Иконок платёжных
            систем тут нет и быть не может: онлайн-оплаты в проекте нет,
            сделка очная. */}
        <div className="mt-8 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-t border-border pt-6">
          <p className="text-caption text-muted">
            © {new Date().getFullYear()} {config.app_name}
          </p>
          <p className="max-w-[72ch] text-caption text-muted">
            Информация носит справочный характер и не является публичной офертой. Наличие,
            комплектацию и итоговую стоимость подтверждает менеджер до оплаты. Товарные знаки
            принадлежат их правообладателям.
          </p>
        </div>
      </div>
    </footer>
  );
}

/** Ссылка и кнопка обязаны выглядеть одинаково: разница между ними —
 *  техническая (роутер против внешнего перехода), и человеку про неё знать
 *  нечего. Поэтому класс один на оба случая, а не скопирован дважды.
 *  text-left нужен именно кнопке: <button> центрует текст по умолчанию, и в
 *  колонке она встала бы не по общей левой линии. */
const LINK_CLASS =
  "rounded-field text-left text-footnote text-muted outline-none transition-colors duration-fast " +
  "hover:text-text focus-visible:ring-2 focus-visible:ring-accent";
