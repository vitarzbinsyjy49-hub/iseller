/** «Цены» — режим администратора (вариант A): вход с подтверждением в боте,
 *  поиск, фильтры и быстрая правка цены. Попасть сюда может кто угодно по
 *  адресу, но без staff-токена сервер не отдаст ни одного товара. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import ScreenHeader from "../components/ScreenHeader";
import StaffPriceSheet from "../components/StaffPriceSheet";
import { Icon } from "../components/icons";
import { usePublicConfig } from "../lib/appConfig";
import {
  clearStaffSession, hasStaffSession, listStaffProducts, pollStaffLogin, saveStaffSession,
  startStaffLogin, type StaffFilter, type StaffProduct,
} from "../lib/staff";
import { openExternalLink } from "../lib/telegram";

const FILTERS: { key: StaffFilter; label: string }[] = [
  { key: "all", label: "Все" },
  { key: "in_stock", label: "В наличии" },
  { key: "recent", label: "Менялись за 7 дней" },
  { key: "out_of_stock", label: "Нет в наличии" },
];

const fmt = (n: number | null) => (n == null ? "—" : `${Math.round(n).toLocaleString("ru-RU")} ₽`);

function StaffLogin({ onReady }: { onReady: () => void }) {
  const config = usePublicConfig();
  const [state, setState] = useState<"idle" | "waiting" | "expired" | "denied" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);

  async function start() {
    setError(null);
    try {
      const { request_id, ttl_seconds } = await startStaffLogin();
      setState("waiting");
      const deadline = Date.now() + ttl_seconds * 1000;
      timer.current = window.setInterval(async () => {
        if (Date.now() > deadline) {
          window.clearInterval(timer.current!); setState("expired"); return;
        }
        try {
          const r = await pollStaffLogin(request_id);
          if (r.status === "approved") {
            window.clearInterval(timer.current!);
            saveStaffSession(r.token, r.expires_in);
            onReady();
          } else if (r.status === "expired") {
            window.clearInterval(timer.current!); setState("expired");
          }
        } catch { /* сеть моргнула — следующий опрос через 2 секунды */ }
      }, 2000);
    } catch (e) {
      const status = (e as { status?: number }).status;
      setState(status === 403 ? "denied" : "error");
      setError(e instanceof Error ? e.message : null);
    }
  }

  const bot = config.bot_username;
  return (
    <div className="mt-4 rounded-xl2 bg-surface p-4 shadow-soft">
      <div className="flex items-start gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-field bg-accent/10 text-accent">
          <Icon name="shield" className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-bold">Вход в режим администратора</p>
          <p className="mt-0.5 text-xs leading-4 text-muted">
            {state === "waiting"
              ? "Мы отправили сообщение в чат с ботом. Нажмите там «Подтвердить вход» — экран откроется сам."
              : "Для защиты вход подтверждается в чате с ботом: без вашего Telegram войти нельзя."}
          </p>
        </div>
      </div>
      {state === "waiting" ? (
        bot && (
          <button onClick={() => openExternalLink(`https://t.me/${bot}`)}
            className="tap mt-3 min-h-11 w-full rounded-field bg-accent px-4 text-[15px] font-semibold text-white">
            Открыть чат с ботом
          </button>
        )
      ) : (
        <button onClick={start}
          className="tap mt-3 min-h-11 w-full rounded-field bg-accent px-4 text-[15px] font-semibold text-white">
          {state === "expired" ? "Запросить вход ещё раз" : "Войти"}
        </button>
      )}
      {state === "expired" && <p className="mt-2 text-[13px] text-muted">Ссылка устарела — запросите вход ещё раз.</p>}
      {state === "denied" && <p className="mt-2 text-[13px] text-danger">У этого аккаунта нет прав администратора.</p>}
      {state === "error" && <p className="mt-2 text-[13px] text-danger">{error ?? "Не удалось начать вход"}</p>}
    </div>
  );
}

export default function StaffPrices() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(hasStaffSession());
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<StaffFilter>("all");
  const [items, setItems] = useState<StaffProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<StaffProduct | null>(null);

  const load = useCallback(async (append = false) => {
    setLoading(true);
    try {
      const r = await listStaffProducts(q, filter, append ? items.length : 0);
      setTotal(r.total);
      setItems((prev) => (append ? [...prev, ...r.items] : r.items));
    } catch (e) {
      if ((e as { status?: number }).status === 401 || (e as { status?: number }).status === 403) setReady(false);
    } finally {
      setLoading(false);
    }
  }, [q, filter, items.length]);

  useEffect(() => {
    if (!ready) return;
    const t = window.setTimeout(() => { void load(false); }, 250);
    return () => window.clearTimeout(t);
    // load зависит от items.length только для догрузки; поиск/фильтр — новый список
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, q, filter]);

  function onSaved(p: StaffProduct) {
    setItems((prev) => prev.map((x) => (x.id === p.id ? p : x)));
    setEditing((cur) => (cur && cur.id === p.id ? p : cur));
  }

  return (
    <div className="mx-auto max-w-md pb-6 lg:max-w-3xl">
      <ScreenHeader title="Цены" subtitle={ready ? `Режим администратора · ${total} товаров` : "Режим администратора"} />

      {!ready ? (
        <StaffLogin onReady={() => setReady(true)} />
      ) : (
        <>
          <div className="mt-3 flex items-center gap-2 rounded-field border border-border bg-surface px-3">
            <Icon name="search" className="h-4 w-4 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Название или артикул: MDVH4"
              className="min-h-11 flex-1 bg-transparent text-[15px] outline-none" />
          </div>
          <div className="no-scrollbar mt-2 flex gap-2 overflow-x-auto">
            {FILTERS.map((f) => (
              <button key={f.key} onClick={() => setFilter(f.key)}
                className={`tap shrink-0 rounded-full border px-3 py-1.5 text-[13px] font-semibold ${
                  filter === f.key ? "border-accent bg-accent/10 text-accent" : "border-border text-muted"}`}>
                {f.label}
              </button>
            ))}
          </div>

          <ul className="mt-3 divide-y divide-border rounded-xl2 bg-surface shadow-soft">
            {items.map((p) => (
              <li key={p.id}>
                <button onClick={() => setEditing(p)} className="tap flex w-full items-center gap-3 px-3 py-2.5 text-left">
                  {p.image ? (
                    <img src={p.image} alt="" className="h-10 w-10 shrink-0 rounded-field object-contain" loading="lazy" />
                  ) : (
                    <span className="h-10 w-10 shrink-0 rounded-field bg-mutedbg" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-[13.5px] leading-[1.3]">{p.title}</p>
                    <p className="text-[11.5px] text-muted">
                      {p.sku ?? "—"}{p.in_stock ? "" : " · нет в наличии"}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-field border border-border px-2 py-1 text-[14px] font-bold">{fmt(p.price)}</span>
                </button>
              </li>
            ))}
            {!loading && items.length === 0 && (
              <li className="px-3 py-6 text-center text-[13px] text-muted">Ничего не нашлось</li>
            )}
          </ul>
          {items.length < total && (
            <button onClick={() => load(true)} disabled={loading}
              className="tap mt-3 min-h-11 w-full rounded-field border border-border text-[14px] font-semibold">
              {loading ? "Загружаю…" : `Показать ещё (${total - items.length})`}
            </button>
          )}
          <button onClick={() => { clearStaffSession(); navigate("/profile"); }}
            className="tap mt-4 min-h-11 w-full rounded-field text-[14px] text-muted">
            Выйти из режима администратора
          </button>
        </>
      )}

      {editing && <StaffPriceSheet product={editing} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </div>
  );
}
