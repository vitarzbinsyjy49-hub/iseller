/** AI-чат сценарной заявки (Trade-In / Для бизнеса / Опт) — v6.
 *
 *  Заменяет статичный bottom-sheet (ScenarioSheet.ScenarioRequestSheet).
 *  Скрипт (scenarioChat.ts) ведёт диалог по шагам БЕЗ модели: тап по чипу
 *  или совпавший по синонимам текст двигают state без сети. AI подключается
 *  только когда needsEscalation() вернула true — см.
 *  docs/superpowers/specs/2026-08-14-scenario-ai-chat-design.md.
 *
 *  Контракт отправки — тот же POST /leads с lead_type/metadata, что и у
 *  прежней формы: админка и лента заявок не меняются.
 */
import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { leadMetadataRows } from "../lib/leads";
import {
  SCENARIOS, buildScenarioLead, type Field, type OptionItem, type ScenarioKey,
} from "../lib/scenario";
import {
  isRequired, matchChip, needsEscalation, stepsFor, type ChatStep,
} from "../lib/scenarioChat";
import { haptic, openExternalLink } from "../lib/telegram";
import { usePublicConfig } from "../lib/appConfig";
import { useAuthStore } from "../store/auth";
import { Icon } from "../components/icons";

type ChatMsg = { role: "user" | "assistant"; text: string };
type TurnResponse = { type: string; value: string | null; reply: string | null };

function isScenarioKey(v: string | undefined): v is ScenarioKey {
  return !!v && v in SCENARIOS;
}

export default function ScenarioChat() {
  const params = useParams<{ scenario: string }>();
  if (!isScenarioKey(params.scenario)) return <Navigate to="/" replace />;
  return <ScenarioChatScreen scenario={params.scenario} />;
}

function ScenarioChatScreen({ scenario }: { scenario: ScenarioKey }) {
  const cfg = SCENARIOS[scenario];
  const navigate = useNavigate();
  const config = usePublicConfig();
  const user = useAuthStore((s) => s.user);
  const requirePhone = !user?.username;
  const managerUrl = (scenario === "trade_in" ? config.manager_tradein_url
    : scenario === "b2b" ? config.manager_b2b_url
    : config.manager_wholesale_url) || config.manager_retail_url;

  const steps = useRef<ChatStep[]>(stepsFor(cfg)).current;
  const [stepIndex, setStepIndex] = useState(0);
  const [values, setValues] = useState<Record<string, string>>({});
  const [phone, setPhone] = useState("");
  const [messages, setMessages] = useState<ChatMsg[]>([{ role: "assistant", text: cfg.intro }]);
  const [inputValue, setInputValue] = useState("");
  const [pending, setPending] = useState(false);
  const [sendState, setSendState] = useState<"idle" | "sending" | "done" | "error">("idle");
  const [error, setError] = useState("");
  const currentStep = steps[stepIndex];
  const endRef = useRef<HTMLDivElement>(null);
  const pushedStepRef = useRef(-1);

  useEffect(() => { track("scenario_chat_opened", { scenario }); }, [scenario]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages, pending]);

  function pushAssistant(text: string) { setMessages((m) => [...m, { role: "assistant", text }]); }
  function pushUser(text: string) { setMessages((m) => [...m, { role: "user", text }]); }

  // Реплика-вопрос для текущего шага — ровно один раз при входе на шаг.
  useEffect(() => {
    if (pushedStepRef.current === stepIndex) return;
    pushedStepRef.current = stepIndex;
    const step = steps[stepIndex];
    if (step.kind === "field") {
      pushAssistant(step.field.label.replace(/\s*\(необязательно\)$/, ""));
    } else if (step.kind === "phone") {
      pushAssistant(requirePhone
        ? "Оставьте телефон для связи"
        : "Телефон для связи (необязательно — вам смогут написать в Telegram)");
    } else {
      pushAssistant(cfg.closingHook);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  function resolveField(field: Field, value: string) {
    setValues((v) => ({ ...v, [field.key]: value }));
    haptic("light");
    track("scenario_option_selected", { scenario, field: field.key });
    setStepIndex((i) => i + 1);
  }

  function pickChip(field: Field, opt: OptionItem) {
    pushUser(opt.label);
    resolveField(field, opt.value);
  }

  function skipField(field: Field) {
    pushUser("Пропущено");
    setInputValue("");
    haptic("light");
    setStepIndex((i) => i + 1);
  }

  async function escalate(field: Field, text: string) {
    setPending(true);
    track("scenario_chat_ai_escalated", { scenario, field: field.key });
    const options = field.kind === "chips"
      ? field.options.map((o) => ({ value: o.value, label: o.label })) : [];
    // Timeout 75с — тот же идиом, что и AiSearch.tsx submit(): без него
    // зависший запрос держал бы pending вечно, а на время pending скрыты
    // и чипы, и кнопки «Пропустить» — выйти можно было бы только закрытием
    // экрана целиком, с потерей всех ответов.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75000);
    try {
      const res = await api<TurnResponse>("/scenario-chat/turn", {
        method: "POST",
        body: JSON.stringify({ scenario, field_key: field.key, options, message: text.slice(0, 500) }),
        signal: controller.signal,
      });
      if (res.type === "field_value" && res.value && options.some((o) => o.value === res.value)) {
        resolveField(field, res.value);
        return;
      }
      if (res.type === "answer_question" && res.reply) {
        pushAssistant(res.reply);
        return;
      }
      pushAssistant(res.reply || "Не расслышал — выберите один из вариантов ниже или уточните ответ.");
    } catch {
      pushAssistant("Не расслышал — выберите один из вариантов ниже или уточните ответ.");
    } finally {
      clearTimeout(timer);
      setPending(false);
    }
  }

  async function handleFieldSubmit(field: Field, text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    pushUser(trimmed);
    setInputValue("");

    if (field.kind === "chips") {
      const matched = matchChip(field, trimmed);
      if (matched !== null) { resolveField(field, matched); return; }
    }
    if (needsEscalation(field, trimmed)) { await escalate(field, trimmed); return; }
    resolveField(field, trimmed);
  }

  function handlePhoneSubmit(text: string) {
    const trimmed = text.trim();
    if (requirePhone && !trimmed) {
      pushAssistant("Без телефона менеджеру не с кем связаться — укажите номер, пожалуйста.");
      haptic("rigid");
      return;
    }
    pushUser(trimmed || "Без телефона — свяжутся в Telegram");
    setPhone(trimmed);
    setInputValue("");
    setStepIndex((i) => i + 1);
  }

  async function submitLead() {
    if (sendState === "sending") return;
    setSendState("sending");
    setError("");
    haptic("medium");
    track("scenario_lead_submitted", { scenario, source: "home" });
    try {
      await api("/leads", { method: "POST", body: JSON.stringify(buildScenarioLead(scenario, values, phone)) });
      track("scenario_lead_success", { scenario });
      haptic("light");
      setSendState("done");
    } catch (e) {
      track("scenario_lead_failed", { scenario });
      setError(e instanceof Error ? e.message : "Не удалось отправить заявку");
      setSendState("error");
    }
  }

  if (sendState === "done") {
    return (
      <div className="mx-auto max-w-md px-4 py-10 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-green/15 text-green">
          <Icon name="check" className="h-8 w-8" strokeWidth={2.2} />
        </div>
        <p className="mt-4 text-lg font-bold">Заявка отправлена</p>
        <p className="mx-auto mt-1 max-w-xs text-sm text-muted">
          Менеджер изучит информацию и свяжется с вами в Telegram. Статус можно посмотреть в разделе «Заявки».
        </p>
        <button
          onClick={() => navigate("/requests")}
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
    );
  }

  return (
    <div className="mx-auto max-w-md pb-cta">
      <div className="flex items-center gap-3 px-4 pt-4">
        <button onClick={() => navigate("/")} aria-label="Назад" className="tap flex h-9 w-9 items-center justify-center rounded-full bg-surface shadow-soft">
          <Icon name="close" className="h-4 w-4" strokeWidth={2} />
        </button>
        <h1 className="text-lg font-bold">{cfg.title}</h1>
      </div>

      <div className="mt-4 space-y-3 px-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={
              m.role === "user"
                ? "max-w-[80%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white"
                : "max-w-[92%] rounded-2xl rounded-bl-md bg-surface px-4 py-3 text-sm shadow-soft"
            }>
              {m.text}
            </div>
          </div>
        ))}
        {pending && (
          <div className="flex w-fit max-w-[92%] items-center gap-1.5 rounded-2xl rounded-bl-md bg-surface px-4 py-3.5 shadow-soft">
            <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
            <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
            <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Чипы текущего шага — видны, пока шаг не пройден, независимо от истории сообщений */}
      {!pending && currentStep.kind === "field" && currentStep.field.kind === "chips" && (
        <div className="mt-3 flex flex-wrap gap-2 px-4">
          {currentStep.field.options.map((opt) => (
            <button
              key={opt.value} onClick={() => pickChip(currentStep.field as Field, opt)}
              className="tap rounded-full border border-border bg-surface px-4 py-2 text-[13px] font-semibold text-text transition-colors hover:border-accent"
            >
              {opt.label}
            </button>
          ))}
          {!isRequired(currentStep.field) && (
            <button
              onClick={() => skipField(currentStep.field as Field)}
              className="tap rounded-full px-3 py-2 text-[13px] font-medium text-muted underline-offset-2 hover:underline"
            >
              Пропустить
            </button>
          )}
        </div>
      )}

      {currentStep.kind === "summary" && (() => {
        const lead = buildScenarioLead(scenario, values, phone);
        return (
          <div className="mt-3 space-y-3 px-4">
            <div className="rounded-xl2 bg-surface p-4 shadow-soft">
              {leadMetadataRows(lead.metadata).map((row) => (
                <div key={row.label} className="flex justify-between gap-3 border-b border-border py-1.5 text-sm last:border-0">
                  <span className="text-muted">{row.label}</span>
                  <span className="text-right font-medium">{row.value}</span>
                </div>
              ))}
              {lead.message && (
                <div className="flex justify-between gap-3 border-b border-border py-1.5 text-sm last:border-0">
                  <span className="text-muted">Комментарий</span>
                  <span className="text-right font-medium">{lead.message}</span>
                </div>
              )}
              {lead.phone && (
                <div className="flex justify-between gap-3 border-b border-border py-1.5 text-sm last:border-0">
                  <span className="text-muted">Телефон</span>
                  <span className="text-right font-medium">{lead.phone}</span>
                </div>
              )}
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <button
              onClick={submitLead} disabled={sendState === "sending"}
              className="tap w-full rounded-xl2 bg-accent py-3.5 font-semibold text-white disabled:opacity-50"
            >
              {sendState === "sending" ? "Отправляем…" : cfg.cta}
            </button>
          </div>
        );
      })()}

      {/* Строка ввода видна и на chips-шагах тоже: покупатель может напечатать
          свободный текст ВМЕСТО тапа по чипу (см. lib/scenarioChat.ts —
          matchChip/needsEscalation рассчитаны именно на этот случай). Раньше
          строка скрывалась на chips-полях, и весь локальный матчинг синонимов
          и эскалация к AI были физически недостижимы через UI. */}
      {(currentStep.kind === "field" || currentStep.kind === "phone") && (
        <div className="mt-3 flex gap-2 px-4">
          <input
            value={inputValue} onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              if (currentStep.kind === "phone") handlePhoneSubmit(inputValue);
              else if (currentStep.kind === "field") void handleFieldSubmit(currentStep.field, inputValue);
            }}
            inputMode={currentStep.kind === "phone" ? "tel" : "text"}
            placeholder={currentStep.kind === "phone" ? "+7 900 000-00-00" : "Введите ответ…"}
            maxLength={currentStep.kind === "phone" ? 64 : 500}
            disabled={pending}
            className="min-w-0 flex-1 rounded-xl2 bg-surface px-4 py-3.5 text-sm shadow-soft outline-none placeholder:text-muted disabled:opacity-50"
          />
          {currentStep.kind === "phone" && !requirePhone && (
            <button
              onClick={() => handlePhoneSubmit("")} disabled={pending}
              className="tap shrink-0 rounded-xl2 bg-mutedbg px-4 text-sm font-semibold text-text disabled:opacity-50"
            >
              Пропустить
            </button>
          )}
          {currentStep.kind === "field" && !isRequired(currentStep.field) && (
            <button
              onClick={() => skipField(currentStep.field as Field)} disabled={pending}
              className="tap shrink-0 rounded-xl2 bg-mutedbg px-4 text-sm font-semibold text-text disabled:opacity-50"
            >
              Пропустить
            </button>
          )}
          <button
            onClick={() => {
              if (currentStep.kind === "phone") handlePhoneSubmit(inputValue);
              else if (currentStep.kind === "field") void handleFieldSubmit(currentStep.field, inputValue);
            }}
            disabled={pending || (currentStep.kind === "field" && !inputValue.trim() && isRequired(currentStep.field))}
            className="tap flex h-12 w-12 shrink-0 items-center justify-center rounded-xl2 bg-accent text-white shadow-soft disabled:opacity-40"
            aria-label="Отправить"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
