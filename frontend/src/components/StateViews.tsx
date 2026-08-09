/** Переиспользуемые состояния загрузки: пусто / ошибка+повтор.
 *
 *  Иллюстрация — иконка из общего набора в спокойном круге, а не крупная emoji.
 *  Emoji здесь и раньше была самым заметным элементом экрана (32–36px), рисовал
 *  её системный шрифт, и «пусто» выглядело чужеродно к остальному интерфейсу. */

import { Icon, type IconName } from "./icons";

export function ErrorState({
  message = "Не удалось загрузить данные", onRetry,
}: { message?: string; onRetry: () => void }) {
  return (
    <div className="fade-in rounded-xl2 bg-surface p-6 text-center shadow-soft">
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
    <div className="fade-in mt-6 py-8 text-center">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-mutedbg text-muted">
        <Icon name={icon} className="h-7 w-7" strokeWidth={1.6} />
      </div>
      <p className="mt-3 text-sm text-muted">{message}</p>
    </div>
  );
}
