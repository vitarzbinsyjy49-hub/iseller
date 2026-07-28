import { useEffect, useState } from "react";
import {
  C, card, input, btn, chip, apiGet, apiPatch, fmtPrice,
  STATUSES, STATUS_RU, SOURCE_RU, LEAD_TYPES, LEAD_TYPE_RU, leadMetaRows,
} from "./ui";
import { Products } from "./Products";
import { Analytics, AiLogs } from "./Analytics";
import { ImportCenter, HomeContent, MediaTab } from "./HomeAdmin";
import { Posts } from "./Posts";
import { PricePosts } from "./PricePosts";

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  return token ? <Shell token={token} onLogout={() => setToken(null)} /> : <Login onToken={setToken} />;
}

// ---------- Login ----------
function Login({ onToken }: { onToken: (t: string) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    const res = await fetch("/api/auth/admin/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) { setError("Неверный email или пароль"); return; }
    const data = await res.json();
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
      </div>
    </div>
  );
}

// ---------- Shell with tabs ----------
type Tab = "dashboard" | "leads" | "products" | "posts" | "price" | "import" | "home" | "media" | "analytics" | "ai";
const TABS: { key: Tab; label: string }[] = [
  { key: "dashboard", label: "Дашборд" },
  { key: "leads", label: "Заявки" },
  { key: "products", label: "Товары" },
  { key: "posts", label: "Посты" },
  { key: "price", label: "Прайс канала" },
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
        {tab === "products" && <Products token={token} />}
        {tab === "posts" && <Posts token={token} />}
        {tab === "price" && <PricePosts token={token} />}
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
  users_total: number; leads_total: number; leads_today: number; ai_queries: number;
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
type Lead = {
  id: number; name: string | null; phone: string | null; username: string | null;
  product_title: string | null; product_price: number | null; message: string | null;
  source: string; delivery_method: string | null; status: string;
  lead_type: string; metadata: Record<string, unknown> | null;
  manager_comment: string | null; created_at: string;
};

// Цвета pill-типа заявки (нейтральные, читаемые на светлой теме админки)
const TYPE_PILL: Record<string, { bg: string; fg: string }> = {
  general: { bg: C.muted, fg: C.sub },
  product: { bg: "#e3f2fd", fg: C.accentDark },
  trade_in: { bg: "#eafaf0", fg: "#0e9f6e" },
  b2b: { bg: "#eef0ff", fg: "#5b5bd6" },
  wholesale: { bg: "#fff3d6", fg: "#b57e00" },
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

  async function update(id: number, patch: Record<string, unknown>) {
    await apiPatch(`/admin/leads/${id}`, token, patch);
    load();
  }

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
          <div style={{ display: "grid", gap: 12 }}>
            {leads.map((l) => (
              <div key={l.id} style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <TypePill type={l.lead_type || "general"} />
                      <strong>{l.product_title || "Консультация"}</strong>
                      {l.product_price != null && <span style={{ fontWeight: 600 }}>{fmtPrice(l.product_price)}</span>}
                    </div>
                    <span style={{ color: C.sub, fontSize: 13 }}>
                      №{l.id} · {SOURCE_RU[l.source] ?? l.source}
                      {l.delivery_method && ` · ${l.delivery_method === "pickup" ? "самовывоз" : "доставка"}`}
                    </span>
                  </div>
                  <span style={{ fontSize: 13, color: C.sub }}>{new Date(l.created_at).toLocaleString("ru-RU")}</span>
                </div>

                {/* Структурированные ответы сценария — компактный человекочитаемый блок,
                    а не сырой JSON. Пустые поля скрыты, неизвестные — нейтрально. */}
                {leadMetaRows(l.metadata).length > 0 && (
                  <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
                    {leadMetaRows(l.metadata).map((r) => (
                      <span key={r.label} style={{ fontSize: 13 }}>
                        <span style={{ color: C.sub }}>{r.label}:</span>{" "}
                        <span style={{ fontWeight: 600 }}>{r.value}</span>
                      </span>
                    ))}
                  </div>
                )}

                <div style={{ marginTop: 8, fontSize: 14, color: C.sub }}>
                  {l.name && <span>{l.name} </span>}
                  {l.phone && <span>· <a href={`tel:${l.phone}`} style={{ color: C.accentDark }}>{l.phone}</a> </span>}
                  {l.username && <span>· @{l.username}</span>}
                </div>
                {l.message && <p style={{ marginTop: 8, fontSize: 14, wordBreak: "break-word" }}>{l.message}</p>}
                <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
                  <select value={l.status} onChange={(e) => update(l.id, { status: e.target.value })}
                    style={{ ...input, width: "auto", marginTop: 0 }}>
                    {STATUSES.map((s) => <option key={s} value={s}>{STATUS_RU[s]}</option>)}
                  </select>
                  <input placeholder="Комментарий менеджера (Enter — сохранить)" defaultValue={l.manager_comment ?? ""}
                    style={{ ...input, marginTop: 0, flex: 1, minWidth: 220 }}
                    onKeyDown={(e) => { if (e.key === "Enter") update(l.id, { manager_comment: (e.target as HTMLInputElement).value }); }} />
                  <StatusPill status={l.status} />
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}
