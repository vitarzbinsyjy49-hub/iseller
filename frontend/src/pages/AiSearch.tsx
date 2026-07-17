import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { AiAction, AiAnswer, ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import LeadForm from "../components/LeadForm";
import { usePublicConfig } from "../lib/appConfig";
import { openExternalLink } from "../lib/telegram";

const QUICK = [
  "iPhone до 90 000",
  "Ноутбук для монтажа",
  "Подарок до 30 000",
  "PlayStation в наличии",
  "MacBook для работы",
  "Наушники до 20 000",
];

type ChatItem =
  | { role: "user"; text: string }
  | { role: "assistant"; answer: AiAnswer };

/** AI-подбор в виде чата: bubble пользователя, typing, bubble ассистента + карточки.
 *  Всё через backend POST /api/ai/chat (JWT). При недоступности AI backend сам
 *  вернёт fallback/mock — пользователь никогда не видит ошибку AI. */
export default function AiSearch() {
  const [params] = useSearchParams();
  const config = usePublicConfig();
  const [value, setValue] = useState("");
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [lead, setLead] = useState<{ card?: TCard; source: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  /** Кнопки-действия из ответа AI (v5.1): refine/manager/lead. */
  function handleAction(action: AiAction, answer: AiAnswer) {
    if (action.type === "refine") {
      inputRef.current?.focus();
      return;
    }
    if (action.type === "manager") {
      const urlByRole: Record<string, string> = {
        retail: config.manager_retail_url,
        wholesale: config.manager_wholesale_url,
        b2b: config.manager_b2b_url,
        trade_in: config.manager_tradein_url,
      };
      const url = urlByRole[action.manager_role ?? "retail"] || config.manager_retail_url;
      if (!openExternalLink(url)) setLead({ source: "manager" });
      return;
    }
    if (action.type === "lead") {
      // product_id уже проверен backend'ом; карточку берём из этого же ответа
      const card = (answer.cards ?? []).find((c) => c.id === action.product_id);
      setLead({ card, source: "ai" });
    }
  }

  useEffect(() => { track("ai_chat_opened"); }, []);
  useEffect(() => {
    const q = params.get("q");
    if (q) submit(q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [chat, loading]);

  /** Нормализация ответа AI: даже если backend/движок вернул неполный объект
   *  (нет cards/meta/actions), UI не должен падать — рисуем что есть. */
  function normalizeAnswer(raw: Partial<AiAnswer> | null | undefined): AiAnswer {
    return {
      text: typeof raw?.text === "string" && raw.text
        ? raw.text
        : "Подобрал варианты — посмотрите карточки ниже или уточните запрос.",
      cards: Array.isArray(raw?.cards) ? raw!.cards : [],
      actions: Array.isArray(raw?.actions) ? raw!.actions : [],
      meta: raw?.meta && typeof raw.meta === "object" ? raw.meta : {},
    };
  }

  /** История для backend (v5): последние 10 текстовых сообщений, без карточек. */
  function historyPayload(items: ChatItem[]): { role: string; text: string }[] {
    return items
      .map((c) => c.role === "user"
        ? { role: "user", text: c.text }
        : { role: "assistant", text: c.answer.text })
      .filter((h) => h.text && h.text.trim().length > 0)
      .slice(-10)
      .map((h) => ({ ...h, text: h.text.slice(0, 1000) }));
  }

  async function submit(text: string) {
    const query = text.trim();
    if (!query || loading) return;
    setLoading(true);
    setValue("");
    const history = historyPayload(chat);
    setChat((c) => [...c, { role: "user", text: query }]);
    // Timeout 75с (v5.1.1) — больше backend-таймаута (65с), который в свою
    // очередь покрывает очередь gateway (10с) + inference (45с) + сеть.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 75000);
    try {
      const raw = await api<Partial<AiAnswer>>("/ai/chat", {
        method: "POST",
        body: JSON.stringify({ message: query, history }),
        signal: controller.signal,
      });
      const data = normalizeAnswer(raw);
      setChat((c) => [...c, { role: "assistant", answer: data }]);
      data.cards.forEach((card) => track("ai_product_card_viewed", { product_id: card.id, source: data.meta?.source }));
    } catch {
      // Даже при отказе AI-роута — тихий fallback на прямой поиск по каталогу
      try {
        const data = await api<{ cards?: TCard[] }>(`/catalog/search?query=${encodeURIComponent(query)}`);
        const cards = Array.isArray(data.cards) ? data.cards : [];
        setChat((c) => [...c, {
          role: "assistant",
          answer: {
            text: cards.length
              ? "Вот что нашлось в каталоге:"
              : "По запросу ничего не нашлось — попробуйте изменить бюджет или категорию.",
            cards, actions: [], meta: { source: "fallback" },
          },
        }]);
      } catch {
        setChat((c) => [...c, {
          role: "assistant",
          answer: {
            text: "Каталог сейчас недоступен. Попробуйте ещё раз через минуту или напишите менеджеру.",
            cards: [], actions: [], meta: { source: "fallback" },
          },
        }]);
      }
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }

  return (
    // pb-24 — mobile: контент чата не уходит под фиксированную строку ввода.
    // Desktop: строка ввода sticky внутри pane, поэтому lg:pb-0.
    <div className="mx-auto max-w-md pb-24 lg:max-w-none lg:pb-0">
      <div className="lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start lg:gap-8">
      {/* Desktop-sidebar: быстрые запросы + история сессии */}
      <AiSidebar chat={chat} onPick={(q) => submit(q)} disabled={loading} />

      <div className="flex min-w-0 flex-col lg:mx-auto lg:w-full lg:max-w-[860px]">
      <h1 className="text-2xl font-bold">AI-подбор техники</h1>
      <p className="mt-1 text-sm text-muted">Опишите, что вам нужно — подберём варианты из наличия</p>

      {/* Быстрые кнопки (mobile/tablet; на desktop — в sidebar) */}
      {chat.length === 0 && (
        <div className="stagger mt-4 grid grid-cols-2 gap-2 lg:hidden">
          {QUICK.map((q) => (
            <button
              key={q} onClick={() => submit(q)}
              className="card-appear tap rounded-xl2 bg-surface px-3 py-3 text-left text-[13px] font-medium shadow-soft"
            >
              {q}
            </button>
          ))}
        </div>
      )}

      {/* Desktop empty-state */}
      {chat.length === 0 && (
        <div className="mt-6 hidden rounded-xl2 border border-dashed border-border bg-surface/60 px-6 py-10 text-center lg:block">
          <span className="text-3xl">🤖</span>
          <p className="mt-2 text-sm text-muted">
            Выберите быстрый запрос слева или опишите задачу своими словами в строке ниже —
            подберём варианты из наличия.
          </p>
        </div>
      )}

      {/* Чат */}
      <div className="mt-4 space-y-3">
        {chat.map((item, i) =>
          item.role === "user" ? (
            <div key={i} className="card-appear flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white lg:max-w-[560px]">
                {item.text}
              </div>
            </div>
          ) : (
            <div key={i} className="card-appear">
              {/* max-w текста ответа на desktop ~760px — не растягиваем на всю ширину */}
              <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-surface px-4 py-3 text-sm leading-relaxed shadow-soft lg:max-w-[760px]">
                {item.answer.text}
              </div>
              {(item.answer.cards ?? []).length > 0 && (
                <div className="stagger mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:gap-4 wide:grid-cols-4">
                  {(item.answer.cards ?? []).slice(0, 6).map((c) => (
                    <ProductCard
                      key={c.id} card={c}
                      onLead={(card) => { track("ai_product_card_clicked", { product_id: card.id }); setLead({ card, source: "ai" }); }}
                    />
                  ))}
                </div>
              )}
              {/* Кнопки-действия (v5.1): только у последнего ответа, чтобы старые не путали */}
              {i === chat.length - 1 && (item.answer.actions ?? []).length > 0 && (
                <div className="fade-in mt-2.5 flex flex-wrap gap-2">
                  {(item.answer.actions ?? []).map((a) => (
                    <button
                      key={`${a.type}-${a.label}`}
                      onClick={() => handleAction(a, item.answer)}
                      className="tap rounded-full bg-surface px-3.5 py-2 text-xs font-medium text-text shadow-soft transition-colors hover:bg-accent hover:text-white"
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ),
        )}

        {/* Typing indicator */}
        {loading && (
          <div className="fade-in flex items-center gap-1.5 rounded-2xl rounded-bl-md bg-surface px-4 py-3.5 shadow-soft" style={{ width: 72 }}>
            <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
            <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
            <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
          </div>
        )}
        {/* scroll-mb-40: автоскролл оставляет последнюю карточку над фикс-строкой ввода */}
        <div ref={endRef} className="scroll-mb-40" />
      </div>

      {/* Строка ввода: mobile — фиксирована над нижней навигацией; desktop — sticky
          снизу внутри чат-pane (main — скролл-контейнер, sticky bottom работает). */}
      <div className="fixed inset-x-0 bottom-[64px] z-30 border-t border-border bg-bg/95 px-4 py-2.5 backdrop-blur-lg lg:sticky lg:inset-x-auto lg:bottom-0 lg:mt-4 lg:rounded-xl2 lg:border lg:border-border lg:bg-surface/95 lg:px-3 lg:py-3">
        <div className="mx-auto flex max-w-md gap-2 lg:max-w-none">
          <input
            ref={inputRef} value={value} maxLength={1000}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit(value)}
            placeholder="Опишите, что вам нужно…"
            className="min-w-0 flex-1 rounded-xl2 bg-surface px-4 py-3.5 text-sm shadow-soft outline-none placeholder:text-muted"
          />
          <button
            onClick={() => submit(value)} disabled={loading || !value.trim()}
            className="tap flex h-12 w-12 shrink-0 items-center justify-center rounded-xl2 bg-accent text-white shadow-soft disabled:opacity-40"
            aria-label="Отправить"
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" />
            </svg>
          </button>
        </div>
      </div>

      </div>{/* /чат-pane */}
      </div>{/* /desktop grid */}

      {lead && (
        <LeadForm
          productId={lead.card?.id ?? null} productTitle={lead.card?.title ?? null}
          productPrice={lead.card?.price ?? null} source={lead.source}
          onClose={() => setLead(null)}
        />
      )}
    </div>
  );
}

/** Desktop-sidebar AI-подбора: быстрые запросы + история запросов текущей сессии. */
function AiSidebar({
  chat, onPick, disabled,
}: { chat: ChatItem[]; onPick: (q: string) => void; disabled: boolean }) {
  const history = chat.filter((c): c is Extract<ChatItem, { role: "user" }> => c.role === "user").slice(-6).reverse();
  return (
    <aside className="hidden lg:block">
      <div className="rounded-xl2 bg-surface p-2 shadow-soft">
        <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">Быстрые запросы</p>
        {QUICK.map((q) => (
          <button
            key={q} onClick={() => onPick(q)} disabled={disabled}
            className="block w-full rounded-xl px-3 py-2.5 text-left text-sm font-medium transition-colors hover:bg-mutedbg disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>

      {history.length > 0 && (
        <div className="mt-4 rounded-xl2 bg-surface p-2 shadow-soft">
          <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">История</p>
          {history.map((h, i) => (
            <button
              key={i} onClick={() => onPick(h.text)} disabled={disabled}
              className="block w-full truncate rounded-xl px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-mutedbg hover:text-text disabled:opacity-50"
            >
              {h.text}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
