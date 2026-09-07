/** Настройки программы лояльности: ставка выплаты, приветственный бонус, рубильник.
 *
 *  Ставка вводится ПРОЦЕНТАМИ, а хранится в сотых процента — пересчёт живёт на
 *  границе с API, как в самой программе лояльности. Человек, который назначает
 *  выплату, думает про «1,5%», а не про «150».
 */
import { useEffect, useState } from "react";
import { C, apiGet, apiSend, btn, card, input } from "./ui";

type LoyaltySettings = {
  referral_rate_bps: number;
  welcome_bonus_points: number;
  auto_accrual_enabled: boolean;
};

const PATH = "/admin/settings/loyalty";

export default function Settings({ token }: { token: string }) {
  const [ratePercent, setRatePercent] = useState("");
  const [welcome, setWelcome] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiGet<LoyaltySettings>(PATH, token)
      .then((s) => {
        setRatePercent(String(s.referral_rate_bps / 100));
        setWelcome(String(s.welcome_bonus_points));
        setEnabled(s.auto_accrual_enabled);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Не удалось загрузить настройки"));
  }, [token]);

  async function save() {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const body = {
        // Округление до целых сотых: 1,255% ввести можно, но хранить нечем.
        referral_rate_bps: Math.round(Number(ratePercent.replace(",", ".")) * 100),
        welcome_bonus_points: Math.round(Number(welcome)),
        auto_accrual_enabled: enabled,
      };
      const fresh = await apiSend<LoyaltySettings>("PUT", PATH, token, body);
      setRatePercent(String(fresh.referral_rate_bps / 100));
      setWelcome(String(fresh.welcome_bonus_points));
      setEnabled(fresh.auto_accrual_enabled);
      setSaved("Сохранено");
    } catch (e) {
      // Форма не гаснет: текст ошибки приходит из detail ответа, и введённое
      // остаётся на месте — переписывать всё заново из-за одной опечатки незачем.
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 style={{ margin: 0 }}>Настройки</h2>
      <p style={{ margin: "6px 0 0", color: C.sub, fontSize: 13 }}>
        Программа лояльности: сколько получает пригласивший и его друг.
      </p>

      {error && <p style={{ color: C.red, marginTop: 12, fontSize: 13 }}>{error}</p>}
      {saved && <p style={{ color: C.green, marginTop: 12, fontSize: 13 }}>{saved}</p>}

      <div style={{ ...card, marginTop: 16, maxWidth: 560 }}>
        <label style={{ display: "block", fontSize: 13, color: C.sub }}>
          Процент пригласившему
          <input
            style={{ ...input, marginTop: 6, width: "100%" }}
            value={ratePercent}
            inputMode="decimal"
            onChange={(e) => setRatePercent(e.target.value)}
          />
          <span style={{ display: "block", marginTop: 6, fontSize: 12 }}>
            В процентах от итоговой суммы сделки приглашённого. Начисляется с каждой
            его покупки, без срока.
          </span>
        </label>

        <label style={{ display: "block", fontSize: 13, color: C.sub, marginTop: 18 }}>
          Приветственные баллы другу
          <input
            style={{ ...input, marginTop: 6, width: "100%" }}
            value={welcome}
            inputMode="numeric"
            onChange={(e) => setWelcome(e.target.value)}
          />
          <span style={{ display: "block", marginTop: 6, fontSize: 12 }}>
            Разово, при первой завершённой сделке приглашённого.
          </span>
        </label>

        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 18, fontSize: 13, minHeight: 44 }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ marginTop: 3, width: 18, height: 18 }}
          />
          <span>
            Автоматические начисления
            <span style={{ display: "block", color: C.sub, fontSize: 12, marginTop: 4 }}>
              Выключение останавливает весь автомат: и кэшбек покупателю, и выплаты
              по приглашениям. Ручное начисление из карточки клиента продолжает
              работать.
            </span>
          </span>
        </label>

        <button style={{ ...btn, marginTop: 20, minHeight: 44 }} disabled={busy} onClick={save}>
          {busy ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
    </div>
  );
}
