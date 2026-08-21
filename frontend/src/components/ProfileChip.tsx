import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { User } from "../store/auth";
import { initials, displayName } from "../lib/user";

/** Профиль-чип вместо «одинокой буквы»: аватар из Telegram (если есть) или
 *  инициалы + (на desktop) имя. Ведёт на /profile, где уже есть полная
 *  карточка (имя/username/источник). */
export function ProfileChip({ user, variant }: { user: User | null; variant: "mobile" | "desktop" }) {
  const navigate = useNavigate();
  const name = displayName(user?.first_name, user?.last_name, user?.username);
  const init = initials(user?.first_name, user?.last_name, user?.username);
  // Ссылка на аватар может протухнуть (Telegram хранит их не вечно) —
  // тогда откатываемся на инициалы, а не показываем битую картинку.
  const [photoFailed, setPhotoFailed] = useState(false);
  const showPhoto = !!user?.photo_url && !photoFailed;

  if (variant === "desktop") {
    return (
      <button
        onClick={() => navigate("/profile")}
        title={name}
        aria-label={`Профиль: ${name}`}
        className="tap flex max-w-[180px] items-center gap-2 rounded-full py-1 pl-1 pr-3 transition-colors hover:bg-mutedbg"
      >
        {showPhoto ? (
          <img
            src={user!.photo_url!}
            alt=""
            onError={() => setPhotoFailed(true)}
            className="h-8 w-8 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">
            {init}
          </span>
        )}
        <span className="min-w-0 truncate text-sm font-medium text-text">{name}</span>
      </button>
    );
  }

  return (
    <button
      onClick={() => navigate("/profile")}
      aria-label={`Профиль: ${name}`}
      title={name}
      className="tap flex h-11 w-11 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      {/* Кружок 36px, область нажатия 44px — как у остальных круглых кнопок. */}
      {showPhoto ? (
        <img
          src={user!.photo_url!}
          alt=""
          onError={() => setPhotoFailed(true)}
          className="h-9 w-9 rounded-full object-cover"
        />
      ) : (
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">
          {init}
        </span>
      )}
    </button>
  );
}
