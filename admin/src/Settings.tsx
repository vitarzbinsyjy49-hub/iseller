/** Настройки программы лояльности: акция первой покупки, приглашения, списание.
 *
 *  Проценты вводятся ПРОЦЕНТАМИ, а хранятся в сотых процента — пересчёт живёт
 *  на границе с API, как в самой программе лояльности. Человек, который
 *  назначает ставку, думает про «1,5%», а не про «150».
 *
 *  Потолки вводятся в баллах, и это же рубли: балл равен рублю скидки.
 *  Потолок существует потому, что маржа магазина примерно постоянна в рублях,
 *  а процент растёт вместе с ценой — без потолка кэшбек с дорогой техники
 *  съедал бы маржу целиком. Подробности: docs/superpowers/specs/2026-09-12-
 *  loyalty-rebuild-design.md.
 */
import { useEffect, useState } from "react";
import { C, apiGet, apiSend, btn, card, input } from "./ui";

type LoyaltySettings = {
  referral_rate_bps: number;
  referral_cap_points: number;
  welcome_bonus_points: number;
  auto_accrual_enabled: boolean;
  newcomer_enabled: boolean;
  newcomer_rate_bps: number;
  newcomer_cap_points: number;
  newcomer_until: string | null;
  redeem_max_bps: number;
};

const PATH = "/admin/settings/loyalty";

const pct = (bps: number) => String(bps / 100);
/** Округление до целых сотых: 1,255% ввести можно, но хранить нечем. */
const toBps = (text: string) => Math.round(Number(text.replace(",", ".")) * 100);

const hint = { display: "block", marginTop: 6, fontSize: 12, color: C.sub } as const;
const field = { display: "block", fontSize: 13, color: C.sub, marginTop: 18 } as const;

export default function Settings({ token }: { token: string }) {
  const [newcomerOn, setNewcomerOn] = useState(false);
  const [newcomerRate, setNewcomerRate] = useState("");
  const [newcomerCap, setNewcomerCap] = useState("");
  const [newcomerUntil, setNewcomerUntil] = useState("");

  const [ratePercent, setRatePercent] = useState("");
  const [referralCap, setReferralCap] = useState("");
  const [welcome, setWelcome] = useState("");

  const [redeemPercent, setRedeemPercent] = useState("");
  const [enabled, setEnabled] = useState(true);

  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [busy, setBusy] = useState(false);

  function fill(s: LoyaltySettings) {
    setNewcomerOn(s.newcomer_enabled);
    setNewcomerRate(pct(s.newcomer_rate_bps));
    setNewcomerCap(String(s.newcomer_cap_points));
    setNewcomerUntil(s.newcomer_until ?? "");
    setRatePercent(pct(s.referral_rate_bps));
    setReferralCap(String(s.referral_cap_points));
    setWelcome(String(s.welcome_bonus_points));
    setRedeemPercent(pct(s.redeem_max_bps));
    setEnabled(s.auto_accrual_enabled);
  }

  useEffect(() => {
    apiGet<LoyaltySettings>(PATH, token)
      .then(fill)
      .catch((e) => setError(e instanceof Error ? e.message : "Не удалось загрузить настройки"));
  }, [token]);

  async function save() {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const body = {
        referral_rate_bps: toBps(ratePercent),
        referral_cap_points: Math.round(Number(referralCap)),
        welcome_bonus_points: Math.round(Number(welcome)),
        auto_accrual_enabled: enabled,
        newcomer_enabled: newcomerOn,
        newcomer_rate_bps: toBps(newcomerRate),
        newcomer_cap_points: Math.round(Number(newcomerCap)),
        // Пустая строка — это «срока нет», а не «1970-01-01».
        newcomer_until: newcomerUntil || null,
        redeem_max_bps: toBps(redeemPercent),
      };
      fill(await apiSend<LoyaltySettings>("PUT", PATH, token, body));
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
        Программа лояльности: сколько получает покупатель, его друг и пригласивший.
      </p>

      {error && <p style={{ color: C.red, marginTop: 12, fontSize: 13 }}>{error}</p>}
      {saved && <p style={{ color: C.green, marginTop: 12, fontSize: 13 }}>{saved}</p>}

      {/* ---- Акция первой покупки ---- */}
      <div style={{ ...card, marginTop: 16, maxWidth: 560 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Акция первой покупки</h3>
        <p style={{ ...hint, marginTop: 4 }}>
          Повышенный кэшбек за первую покупку человека. «Первая» считается по журналу
          покупок, а не по дате регистрации: регистрация ничего не стоит.
        </p>

        <label style={{ display: "flex", gap: 10, alignItems: "flex-start", marginTop: 14, fontSize: 13, minHeight: 44 }}>
          <input
            type="checkbox"
            checked={newcomerOn}
            onChange={(e) => setNewcomerOn(e.target.checked)}
            style={{ marginTop: 3, width: 18, height: 18 }}
          />
          <span>Акция включена</span>
        </label>

        <label style={field}>
          Ставка акции, %
          <input
            style={{ ...input, marginTop: 6, width: "100%" }}
            value={newcomerRate}
            inputMode="decimal"
            onChange={(e) => setNewcomerRate(e.target.value)}
          />
        </label>

        <label style={field}>
          Потолок начисления, баллов
          <input
            style={{ ...input, marginTop: 6, width: "100%" }}
            value={newcomerCap}
            inputMode="numeric"
            onChange={(e) => setNewcomerCap(e.target.value)}
          />
          <span style={hint}>
            Больше этого с одной покупки не начислится, какой бы ни был чек.
          </span>
        </label>

        <label style={field}>
          Действует по
          <input
            type="date"
            style={{ ...input, marginTop: 6, width: "100%" }}
            value={newcomerUntil}
            onChange={(e) => setNewcomerUntil(e.target.value)}
          />
          <span style={hint}>
            Последний день включительно. Срок считается по дате ЗАВЕРШЕНИЯ заявки:
            купили 30 октября, закрыли 3 ноября — акции не будет. Без срока акцию
            включить нельзя.
          </span>
        </label>
      </div>

      {/* ---- Приглашения ---- */}
      <div style={{ ...card, marginTop: 16, maxWidth: 560 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Приглашения</h3>

        <label style={field}>
          Процент пригласившему
          <input
            style={{ ...input, marginTop: 6, width: "100%" }}
            value={ratePercent}
            inputMode="decimal"
            onChange={(e) => setRatePercent(e.target.value)}
          />
          <span style={hint}>
            В процентах от итоговой суммы сделки приглашённого. Начисляется с каждой
            его покупки, без срока.
          </span>
        </label>

        <label style={field}>
          Потолок выплаты, баллов
          <input
            style={{ ...input, marginTop: 6, width: "100%" }}
            value={referralCap}
            inputMode="numeric"
            onChange={(e) => setReferralCap(e.target.value)}
          />
          <span style={hint}>
            Максимум с одной покупки друга. Без потолка пригласивший получал с
            крупного чека больше, чем сам покупатель.
          </span>
        </label>

        <label style={field}>
          Приветственные баллы другу
          <input
            style={{ ...input, marginTop: 6, width: "100%" }}
            value={welcome}
            inputMode="numeric"
            onChange={(e) => setWelcome(e.target.value)}
          />
          <span style={hint}>Разово, при первой завершённой сделке приглашённого.</span>
        </label>
      </div>

      {/* ---- Списание и автоматика ---- */}
      <div style={{ ...card, marginTop: 16, maxWidth: 560 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>Списание и автоматика</h3>

        <label style={field}>
          Доля чека, которую можно закрыть баллами, %
          <input
            style={{ ...input, marginTop: 6, width: "100%" }}
            value={redeemPercent}
            inputMode="decimal"
            onChange={(e) => setRedeemPercent(e.target.value)}
          />
          <span style={hint}>
            Ставить выше наценки нельзя: при марже около 5,5% списание в 10% чека —
            продажа в убыток.
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
