import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { AiAnswer, ProductCard as TCard } from "../components/ai/types";
import ProductCard from "../components/ProductCard";
import LeadForm from "../components/LeadForm";

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
  const [value, setValue] = useState("");
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [lead, setLead] = useState<{ card?: TCard; source: string } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

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

  async function submit(text: string) {
    const query = text.trim();
    if (!query || loading) return;
    setLoading(true);
    setValue("");
    setChat((c) => [...c, { role: "user", text: query }]);
    try {
      const raw = await api<Partial<AiAnswer>>("/ai/chat", { method: "POST", body: JSON.stringify({ message: query }) });
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
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col">
      <h1 className="text-2xl font-bold">AI-подбор техники</h1>
      <p className="mt-1 text-sm text-muted">Опишите, что вам нужно — подберём варианты из наличия</p>

      {/* Быстрые кнопки */}
      {chat.length === 0 && (
        <div className="stagger mt-4 grid grid-cols-2 gap-2">
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

      {/* Чат */}
      <div className="mt-4 space-y-3">
        {chat.map((item, i) =>
          item.role === "user" ? (
            <div key={i} className="card-appear flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white">
                {item.text}
              </div>
            </div>
          ) : (
            <div key={i} className="card-appear">
              <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-surface px-4 py-3 text-sm leading-relaxed shadow-soft">
                {item.answer.text}
              </div>
              {(item.answer.cards ?? []).length > 0 && (
                <div className="stagger mt-3 grid grid-cols-2 gap-3">
                  {(item.answer.cards ?? []).slice(0, 6).map((c) => (
                    <ProductCard
                      key={c.id} card={c}
                      onLead={(card) => { track("ai_product_card_clicked", { product_id: card.id }); setLead({ card, source: "ai" }); }}
                    />
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
        <div ref={endRef} />
      </div>

      {/* Input снизу */}
      <div className="sticky bottom-0 mt-4 flex gap-2 bg-bg pb-1 pt-2">
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
