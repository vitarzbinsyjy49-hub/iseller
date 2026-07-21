/** Лёгкие toast-уведомления без зависимостей: toast() шлёт событие, компонент
 *  <Toaster/> (смонтирован один раз в App) слушает и рисует. */
export type ToastKind = "success" | "error" | "info";
export const TOAST_EVENT = "app-toast";

export function toast(message: string, kind: ToastKind = "success"): void {
  try {
    window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { message, kind } }));
  } catch {
    /* no-op */
  }
}
