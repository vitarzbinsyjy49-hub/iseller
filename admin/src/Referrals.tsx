/** «Кто кого привёл»: пары и суммы выплат.
 *
 *  Сортировка по выплатам приходит с сервера и не переключается: накрутка
 *  всплывает наверх сама. Отдельного детектора здесь нет и не будет — статус
 *  «завершена» и итоговую сумму ставит человек, и последним рубежом остаётся
 *  тот, кто нажимает кнопку.
 */
import { useEffect, useState } from "react";
import { C, apiGet, card, fmtDateTime } from "./ui";

type Person = {
  id: number;
  telegram_id: number | null;
  username: string | null;
  name: string | null;
};

type Pair = {
  inviter: Person;
  invited: Person;
  registered_at: string | null;
  completed_leads: number;
  paid_points: number;
};

const who = (p: Person) => p.name || (p.username ? `@${p.username}` : `#${p.id}`);

export default function Referrals({ token }: { token: string }) {
  const [items, setItems] = useState<Pair[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    apiGet<{ items: Pair[] }>("/admin/referrals", token)
      .then((r) => setItems(r.items))
      .catch((e) => setError(e instanceof Error ? e.message : "Не удалось загрузить"));
  }, [token]);

  return (
    <div>
      <h2 style={{ margin: 0 }}>Приглашения</h2>
      <p style={{ margin: "6px 0 0", color: C.sub, fontSize: 13 }}>
        Кто кого привёл и сколько на этом заработал. Наверху — крупнейшие выплаты.
      </p>

      {error && <p style={{ color: C.red, marginTop: 12, fontSize: 13 }}>{error}</p>}

      <div style={{ ...card, marginTop: 16, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", color: C.sub }}>
              <th style={th}>Пригласивший</th>
              <th style={th}>Приглашённый</th>
              <th style={th}>Регистрация</th>
              <th style={th}>Завершённых сделок</th>
              <th style={th}>Выплачено баллов</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={5} style={{ ...td, color: C.sub }}>
                  По ссылкам пока никто не пришёл.
                </td>
              </tr>
            )}
            {items.map((r) => (
              <tr key={`${r.inviter.id}-${r.invited.id}`} style={{ borderTop: `1px solid ${C.border}` }}>
                <td style={{ ...td, fontWeight: 600 }}>{who(r.inviter)}</td>
                <td style={td}>{who(r.invited)}</td>
                <td style={{ ...td, color: C.sub, whiteSpace: "nowrap" }}>{fmtDateTime(r.registered_at)}</td>
                <td style={td}>{r.completed_leads}</td>
                <td style={{ ...td, fontWeight: 600 }}>{r.paid_points.toLocaleString("ru-RU")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "10px 12px", fontWeight: 500, whiteSpace: "nowrap" };
const td: React.CSSProperties = { padding: "10px 12px", verticalAlign: "top" };
