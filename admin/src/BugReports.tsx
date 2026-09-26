/** Сообщения об ошибках из профиля Mini App («Сообщить об ошибке»).
 *
 *  Цикл короткий: «Исправлено» — автору уходит спасибо в чат с ботом;
 *  «Не ошибка» — закрывается молча (пожелание, не повторяется). Закрытые не
 *  удаляются: повторная жалоба на то же место должна быть видна как повторная.
 */
import { useCallback, useEffect, useState } from "react";
import { C, apiGet, apiSend, btn, btnGhost, card, chip, fmtDateTime, input } from "./ui";

type Report = {
  id: number;
  username: string | null;
  name: string | null;
  text: string;
  photos: string[];
  context: Record<string, string>;
  status: string;
  manager_note: string | null;
  created_at: string | null;
};

const FILTERS: { key: string; label: string }[] = [
  { key: "new", label: "Новые" },
  { key: "fixed", label: "Исправлены" },
  { key: "declined", label: "Не ошибка" },
  { key: "", label: "Все" },
];

const STATUS_RU: Record<string, string> = { new: "новое", fixed: "исправлено", declined: "не ошибка" };

const CONTEXT_RU: [string, string][] = [
  ["platform", "Платформа"], ["tg_version", "Telegram"], ["viewport", "Экран"],
  ["path", "Раздел"], ["user_agent", "Браузер"],
];

/** Только наши загрузки: массив рисуется ссылками на origin админки. */
const own = (url: string) => url.startsWith("/api/uploads/");

export default function BugReports({ token }: { token: string }) {
  const [items, setItems] = useState<Report[]>([]);
  const [fresh, setFresh] = useState(0);
  const [filter, setFilter] = useState("new");
  const [error, setError] = useState("");
  const [note, setNote] = useState<Record<number, string>>({});

  const load = useCallback(() => {
    const query = filter ? `?status_filter=${filter}` : "";
    apiGet<{ reports: Report[]; new: number }>(`/admin/bug-reports${query}`, token)
      .then((r) => { setItems(r.reports); setFresh(r.new); setError(""); })
      .catch((e) => setError(e instanceof Error ? e.message : "Не удалось загрузить"));
  }, [filter, token]);
  useEffect(load, [load]);

  async function setStatus(id: number, status: string) {
    try {
      await apiSend("PATCH", `/admin/bug-reports/${id}`, token, { status, note: note[id] ?? null });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    }
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button key={f.key} onClick={() => setFilter(f.key)} style={chip(filter === f.key)}>
            {f.label}
            {f.key === "new" && fresh > 0 ? ` · ${fresh}` : ""}
          </button>
        ))}
      </div>

      {error && <p style={{ color: C.red, fontSize: 13 }}>{error}</p>}
      {items.length === 0 && !error && <p style={{ color: C.sub, fontSize: 13 }}>Пусто.</p>}

      {items.map((r) => (
        <div key={r.id} style={{ ...card, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>
                #{r.id} · {r.username ? `@${r.username}` : (r.name || "покупатель")}
              </div>
              <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>{fmtDateTime(r.created_at)}</div>
            </div>
            <span style={{ fontSize: 12, color: C.sub, alignSelf: "flex-start" }}>{STATUS_RU[r.status] ?? r.status}</span>
          </div>

          <p style={{ fontSize: 14, lineHeight: 1.55, marginTop: 10, whiteSpace: "pre-wrap" }}>{r.text}</p>

          {r.photos.filter(own).length > 0 && (
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              {r.photos.filter(own).map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer">
                  <img src={url} alt="" style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 8 }} />
                </a>
              ))}
            </div>
          )}

          <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
            {CONTEXT_RU.filter(([k]) => r.context?.[k]).map(([k, label]) => (
              <span key={k} style={{ fontSize: 12, color: C.sub, wordBreak: "break-word" }}>
                {label}: <span style={{ color: C.text }}>{r.context[k]}</span>
              </span>
            ))}
          </div>

          {r.manager_note && (
            <p style={{ fontSize: 12, color: C.sub, marginTop: 8 }}>Заметка: {r.manager_note}</p>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={note[r.id] ?? ""}
              onChange={(e) => setNote((prev) => ({ ...prev, [r.id]: e.target.value }))}
              placeholder="Заметка (покупателю не видна)"
              style={{ ...input, marginTop: 0, flex: 1, minWidth: 220 }}
            />
            {r.status !== "fixed" && (
              <button style={btn} onClick={() => setStatus(r.id, "fixed")}>Исправлено</button>
            )}
            {r.status !== "declined" && (
              <button style={btnGhost} onClick={() => setStatus(r.id, "declined")}>Не ошибка</button>
            )}
            {r.status !== "new" && (
              <button style={btnGhost} onClick={() => setStatus(r.id, "new")}>Вернуть в новые</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
