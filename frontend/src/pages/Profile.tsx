import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth";
import {
  addToHomeScreen,
  checkHomeScreenStatus,
  isInsideTelegram,
  openExternalLink,
  type HomeScreenStatus,
} from "../lib/telegram";
import { usePublicConfig } from "../lib/appConfig";
import { useFavoriteIds } from "../lib/favorites";
import { ScenarioRequestSheet } from "../components/ScenarioSheet";
import { Icon, type IconName } from "../components/icons";
import type { ScenarioKey } from "../lib/scenario";
import { track } from "../lib/analytics";
import { fetchLoyalty, formatRate, type LoyaltyAccount } from "../lib/loyalty";

export default function Profile() {
  const user = useAuthStore((s) => s.user);
  const navigate = useNavigate();
  const config = usePublicConfig();
  const [leadCount, setLeadCount] = useState<number | null>(null);
  const favCount = useFavoriteIds().length;  // из памяти, без лишнего запроса
  // Опт / бизнес / Trade-In открывают ту же встроенную сценарную заявку, что и
  // быстрые действия на Главной: один и тот же раздел не должен вести себя
  // по-разному в зависимости от того, откуда в него зашли.
  const [scenario, setScenario] = useState<ScenarioKey | null>(null);
  // Контакт обязателен, только если менеджеру некуда ответить в Telegram.
  const requirePhone = !user?.username;

  const managerUrlFor = (k: ScenarioKey): string =>
    (k === "trade_in" ? config.manager_tradein_url
      : k === "b2b" ? config.manager_b2b_url
      : config.manager_wholesale_url) || config.manager_retail_url;

  function openScenario(k: ScenarioKey) {
    track("quick_scenario_clicked", { scenario: k, from: "profile" });
    setScenario(k);
  }

  /** Открыть диалог с менеджером; если ссылка не настроена — AI-консультант. */
  function openManager(url: string) {
    if (!openExternalLink(url || config.manager_retail_url)) navigate("/ai");
  }

  useEffect(() => {
    api<{ leads: unknown[] }>("/leads/my").then((d) => setLeadCount(d.leads.length)).catch(() => setLeadCount(0));
  }, []);

  // Счёт лояльности. Сбой запроса оставляет блок в нейтральном виде — карточка
  // с ошибкой в профиле пугает сильнее, чем отсутствие цифры.
  const [loyalty, setLoyalty] = useState<LoyaltyAccount | null>(null);
  useEffect(() => { fetchLoyalty().then(setLoyalty).catch(() => setLoyalty(null)); }, []);

  // Ярлык на домашнем экране (Bot API 8.0). Спрашиваем Telegram, а не гадаем:
  // на desktop и старых клиентах метода нет, и кнопка, которая ничего не
  // делает, — худший вид интерфейса. Показываем ТОЛЬКО при «missed».
  const [homeScreen, setHomeScreen] = useState<HomeScreenStatus>("unsupported");
  useEffect(() => { checkHomeScreenStatus().then(setHomeScreen); }, []);

  function addShortcut() {
    track("home_screen_prompted", { from: "profile" });
    if (!addToHomeScreen()) return;
    // Telegram не сообщает результат синхронно: диалог показывает он сам.
    // Перепроверяем состояние — если ярлык встал, предложение исчезнет.
    setTimeout(() => { checkHomeScreenStatus().then(setHomeScreen); }, 3000);
  }

  const name = [user?.first_name, user?.last_name].filter(Boolean).join(" ") || "Гость";
  const source = isInsideTelegram() ? "Telegram Mini App" : "Веб (dev-режим)";
  // Ссылка на аватар может протухнуть (Telegram хранит их не вечно) —
  // тогда откатываемся на инициалы, а не показываем битую картинку. Тот же
  // паттерн, что и у ProfileChip в шапке.
  const [photoFailed, setPhotoFailed] = useState(false);
  const showPhoto = !!user?.photo_url && !photoFailed;

  return (
    <div className="mx-auto max-w-md lg:max-w-5xl">
      <h1 className="text-2xl font-bold">Профиль</h1>

      {/* Карточка пользователя — профильный header на всю ширину */}
      <div className="mt-4 flex items-center gap-4 rounded-xl2 bg-surface p-4 shadow-soft lg:p-6">
        {showPhoto ? (
          <img
            src={user!.photo_url!}
            alt=""
            onError={() => setPhotoFailed(true)}
            className="h-14 w-14 shrink-0 rounded-full object-cover"
          />
        ) : (
          <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xl font-bold text-accent">
            {name[0]?.toUpperCase() ?? "?"}
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-[16px] font-bold">{name}</p>
          {user?.username && <p className="text-sm text-muted">@{user.username}</p>}
          <p className="text-xs text-muted">{source}</p>
        </div>
      </div>

      {/* Desktop: 2 колонки — [аккаунт/заявки | контакты/опт/B2B/Trade-In] */}
      <div className="lg:mt-6 lg:grid lg:grid-cols-2 lg:items-start lg:gap-6">
      <div>
      {/* Баллы. Пока счёт не загрузился, показываем уровень и ставку как
          «—»: подставить нули значило бы сообщить человеку, что у него ничего
          нет, хотя мы этого ещё не знаем. */}
      <button
        onClick={() => navigate("/loyalty")}
        className="tap mt-3 flex w-full items-center justify-between gap-3 rounded-xl2 bg-gradient-to-r from-[#e3f2fd] to-[#e8eaf6] p-4 text-left lg:mt-0"
      >
        <div className="min-w-0">
          <p className="text-sm font-bold">Баллы</p>
          <p className="mt-0.5 text-xs text-muted">
            {loyalty
              ? `${loyalty.level.title} · кэшбек ${formatRate(loyalty.level.rate_bps)}${
                  loyalty.next_level ? ` · до «${loyalty.next_level.title}» ${Math.round(loyalty.to_next).toLocaleString("ru-RU")} ₽` : ""
                }`
              : "Копите кэшбек с покупок"}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded-full bg-surface px-3 py-1.5 text-sm font-bold shadow-soft">
          {loyalty ? loyalty.balance.toLocaleString("ru-RU") : "—"}
          <Icon name="sparkles" className="h-3.5 w-3.5 text-accent" strokeWidth={2} />
        </span>
      </button>

      {/* Ярлык на домашний экран. Появляется только когда Telegram подтвердил,
          что ярлыка нет и добавить его можно — иначе блока нет вовсе, а не
          «есть, но неактивен»: неработающая кнопка обесценивает соседние. */}
      {homeScreen === "missed" && (
        <div className="pop-in mt-3 flex items-center gap-3 rounded-xl2 bg-surface p-4 shadow-soft">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-field bg-accent/10 text-accent">
            <Icon name="phone" className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-bold">Магазин на домашний экран</p>
            <p className="mt-0.5 text-xs leading-4 text-muted">
              Открывайте каталог в одно касание, как обычное приложение
            </p>
          </div>
          <button
            onClick={addShortcut}
            className="tap shrink-0 rounded-field bg-accent px-3.5 py-2 text-[13px] font-semibold text-white"
          >
            Добавить
          </button>
        </div>
      )}

      {/* Меню */}
      <div className="mt-3 overflow-hidden rounded-xl2 bg-surface shadow-soft">
        <MenuRow icon="heart" title="Избранное"
          badge={favCount > 0 ? String(favCount) : undefined}
          subtitle={favCount > 0 ? undefined : "Сохраняйте понравившиеся товары"}
          onClick={() => navigate("/favorites")} />
        <MenuRow icon="doc" title="Мои заявки" badge={leadCount === null ? "…" : String(leadCount)}
          onClick={() => navigate("/requests")} />
        <MenuRow icon="clock" title="История просмотров" subtitle="Товары, которые вы открывали"
          onClick={() => navigate("/history")} />
        <MenuRow icon="pin" title="Точка выдачи" subtitle="Горбушка, Москва — ежедневно 10:00–21:00"
          onClick={() => navigate("/info#contacts")} />
        <MenuRow icon="info" title="О магазине" subtitle="Доставка, оплата, гарантия и контакты" last
          onClick={() => navigate("/info")} />
      </div>
      </div>{/* /левая колонка */}

      <div>
      {/* Связь с менеджерами: ссылки приходят из /api/config/public (.env backend),
          во фронтенде контактов нет. Пустая специальная ссылка -> розничный менеджер. */}
      <h2 className="mt-5 text-[17px] font-bold lg:mt-0">Связаться с нами</h2>
      <div className="mt-2 overflow-hidden rounded-xl2 bg-surface shadow-soft">
        <MenuRow icon="chat" title="Написать менеджеру" subtitle="Вопросы по товарам и заказам — ответим быстро"
          onClick={() => openManager(config.manager_retail_url)} />
        <MenuRow icon="box" title="Оптовая закупка" subtitle="Партии от 5 шт, спеццены"
          onClick={() => openScenario("wholesale")} />
        <MenuRow icon="building" title="Поставка для компании" subtitle="Техника для офиса, документы для юрлиц"
          onClick={() => openScenario("b2b")} />
        <MenuRow icon="refresh" title="Trade-In / предложить технику" subtitle="Обменяйте старое устройство или продайте нам" last
          onClick={() => openScenario("trade_in")} />
      </div>
      </div>{/* /правая колонка */}
      </div>{/* /desktop 2 колонки */}

      {scenario && (
        <ScenarioRequestSheet
          scenario={scenario}
          managerUrl={managerUrlFor(scenario)}
          requirePhone={requirePhone}
          onClose={() => setScenario(null)}
        />
      )}
    </div>
  );
}

function MenuRow({
  icon, title, subtitle, badge, onClick, last,
}: { icon: IconName; title: string; subtitle?: string; badge?: string; onClick?: () => void; last?: boolean }) {
  return (
    <button
      onClick={onClick} disabled={!onClick}
      className={`tap flex w-full items-center gap-3 px-4 py-3.5 text-left ${last ? "" : "border-b border-border"}`}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-mutedbg text-muted">
        <Icon name={icon} className="h-[18px] w-[18px]" />
      </span>
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
