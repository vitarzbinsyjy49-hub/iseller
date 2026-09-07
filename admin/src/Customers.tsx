/** Раздел «Клиенты»: счёт лояльности и операции по нему.
 *
 *  Ставки и пороги уровней приходят С СЕРВЕРА (`level` в каждой строке,
 *  `levels` в карточке). Своей копии лестницы админка не держит: вторая копия
 *  разъедется с бэкендом ровно так же, как когда-то разъехался захардкоженный
 *  список категорий, и менеджер будет обещать клиенту не ту ставку.
 *
 *  Поля «поставить баланс = N» здесь нет: баланс — следствие журнала. Обнуление
 *  проводится корректировкой с комментарием, и через год видно, кто и зачем.
 */
import { useEffect, useState } from "react";
import { C, card, input, btn, btnGhost, chip, apiGet, apiPost, fmtPrice, fmtDateTime } from "./ui";

type Level = { key: string; title: string; threshold: number; rate_bps: number; rate_percent: number };

type Customer = {
  id: number; telegram_id: number | null; username: string | null; name: string | null;
  role: string; created_at: string | null; last_seen_at: string | null;
  balance: number; lifetime_spent: number; level: Level;
};

type Tx = {
  id: number; kind: string; points: number; amount: number | null; rate_bps: number | null;
  comment: string | null; created_by: string | null; created_at: string | null;
};

type Detail = Customer & {
  progress: { next_level: Level | null; to_next: number; ratio: number };
  history: Tx[];
  levels: Level[];
  leads: { id: number; public_number?: string; status: string; created_at: string;
           estimated_total: number | null; product_price: number | null; product_title: string | null }[];
};

/** Ставка по-русски: «0,25%», а не «0.25%». Точка в дробях рядом с рублёвыми
 *  суммами читается как опечатка. */
const fmtRate = (rateBps: number) =>
  `${(rateBps / 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 })}%`;

const KIND_RU: Record<string, string> = {
  purchase: "Покупка",
  spend: "Списание",
  bonus: "Бонус",
  correction: "Корректировка",
  referral: "За приглашение",
};

const LEVEL_COLOR: Record<string, { bg: string; fg: string }> = {
  start: { bg: C.muted, fg: C.sub },
  silver: { bg: "#eef1f5", fg: "#5b6472" },
  gold: { bg: "#fff3d6", fg: "#b57e00" },
  platinum: { bg: "#eef0ff", fg: "#5b5bd6" },
  black: { bg: "#23262f", fg: "#ffffff" },
};

function LevelPill({ level }: { level: Level }) {
  const c = LEVEL_COLOR[level.key] ?? LEVEL_COLOR.start;
  return (
    <span style={{ background: c.bg, color: c.fg, borderRadius: 999, padding: "3px 10px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
      {level.title} · {fmtRate(level.rate_bps)}
    </span>
  );
}

const td: React.CSSProperties = {
  padding: "10px 12px", borderBottom: `1px solid ${C.border}`, verticalAlign: "top",
};

export function Customers({ token }: { token: string }) {
  const [rows, setRows] = useState<Customer[]>([]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"recent" | "balance" | "spent">("recent");
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<number | null>(null);

  function load() {
    setLoading(true);
    const qs = new URLSearchParams({ sort });
    if (q.trim()) qs.set("q", q.trim());
    apiGet<{ users: Customer[] }>(`/admin/users?${qs.toString()}`, token)
      .then((d) => setRows(d.users)).finally(() => setLoading(false));
  }
  useEffect(load, [sort, token]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && load()}
          placeholder="Имя, @username или telegram_id"
          style={{ ...input, marginTop: 0, width: 280 }}
        />
        <button style={btnGhost} onClick={load}>Найти</button>
        <span style={{ width: 12 }} />
        <button onClick={() => setSort("recent")} style={chip(sort === "recent")}>По визиту</button>
        <button onClick={() => setSort("balance")} style={chip(sort === "balance")}>По баллам</button>
        <button onClick={() => setSort("spent")} style={chip(sort === "spent")}>По обороту</button>
      </div>

      {loading ? <p style={{ color: C.sub }}>Загрузка…</p> :
        rows.length === 0 ? <p style={{ color: C.sub }}>Клиентов не найдено</p> : (
          <div style={{ ...card, padding: 0, overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: C.sub, textAlign: "left" }}>
                  {["Клиент", "Telegram", "Баллы", "Оборот", "Уровень", "Последний визит", ""].map((h) => (
                    <th key={h} style={{ padding: "10px 12px", borderBottom: `1px solid ${C.border}`, fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr key={u.id}>
                    <td style={td}>
                      <div style={{ fontWeight: 600 }}>{u.name || "Без имени"}</div>
                      <div style={{ color: C.sub, marginTop: 2 }}>id {u.id}</div>
                    </td>
                    <td style={td}>
                      {u.username
                        ? <a href={`https://t.me/${u.username}`} target="_blank" rel="noopener noreferrer" style={{ color: C.accentDark }}>@{u.username}</a>
                        : <span style={{ color: C.sub }}>{u.telegram_id ?? "—"}</span>}
                    </td>
                    <td style={{ ...td, fontWeight: 700, whiteSpace: "nowrap" }}>{u.balance.toLocaleString("ru-RU")}</td>
                    <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtPrice(u.lifetime_spent)}</td>
                    <td style={td}><LevelPill level={u.level} /></td>
                    <td style={{ ...td, color: C.sub, whiteSpace: "nowrap" }}>{fmtDateTime(u.last_seen_at)}</td>
                    <td style={td}>
                      <button style={{ ...btnGhost, padding: "6px 10px", fontSize: 13 }} onClick={() => setOpenId(u.id)}>
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
        <CustomerDetail token={token} userId={openId} onClose={() => setOpenId(null)} onChanged={load} />
      )}
    </div>
  );
}

function CustomerDetail({
  token, userId, onClose, onChanged,
}: { token: string; userId: number; onClose: () => void; onChanged: () => void }) {
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");

  const reload = () => {
    apiGet<Detail>(`/admin/users/${userId}`, token).then(setD).catch((e) => setError(String(e)));
  };
  useEffect(reload, [userId, token]);

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(17,24,39,.45)", zIndex: 50, display: "grid", placeItems: "center", padding: 20 }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ ...card, width: "min(880px, 100%)", maxHeight: "88vh", overflowY: "auto" }}>
        {error && <p style={{ color: C.red, fontSize: 13 }}>{error}</p>}
        {!d ? <p style={{ color: C.sub }}>Загрузка…</p> : (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <h2 style={{ margin: 0, fontSize: 18 }}>{d.name || "Без имени"}</h2>
                <LevelPill level={d.level} />
              </div>
              <button style={{ ...btnGhost, padding: "6px 12px" }} onClick={onClose}>Закрыть</button>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 18px", marginTop: 8, fontSize: 13, color: C.sub }}>
              {d.username && <a href={`https://t.me/${d.username}`} target="_blank" rel="noopener noreferrer" style={{ color: C.accentDark }}>@{d.username}</a>}
              <span>telegram_id: {d.telegram_id ?? "—"}</span>
              <span>С нами с {fmtDateTime(d.created_at)}</span>
            </div>

            {/* ---- Счёт ---- */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginTop: 16 }}>
              <div style={{ ...card, padding: 14, background: C.accent }}>
                <p style={{ margin: 0, color: "rgba(255,255,255,.85)", fontSize: 13 }}>Баллы</p>
                <p style={{ margin: "6px 0 0", fontSize: 26, fontWeight: 700, color: "#fff" }}>{d.balance.toLocaleString("ru-RU")}</p>
              </div>
              <div style={{ ...card, padding: 14 }}>
                <p style={{ margin: 0, color: C.sub, fontSize: 13 }}>Оборот за всё время</p>
                <p style={{ margin: "6px 0 0", fontSize: 22, fontWeight: 700 }}>{fmtPrice(d.lifetime_spent)}</p>
              </div>
              <div style={{ ...card, padding: 14 }}>
                <p style={{ margin: 0, color: C.sub, fontSize: 13 }}>Ставка кэшбека</p>
                <p style={{ margin: "6px 0 0", fontSize: 22, fontWeight: 700 }}>{fmtRate(d.level.rate_bps)}</p>
                <p style={{ margin: "4px 0 0", color: C.sub, fontSize: 12 }}>
                  {d.progress.next_level
                    ? `До «${d.progress.next_level.title}» ещё ${fmtPrice(d.progress.to_next)}`
                    : "Максимальный уровень"}
                </p>
              </div>
            </div>

            <OperationForm
              token={token}
              userId={userId}
              rateBps={d.level.rate_bps}
              balance={d.balance}
              onDone={() => { reload(); onChanged(); }}
            />

            {/* ---- Лестница ---- */}
            <h3 style={{ marginTop: 20, marginBottom: 6, fontSize: 15 }}>Уровни</h3>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {d.levels.map((l) => (
                <span key={l.key} style={{
                  border: `1px solid ${l.key === d.level.key ? C.accent : C.border}`,
                  borderRadius: 10, padding: "6px 10px", fontSize: 12,
                  color: l.key === d.level.key ? C.accentDark : C.sub,
                  fontWeight: l.key === d.level.key ? 700 : 400,
                }}>
                  {l.title} · {fmtRate(l.rate_bps)} · от {fmtPrice(l.threshold)}
                </span>
              ))}
            </div>

            {/* ---- История ---- */}
            <h3 style={{ marginTop: 20, marginBottom: 6, fontSize: 15 }}>История операций</h3>
            {d.history.length === 0 ? (
              <p style={{ color: C.sub, fontSize: 13, margin: 0 }}>Операций пока не было</p>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ color: C.sub, textAlign: "left" }}>
                      {["Дата", "Операция", "Сумма покупки", "Ставка", "Баллы", "Комментарий", "Кто"].map((h) => (
                        <th key={h} style={{ padding: "8px 10px", borderBottom: `1px solid ${C.border}`, fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {d.history.map((t) => (
                      <tr key={t.id}>
                        <td style={{ ...td, color: C.sub, whiteSpace: "nowrap" }}>{fmtDateTime(t.created_at)}</td>
                        <td style={td}>{KIND_RU[t.kind] ?? t.kind}</td>
                        <td style={{ ...td, whiteSpace: "nowrap" }}>{t.amount != null ? fmtPrice(t.amount) : "—"}</td>
                        <td style={{ ...td, whiteSpace: "nowrap", color: C.sub }}>{t.rate_bps != null ? fmtRate(t.rate_bps) : "—"}</td>
                        <td style={{ ...td, whiteSpace: "nowrap", fontWeight: 700, color: t.points < 0 ? C.red : C.green }}>
                          {t.points > 0 ? "+" : ""}{t.points}
                        </td>
                        <td style={td}>{t.comment || "—"}</td>
                        <td style={{ ...td, color: C.sub }}>{t.created_by || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* ---- Заявки клиента ---- */}
            <h3 style={{ marginTop: 20, marginBottom: 6, fontSize: 15 }}>Заявки</h3>
            {d.leads.length === 0 ? (
              <p style={{ color: C.sub, fontSize: 13, margin: 0 }}>Заявок нет</p>
            ) : d.leads.map((l) => (
              <div key={l.id} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                <span>{l.public_number ?? `№${l.id}`} · {l.product_title || "Корзина"}</span>
                <span style={{ color: C.sub }}>{fmtDateTime(l.created_at)}</span>
                <span style={{ fontWeight: 600 }}>{fmtPrice(l.estimated_total ?? l.product_price)}</span>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** Две операции менеджера: покупка и правка счёта.
 *
 *  Расчёт баллов по ставке ПРЕДЛАГАЕТСЯ и остаётся редактируемым: сделка могла
 *  пройти с индивидуальной скидкой, и запрет на правку заставил бы менеджера
 *  проводить её задним числом второй операцией. */
function OperationForm({
  token, userId, rateBps, balance, onDone,
}: { token: string; userId: number; rateBps: number; balance: number; onDone: () => void }) {
  const [mode, setMode] = useState<"purchase" | "adjust">("purchase");
  const [amount, setAmount] = useState("");
  const [points, setPoints] = useState("");
  const [kind, setKind] = useState<"spend" | "bonus" | "correction">("spend");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Предрасчёт ровно тот же, что на сервере (округление вниз). Показываем его
  // до отправки: менеджер должен видеть, что именно он начисляет.
  const money = Number(amount.replace(/\s/g, "").replace(",", ".")) || 0;
  const suggested = Math.floor((money * rateBps) / 10000);

  async function submit() {
    setError("");
    setBusy(true);
    // Ключ идемпотентности на попытку: двойной клик по «Начислить» не имеет
    // права дать двойной кэшбек.
    const key = `admin-${userId}-${Date.now()}`;
    const body = mode === "purchase"
      ? { kind: "purchase", amount: money, points: points === "" ? undefined : Number(points), comment, idempotency_key: key }
      : { kind, points: Number(points), comment, idempotency_key: key };
    try {
      await apiPost(`/admin/users/${userId}/loyalty`, token, body);
      setAmount(""); setPoints(""); setComment("");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось провести операцию");
    } finally {
      setBusy(false);
    }
  }

  const signedPoints = Number(points) || 0;
  const canSubmit = mode === "purchase"
    ? money > 0
    : signedPoints !== 0 && comment.trim().length > 0;

  return (
    <div style={{ ...card, marginTop: 16, background: C.muted }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button onClick={() => setMode("purchase")} style={chip(mode === "purchase")}>Покупка</button>
        <button onClick={() => setMode("adjust")} style={chip(mode === "adjust")}>Списать / скорректировать</button>
      </div>

      {mode === "purchase" ? (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ fontSize: 13, color: C.sub }}>
            Сумма покупки, ₽
            <input style={{ ...input }} value={amount} inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)} placeholder="100000" />
          </label>
          <label style={{ fontSize: 13, color: C.sub }}>
            Баллы (по умолчанию расчёт по ставке)
            <input style={{ ...input }} value={points} inputMode="numeric"
              onChange={(e) => setPoints(e.target.value)} placeholder={String(suggested)} />
          </label>
          <p style={{ gridColumn: "1 / -1", margin: 0, fontSize: 13 }}>
            {money > 0
              ? <>Начислим <strong>+{points === "" ? suggested : Number(points) || 0}</strong> баллов по ставке {fmtRate(rateBps)}</>
              : <span style={{ color: C.sub }}>Введите сумму покупки — баллы посчитаются по текущей ставке клиента</span>}
          </p>
          <label style={{ gridColumn: "1 / -1", fontSize: 13, color: C.sub }}>
            Комментарий (необязательно)
            <input style={{ ...input }} value={comment} onChange={(e) => setComment(e.target.value)}
              placeholder="Например: iPhone 16 Pro, сделка от 01.08" />
          </label>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <label style={{ fontSize: 13, color: C.sub }}>
            Вид операции
            <select style={{ ...input }} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="spend">Списание (скидка по сделке)</option>
              <option value="bonus">Бонус (акция, компенсация)</option>
              <option value="correction">Корректировка ошибки</option>
            </select>
          </label>
          <label style={{ fontSize: 13, color: C.sub }}>
            Баллы со знаком (списание — минус)
            <input style={{ ...input }} value={points}
              onChange={(e) => setPoints(e.target.value)} placeholder={kind === "spend" ? "-1000" : "500"} />
          </label>
          <p style={{ gridColumn: "1 / -1", margin: 0, fontSize: 13, color: C.sub }}>
            На счету {balance.toLocaleString("ru-RU")} баллов.
            {signedPoints !== 0 && <> После операции станет <strong>{(balance + signedPoints).toLocaleString("ru-RU")}</strong>.</>}
          </p>
          <label style={{ gridColumn: "1 / -1", fontSize: 13, color: C.sub }}>
            Комментарий (обязателен)
            <input style={{ ...input }} value={comment} onChange={(e) => setComment(e.target.value)}
              placeholder="Зачем проводится операция" />
          </label>
        </div>
      )}

      {error && <p style={{ color: C.red, fontSize: 13, marginBottom: 0 }}>{error}</p>}
      <button style={{ ...btn, marginTop: 12, opacity: canSubmit && !busy ? 1 : .5 }}
        disabled={!canSubmit || busy} onClick={submit}>
        {busy ? "Проводим…" : mode === "purchase" ? "Начислить за покупку" : "Провести операцию"}
      </button>
    </div>
  );
}
