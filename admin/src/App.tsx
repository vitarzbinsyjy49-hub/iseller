import { useEffect, useState } from "react";
import {
  C, card, input, btn, btnGhost, chip, apiGet, apiPatch, apiPost, fmtPrice, fmtDateTime, storefrontUrl,
  STATUSES, STATUS_RU, SOURCE_RU, LEAD_TYPES, LEAD_TYPE_RU, FULFILLMENT_RU, AVAILABILITY_RU,
  leadMetaRows, storeTokens, clearTokens, loadStoredAccessToken, onTokenRefreshed,
} from "./ui";
import { Products } from "./Products";
import { Analytics, AiLogs } from "./Analytics";
import { ImportCenter, HomeContent, MediaTab } from "./HomeAdmin";
import { Posts } from "./Posts";
import { PricePosts } from "./PricePosts";
import { ChannelPosts } from "./ChannelPosts";
import { Customers } from "./Customers";
import PromoCodes from "./PromoCodes";

export default function App() {
  const [token, setToken] = useState<string | null>(() => loadStoredAccessToken());
  useEffect(() => {
    onTokenRefreshed((fresh) => setToken(fresh));
    return () => onTokenRefreshed(null);
  }, []);
  return token
    ? <Shell token={token} onLogout={() => { clearTokens(); setToken(null); }} />
    : <Login onToken={setToken} />;
}

// ---------- Login ----------
/** Локальный ли это запуск. Кнопка тестового входа существует ТОЛЬКО здесь.
 *
 *  Две независимые защиты, и ни одна из них не полагается на флаг сборки:
 *  1) кнопка не рисуется нигде, кроме localhost;
 *  2) сам маршрут /auth/admin/dev при DEV_MODE=false отдаёт 404 — решение
 *     принимает сервер, а не клиент.
 *  Поэтому production-бандл, открытый на боевом домене, этой кнопки не покажет,
 *  а если бы и показал — она бы не сработала. */
function isLocalHost(): boolean {
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h === "[::1]";
}

function Login({ onToken }: { onToken: (t: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [devAvailable, setDevAvailable] = useState(false);

  // Спрашиваем сервер, доступен ли тестовый вход. 404 — обычный ответ прода,
  // поэтому ошибку не показываем: кнопки просто не будет.
  useEffect(() => {
    if (!isLocalHost()) return;
    fetch("/api/config").then(() => setDevAvailable(true)).catch(() => setDevAvailable(false));
  }, []);

  async function devLogin() {
    setError("");
    const res = await fetch("/api/auth/admin/dev", { method: "POST" });
    if (!res.ok) {
      setError("Тестовый вход недоступен: сервер запущен не в DEV_MODE");
      return;
    }
    const data = await res.json();
    storeTokens(data.access_token, data.refresh_token);
    onToken(data.access_token);
  }

  async function submit() {
    setError("");
    const res = await fetch("/api/auth/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) { setError("Неверный email или пароль"); return; }
    const data = await res.json();
    storeTokens(data.access_token, data.refresh_token);
    onToken(data.access_token);
  }

  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: C.bg, color: C.text }}>
      <div style={{ ...card, width: 340 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 40, height: 40, borderRadius: 12, background: C.accent, color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 13 }}>AI</div>
          <div>
            <h1 style={{ margin: 0, fontSize: 18 }}>AI Seller — Админ</h1>
            <p style={{ color: C.sub, fontSize: 13, margin: 0 }}>Центр управления магазином</p>
          </div>
        </div>
        <label style={{ display: "block", marginTop: 18, fontSize: 13, color: C.sub }}>
          Email<input style={input} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label style={{ display: "block", marginTop: 12, fontSize: 13, color: C.sub }}>
          Пароль
          <input style={input} type="password" value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()} />
        </label>
        {error && <p style={{ color: C.red, fontSize: 13 }}>{error}</p>}
        <button style={{ ...btn, width: "100%", marginTop: 16 }} onClick={submit}>Войти</button>
        {isLocalHost() && devAvailable && (
          <>
            <button
              style={{ ...btnGhost, width: "100%", marginTop: 8 }}
              onClick={devLogin}
              data-testid="dev-admin-login"
            >
              Тестовый вход (только локально)
            </button>
            <p style={{ color: C.sub, fontSize: 11, marginTop: 6, marginBottom: 0, textAlign: "center" }}>
              Без пароля. На боевом домене кнопки нет, а маршрут отдаёт 404.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- Shell with tabs ----------
type Tab = "dashboard" | "leads" | "customers" | "promo" | "products" | "posts" | "price" | "channel" | "import" | "home" | "media" | "analytics" | "ai";
const TABS: { key: Tab; label: string }[] = [
  { key: "dashboard", label: "Дашборд" },
  { key: "leads", label: "Заявки" },
  { key: "customers", label: "Клиенты" },
  { key: "promo", label: "Промокоды" },
  { key: "products", label: "Товары" },
  { key: "posts", label: "Посты" },
  { key: "price", label: "Прайс канала" },
  { key: "channel", label: "Посты канала" },
  { key: "import", label: "Импорт" },
  { key: "home", label: "Главная" },
  { key: "media", label: "Медиа" },
  { key: "analytics", label: "Аналитика" },
  { key: "ai", label: "AI-логи" },
];

function Shell({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("dashboard");

  return (
    <div style={{ minHeight: "100vh", background: C.bg, color: C.text }}>
      <header style={{
        display: "flex", alignItems: "center", gap: 16, padding: "14px 24px",
        borderBottom: `1px solid ${C.border}`, background: C.surface, position: "sticky", top: 0, zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 32, height: 32, borderRadius: 10, background: C.accent, color: "#fff", display: "grid", placeItems: "center", fontWeight: 700, fontSize: 12 }}>AI</div>
          <h1 style={{ margin: 0, fontSize: 16 }}>AI Seller Admin</h1>
        </div>
        <nav style={{ display: "flex", gap: 6, flex: 1, flexWrap: "wrap" }}>
          {TABS.map((t) => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{
                padding: "7px 14px", borderRadius: 999, cursor: "pointer", border: "none", fontSize: 14,
                background: tab === t.key ? C.accent : "transparent",
                color: tab === t.key ? "#fff" : C.sub, fontWeight: tab === t.key ? 600 : 400,
              }}>
              {t.label}
            </button>
          ))}
        </nav>
        <button style={{ padding: "8px 14px", borderRadius: 10, cursor: "pointer", background: "transparent", color: C.sub, border: `1px solid ${C.border}` }} onClick={onLogout}>
          Выйти
        </button>
      </header>
      <main style={{ padding: 24, maxWidth: 1150, margin: "0 auto" }}>
        {tab === "dashboard" && <Dashboard token={token} />}
        {tab === "leads" && <Leads token={token} />}
        {tab === "customers" && <Customers token={token} />}
        {tab === "promo" && <PromoCodes token={token} />}
        {tab === "products" && <Products token={token} />}
        {tab === "posts" && <Posts token={token} />}
        {tab === "price" && <PricePosts token={token} />}
        {tab === "channel" && <ChannelPosts token={token} />}
        {tab === "import" && <ImportCenter token={token} />}
        {tab === "home" && <HomeContent token={token} />}
        {tab === "media" && <MediaTab token={token} />}
        {tab === "analytics" && <Analytics token={token} />}
        {tab === "ai" && <AiLogs token={token} />}
      </main>
    </div>
  );
}

// ---------- Dashboard ----------
type DashLead = {
  id: number; name: string | null; product_title: string | null; product_price: number | null;
  status: string; created_at: string;
};
type Dash = {
  users_total: number; leads_total: number; leads_today: number; cart_leads_total?: number; ai_queries: number;
  app_opens: number; conversion_pct: number; products_in_stock: number;
  recent_leads: DashLead[];
  top_products: { id: number; title: string; views: number }[];
  recent_events: { event: string; payload: Record<string, unknown>; created_at: string }[];
};

function Dashboard({ token }: { token: string }) {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { apiGet<Dash>("/admin/dashboard", token).then(setD).catch((e) => setErr(String(e))); }, [token]);
  if (err) return <p style={{ color: C.red }}>Ошибка загрузки: {err}</p>;
  if (!d) return <p style={{ color: C.sub }}>Загрузка…</p>;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 14 }}>
        <Metric label="Заявки сегодня" value={d.leads_today} accent />
        <Metric label="Всего заявок" value={d.leads_total} />
        <Metric label="Из корзины" value={d.cart_leads_total ?? 0} />
        <Metric label="AI-запросы" value={d.ai_queries} />
        <Metric label="Пользователи" value={d.users_total} />
        <Metric label="Товары в наличии" value={d.products_in_stock} />
        <Metric label="Конверсия" value={`${d.conversion_pct}%`} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 14, marginTop: 14 }}>
        <div style={card}>
          <h3 style={{ marginTop: 0, fontSize: 15 }}>Последние заявки</h3>
          {d.recent_leads.length === 0 ? <p style={{ color: C.sub, fontSize: 14 }}>Заявок пока нет</p> :
            d.recent_leads.map((l) => (
              <div key={l.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "8px 0", borderBottom: `1px solid ${C.border}`, fontSize: 14 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {l.name || "—"} · {l.product_title || "консультация"}
                </span>
                <span style={{ color: C.sub, whiteSpace: "nowrap" }}>{fmtPrice(l.product_price)}</span>
                <StatusPill status={l.status} />
              </div>
            ))}
        </div>
        <div>
          <div style={card}>
            <h3 style={{ marginTop: 0, fontSize: 15 }}>Популярные товары</h3>
            {d.top_products.length === 0 ? <p style={{ color: C.sub, fontSize: 14 }}>Пока нет просмотров</p> :
              d.top_products.map((p) => (
                <div key={p.id} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 14 }}>
                  <span>{p.title}</span><span style={{ color: C.sub }}>{p.views} просм.</span>
                </div>
              ))}
          </div>
          <div style={{ ...card, marginTop: 14 }}>
            <h3 style={{ marginTop: 0, fontSize: 15 }}>Последние события</h3>
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {d.recent_events.map((e, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "4px 0" }}>
                  <span style={{ color: C.accentDark }}>{e.event}</span>
                  <span style={{ color: C.sub }}>{new Date(e.created_at).toLocaleTimeString("ru-RU")}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div style={{ ...card, padding: 16, background: accent ? C.accent : C.surface }}>
      <p style={{ margin: 0, color: accent ? "rgba(255,255,255,.85)" : C.sub, fontSize: 13 }}>{label}</p>
      <p style={{ margin: "6px 0 0", fontSize: 26, fontWeight: 700, color: accent ? "#fff" : C.text }}>{value}</p>
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const bg: Record<string, string> = {
    new: "#e3f2fd", in_progress: "#fff3d6", reserved: "#eaf7ea", completed: "#eaf7ea", cancelled: C.muted,
  };
  const fg: Record<string, string> = {
    new: C.accentDark, in_progress: "#b57e00", reserved: C.green, completed: C.green, cancelled: C.sub,
  };
  return (
    <span style={{ background: bg[status] ?? C.muted, color: fg[status] ?? C.sub, borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
      {STATUS_RU[status] ?? status}
    </span>
  );
}

// ---------- Leads ----------
type LeadItem = {
  id: number; product_id: number | null; sku: string | null; title: string;
  price: number | null; quantity: number; line_total: number | null;
  availability_mode: string | null; image: string | null;
  // Приходит только в деталях: актуальное состояние того же товара сейчас.
  current_price?: number | null; current_title?: string | null;
  product_exists?: boolean; product_active?: boolean; price_diff?: number | null;
};

type Lead = {
  id: number; public_number?: string;
  name: string | null; phone: string | null; username: string | null;
  telegram_id?: number | null;
  product_title: string | null; product_price: number | null; message: string | null;
  source: string; delivery_method: string | null; status: string;
  lead_type: string; metadata: Record<string, unknown> | null;
  manager_comment: string | null; assigned_to?: string | null;
  created_at: string; updated_at?: string | null;
  items_count?: number; estimated_total?: number | null; currency?: string;
  items?: LeadItem[];
  status_history?: { from: string | null; to: string | null; actor: string; created_at: string | null }[];
};

// Цвета pill-типа заявки (нейтральные, читаемые на светлой теме админки)
const TYPE_PILL: Record<string, { bg: string; fg: string }> = {
  general: { bg: C.muted, fg: C.sub },
  product: { bg: "#e3f2fd", fg: C.accentDark },
  trade_in: { bg: "#eafaf0", fg: "#0e9f6e" },
  b2b: { bg: "#eef0ff", fg: "#5b5bd6" },
  wholesale: { bg: "#fff3d6", fg: "#b57e00" },
  sell_item: { bg: "#fdf2e9", fg: "#c2570c" },
};

function TypePill({ type }: { type: string }) {
  const c = TYPE_PILL[type] ?? TYPE_PILL.general;
  return (
    <span style={{ background: c.bg, color: c.fg, borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
      {LEAD_TYPE_RU[type] ?? type}
    </span>
  );
}

function Leads({ token }: { token: string }) {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filter, setFilter] = useState("");
  const [sourceFilter, setSourceFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);

  function load() {
    setLoading(true);
    const qs = new URLSearchParams();
    if (filter) qs.set("status_filter", filter);
    if (sourceFilter) qs.set("source_filter", sourceFilter);
    if (typeFilter) qs.set("type_filter", typeFilter);
    apiGet<{ leads: Lead[] }>(`/admin/leads?${qs.toString()}`, token)
      .then((d) => setLeads(d.leads)).finally(() => setLoading(false));
  }
  useEffect(load, [filter, sourceFilter, typeFilter]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <button onClick={() => setFilter("")} style={chip(filter === "")}>Все</button>
        {STATUSES.map((s) => <button key={s} onClick={() => setFilter(s)} style={chip(filter === s)}>{STATUS_RU[s]}</button>)}
        <span style={{ width: 12 }} />
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
          style={{ ...chip(typeFilter !== ""), appearance: "none" as const }}>
          <option value="">Тип: все</option>
          {LEAD_TYPES.map((k) => <option key={k} value={k}>{LEAD_TYPE_RU[k]}</option>)}
        </select>
        <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}
          style={{ ...chip(sourceFilter !== ""), appearance: "none" as const }}>
          <option value="">Источник: все</option>
          {Object.entries(SOURCE_RU).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>

      {loading ? <p style={{ color: C.sub }}>Загрузка…</p> :
        leads.length === 0 ? <p style={{ color: C.sub }}>Заявок нет</p> : (
          // Таблица, а не карточки: заявка из корзины — это состав, сумма и
          // способ получения, и сравнивать их между заявками нужно взглядом
          // по колонке, а не листая карточки.
          <div style={{ ...card, padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: C.sub, textAlign: "left" }}>
                  {["№", "Дата", "Клиент", "Телефон", "Telegram", "Позиции", "Сумма",
                    "Получение", "Статус", "Источник", "Менеджер", ""].map((h) => (
                    <th key={h} style={{ padding: "10px 12px", borderBottom: `1px solid ${C.border}`, fontWeight: 600, whiteSpace: "nowrap" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id}>
                    <td style={td}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <strong>{l.public_number ?? `№${l.id}`}</strong>
                        <TypePill type={l.lead_type || "general"} />
                      </div>
                      <div style={{ color: C.sub, marginTop: 2, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {l.product_title || "Консультация"}
                      </div>
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", color: C.sub }}>{fmtDateTime(l.created_at)}</td>
                    <td style={td}>{l.name || "—"}</td>
                    <td style={td}>
                      {l.phone ? <a href={`tel:${l.phone}`} style={{ color: C.accentDark }}>{l.phone}</a> : "—"}
                    </td>
                    <td style={td}>
                      {/* Открываем диалог только по существующему username: ссылка
                          по числовому id в Telegram не работает и вводит в заблуждение. */}
                      {l.username
                        ? <a href={`https://t.me/${l.username}`} target="_blank" rel="noopener noreferrer" style={{ color: C.accentDark }}>@{l.username}</a>
                        : "—"}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      {l.lead_type === "cart"
                        ? `${l.items?.length ?? 0} поз. · ${l.items_count ?? 0} шт`
                        : "—"}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap", fontWeight: 600 }}>
                      {l.estimated_total != null ? fmtPrice(l.estimated_total) : fmtPrice(l.product_price)}
                    </td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>
                      {l.delivery_method ? (FULFILLMENT_RU[l.delivery_method] ?? l.delivery_method) : "—"}
                    </td>
                    <td style={td}><StatusPill status={l.status} /></td>
                    <td style={{ ...td, color: C.sub, whiteSpace: "nowrap" }}>{SOURCE_RU[l.source] ?? l.source}</td>
                    <td style={{ ...td, color: C.sub }}>{l.assigned_to || "—"}</td>
                    <td style={td}>
                      <button style={{ ...btnGhost, padding: "6px 10px", fontSize: 13 }} onClick={() => setOpenId(l.id)}>
                        Открыть
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

      {openId != null && (
        <LeadDetail
          token={token}
          leadId={openId}
          onClose={() => setOpenId(null)}
          onSaved={() => { load(); }}
        />
      )}
    </div>
  );
}

const td: React.CSSProperties = {
  padding: "10px 12px", borderBottom: `1px solid ${C.border}`, verticalAlign: "top",
};

/** Детали заявки: состав, снапшот против актуального каталога, действия менеджера.
 *
 *  Снапшот здесь только показывается. Редактирования состава нет и быть не
 *  должно: заявка — это то, что отправил покупатель, и незаметная правка задним
 *  числом лишает её смысла. Менеджер меняет статус, ответственного и заметку. */
function LeadDetail({
  token, leadId, onClose, onSaved,
}: { token: string; leadId: number; onClose: () => void; onSaved: () => void }) {
  const [lead, setLead] = useState<Lead | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [assignee, setAssignee] = useState("");
  const [copied, setCopied] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [published, setPublished] = useState(false);

  const reload = () => {
    apiGet<Lead>(`/admin/leads/${leadId}`, token)
      .then((d) => { setLead(d); setNote(d.manager_comment ?? ""); setAssignee(d.assigned_to ?? ""); })
      .catch((e) => setError(String(e)));
  };
  useEffect(reload, [leadId, token]);

  async function patch(body: Record<string, unknown>) {
    try {
      await apiPatch(`/admin/leads/${leadId}`, token, body);
      reload();
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    }
  }

  /** Состав заявки текстом — то, что менеджер вставит в переписку с клиентом. */
  async function copyComposition() {
    if (!lead) return;
    const lines = (lead.items ?? []).map(
      (i) => `${i.title}${i.sku ? ` (${i.sku})` : ""} — ${i.quantity} шт × ${fmtPrice(i.price)} = ${fmtPrice(i.line_total)}`,
    );
    const text = [
      `Заявка ${lead.public_number ?? `№${lead.id}`} от ${fmtDateTime(lead.created_at)}`,
      ...lines,
      `Предварительно: ${fmtPrice(lead.estimated_total)}`,
    ].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setError("Буфер обмена недоступен — скопируйте состав вручную");
    }
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(17,24,39,.45)", zIndex: 50,
        display: "grid", placeItems: "center", padding: 20,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{ ...card, width: "min(920px, 100%)", maxHeight: "88vh", overflowY: "auto" }}
      >
        {error && <p style={{ color: C.red, fontSize: 13 }}>{error}</p>}
        {!lead ? <p style={{ color: C.sub }}>Загрузка…</p> : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>Заявка {lead.public_number ?? `№${lead.id}`}</h2>
                <TypePill type={lead.lead_type || "general"} />
                <StatusPill status={lead.status} />
              </div>
              <button style={{ ...btnGhost, padding: "6px 12px" }} onClick={onClose}>Закрыть</button>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", marginTop: 8, fontSize: 13, color: C.sub }}>
              <span>Создана: {fmtDateTime(lead.created_at)}</span>
              <span>Обновлена: {fmtDateTime(lead.updated_at)}</span>
              <span>Источник: {SOURCE_RU[lead.source] ?? lead.source}</span>
              <span>Получение: {lead.delivery_method ? (FULFILLMENT_RU[lead.delivery_method] ?? lead.delivery_method) : "—"}</span>
            </div>

            {/* ---- Контакты ---- */}
            <div style={{ marginTop: 14, padding: 12, background: C.muted, borderRadius: 12, fontSize: 14 }}>
              <strong>{lead.name || "Без имени"}</strong>
              {lead.phone && <> · <a href={`tel:${lead.phone}`} style={{ color: C.accentDark }}>{lead.phone}</a></>}
              {lead.username && (
                <> · <a href={`https://t.me/${lead.username}`} target="_blank" rel="noopener noreferrer" style={{ color: C.accentDark }}>@{lead.username}</a></>
              )}
              {lead.message && <p style={{ margin: "8px 0 0", wordBreak: "break-word" }}>{lead.message}</p>}
            </div>

            {/* ---- Состав ---- */}
            {(lead.items ?? []).length > 0 ? (
              <>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 18 }}>
                  <h3 style={{ margin: 0, fontSize: 15 }}>Состав заявки</h3>
                  <button style={{ ...btnGhost, padding: "6px 12px", fontSize: 13 }} onClick={copyComposition}>
                    {copied ? "Скопировано" : "Копировать состав"}
                  </button>
                </div>
                <div style={{ overflowX: "auto", marginTop: 8 }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <thead>
                      <tr style={{ color: C.sub, textAlign: "left" }}>
                        {["Фото", "Товар", "SKU", "Цена в заявке", "Цена сейчас", "Кол-во", "Сумма", "Наличие", ""].map((h) => (
                          <th key={h} style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(lead.items ?? []).map((i) => {
                        const link = i.product_id ? storefrontUrl(`/product/${i.product_id}`) : null;
                        return (
                          <tr key={i.id}>
                            <td style={td}>
                              {i.image
                                ? <img src={i.image} alt="" style={{ width: 40, height: 40, objectFit: "contain", background: C.muted, borderRadius: 8 }} />
                                : <div style={{ width: 40, height: 40, background: C.muted, borderRadius: 8 }} />}
                            </td>
                            <td style={td}>
                              <div style={{ fontWeight: 600 }}>{i.title}</div>
                              {/* Название в каталоге изменилось — показываем оба:
                                  менеджер должен понимать, что именно заказывали. */}
                              {i.current_title && i.current_title !== i.title && (
                                <div style={{ color: C.sub, marginTop: 2 }}>Сейчас в каталоге: {i.current_title}</div>
                              )}
                              {i.product_exists === false && (
                                <div style={{ color: C.red, marginTop: 2 }}>Товар удалён из каталога</div>
                              )}
                              {i.product_exists && i.product_active === false && (
                                <div style={{ color: C.yellow, marginTop: 2 }}>Скрыт с витрины</div>
                              )}
                            </td>
                            <td style={{ ...td, color: C.sub, whiteSpace: "nowrap" }}>{i.sku || "—"}</td>
                            <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtPrice(i.price)}</td>
                            <td style={{ ...td, whiteSpace: "nowrap" }}>
                              {i.current_price == null ? "—" : (
                                <>
                                  {fmtPrice(i.current_price)}
                                  {!!i.price_diff && (
                                    <div style={{ color: i.price_diff > 0 ? C.red : C.green, fontSize: 12 }}>
                                      {i.price_diff > 0 ? "+" : ""}{fmtPrice(i.price_diff)}
                                    </div>
                                  )}
                                </>
                              )}
                            </td>
                            <td style={{ ...td, whiteSpace: "nowrap" }}>{i.quantity}</td>
                            <td style={{ ...td, whiteSpace: "nowrap", fontWeight: 600 }}>{fmtPrice(i.line_total)}</td>
                            <td style={{ ...td, color: C.sub, whiteSpace: "nowrap" }}>
                              {i.availability_mode ? (AVAILABILITY_RU[i.availability_mode] ?? i.availability_mode) : "—"}
                            </td>
                            <td style={td}>
                              {link && (
                                <a href={link} target="_blank" rel="noopener noreferrer" style={{ color: C.accentDark, whiteSpace: "nowrap" }}>
                                  Открыть
                                </a>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p style={{ marginTop: 10, textAlign: "right", fontSize: 15 }}>
                  Предварительная сумма: <strong>{fmtPrice(lead.estimated_total)}</strong>
                  <span style={{ color: C.sub, fontSize: 13 }}> · {lead.items_count ?? 0} шт</span>
                </p>
              </>
            ) : (
              // Одиночная заявка: позиций нет, показываем товар как раньше.
              <div style={{ marginTop: 16, fontSize: 14 }}>
                <strong>{lead.product_title || "Консультация"}</strong>
                {lead.product_price != null && <span> · {fmtPrice(lead.product_price)}</span>}
              </div>
            )}

            {/* ---- Ответы сценария (Trade-In/B2B/опт) ---- */}
            {leadMetaRows(lead.metadata).length > 0 && (
              <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
                {leadMetaRows(lead.metadata).map((r) => (
                  <span key={r.label} style={{ fontSize: 13 }}>
                    <span style={{ color: C.sub }}>{r.label}:</span> <span style={{ fontWeight: 600 }}>{r.value}</span>
                  </span>
                ))}
              </div>
            )}

            {/* ---- Фото заявки «Предложить товар» ---- */}
            {lead.lead_type === "sell_item" &&
              Array.isArray((lead.metadata as Record<string, unknown> | undefined)?.photos) &&
              ((lead.metadata as Record<string, unknown>).photos as string[]).length > 0 && (
              <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 8 }}>
                {((lead.metadata as Record<string, unknown>).photos as string[]).map((url, i) => (
                  <a key={url} href={url} target="_blank" rel="noopener noreferrer">
                    <img
                      src={url} alt={`Фото ${i + 1}`}
                      style={{ width: 88, height: 88, objectFit: "cover", borderRadius: 10, border: `1px solid ${C.border}` }}
                    />
                  </a>
                ))}
              </div>
            )}

            {/* ---- Действия менеджера ---- */}
            {lead.lead_type === "sell_item" && lead.status !== "cancelled" && lead.status !== "completed" && !published && (
              <button
                style={btn}
                disabled={publishing}
                onClick={async () => {
                  setPublishError(null);
                  const meta = (lead.metadata as Record<string, unknown>) || {};
                  const price = Number(meta.price_wanted);
                  if (!Number.isFinite(price) || price <= 0) {
                    // price_wanted у "Предложить товар" бывает нечисловым текстом
                    // ("по договорённости", см. Task 11) — публиковать в этом
                    // случае значило бы выложить живой товар за 0 ₽ без
                    // предупреждения модератору.
                    setPublishError("Некорректная цена в заявке — исправьте вручную перед публикацией");
                    return;
                  }
                  const photos = Array.isArray(meta.photos) ? (meta.photos as string[]) : [];
                  const description = [meta.state, lead.message].filter(Boolean).join(" — ");
                  setPublishing(true);
                  try {
                    await apiPost("/admin/products", token, {
                      title: String(meta.title || lead.product_title || "Товар из заявки"),
                      price,
                      category: String(meta.category || ""),
                      condition: "used",
                      description,
                      images: photos,
                      source: "user_submitted",
                    });
                    // Товар уже создан — что бы ни случилось дальше (в т.ч. если
                    // patch() ниже не сможет перевести лид в completed), кнопка
                    // не должна дать создать ВТОРОЙ товар из той же заявки.
                    setPublished(true);
                    await patch({ status: "completed" });
                  } catch (e) {
                    // Сюда попадает только сбой самого apiPost (patch() свои
                    // ошибки гасит сам через error/setError) — значит товар не
                    // создан, повтор безопасен.
                    setPublishing(false);
                    setPublishError(e instanceof Error ? e.message : "Не удалось опубликовать товар");
                  }
                }}
              >
                {publishing ? "Публикуем…" : "Опубликовать в каталог"}
              </button>
            )}
            {publishError && <p style={{ color: C.red, fontSize: 13 }}>{publishError}</p>}
            <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 10, marginTop: 18, alignItems: "center" }}>
              <span style={{ fontSize: 13, color: C.sub }}>Статус</span>
              <select value={lead.status} onChange={(e) => patch({ status: e.target.value })}
                style={{ ...input, marginTop: 0, width: "auto" }}>
                {STATUSES.map((s) => <option key={s} value={s}>{STATUS_RU[s]}</option>)}
              </select>

              <span style={{ fontSize: 13, color: C.sub }}>Менеджер</span>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={assignee} onChange={(e) => setAssignee(e.target.value)}
                  placeholder="Кто ведёт заявку" style={{ ...input, marginTop: 0, flex: 1 }} />
                <button style={btnGhost} onClick={() => patch({ assigned_to: assignee })}>Сохранить</button>
              </div>

              <span style={{ fontSize: 13, color: C.sub }}>Заметка</span>
              <div style={{ display: "flex", gap: 8 }}>
                <input value={note} onChange={(e) => setNote(e.target.value)}
                  placeholder="Внутренний комментарий" style={{ ...input, marginTop: 0, flex: 1 }} />
                <button style={btnGhost} onClick={() => patch({ manager_comment: note })}>Сохранить</button>
              </div>
            </div>

            {/* ---- История статусов ---- */}
            <h3 style={{ marginTop: 20, marginBottom: 6, fontSize: 15 }}>История статусов</h3>
            {(lead.status_history ?? []).length === 0 ? (
              <p style={{ color: C.sub, fontSize: 13, margin: 0 }}>
                Статус пока не менялся — заявка в исходном состоянии.
              </p>
            ) : (
              <div style={{ fontSize: 13 }}>
                {(lead.status_history ?? []).map((h, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, padding: "6px 0", borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ color: C.sub, whiteSpace: "nowrap" }}>{fmtDateTime(h.created_at)}</span>
                    <span>{STATUS_RU[h.from ?? ""] ?? h.from} → <strong>{STATUS_RU[h.to ?? ""] ?? h.to}</strong></span>
                    <span style={{ color: C.sub, marginLeft: "auto" }}>{h.actor}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
