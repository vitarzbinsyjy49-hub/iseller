import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

/** Поле формы: видимая подпись, ошибка ПОД полем, focus-ring для клавиатуры.
 *
 *  Появился из-за расхождения двух форм. Оформление корзины и шторка «Оставить
 *  заявку» просят одно и то же — имя, телефон, комментарий, — но были написаны
 *  дважды: строка `inputCls` скопирована, а обработка ошибки разъехалась
 *  (у корзины стоял role="alert", у шторки нет). Любая правка доступности
 *  требовала делать её в двух местах, и один из двух неизбежно отставал.
 *
 *  Что здесь решено раз и навсегда:
 *
 *  - **Подпись видима и связана с полем.** Раньше подписи не было вовсе —
 *    только placeholder. Скринридер читал пустое поле, а звёздочка
 *    обязательности из «Телефон *» исчезала ровно в тот момент, когда человек
 *    начинал печатать, то есть когда она и нужна.
 *  - **autoComplete обязателен параметром**, а не забывается: без него
 *    Telegram WebView не подставляет имя и телефон — самый дешёвый способ
 *    потерять заявку на ровном месте.
 *  - **Ошибка живёт под своим полем** (`aria-describedby` + `role="alert"`),
 *    а не одним абзацем над кнопкой отправки.
 *  - **`outline-none` компенсирован ring'ом.** Он на `focus-visible`, а не на
 *    `focus`: при тапе пальцем рамка не нужна, при табуляции — обязательна.
 */

const base =
  "w-full rounded-xl2 border bg-mutedbg px-4 py-3 text-sm outline-none transition-colors " +
  "focus:bg-surface focus-visible:ring-2 focus-visible:ring-accent/40";

const tone = (invalid: boolean) =>
  invalid ? "border-danger focus:border-danger" : "border-border focus:border-accent";

type Common = {
  /** id поля: и для `htmlFor`, и чтобы форма могла увести на него фокус. */
  id: string;
  label: string;
  /** Текст ошибки. Показывается под полем и включает невалидное состояние. */
  error?: string | null;
  /** Спокойная подсказка под полем — видна, пока нет ошибки. */
  hint?: ReactNode;
  required?: boolean;
};

function Shell({
  id, label, error, hint, required, children,
}: Common & { children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[12px] font-medium text-muted">
        {label}
        {required && <span className="text-danger" aria-hidden> *</span>}
        {required && <span className="sr-only"> (обязательное поле)</span>}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1 text-[12px] font-medium text-dangerink">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-[12px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

/** aria-describedby указывает на ошибку, а при её отсутствии — на подсказку. */
const describedBy = (id: string, error?: string | null, hint?: ReactNode) =>
  error ? `${id}-error` : hint ? `${id}-hint` : undefined;

export function TextField({
  id, label, error, hint, required, className = "", ...rest
}: Common & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <Shell id={id} label={label} error={error} hint={hint} required={required}>
      <input
        {...rest}
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={`${base} ${tone(!!error)} ${className}`}
      />
    </Shell>
  );
}

export function TextAreaField({
  id, label, error, hint, required, className = "", ...rest
}: Common & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <Shell id={id} label={label} error={error} hint={hint} required={required}>
      <textarea
        {...rest}
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, error, hint)}
        className={`${base} ${tone(!!error)} resize-none ${className}`}
      />
    </Shell>
  );
}

/** Ошибка уровня всей формы (сеть, 409, «уберите недоступные товары») — то, что
 *  не принадлежит ни одному полю и потому остаётся рядом с кнопкой отправки. */
export function FormError({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-3 rounded-xl2 bg-dangerbg px-3 py-2 text-[13px] text-dangerink">
      {children}
    </p>
  );
}
