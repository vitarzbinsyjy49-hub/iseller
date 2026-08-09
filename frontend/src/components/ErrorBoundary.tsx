import { Component, type ReactNode } from "react";
import { Icon } from "./icons";

/** Ловит любые render-ошибки и показывает дружелюбный экран вместо
 *  белого экрана смерти. Кнопка перезагружает Mini App целиком. */
export default class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Единственное место, где ошибка уходит в консоль осознанно — для отладки демо.
    console.error("App render error:", error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-mutedbg text-muted">
          <Icon name="alert" className="h-7 w-7" strokeWidth={1.6} />
        </div>
        <p className="mt-4 text-lg font-bold">Что-то пошло не так</p>
        <p className="mt-1.5 text-sm text-muted">
          Попробуйте обновить приложение. Если не поможет — напишите менеджеру.
        </p>
        <button
          onClick={() => window.location.assign("/")}
          className="tap mt-5 rounded-xl2 bg-accent px-6 py-3 text-sm font-semibold text-white"
        >
          Обновить приложение
        </button>
      </div>
    );
  }
}
