/** Промокоды: создание, выключение и расход.
 *
 *  Расход («использовано / лимит») — главная колонка этого экрана: акция на
 *  двадцать купонов без ответа на вопрос «сколько осталось» непроверяема, и
 *  владелец узнаёт о её конце от покупателей.
 */
import { Fragment, useEffect, useState } from "react";
import { C, apiGet, apiPatch, apiPost, apiSend, btn, btnGhost, card, input } from "./ui";

type Promo = {
  id: number;
  code: string;
  discount_amount: number;
  max_redemptions: number | null;
  min_order_amount: number | null;
  expires_at: string | null;
  is_active: boolean;
  note: string | null;
  used: number;
  left: number | null;
  created_at: string | null;
};

type Redemption = {
  id: number;
  user_id: number;
  lead_id: number | null;
  discount_amount: number;
  order_total: number;
  created_at: string | null;
  username: string | null;
  name: string | null;
};

const money = (v: number | null | undefined) =>
  v == null ? "—" : `${Math.round(v).toLocaleString("ru-RU")} ₽`;

const dt = (iso: string | null) =>
  !iso ? "—" : new Date(iso).toLocaleString("ru-RU");

export default function PromoCodes({ token }: { token: string }) {
  const [items, setItems] = useState<Promo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  function load() {
    apiGet<{ items: Promo[] }>("/admin/promo-codes", token)
      .then((r) => setItems(r.items))
      .catch((e) => setError(e.message));
  }

  useEffect(load, [token]);

  async function toggle(promo: Promo) {
    setBusy(true);
    setError("");
    try {
      await apiPatch<Promo>(`/admin/promo-codes/${promo.id}`, token, { is_active: !promo.is_active });
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось изменить код");
    } finally {
      setBusy(false);
    }
  }

  async function remove(promo: Promo) {
    if (!confirm(`Удалить промокод ${promo.code}?`)) return;
    setBusy(true);
    setError("");
    try {
      await apiSend("DELETE", `/admin/promo-codes/${promo.id}`, token);
      load();
    } catch (e) {
      // Код с расходом удалить нельзя — сервер отвечает 409 с объяснением.
      setError(e instanceof Error ? e.message : "Не удалось удалить код");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>Промокоды</h2>
          <p style={{ margin: "6px 0 0", color: C.sub, fontSize: 13 }}>
            Купон списывается только вместе с заявкой. Проверка кода в корзине расход не тратит.
          </p>
        </div>
        <button style={btn} onClick={() => setCreating((v) => !v)}>
          {creating ? "Отмена" : "+ Промокод"}
        </button>
      </div>

      {error && (
        <p style={{ color: C.red, marginTop: 12, fontSize: 13 }}>{error}</p>
      )}

      {creating && (
        <CreateForm token={token} onDone={() => { setCreating(false); load(); }} onError={setError} />
      )}

      <div style={{ ...card, marginTop: 16, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: C.sub }}>
              <th style={th}>Код</th>
              <th style={th}>Скидка</th>
              <th style={th}>Использовано</th>
              <th style={th}>От суммы</th>
              <th style={th}>Действует до</th>
              <th style={th}>Статус</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} style={{ ...td, color: C.sub }}>
                  Промокодов пока нет.
                </td>
              </tr>
            )}
            {items.map((p) => (
              // Ключ на ФРАГМЕНТЕ, а не только на строках: прямой потомок map —
              // он, и без ключа React ругается в консоль.
              <Fragment key={p.id}>
                <tr style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ ...td, fontWeight: 600, fontFamily: "ui-monospace, monospace" }}>
                    {p.code}
                    {p.note && <div style={{ color: C.sub, fontWeight: 400, fontSize: 12 }}>{p.note}</div>}
                  </td>
                  <td style={td}>{money(p.discount_amount)}</td>
                  <td style={td}>
                    <span style={{ fontWeight: 600 }}>{p.used}</span>
                    {p.max_redemptions != null && (
                      <span style={{ color: C.sub }}> / {p.max_redemptions}</span>
                    )}
                    {p.left === 0 && (
                      <span style={{ color: C.red, marginLeft: 8 }}>кончился</span>
                    )}
                  </td>
                  <td style={td}>{p.min_order_amount == null ? "—" : money(p.min_order_amount)}</td>
                  <td style={td}>{p.expires_at ? dt(p.expires_at) : "бессрочно"}</td>
                  <td style={td}>
                    <span style={{ color: p.is_active ? C.green : C.sub }}>
                      {p.is_active ? "активен" : "выключен"}
                    </span>
                  </td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>
                    <button style={{ ...btnGhost, padding: "6px 10px" }} disabled={busy}
                      onClick={() => toggle(p)}>
                      {p.is_active ? "Выключить" : "Включить"}
                    </button>
                    <button style={{ ...btnGhost, padding: "6px 10px", marginLeft: 6 }}
                      onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                      {openId === p.id ? "Скрыть" : "Кто применил"}
                    </button>
                    {p.used === 0 && (
                      <button style={{ ...btnGhost, padding: "6px 10px", marginLeft: 6, color: C.red }}
                        disabled={busy} onClick={() => remove(p)}>
                        Удалить
                      </button>
                    )}
                  </td>
                </tr>
                {openId === p.id && (
                  <tr>
                    <td colSpan={7} style={{ ...td, background: C.muted }}>
                      <Redemptions token={token} promoId={p.id} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CreateForm({ token, onDone, onError }: {
  token: string; onDone: () => void; onError: (m: string) => void;
}) {
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState("");
  const [limit, setLimit] = useState("20");
  const [minOrder, setMinOrder] = useState("");
  const [expires, setExpires] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    onError("");
    try {
      await apiPost("/admin/promo-codes", token, {
        code: code.trim().toUpperCase(),
        discount_amount: Number(amount),
        // Пустой лимит = без ограничения. Это осознанный выбор владельца, а не
        // «забыл заполнить», поэтому пустое поле не превращаем в ноль.
        max_redemptions: limit.trim() ? Number(limit) : null,
        min_order_amount: minOrder.trim() ? Number(minOrder) : null,
        expires_at: expires ? new Date(expires).toISOString() : null,
        note: note.trim() || null,
      });
      onDone();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Не удалось создать код");
    } finally {
      setBusy(false);
    }
  }

  const valid = code.trim().length > 0 && Number(amount) > 0;

  return (
    <div style={{ ...card, marginTop: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <label style={lbl}>Код
          <input style={{ ...input, textTransform: "uppercase" }} value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="START20" />
        </label>
        <label style={lbl}>Скидка, ₽
          <input style={input} value={amount} onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal" placeholder="5000" />
        </label>
        <label style={lbl}>Сколько купонов
          <input style={input} value={limit} onChange={(e) => setLimit(e.target.value)}
            inputMode="numeric" placeholder="пусто = без лимита" />
        </label>
        <label style={lbl}>Минимальная сумма, ₽
          <input style={input} value={minOrder} onChange={(e) => setMinOrder(e.target.value)}
            inputMode="decimal" placeholder="без порога" />
        </label>
        <label style={lbl}>Действует до
          <input style={input} type="datetime-local" value={expires}
            onChange={(e) => setExpires(e.target.value)} />
        </label>
        <label style={lbl}>Заметка
          <input style={input} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="для себя, покупатель не увидит" />
        </label>
      </div>
      <p style={{ color: C.sub, fontSize: 12, margin: "12px 0 0" }}>
        Один аккаунт применяет код один раз. Переименовать код после создания нельзя —
        его уже унесли в переписку; ненужный код выключают.
      </p>
      <button style={{ ...btn, marginTop: 12 }} disabled={!valid || busy} onClick={submit}>
        {busy ? "Создаём…" : "Создать"}
      </button>
    </div>
  );
}

function Redemptions({ token, promoId }: { token: string; promoId: number }) {
  const [rows, setRows] = useState<Redemption[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    apiGet<{ items: Redemption[] }>(`/admin/promo-codes/${promoId}/redemptions`, token)
      .then((r) => setRows(r.items))
      .catch((e) => setError(e.message));
  }, [promoId, token]);

  if (error) return <span style={{ color: C.red }}>{error}</span>;
  if (rows === null) return <span style={{ color: C.sub }}>Загружаем…</span>;
  if (rows.length === 0) return <span style={{ color: C.sub }}>Этим кодом ещё не пользовались.</span>;

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
      <thead>
        <tr style={{ textAlign: "left", color: C.sub }}>
          <th style={th}>Покупатель</th>
          <th style={th}>Заявка</th>
          <th style={th}>Скидка</th>
          <th style={th}>Сумма до скидки</th>
          <th style={th}>Когда</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderTop: `1px solid ${C.border}` }}>
            <td style={td}>
              {r.username ? `@${r.username}` : r.name || `id ${r.user_id}`}
            </td>
            <td style={td}>{r.lead_id ? `№${r.lead_id}` : "—"}</td>
            <td style={td}>{money(r.discount_amount)}</td>
            <td style={td}>{money(r.order_total)}</td>
            <td style={td}>{dt(r.created_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const th: React.CSSProperties = { padding: "10px 12px", fontWeight: 500, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "10px 12px", verticalAlign: "top" };
const lbl: React.CSSProperties = { fontSize: 12, color: C.sub, display: "block" };
