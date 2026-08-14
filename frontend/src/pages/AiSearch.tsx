import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { track } from "../lib/analytics";
import { AiAction, AiAnswer, ProductCard as TCard } from "../components/ai/types";
import ProductCard, { ProductImage } from "../components/ProductCard";
import { CartGlyph } from "../components/CartBar";
import { useCart } from "../lib/cart";
import { formatPrice } from "../lib/format";
import LeadForm from "../components/LeadForm";
import { usePublicConfig } from "../lib/appConfig";
import { PoweredByClaude } from "../components/ClaudeMark";
import AiRoadmapSheet from "../components/AiRoadmapSheet";
import { openExternalLink } from "../lib/telegram";
import { aiEntryAction, clearAiHistory, loadAiHistory, pushAiQuery } from "../lib/searchHistory";
import { prefersReducedMotion, revealDurationMs, revealedChars } from "../lib/answerReveal";
import AnswerBody from "../components/AnswerBody";
import { parseAnswer, plainText } from "../lib/answerFormat";
import { Icon } from "../components/icons";

/** Намерения для товара, с карточки которого пришли. Формулировки короткие и
 *  от лица покупателя — они уходят в чат как его реплика. Товар в тексте не
 *  называем: backend знает его по id, а длинное название в пузыре мешало бы
 *  читать сам вопрос. */
const PRODUCT_INTENTS = [
  "Сравни с альтернативами",
  "Кому подойдёт",
  "Что есть дешевле",
] as const;

/** Сценарные быстрые действия: понятная подпись + что произойдёт.
 *  mode: submit — отправить готовый запрос; prefill — подставить шаблон в
 *  строку (пользователь допишет детали); manager — диалог с менеджером. */
type QuickAction = {
  label: string;
  hint: string;
  mode: "submit" | "prefill" | "manager";
  text?: string;
};

const QUICK_ACTIONS: QuickAction[] = [
  { label: "Подобрать смартфон", hint: "Бюджет и задачи — предложим варианты", mode: "submit", text: "Подобрать смартфон под мои задачи и бюджет" },
  { label: "Подобрать ноутбук", hint: "MacBook или другой — по задачам", mode: "submit", text: "Подобрать MacBook или ноутбук под мои задачи" },
  { label: "Сравнить модели", hint: "Впишите, что сравнить", mode: "prefill", text: "Сравни " },
  { label: "Вариант в бюджете", hint: "Впишите сумму и что ищете", mode: "prefill", text: "Ищу вариант до " },
  { label: "Подобрать подарок", hint: "Расскажите, кому и на какой случай", mode: "submit", text: "Помоги подобрать подарок" },
  { label: "Trade-In", hint: "Обменять или продать технику", mode: "submit", text: "Хочу сдать технику в Trade-In" },
  { label: "Для офиса / компании", hint: "Поставка юрлицу, документы", mode: "submit", text: "Нужна техника для компании" },
  { label: "Позвать менеджера", hint: "Живой диалог в Telegram", mode: "manager" },
];

type ChatItem =
  | { role: "user"; text: string }
  | { role: "assistant"; answer: AiAnswer };

/** AI-подбор в виде чата: bubble пользователя, typing, bubble ассистента + карточки.
 *  Всё через backend POST /api/ai/chat (JWT). При недоступности AI backend сам
 *  вернёт fallback/mock — пользователь никогда не видит ошибку AI. */
export default function AiSearch() {
  const [params, setParams] = useSearchParams();
  const config = usePublicConfig();
  const [value, setValue] = useState("");
  const [chat, setChat] = useState<ChatItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [lead, setLead] = useState<{ card?: TCard; source: string } | null>(null);
  const [roadmap, setRoadmap] = useState(false);
  const navigate = useNavigate();
  // Счётчик корзины: панель корзины на этом экране скрыта, вход живёт в шапке.
  const cart = useCart();
  // Локальная история запросов к AI (localStorage, между сессиями)
  const [aiHistory, setAiHistory] = useState<string[]>(() => loadAiHistory());
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  // Одноразовый guard авто-отправки (?q=…&auto=1): StrictMode/remount не должны
  // отправить запрос дважды; после потребления параметры стираются из URL.
  const autoConsumedRef = useRef(false);

  /** Кнопки-действия из ответа AI (v5.1): quick_reply/manager/lead. */
  function handleAction(action: AiAction, answer: AiAnswer) {
    if (action.type === "quick_reply") {
      // Нажатие = обычное сообщение от покупателя: диалог продолжается без
      // печати, и модель видит ровно тот текст, который написан на кнопке.
      void submit(action.label);
      return;
    }
    if (action.type === "scenario" && action.scenario) {
      navigate(`/apply/${action.scenario}`);
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

  // /ai?product=<id> — пришли с карточки товара. Товар подтягиваем из каталога
  // и показываем плашкой: человек должен видеть, о чём именно пойдёт разговор,
  // а не гадать, понял ли его AI. Сбой загрузки просто оставляет обычный чат —
  // это хуже, но не сломано.
  const [focus, setFocus] = useState<TCard | null>(null);
  useEffect(() => {
    const raw = params.get("product");
    const id = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    if (!id) return;
    track("ai_product_context_opened", { product_id: id });
    api<TCard>(`/catalog/product/${id}`)
      .then((card) => setFocus(card))
      .catch(() => setFocus(null));
    setParams(new URLSearchParams(), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // /ai?q=<text> — безопасный prefill: текст подставляется в строку, отправляет
  // его САМ пользователь. Исключение — явный переход по кнопке «Спросить AI»
  // (auto=1): тогда одна контролируемая отправка (guard от StrictMode/remount).
  useEffect(() => {
    const q = params.get("q");
    const action = aiEntryAction(q, params.get("auto") === "1", autoConsumedRef.current);
    if (action === "none") return;
    autoConsumedRef.current = true;
    track("ai_prefill_opened", { query_length: q!.length, auto: action === "submit" });
    if (action === "submit") {
      submit(q!);
    } else {
      setValue(q!);
      inputRef.current?.focus();
    }
    // Потребили параметры — чистим URL, чтобы Back/remount не повторяли prefill
    setParams(new URLSearchParams(), { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [chat, loading]);

  // Подпись под точками «печатает»: обычный ответ укладывается в 3-15с, но при
  // сетевом сбое на пути к гейтвею SDK делает до двух ретраев по 30с каждый —
  // тогда пузырь неотличимо висит до минуты. Без текста это читается как
  // «зависло», хотя запрос всё ещё выполняется. Подпись даём по реальным
  // порогам ожидания, не выдумывая проценты и таймер.
  const [waitLabel, setWaitLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!loading) { setWaitLabel(null); return; }
    const t1 = setTimeout(() => setWaitLabel("Подбираем варианты в каталоге"), 4000);
    const t2 = setTimeout(() => setWaitLabel("Ещё немного — сверяем наличие и цену"), 16000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [loading]);

  // Набор текста последнего ответа. null — «набирать нечего»: либо ответ уже
  // показан целиком, либо это старое сообщение в истории диалога.
  // Число — сколько символов показано прямо сейчас; по нему же решается,
  // пора ли прикладывать карточки (они ждут конца набора).
  const [revealChars, setRevealChars] = useState<number | null>(null);
  const revealRaf = useRef<number | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Момент, когда набор закончился и появились карточки: высота выросла, нужен
  // доскролл. Отдельным эффектом, а не вместе с [chat, loading]: там пришлось бы
  // добавить revealChars в зависимости, и скролл дёргался бы на каждом кадре.
  useEffect(() => {
    if (revealChars === null) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [revealChars]);

  /** Снять набор: показать ответ целиком. Одна точка выхода для обеих ветвей —
   *  и для кадров rAF, и для страховочного таймера. */
  function finishReveal() {
    if (revealRaf.current !== null) { cancelAnimationFrame(revealRaf.current); revealRaf.current = null; }
    if (revealTimer.current !== null) { clearTimeout(revealTimer.current); revealTimer.current = null; }
    // null вместо length: «набор закончен» и «набирать нечего» — одно состояние
    // для рендера, поэтому не держим два разных признака.
    setRevealChars(null);
  }

  /** Запустить набор текста только что полученного ответа.
   *
   *  rAF, а не setInterval: интервал не синхронизирован с кадрами и на слабом
   *  устройстве даёт рваный набор. Кадр пропущен — ничего не сломается, число
   *  символов считается от реального времени, а не накоплением шагов.
   *
   *  Плюс страховочный таймер: rAF в скрытой вкладке НЕ вызывается. Свернул
   *  Mini App посреди набора — без таймера текст остался бы недописанным, а
   *  карточки не появились бы вовсе. Таймеры в фоне работают (пусть и
   *  притормаживают), поэтому набор всегда доводится до конца. Проверено живьём:
   *  в скрытой панели браузера кадры не шли, и набор висел неоконченным. */
  function startReveal(text: string) {
    finishReveal();
    // Считаем по тексту БЕЗ разметки: символы `**` и `- ` на экран не попадают,
    // и если мерить по сырому ответу, набор «залипал» бы на невидимом.
    const length = plainText(parseAnswer(text)).length;
    // Пустой текст показываем сразу. При «уменьшить движение» набор НЕ
    // выключается — он короче: текст не движется, а проявляется, и без него
    // ответ возникал стеной (жалоба с телефона в Telegram).
    if (!length) return;
    const reduced = prefersReducedMotion();
    const startedAt = performance.now();
    const total = revealDurationMs(length, reduced);
    setRevealChars(0);
    const step = () => {
      const elapsed = performance.now() - startedAt;
      if (elapsed >= total) { finishReveal(); return; }
      setRevealChars(revealedChars(length, elapsed, reduced));
      revealRaf.current = requestAnimationFrame(step);
    };
    revealRaf.current = requestAnimationFrame(step);
    // Запас 400мс: если кадры идут нормально, таймер не успевает сработать.
    revealTimer.current = setTimeout(finishReveal, total + 400);
  }

  // Уход с экрана посреди набора не должен оставлять висящий кадр или таймер.
  useEffect(() => () => {
    if (revealRaf.current !== null) cancelAnimationFrame(revealRaf.current);
    if (revealTimer.current !== null) clearTimeout(revealTimer.current);
  }, []);

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

  /** Обработка сценарной карточки: submit/prefill/manager. */
  function handleQuick(qa: QuickAction) {
    if (qa.mode === "manager") {
      handleAction({ type: "manager", label: qa.label, manager_role: "retail" }, { text: "", cards: [], actions: [], meta: {} });
      return;
    }
    if (qa.mode === "prefill") {
      setValue(qa.text ?? "");
      inputRef.current?.focus();
      return;
    }
    submit(qa.text ?? qa.label);
  }

  /** Добавить ответ ассистента и начать его набор. Единая точка: ответов три
   *  вида (AI, fallback-поиск, недоступный каталог), и набор должен вести себя
   *  одинаково у всех — иначе fallback появлялся бы рывком на фоне плавного AI. */
  function pushAnswer(answer: AiAnswer) {
    setChat((c) => [...c, { role: "assistant", answer }]);
    startReveal(answer.text ?? "");
  }

  async function submit(text: string) {
    const query = text.trim();
    if (!query || loading) return;
    setAiHistory(pushAiQuery(query));
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
        // product_id держится всю беседу, а не только на первый вопрос:
        // «а что дешевле?» следующей репликой всё ещё про этот товар.
        body: JSON.stringify({ message: query, history, product_id: focus?.id ?? null }),
        signal: controller.signal,
      });
      const data = normalizeAnswer(raw);
      pushAnswer(data);
      data.cards.forEach((card) => track("ai_product_card_viewed", { product_id: card.id, source: data.meta?.source }));
    } catch {
      // Даже при отказе AI-роута — тихий fallback на прямой поиск по каталогу
      try {
        const data = await api<{ cards?: TCard[] }>(`/catalog/search?query=${encodeURIComponent(query)}`);
        const cards = Array.isArray(data.cards) ? data.cards : [];
        pushAnswer({
          text: cards.length
            ? "Вот что нашлось в каталоге:"
            : "По запросу ничего не нашлось — попробуйте изменить бюджет или категорию.",
          cards, actions: [], meta: { source: "fallback" },
        });
      } catch {
        pushAnswer({
          text: "Каталог сейчас недоступен. Попробуйте ещё раз через минуту или напишите менеджеру.",
          cards: [], actions: [], meta: { source: "fallback" },
        });
      }
    } finally {
      clearTimeout(timer);
      setLoading(false);
    }
  }

  return (
    // pb-cta (mobile) — тот же вычисляемый отступ под фиксированной строкой ввода,
    // что и у CTA товара (index.css): позиция над навбаром (safe-area) + высота бара.
    // Desktop: строка ввода sticky внутри pane, поэтому lg:pb-0.
    <div className="mx-auto max-w-md pb-cta lg:max-w-none lg:pb-0">
      <div className="lg:grid lg:grid-cols-[280px_minmax(0,1fr)] lg:items-start lg:gap-8">
      {/* Desktop-sidebar: те же сценарии, что и на mobile, + постоянная история */}
      <AiSidebar
        history={aiHistory}
        onQuick={handleQuick}
        onPick={(q) => submit(q)}
        onClearHistory={() => { clearAiHistory(); setAiHistory([]); }}
        disabled={loading}
      />

      <div className="flex min-w-0 flex-col lg:mx-auto lg:w-full lg:max-w-[860px]">
      {/* Заголовок и вход в корзину в одной строке. Кнопка нужна именно здесь:
          плавающая панель корзины на этом экране скрыта (она перекрывала строку
          ввода), и без неё корзина стала бы недостижима с экрана AI — а человек
          приходит сюда как раз выбирать, что в неё положить. */}
      <div className="flex items-start justify-between gap-3">
        <h1 className="text-2xl font-bold">AI-подбор техники</h1>
        {cart.items_count > 0 && (
          <button
            onClick={() => { track("cart_open", { source: "ai_header" }); navigate("/cart"); }}
            aria-label={`Корзина: ${cart.items_count}`}
            className="tap relative mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface shadow-soft lg:hidden"
          >
            <CartGlyph className="h-[18px] w-[18px]" />
            <span className="absolute -right-0.5 -top-0.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-white">
              {cart.items_count}
            </span>
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">Опишите, что вам нужно — подберём варианты из наличия</p>

      {/* Бейдж движка. Показывается ТОЛЬКО когда backend подтвердил, что
          отвечает действительно Claude (config.ai_vendor): на стенде с
          AI_PROVIDER=fallback ответ собирается из каталога без модели, и
          утверждать обратное значило бы соврать про собственный магазин.
          По нажатию — роудмап: чем помощник станет дальше. */}
      {config.ai_vendor === "claude" && (
        <button
          onClick={() => { track("ai_roadmap_opened", { source: "ai_header" }); setRoadmap(true); }}
          aria-haspopup="dialog"
          className="tap mt-2.5 inline-flex items-center gap-1.5 self-start rounded-full border border-border bg-surface py-1.5 pl-2.5 pr-2 transition-colors hover:bg-mutedbg"
        >
          <PoweredByClaude model={config.ai_model} />
          <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 text-muted" fill="none"
            stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="m9 18 6-6-6-6" />
          </svg>
        </button>
      )}

      {/* Контекст товара: пришли с карточки. Показываем, о ЧЁМ будет разговор,
          и предлагаем намерение в один тап — вместо километрового запроса,
          который раньше подставлялся в поле и никем не читался.
          Плашка держится всю беседу: по ней видно, что AI помнит товар. */}
      {focus && (
        <div className="fade-in mt-4 flex items-center gap-3 rounded-xl2 bg-surface p-3 shadow-soft">
          <ProductImage src={focus.image} title={focus.title} category={focus.category}
            className="h-14 w-14 shrink-0 rounded-field" compact />
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-muted">Вы смотрите</p>
            <p className="line-clamp-2 text-[13px] font-semibold leading-4">{focus.title}</p>
            <p className="mt-0.5 text-[13px] font-bold">{formatPrice(focus.price)}</p>
          </div>
          <button
            onClick={() => setFocus(null)}
            aria-label="Спрашивать не про этот товар"
            className="tap -mr-1 -mt-1 flex h-7 w-7 shrink-0 items-center justify-center self-start rounded-full text-muted hover:bg-mutedbg"
          >
            <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor"
              strokeWidth="2.4" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      )}
      {focus && chat.length === 0 && (
        <div className="stagger mt-2 flex flex-wrap gap-2">
          {PRODUCT_INTENTS.map((intent) => (
            <button
              key={intent}
              onClick={() => submit(intent)}
              disabled={loading}
              className="card-appear tap rounded-full border border-accent bg-transparent px-3.5 py-2 text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
            >
              {intent}
            </button>
          ))}
        </div>
      )}

      {/* Сценарные карточки (mobile/tablet; на desktop — в sidebar) */}
      {!focus && chat.length === 0 && (
        <div className="stagger mt-4 grid grid-cols-2 gap-2 lg:hidden">
          {QUICK_ACTIONS.map((qa) => (
            <button
              key={qa.label} onClick={() => handleQuick(qa)} disabled={loading}
              className="card-appear tap rounded-xl2 bg-surface px-3 py-3 text-left shadow-soft disabled:opacity-50"
            >
              <span className="block text-[13px] font-semibold leading-4">{qa.label}</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-muted">{qa.hint}</span>
            </button>
          ))}
        </div>
      )}

      {/* История прошлых запросов (localStorage, между сессиями) — mobile/tablet */}
      {chat.length === 0 && aiHistory.length > 0 && (
        <div className="fade-in mt-4 lg:hidden">
          <div className="flex items-baseline justify-between px-1">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Вы спрашивали</p>
            <button
              onClick={() => { clearAiHistory(); setAiHistory([]); }}
              className="text-xs font-medium text-muted transition-colors hover:text-text"
            >
              Очистить
            </button>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {aiHistory.map((h) => (
              <button
                key={h} onClick={() => submit(h)} disabled={loading}
                className="tap max-w-full truncate rounded-full bg-surface px-3 py-1.5 text-[13px] font-medium shadow-soft disabled:opacity-50"
              >
                {h}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Desktop empty-state */}
      {chat.length === 0 && (
        <div className="mt-6 hidden rounded-xl2 border border-dashed border-border bg-surface/60 px-6 py-10 text-center lg:block">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-mutedbg text-muted">
            <Icon name="bot" className="h-7 w-7" strokeWidth={1.6} />
          </span>
          <p className="mt-2 text-sm text-muted">
            Выберите быстрый запрос слева или опишите задачу своими словами в строке ниже —
            подберём варианты из наличия.
          </p>
        </div>
      )}

      {/* Чат */}
      <div className="mt-4 space-y-3">
        {chat.map((item, i) => {
          if (item.role === "user") {
            return (
              <div key={i} className="card-appear flex justify-end">
                <div className="max-w-[80%] rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-sm text-white lg:max-w-[560px]">
                  {item.text}
                </div>
              </div>
            );
          }
          // Набирается только последний ответ: старые в истории диалога всегда
          // показаны целиком, иначе прокрутка назад запускала бы анимацию заново.
          const isRevealing = revealChars !== null && i === chat.length - 1;
          const fullText = item.answer.text ?? "";
          return (
            <div key={i} className="card-appear">
              {/* max-w текста ответа на desktop ~760px — не растягиваем на всю ширину */}
              <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-surface px-4 py-3 text-sm shadow-soft lg:max-w-[760px]">
                {/* Абзацы, списки и выделения; ненабранный хвост держит размер
                    пузыря — см. комментарий в AnswerBody. */}
                <AnswerBody text={fullText} revealChars={isRevealing ? revealChars : null} />
              </div>
              {/* Карточки и кнопки прикладываются ПОСЛЕ набора текста: сначала
                  читаешь ответ, потом появляются варианты. */}
              {!isRevealing && (item.answer.cards ?? []).length > 0 && (
                <div className="stagger mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:gap-4 wide:grid-cols-4">
                  {(item.answer.cards ?? []).slice(0, 6).map((c) => (
                    <ProductCard
                      key={c.id} card={c}
                      onOpen={(card) => track("ai_product_card_clicked", { product_id: card.id })}
                    />
                  ))}
                </div>
              )}
              {/* Кнопки-действия (v5.1): только у последнего ответа, чтобы старые не путали */}
              {!isRevealing && i === chat.length - 1 && (item.answer.actions ?? []).length > 0 && (
                <div className="fade-in mt-2.5 flex flex-wrap gap-2">
                  {/* Быстрые ответы — реплики ПОКУПАТЕЛЯ, поэтому обведены
                      акцентом: визуально это продолжение его стороны диалога,
                      а не системное действие вроде «Позвать менеджера». */}
                  {(item.answer.actions ?? []).map((a) => (
                    <button
                      key={`${a.type}-${a.label}`}
                      onClick={() => handleAction(a, item.answer)}
                      disabled={loading}
                      className={
                        a.type === "quick_reply"
                          ? "tap rounded-full border border-accent bg-transparent px-3.5 py-2 text-xs font-medium text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
                          : "tap rounded-full bg-surface px-3.5 py-2 text-xs font-medium text-text shadow-soft transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
                      }
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}

        {/* Typing indicator: пузырь растёт по контенту, а не фиксированной
            ширины — подпись ожидания (см. waitLabel выше) не должна обрезаться. */}
        {loading && (
          // w-fit обязателен. Контейнер чата — блочный, поэтому пузырь без него
          // растягивался во всю ширину экрана: три точки посреди пустой панели
          // читались как сломанная заглушка, а не как «собеседник печатает».
          <div className="fade-in flex w-fit max-w-[92%] flex-col items-start gap-1.5 rounded-2xl rounded-bl-md bg-surface px-4 py-3.5 shadow-soft">
            <div className="flex items-center gap-1.5">
              <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
              <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
              <span className="typing-dot h-2 w-2 rounded-full bg-muted" />
            </div>
            {waitLabel && <span className="fade-in text-xs text-muted">{waitLabel}</span>}
          </div>
        )}
        {/* scroll-mb-40: автоскролл оставляет последнюю карточку над фикс-строкой ввода */}
        <div ref={endRef} className="scroll-mb-40" />
      </div>

      {/* Строка ввода: mobile — фиксирована над нижней навигацией; desktop — sticky
          снизу внутри чат-pane (main — скролл-контейнер, sticky bottom работает). */}
      <div className="fixed inset-x-0 cta-dock z-30 border-t border-border bg-bg px-4 pt-2.5 lg:sticky lg:inset-x-auto lg:bottom-0 lg:mt-4 lg:rounded-xl2 lg:border lg:border-border lg:bg-surface lg:px-3 lg:py-3">
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

      {roadmap && (
        <AiRoadmapSheet model={config.ai_model} onClose={() => setRoadmap(false)} />
      )}
    </div>
  );
}

/** Desktop-sidebar AI-подбора: сценарии (те же, что на mobile) + постоянная
 *  история запросов (localStorage, между сессиями) с очисткой. */
function AiSidebar({
  history, onQuick, onPick, onClearHistory, disabled,
}: {
  history: string[];
  onQuick: (qa: QuickAction) => void;
  onPick: (q: string) => void;
  onClearHistory: () => void;
  disabled: boolean;
}) {
  return (
    <aside className="hidden lg:block">
      <div className="rounded-xl2 bg-surface p-2 shadow-soft">
        <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">Сценарии</p>
        {QUICK_ACTIONS.map((qa) => (
          <button
            key={qa.label} onClick={() => onQuick(qa)} disabled={disabled}
            className="block w-full rounded-xl px-3 py-2 text-left transition-colors hover:bg-mutedbg disabled:opacity-50"
          >
            <span className="block text-sm font-medium">{qa.label}</span>
            <span className="block text-xs text-muted">{qa.hint}</span>
          </button>
        ))}
      </div>

      {history.length > 0 && (
        <div className="mt-4 rounded-xl2 bg-surface p-2 shadow-soft">
          <div className="flex items-baseline justify-between px-3 pb-1 pt-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">История</p>
            <button
              onClick={onClearHistory}
              className="text-xs font-medium text-muted transition-colors hover:text-text"
            >
              Очистить
            </button>
          </div>
          {history.map((h) => (
            <button
              key={h} onClick={() => onPick(h)} disabled={disabled}
              className="block w-full truncate rounded-xl px-3 py-2 text-left text-sm text-muted transition-colors hover:bg-mutedbg hover:text-text disabled:opacity-50"
            >
              {h}
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
