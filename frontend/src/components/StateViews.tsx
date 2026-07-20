/** Переиспользуемые состояния загрузки: пусто / ошибка+повтор. */

export function ErrorState({
  message = "Не удалось загрузить данные", onRetry,
}: { message?: string; onRetry: () => void }) {
  return (
    <div className="fade-in rounded-xl2 bg-surface p-6 text-center shadow-soft">
      <p className="text-3xl">⚠️</p>
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
  icon = "🔍", message,
}: { icon?: string; message: string }) {
  return (
    <div className="fade-in mt-6 py-8 text-center">
      <div className="text-4xl">{icon}</div>
      <p className="mt-3 text-sm text-muted">{message}</p>
    </div>
  );
}
