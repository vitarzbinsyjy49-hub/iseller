import { useEffect, useState } from "react";
import { C, card, apiGet, SOURCE_RU } from "./ui";

/** Аналитика: воронка, источники заявок, счётчики событий. */

type AnalyticsData = {
  by_event: Record<string, number>;
  funnel: { step: string; event: string; count: number }[];
  lead_sources: { source: string; count: number }[];
};

export function Analytics({ token }: { token: string }) {
  const [d, setD] = useState<AnalyticsData | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { apiGet<AnalyticsData>("/admin/analytics", token).then(setD).catch((e) => setErr(String(e))); }, [token]);
  if (err) return <p style={{ color: C.red }}>Ошибка: {err}</p>;
  if (!d) return <p style={{ color: C.sub }}>Загрузка…</p>;

  const maxFunnel = Math.max(1, ...d.funnel.map((f) => f.count));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 14 }}>
      <div style={card}>
        <h3 style={{ marginTop: 0, fontSize: 15 }}>Воронка</h3>
        {d.funnel.map((f) => (
          <div key={f.event} style={{ marginTop: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
              <span>{f.step}</span>
              <span style={{ color: C.sub }}>{f.count}</span>
            </div>
            <div style={{ height: 10, borderRadius: 999, background: C.muted, marginTop: 4, overflow: "hidden" }}>
              <div style={{
                height: "100%", width: `${Math.round((f.count / maxFunnel) * 100)}%`,
                background: `linear-gradient(90deg, ${C.accent}, ${C.accentDark})`, borderRadius: 999,
                transition: "width 300ms",
              }} />
            </div>
          </div>
        ))}
      </div>

      <div>
        <div style={card}>
          <h3 style={{ marginTop: 0, fontSize: 15 }}>Источники заявок</h3>
          {d.lead_sources.length === 0 ? <p style={{ color: C.sub, fontSize: 14 }}>Заявок пока нет</p> :
            d.lead_sources.map((s) => (
              <div key={s.source} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 14 }}>
                <span>{SOURCE_RU[s.source] ?? s.source}</span>
                <span style={{ fontWeight: 700 }}>{s.count}</span>
              </div>
            ))}
        </div>
        <div style={{ ...card, marginTop: 14 }}>
          <h3 style={{ marginTop: 0, fontSize: 15 }}>События</h3>
          <div style={{ maxHeight: 260, overflowY: "auto" }}>
            {Object.entries(d.by_event).sort((a, b) => Number(b[1]) - Number(a[1])).map(([ev, cnt]) => (
              <div key={ev} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 13 }}>
                <span style={{ color: C.accentDark }}>{ev}</span>
                <span style={{ color: C.sub }}>{cnt}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- AI-логи ----------
type AiLog = {
  user_id: number | null;
  payload: {
    source?: string; intent?: string; cards?: number; query?: string;
    latency_ms?: number; error?: string;
  };
  created_at: string;
};

export function AiLogs({ token }: { token: string }) {
  const [logs, setLogs] = useState<AiLog[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { apiGet<{ logs: AiLog[] }>("/admin/ai-logs", token).then((d) => setLogs(d.logs)).catch((e) => setErr(String(e))); }, [token]);
  if (err) return <p style={{ color: C.red }}>Ошибка: {err}</p>;
  if (!logs) return <p style={{ color: C.sub }}>Загрузка…</p>;
  if (logs.length === 0) return <p style={{ color: C.sub }}>AI-запросов пока не было</p>;

  const srcColor = (s?: string) => (s === "ai" ? C.green : s === "mock" ? C.yellow : C.accentDark);

  return (
    <div style={{ ...card, padding: 0, overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ color: C.sub, textAlign: "left", borderBottom: `1px solid ${C.border}` }}>
            <th style={{ padding: "12px 14px" }}>Запрос</th>
            <th>Источник</th><th>Intent</th><th>Карточек</th><th>Latency</th><th>Ошибка</th><th>Когда</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((l, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
              <td style={{ padding: "10px 14px", maxWidth: 320 }}>{l.payload.query ?? "—"}</td>
              <td>
                <span style={{ color: srcColor(l.payload.source), fontWeight: 600 }}>{l.payload.source ?? "—"}</span>
              </td>
              <td style={{ color: C.sub }}>{l.payload.intent ?? "—"}</td>
              <td>{l.payload.cards ?? 0}</td>
              <td style={{ color: C.sub }}>{l.payload.latency_ms != null ? `${l.payload.latency_ms} мс` : "—"}</td>
              <td style={{ color: l.payload.error ? C.red : C.sub }}>{l.payload.error ?? "—"}</td>
              <td style={{ color: C.sub, whiteSpace: "nowrap", padding: "10px 14px" }}>
                {new Date(l.created_at).toLocaleString("ru-RU")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
