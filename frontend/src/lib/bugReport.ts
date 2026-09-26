/** «Сообщить об ошибке»: что приложить к тексту человека.
 *
 *  «Не работает кнопка» без устройства почти невоспроизводимо: половина
 *  ошибок Mini App живёт только в одном клиенте Telegram или на одной ширине.
 *  Поэтому к сообщению едут платформа, версия Telegram, размер окна и
 *  user-agent. В аналитике user-agent сознательно не пишется (см.
 *  analyticsContext.ts), здесь — пишется: сообщение человек отправляет сам,
 *  и экран прямо говорит, что приложим.
 *
 *  Поля совпадают с backend/app/services/bug_reports.CONTEXT_KEYS — лишнее
 *  сервер отбросит молча.
 */

export type BugContextSources = {
  window: { innerWidth: number; innerHeight: number } | null;
  navigator: { userAgent?: string } | null;
  telegram: { platform?: string; version?: string } | null;
};

export type BugContext = Partial<Record<"platform" | "tg_version" | "viewport" | "user_agent", string>>;

export function bugContext({ window, navigator, telegram }: BugContextSources): BugContext {
  const out: BugContext = {};
  if (telegram?.platform) out.platform = telegram.platform;
  if (telegram?.version) out.tg_version = telegram.version;
  if (window && window.innerWidth > 0 && window.innerHeight > 0) {
    out.viewport = `${Math.round(window.innerWidth)}x${Math.round(window.innerHeight)}`;
  }
  if (navigator?.userAgent) out.user_agent = navigator.userAgent;
  return out;
}

/** Столько же, сколько принимает сервер (services/bug_reports.MAX_PHOTOS). */
export const MAX_BUG_SCREENSHOTS = 5;
/** Короче сервер не примет: по «ой» искать нечего. */
export const MIN_BUG_TEXT = 5;

export function canSendBugReport(text: string, busy: boolean): boolean {
  return !busy && text.trim().length >= MIN_BUG_TEXT;
}
