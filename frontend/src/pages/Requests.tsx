import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../lib/api";
import { track } from "../lib/analytics";
import { toast } from "../lib/toast";
import { formatPrice } from "../lib/format";
import { ErrorState } from "../components/StateViews";
import { leadTitle, leadTypeLabel, leadMetadataRows } from "../lib/leads";
import { Icon } from "../components/icons";
import { enterGridRefCallback, enterRefCallback } from "../lib/useEnter";

type Lead = {
  id: number; product_id: number | null; product_title: string | null; product_price: number | null;
  message: string | null; status: string; source: string; delivery_method: string | null;
  lead_type: string; metadata: Record<string, unknown> | null;
  manager_comment: string | null; created_at: string;
};

const STATUS_LABEL: Record<string, string> = {
  new: "Новая", in_progress: "В работе", reserved: "Бронь",
  completed: "Завершена", cancelled: "Отменена",
};
const STATUS_STYLE: Record<string, string> = {
  new: "bg-accent/10 text-accent",
  in_progress: "bg-[#fff3d6] text-[#b57e00]",
  reserved: "bg-green/10 text-green",
  completed: "bg-green/15 text-green",
  cancelled: "bg-mutedbg text-muted",
};
/** Подписи без emoji: это обычная строка текста в карточке заявки, и значок
 *  здесь ничего не добавлял, кроме системного шрифта посреди нашего. */
const DELIVERY_LABEL: Record<string, string> = {
  pickup: "Самовывоз · Горбушка",
  delivery: "Доставка по Москве",
};

/** Статусы, с которых пользователь ещё может отменить заявку сам —
 *  зеркало backend-проверки в POST /leads/{id}/cancel (leads.py). */
function cancellable(status: string): boolean {
  return status !== "completed" && status !== "cancelled";
}

const FILTERS = [
  { key: "", label: "Все" },
  { key: "new", label: "Новые" },
  { key: "in_progress", label: "В работе" },
  { key: "done", label: "Завершённые" },
];

export default function Requests() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  // Ошибка сети/сервера — НЕ то же самое, что «заявок нет»: раньше catch
  // подменял её пустым списком, и пользователь видел ложное «пусто».
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState("");
  // Заявка, для которой сейчас показано инлайн-подтверждение отмены —
  // максимум одна за раз, второй тап по другой карточке закрывает первую.
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);

  const load = () => {
    setLeads(null);
    setError(false);
    api<{ leads: Lead[] }>("/leads/my").then((d) => setLeads(d.leads)).catch(() => setError(true));
  };

  async function cancelLead(id: number) {
    setCancellingId(id);
    try {
      await api(`/leads/${id}/cancel`, { method: "POST" });
      setLeads((prev) => prev && prev.map((l) => (l.id === id ? { ...l, status: "cancelled" } : l)));
      track("lead_cancelled", { lead_id: id });
      setConfirmId(null);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не удалось отменить заявку", "error");
    } finally {
      setCancellingId(null);
    }
  }

  useEffect(() => { load(); }, []);

  const visible = useMemo(() => {
    if (!leads) return null;
    // «Все» — не буквально все: отменённые не удаляются и не пропадают из
    // данных, просто не маячат в основном списке рядом с активными. Смотреть
    // их — во вкладке «Завершённые» (там они и так уже были, вместе с completed).
    if (!filter) return leads.filter((l) => l.status !== "cancelled");
    if (filter === "done") return leads.filter((l) => l.status === "completed" || l.status === "cancelled");
    if (filter === "in_progress") return leads.filter((l) => l.status === "in_progress" || l.status === "reserved");
    return leads.filter((l) => l.status === filter);
  }, [leads, filter]);

  return (
    <div className="mx-auto max-w-md lg:max-w-5xl">
      <h1 className="text-2xl font-bold">Мои заявки</h1>

      <div className="no-scrollbar -mx-4 mt-3 flex gap-2 overflow-x-auto px-4 pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.key} onClick={() => setFilter(f.key)}
            className={`tap shrink-0 rounded-full px-3.5 py-2 text-xs font-medium transition-colors ${
              filter === f.key ? "bg-accent text-white" : "bg-surface text-text shadow-soft"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error ? (
        <div className="mt-6"><ErrorState message="Не удалось загрузить заявки" onRetry={load} /></div>
      ) : !visible ? (
        <div className="mt-4 space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-28 rounded-xl2" />)}
        </div>
      ) : visible.length === 0 ? (
        <div ref={enterRefCallback("fade")} className="mt-14 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-mutedbg text-muted">
            <Icon name="doc" className="h-7 w-7" strokeWidth={1.6} />
          </div>
          <p className="mt-3 text-[15px] font-bold">Заявок пока нет</p>
          <p className="mx-auto mt-1 max-w-[280px] text-sm text-muted">
            Заявка создаётся из карточки товара («Оставить заявку») или из AI-подбора —
            менеджер свяжется и всё уточнит.
          </p>
          <div className="mx-auto mt-4 flex max-w-xs flex-col gap-2 sm:max-w-none sm:flex-row sm:justify-center">
            <button
              onClick={() => {
                track("empty_state_action_clicked", { source: "requests_catalog" });
                navigate("/catalog");
              }}
              className="tap rounded-xl2 bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accentdark"
            >
              Открыть каталог
            </button>
            <button
              onClick={() => {
                track("empty_state_action_clicked", { source: "requests_ai" });
                navigate("/ai");
              }}
              className="tap flex items-center justify-center gap-2 rounded-xl2 bg-surface px-5 py-2.5 text-sm font-semibold text-accent shadow-soft"
            >
              <Icon name="sparkles" className="h-4 w-4" strokeWidth={2} />
              Подобрать через AI
            </button>
          </div>
        </div>
      ) : (
        // Desktop: 2 колонки компактных карточек; mobile — прежний список
        <div className="stagger mt-4 space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {visible.map((l) => (
            <div key={l.id} ref={enterGridRefCallback("fadeUp")} className="rounded-xl2 bg-surface p-4 shadow-soft transition-shadow lg:hover:shadow-[0_8px_24px_rgba(17,24,39,0.10)]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold">{leadTitle(l)}</p>
                  {l.product_price != null && (
                    <p className="mt-0.5 text-sm font-bold text-text">{formatPrice(l.product_price)}</p>
                  )}
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_STYLE[l.status] ?? "bg-mutedbg text-muted"}`}>
                  {STATUS_LABEL[l.status] ?? l.status}
                </span>
              </div>

              {/* Тип сценария (для не-обычных заявок) */}
              {l.lead_type && l.lead_type !== "general" && (
                <span className="mt-2 inline-block rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] font-semibold text-accent">
                  {leadTypeLabel(l.lead_type)}
                </span>
              )}

              {/* Краткое резюме сценария — локализованные поля metadata, не сырой JSON */}
              {leadMetadataRows(l.metadata).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                  {leadMetadataRows(l.metadata).map((r) => (
                    <span key={r.label} className="text-[12px] text-muted">
                      <span className="text-text/70">{r.label}:</span> <span className="font-medium text-text">{r.value}</span>
                    </span>
                  ))}
                </div>
              )}

              {l.delivery_method && (
                <p className="mt-2 text-xs text-muted">{DELIVERY_LABEL[l.delivery_method] ?? l.delivery_method}</p>
              )}
              {l.message && <p className="mt-1.5 line-clamp-2 break-words text-[13px] text-muted">{l.message}</p>}
              {l.manager_comment && (
                <p className="mt-2 rounded-xl bg-mutedbg px-3 py-2 text-xs text-muted">
                  <span className="font-semibold text-text">Менеджер:</span> {l.manager_comment}
                </p>
              )}
              {cancellable(l.status) && (
                <div className="mt-3 border-t border-border pt-2.5">
                  {confirmId === l.id ? (
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted">Точно отменить?</span>
                      <div className="flex gap-2">
                        <button
                          className="tap rounded-full px-3 py-1.5 text-xs font-medium text-muted"
                          onClick={() => setConfirmId(null)}
                        >
                          Нет
                        </button>
                        <button
                          className="tap rounded-full bg-danger px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-60"
                          disabled={cancellingId === l.id}
                          onClick={() => cancelLead(l.id)}
                        >
                          {cancellingId === l.id ? "Отменяем…" : "Да, отменить"}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="tap text-xs font-medium text-danger"
                      onClick={() => setConfirmId(l.id)}
                    >
                      Отменить заявку
                    </button>
                  )}
                </div>
              )}
              <p className="mt-2 text-[11px] text-muted">
                №{l.id} · {new Date(l.created_at).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
