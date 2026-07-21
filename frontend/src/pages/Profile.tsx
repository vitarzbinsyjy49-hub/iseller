import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
import { isInsideTelegram, openExternalLink } from "../lib/telegram";
import { usePublicConfig } from "../lib/appConfig";
import { useFavoriteIds } from "../lib/favorites";

export default function Profile() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const config = usePublicConfig();
  const [leadCount, setLeadCount] = useState<number | null>(null);
  const favCount = useFavoriteIds().length;  // из памяти, без лишнего запроса

  /** Открыть диалог с менеджером; если ссылка не настроена — AI-консультант. */
  function openManager(url: string) {
    if (!openExternalLink(url || config.manager_retail_url)) navigate("/ai");
  }

  useEffect(() => {
    api<{ leads: unknown[] }>("/leads/my").then((d) => setLeadCount(d.leads.length)).catch(() => setLeadCount(0));
  }, []);

  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "Гость";
  const source = isInsideTelegram() ? "Telegram Mini App" : "Веб (dev-режим)";

  return (
    <div className="mx-auto max-w-md lg:max-w-5xl">
      <h1 className="text-2xl font-bold">Профиль</h1>

      {/* Карточка пользователя — профильный header на всю ширину */}
      <div className="mt-4 flex items-center gap-4 rounded-xl2 bg-surface p-4 shadow-soft lg:p-6">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/10 text-xl font-bold text-accent">
          {name[0]?.toUpperCase() ?? "?"}
        </div>
        <div className="min-w-0">
          <p className="truncate text-[16px] font-bold">{name}</p>
          {user?.username && <p className="text-sm text-muted">@{user.username}</p>}
          <p className="text-xs text-muted">{source}</p>
        </div>
      </div>

      {/* Desktop: 2 колонки — [аккаунт/заявки | контакты/опт/B2B/Trade-In] */}
      <div className="lg:mt-6 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6">
      <div>
      {/* Бонусы — заглушка */}
      <div className="mt-3 flex items-center justify-between rounded-xl2 bg-gradient-to-r from-[#e3f2fd] to-[#e8eaf6] p-4 lg:mt-0">
        <div>
          <p className="text-sm font-bold">Бонусы</p>
          <p className="mt-0.5 text-xs text-muted">Скоро: копите баллы за покупки</p>
        </div>
        <span className="rounded-full bg-surface px-3 py-1.5 text-sm font-bold shadow-soft">0 ✨</span>
      </div>

      {/* Меню */}
      <div className="mt-3 overflow-hidden rounded-xl2 bg-surface shadow-soft">
        <MenuRow icon="❤️" title="Избранное"
          badge={favCount > 0 ? String(favCount) : undefined}
          subtitle={favCount > 0 ? undefined : "Сохраняйте понравившиеся товары"}
          onClick={() => navigate("/favorites")} />
        <MenuRow icon="📋" title="Мои заявки" badge={leadCount === null ? "…" : String(leadCount)}
          onClick={() => navigate("/requests")} />
        <MenuRow icon="🕐" title="История просмотров" subtitle="Скоро" />
        <MenuRow icon="📍" title="Точка выдачи" subtitle="Горбушка, Москва — ежедневно 10:00–21:00" />
        <MenuRow icon="ℹ️" title="О магазине" subtitle="Техника с Горбушки: проверка при вас, гарантия" last />
      </div>
      </div>{/* /левая колонка */}

      <div>
      {/* Связь с менеджерами: ссылки приходят из /api/config/public (.env backend),
          во фронтенде контактов нет. Пустая специальная ссылка -> розничный менеджер. */}
      <h2 className="mt-5 text-[17px] font-bold lg:mt-0">Связаться с нами</h2>
      <div className="mt-2 overflow-hidden rounded-xl2 bg-surface shadow-soft">
        <MenuRow icon="💬" title="Написать менеджеру" subtitle="Вопросы по товарам и заказам — ответим быстро"
          onClick={() => openManager(config.manager_retail_url)} />
        <MenuRow icon="📦" title="Оптовая закупка" subtitle="Партии от 5 шт, спеццены"
          onClick={() => openManager(config.manager_wholesale_url)} />
        <MenuRow icon="🏢" title="Поставка для компании" subtitle="Техника для офиса, документы для юрлиц"
          onClick={() => openManager(config.manager_b2b_url)} />
        <MenuRow icon="🔄" title="Trade-In / предложить технику" subtitle="Обменяйте старое устройство или продайте нам" last
          onClick={() => openManager(config.manager_tradein_url)} />
      </div>
      </div>{/* /правая колонка */}
      </div>{/* /desktop 2 колонки */}
    </div>
  );
}

function MenuRow({
  icon, title, subtitle, badge, onClick, last,
}: { icon: string; title: string; subtitle?: string; badge?: string; onClick?: () => void; last?: boolean }) {
  return (
    <button
      onClick={onClick} disabled={!onClick}
      className={`tap flex w-full items-center gap-3 px-4 py-3.5 text-left ${last ? "" : "border-b border-border"}`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-mutedbg text-lg">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{title}</span>
        {subtitle && <span className="mt-0.5 block truncate text-xs text-muted">{subtitle}</span>}
      </span>
      {badge && <span className="rounded-full bg-accent/10 px-2.5 py-1 text-xs font-bold text-accent">{badge}</span>}
      {onClick && (
        <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 text-muted" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
      )}
    </button>
  );
}
