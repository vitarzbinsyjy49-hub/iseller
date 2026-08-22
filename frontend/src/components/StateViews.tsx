/** Переиспользуемые состояния загрузки: пусто / ошибка+повтор.
 *
 *  Иллюстрация — иконка из общего набора в спокойном круге, а не крупная emoji.
 *  Emoji здесь и раньше была самым заметным элементом экрана (32–36px), рисовал
 *  её системный шрифт, и «пусто» выглядело чужеродно к остальному интерфейсу. */

import { Icon, type IconName } from "./icons";
import { enterRefCallback } from "../lib/useEnter";

export function ErrorState({
  message = "Не удалось загрузить данные", onRetry,
}: { message?: string; onRetry: () => void }) {
  return (
    <div ref={enterRefCallback("fade")} className="rounded-xl2 bg-surface p-6 text-center shadow-soft">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-dangerbg text-dangerink">
        <Icon name="alert" className="h-6 w-6" />
      </div>
      <p className="mt-2 text-sm text-muted">{message}</p>
      <button
        onClick={onRetry}
        className="tap mt-3 rounded-xl2 bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accentdark"
      >
        Повторить
      </button>
    </div>
  );
}

export function EmptyState({
  icon = "search", message,
}: { icon?: IconName; message: string }) {
  return (
    <div ref={enterRefCallback("fade")} className="mt-6 py-8 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-mutedbg text-muted">
        <Icon name={icon} className="h-7 w-7" strokeWidth={1.6} />
      </div>
      <p className="mt-3 text-sm text-muted">{message}</p>
    </div>
  );
}

/** Скелетон карточки товара.
 *
 *  Повторяет ИТОГОВУЮ раскладку страницы, а не «что-нибудь серое»: полоса
 *  действий сверху, квадрат галереи, две строки заголовка, цена, наличие, ряд
 *  характеристик, блок доверия. Всё — на своих местах и своей высоты.
 *
 *  Зачем так. При заходе в товар подряд показывались ТРИ разные формы: сначала
 *  запасной экран Suspense (а он в форме каталога — заголовок и сетка карточек),
 *  потом собственный скелетон страницы из квадрата и двух полосок, потом сама
 *  страница. Каждая смена — прыжок раскладки, и вместе они читались как «сначала
 *  посередине что-то, потом уже карточка». Причём это не лечится ускорением:
 *  сколько бы ни грузилось, форм всё равно три.
 *
 *  Поэтому один и тот же скелетон стоит и запасным экраном чанка, и состоянием
 *  загрузки данных. Тогда подряд идут не три формы, а одна — и подстановка
 *  настоящего содержимого не двигает то, что уже нарисовано.
 *
 *  pb-cta — тот же отступ под фиксированной кнопкой, что у самой страницы: без
 *  него высота прокрутки скакала бы в момент появления контента.
 */
export function ProductSkeleton() {
  return (
    <div className="mx-auto max-w-md pb-cta lg:max-w-[1440px] lg:pb-12" aria-busy="true" aria-label="Загрузка товара">
      {/* Строка действий: назад / поиск / поделиться / избранное */}
      <div className="-mx-4 -mt-3 mb-3 flex items-center gap-2 px-3 py-1 lg:hidden">
        <div className="skeleton h-9 w-9 rounded-full" />
        <div className="flex-1" />
        <div className="skeleton h-9 w-9 rounded-full" />
        <div className="skeleton h-9 w-9 rounded-full" />
        <div className="skeleton h-9 w-9 rounded-full" />
      </div>

      <div className="lg:grid lg:grid-cols-[48fr_52fr] lg:items-start lg:gap-8 xl:gap-12">
        <div className="skeleton aspect-square w-full rounded-xl2" />

        <div>
          {/* Заголовок — две строки: столько же занимает настоящее название */}
          <div className="skeleton mt-4 h-5 w-11/12 rounded-lg lg:mt-0" />
          <div className="skeleton mt-2 h-5 w-7/12 rounded-lg" />

          {/* Цена и наличие */}
          <div className="skeleton mt-4 h-8 w-2/5 rounded-lg" />
          <div className="skeleton mt-2.5 h-4 w-1/3 rounded" />

          {/* Ряд характеристик */}
          <div className="mt-4 flex gap-2">
            <div className="skeleton h-8 w-20 rounded-field" />
            <div className="skeleton h-8 w-16 rounded-field" />
            <div className="skeleton h-8 w-24 rounded-field" />
          </div>

          {/* Блок доверия: четыре строки-обещания */}
          <div className="mt-5 space-y-2.5">
            <div className="skeleton h-4 w-3/4 rounded" />
            <div className="skeleton h-4 w-2/3 rounded" />
            <div className="skeleton h-4 w-4/5 rounded" />
            <div className="skeleton h-4 w-1/2 rounded" />
          </div>
        </div>
      </div>
    </div>
  );
}
