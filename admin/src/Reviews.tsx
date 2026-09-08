/** Модерация отзывов.
 *
 *  Отзыв приходит от покупателя после закрытой заявки и ждёт решения. На
 *  витрине он идёт с отметкой «покупка подтверждена», и отметка обязана значить
 *  ровно то, что написано, — поэтому публикуется только одобренный.
 *
 *  Отклонённый не удаляется: иначе тот же текст прислали бы снова, а мы бы не
 *  помнили, что уже решали по нему. Причина отклонения видна только здесь.
 */
import { useCallback, useEffect, useState } from "react";
import { C, apiGet, apiSend, btn, btnGhost, card, chip, fmtDateTime, input } from "./ui";

type Review = {
  id: number;
  lead_id: number;
  lead_number: string | null;
  lead_total: number | null;
  product_id: number | null;
  product_title: string | null;
  author_name: string;
  rating: number;
  text: string;
  photos: string[];
  status: string;
  moderator_note: string | null;
  created_at: string | null;
};

const FILTERS: { key: string; label: string }[] = [
  { key: "pending", label: "Ждут решения" },
  { key: "approved", label: "Опубликованы" },
  { key: "rejected", label: "Отклонены" },
  { key: "", label: "Все" },
];

const stars = (n: number) => "★".repeat(n) + "☆".repeat(Math.max(0, 5 - n));

export default function Reviews({ token }: { token: string }) {
  const [items, setItems] = useState<Review[]>([]);
  const [pending, setPending] = useState(0);
  const [filter, setFilter] = useState("pending");
  const [error, setError] = useState("");
  const [note, setNote] = useState<Record<number, string>>({});

  const load = useCallback(() => {
    const query = filter ? `?status_filter=${filter}` : "";
    apiGet<{ reviews: Review[]; pending: number }>(`/admin/reviews${query}`, token)
      .then((r) => { setItems(r.reviews); setPending(r.pending); setError(""); })
      .catch((e) => setError(e instanceof Error ? e.message : "Не удалось загрузить"));
  }, [filter, token]);
  useEffect(load, [load]);

  async function moderate(id: number, status: string) {
    try {
      await apiSend("PATCH", `/admin/reviews/${id}`, token, { status, note: note[id] || null });
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
            {f.key === "pending" && pending > 0 ? ` · ${pending}` : ""}
          </button>
        ))}
      </div>

      {error && <p style={{ color: C.red, fontSize: 13 }}>{error}</p>}
      {items.length === 0 && !error && (
        <p style={{ color: C.sub, fontSize: 13 }}>Пусто.</p>
      )}

      {items.map((r) => (
        <div key={r.id} style={{ ...card, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>
                {r.author_name}{" "}
                <span style={{ color: "#f0a020", letterSpacing: 1 }}>{stars(r.rating)}</span>
              </div>
              <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>
                {r.lead_number ? `Заявка ${r.lead_number}` : `Заявка #${r.lead_id}`}
                {r.lead_total != null ? ` · ${r.lead_total} ₽` : ""}
                {r.created_at ? ` · ${fmtDateTime(r.created_at)}` : ""}
              </div>
              {/* Товар — то, к чему отзыв прикрепится на витрине. Пусто значит
                  «общая лента»: у заявки-корзины непонятно, о какой позиции
                  речь, и приписать случайную было бы враньём на карточке. */}
              <div style={{ fontSize: 12, color: C.sub, marginTop: 2 }}>
                {r.product_title
                  ? `Товар: ${r.product_title}`
                  : "Товар не выбран — отзыв попадёт только в общую ленту"}
              </div>
            </div>
            <span style={{ fontSize: 12, color: C.sub, alignSelf: "flex-start" }}>{r.status}</span>
          </div>

          {r.text && (
            <p style={{ fontSize: 14, lineHeight: 1.55, marginTop: 10, whiteSpace: "pre-wrap" }}>
              {r.text}
            </p>
          )}

          {r.photos.length > 0 && (
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              {r.photos.map((url) => (
                <a key={url} href={url} target="_blank" rel="noreferrer">
                  <img src={url} alt="" style={{ width: 84, height: 84, objectFit: "cover", borderRadius: 8 }} />
                </a>
              ))}
            </div>
          )}

          {r.moderator_note && (
            <p style={{ fontSize: 12, color: C.sub, marginTop: 8 }}>
              Причина: {r.moderator_note}
            </p>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={note[r.id] ?? ""}
              onChange={(e) => setNote((prev) => ({ ...prev, [r.id]: e.target.value }))}
              placeholder="Причина отклонения (не видна покупателю)"
              style={{ ...input, marginTop: 0, flex: 1, minWidth: 220 }}
            />
            {r.status !== "approved" && (
              <button style={btn} onClick={() => moderate(r.id, "approved")}>Опубликовать</button>
            )}
            {r.status !== "rejected" && (
              <button style={btnGhost} onClick={() => moderate(r.id, "rejected")}>Отклонить</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
