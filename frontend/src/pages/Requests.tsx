import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { formatPrice } from "../lib/format";

type Lead = {
  id: number; product_id: number | null; product_title: string | null; product_price: number | null;
  message: string | null; status: string; source: string; delivery_method: string | null;
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
const DELIVERY_LABEL: Record<string, string> = {
  pickup: "🏬 Самовывоз · Горбушка",
  delivery: "🚚 Доставка по Москве",
};

const FILTERS = [
  { key: "", label: "Все" },
  { key: "new", label: "Новые" },
  { key: "in_progress", label: "В работе" },
  { key: "done", label: "Завершённые" },
];

export default function Requests() {
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api<{ leads: Lead[] }>("/leads/my").then((d) => setLeads(d.leads)).catch(() => setLeads([]));
  }, []);

  const visible = useMemo(() => {
    if (!leads) return null;
    if (!filter) return leads;
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

      {!visible ? (
        <div className="mt-4 space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-28 rounded-xl2" />)}
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-14 text-center">
          <div className="text-4xl">📋</div>
          <p className="mx-auto mt-3 max-w-[260px] text-sm text-muted">
            Заявок пока нет. Найдите товар в каталоге или через AI-подбор и оставьте заявку.
          </p>
          <button onClick={() => navigate("/catalog")} className="tap mt-4 rounded-xl2 bg-accent px-5 py-2.5 text-sm font-semibold text-white">
            В каталог
          </button>
        </div>
      ) : (
        // Desktop: 2 колонки компактных карточек; mobile — прежний список
        <div className="stagger mt-4 space-y-3 lg:grid lg:grid-cols-2 lg:gap-4 lg:space-y-0">
          {visible.map((l) => (
            <div key={l.id} className="card-appear rounded-xl2 bg-surface p-4 shadow-soft transition-shadow lg:hover:shadow-[0_8px_24px_rgba(17,24,39,0.10)]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold">{l.product_title || "Консультация"}</p>
                  {l.product_price != null && (
                    <p className="mt-0.5 text-sm font-bold text-text">{formatPrice(l.product_price)}</p>
                  )}
                </div>
                <span className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold ${STATUS_STYLE[l.status] ?? "bg-mutedbg text-muted"}`}>
                  {STATUS_LABEL[l.status] ?? l.status}
                </span>
              </div>

              {l.delivery_method && (
                <p className="mt-2 text-xs text-muted">{DELIVERY_LABEL[l.delivery_method] ?? l.delivery_method}</p>
              )}
              {l.message && <p className="mt-1.5 line-clamp-2 text-[13px] text-muted">{l.message}</p>}
              {l.manager_comment && (
                <p className="mt-2 rounded-xl bg-mutedbg px-3 py-2 text-xs text-muted">
                  <span className="font-semibold text-text">Менеджер:</span> {l.manager_comment}
                </p>
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
