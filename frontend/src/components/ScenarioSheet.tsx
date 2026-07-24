/** Встроенные сценарные заявки (v5.4.0).
 *
 *  ScenarioRequestSheet — один конфигурируемый bottom-sheet (mobile) / центр-модалка
 *  (desktop) для Trade-In / «Для бизнеса» / «Опт». Создаёт структурированную заявку
 *  (POST /leads с lead_type + metadata) прямо в приложении, без ухода к менеджеру.
 *  ScenarioChoiceSheet — лёгкое меню выбора (для «Подобрать MacBook»): только
 *  навигация в AI с prefill, БЕЗ создания заявки и без авто-отправки.
 *
 *  Рендер через portal в document.body (как LeadForm): fixed-оверлей позиционируется
 *  от viewport и не зависит от transform/overflow родителей. Управление фокусом,
 *  блокировка фонового скролла, Escape, safe-area, haptic, защита от двойной отправки.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { haptic, openExternalLink } from "../lib/telegram";
import {
  SCENARIOS,
  buildScenarioLead,
  validateScenario,
  type ChoiceItem,
  type Field,
  type ScenarioKey,
} from "../lib/scenario";

export type { ScenarioKey, ChoiceItem } from "../lib/scenario";

/* ============================================================
   Общая оболочка: portal, backdrop, Escape, scroll-lock, focus trap.
   ============================================================ */
function SheetShell({ onClose, labelledBy, children }: {
  onClose: () => void; labelledBy: string; children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Блокировка фонового скролла без прыжка страницы (компенсируем ширину
  // скроллбара на desktop; на mobile она ~0). Восстанавливаем при закрытии.
  useEffect(() => {
    const { style } = document.body;
    const prevOverflow = style.overflow;
    const prevPad = style.paddingRight;
    const sbw = window.innerWidth - document.documentElement.clientWidth;
    style.overflow = "hidden";
    if (sbw > 0) style.paddingRight = `${sbw}px`;
    return () => { style.overflow = prevOverflow; style.paddingRight = prevPad; };
  }, []);

  // Фокус внутрь шторки + Escape + простая ловушка Tab.
  useEffect(() => {
    const panel = panelRef.current;
    const prevActive = document.activeElement as HTMLElement | null;
    const focusables = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(
        'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
      ) ?? []).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
    // начальный фокус на саму панель (не на первое поле — чтобы клавиатура iOS
    // не открывалась мгновенно и не перекрывала контент/CTA)
    panel?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key !== "Tab") return;
      const els = focusables();
      if (els.length === 0) return;
      const first = els[0], last = els[els.length - 1];
      const active = document.activeElement as HTMLElement;
      if (e.shiftKey && (active === first || active === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prevActive?.focus?.(); };
  }, [onClose]);

  return createPortal(
    <div
      className="backdrop-in fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="sheet-in flex max-h-[88vh] w-full max-w-md flex-col rounded-t-3xl bg-surface shadow-sheet outline-none safe-bottom sm:max-h-[90vh] sm:rounded-3xl"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}

function DragHandle() {
  return <div className="mx-auto mt-3 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />;
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose} aria-label="Закрыть"
      className="tap flex h-8 w-8 items-center justify-center rounded-full bg-mutedbg text-muted"
    >✕</button>
  );
}

/* ============================================================
   ScenarioRequestSheet — форма сценария и success-state.
   ============================================================ */
export function ScenarioRequestSheet({
  scenario, managerUrl, requirePhone, onClose, onCreated,
}: {
  scenario: ScenarioKey;
  /** Ссылка профильного менеджера (из public config). Пустая -> вторичной кнопки нет. */
  managerUrl?: string;
  /** true, если у пользователя нет Telegram-username: тогда контакт обязателен. */
  requirePhone?: boolean;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const cfg = SCENARIOS[scenario];
  const navigate = useNavigate();
  const [values, setValues] = useState<Record<string, string>>({});
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const [phone, setPhone] = useState("");

  useEffect(() => { track("scenario_sheet_opened", { scenario }); }, [scenario]);

  const inputCls =
    "w-full rounded-xl2 border border-border bg-mutedbg px-4 py-3 text-[15px] outline-none transition-colors focus:border-accent focus:bg-surface";

  function setVal(key: string, v: string) { setValues((s) => ({ ...s, [key]: v })); }

  function pickChip(field: Field, value: string) {
    haptic("light");
    setVal(field.key, value);
    track("scenario_option_selected", { scenario, field: field.key });
  }

  async function submit() {
    if (state === "sending") return;                 // защита от двойной отправки
    const problem = validateScenario(scenario, values, !!requirePhone, phone);
    if (problem) { setError(problem); haptic("rigid"); return; }
    setState("sending");
    setError("");
    haptic("medium");

    track("scenario_lead_submitted", { scenario, source: "home" });
    try {
      await api("/leads", {
        method: "POST",
        body: JSON.stringify(buildScenarioLead(scenario, values, phone)),
      });
      track("scenario_lead_success", { scenario });
      haptic("light");
      setState("done");
      onCreated?.();
    } catch (e) {
      track("scenario_lead_failed", { scenario });
      setError(e instanceof Error ? e.message : "Не удалось отправить заявку");
      setState("error");
    }
  }

  // ---- success-state ----
  if (state === "done") {
    return (
      <SheetShell onClose={onClose} labelledBy="scenario-done-title">
        <DragHandle />
        <div className="pop-in px-5 pb-5 pt-2 text-center">
          <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green/15 text-3xl">✅</div>
          <p id="scenario-done-title" className="mt-4 text-lg font-bold">Заявка отправлена</p>
          <p className="mx-auto mt-1 max-w-xs text-sm text-muted">
            Менеджер изучит информацию и свяжется с вами в Telegram. Статус можно посмотреть в разделе «Заявки».
          </p>
          <button
            onClick={() => { onClose(); navigate("/requests"); }}
            className="tap mt-5 w-full rounded-xl2 bg-accent py-3.5 font-semibold text-white"
          >
            Посмотреть заявку
          </button>
          {managerUrl && managerUrl.trim() && (
            <button
              onClick={() => openExternalLink(managerUrl)}
              className="tap mt-2 w-full rounded-xl2 bg-mutedbg py-3 text-sm font-semibold text-text"
            >
              Написать менеджеру сейчас
            </button>
          )}
        </div>
      </SheetShell>
    );
  }

  // ---- форма ----
  return (
    <SheetShell onClose={onClose} labelledBy="scenario-form-title">
      <DragHandle />
      <div className="flex items-start justify-between gap-3 px-5 pt-2">
        <div className="min-w-0">
          <h3 id="scenario-form-title" className="text-lg font-bold leading-6">{cfg.title}</h3>
          <p className="mt-0.5 text-[13px] text-muted">{cfg.subtitle}</p>
        </div>
        <CloseButton onClose={onClose} />
      </div>

      {/* Прокручиваемое тело: длинная форма скроллится, CTA закреплена снизу и
          не перекрывается клавиатурой iOS. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2 pt-4">
        <div className="space-y-4">
          {cfg.fields.map((f) => (
            <div key={f.key}>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
                {f.label}{"required" in f && f.required && <span className="text-[#ff3b30]"> *</span>}
              </label>
              {f.kind === "chips" ? (
                <div className="flex flex-wrap gap-2">
                  {f.options.map((o) => {
                    const active = values[f.key] === o.value;
                    return (
                      <button
                        key={o.value} type="button" onClick={() => pickChip(f, o.value)}
                        aria-pressed={active}
                        className={`tap rounded-full border px-4 py-2 text-[13px] font-semibold transition-colors ${
                          active ? "border-accent bg-accent text-white" : "border-border bg-surface text-text"
                        }`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              ) : f.kind === "textarea" ? (
                <textarea
                  value={values[f.key] ?? ""} onChange={(e) => setVal(f.key, e.target.value)}
                  placeholder={f.placeholder} rows={2} maxLength={2000}
                  className={`${inputCls} resize-none`}
                />
              ) : (
                <input
                  value={values[f.key] ?? ""} onChange={(e) => setVal(f.key, e.target.value)}
                  placeholder={f.placeholder} maxLength={200} className={inputCls}
                />
              )}
            </div>
          ))}

          {/* Контакт: телефон необязателен, если менеджер может ответить в Telegram
              (есть @username); иначе обязателен. */}
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted">
              Телефон{requirePhone ? <span className="text-[#ff3b30]"> *</span> : " (необязательно)"}
            </label>
            <input
              value={phone} onChange={(e) => setPhone(e.target.value)}
              placeholder="+7 900 000-00-00" inputMode="tel" maxLength={64} className={inputCls}
            />
            {!requirePhone && (
              <p className="mt-1 text-[11px] text-muted">Менеджер сможет написать вам в Telegram; телефон — по желанию.</p>
            )}
          </div>

          {error && <p className="text-sm text-[#ff3b30]">{error}</p>}
        </div>
      </div>

      {/* CTA закреплена снизу шторки (не уезжает за клавиатуру) */}
      <div className="shrink-0 border-t border-border px-5 pb-1 pt-3">
        <button
          onClick={submit} disabled={state === "sending"}
          className="tap w-full rounded-xl2 bg-accent py-3.5 font-semibold text-white transition-opacity disabled:opacity-50"
        >
          {state === "sending" ? "Отправляем…" : cfg.cta}
        </button>
        <p className="mt-2 text-center text-[11px] text-muted">
          Нажимая кнопку, вы соглашаетесь с обработкой персональных данных
        </p>
      </div>
    </SheetShell>
  );
}

/* ============================================================
   ScenarioChoiceSheet — меню «Какой MacBook вам нужен?».
   Только навигация в AI с prefill; заявка НЕ создаётся, авто-отправки НЕТ.
   ============================================================ */
export function ScenarioChoiceSheet({
  title, items, onClose, onPick,
}: {
  title: string;
  items: ChoiceItem[];
  onClose: () => void;
  /** Получает prefill выбранного пункта. Вызывающий навигирует в /ai?q=… */
  onPick: (item: ChoiceItem) => void;
}) {
  return (
    <SheetShell onClose={onClose} labelledBy="choice-title">
      <DragHandle />
      <div className="flex items-start justify-between gap-3 px-5 pt-2">
        <h3 id="choice-title" className="text-lg font-bold leading-6">{title}</h3>
        <CloseButton onClose={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-4">
        <div className="space-y-2">
          {items.map((it) => (
            <button
              key={it.key}
              onClick={() => { haptic("light"); onPick(it); }}
              className="tap flex w-full items-center justify-between gap-3 rounded-xl2 border border-border bg-surface px-4 py-3.5 text-left"
            >
              <span className="text-[15px] font-semibold">{it.label}</span>
              <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
          ))}
        </div>
      </div>
    </SheetShell>
  );
}
