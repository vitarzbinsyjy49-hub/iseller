import { useNavigate } from "react-router-dom";
import type { User } from "../store/auth";
import { initials, displayName } from "../lib/user";

/** Профиль-чип вместо «одинокой буквы»: инициалы + (на desktop) имя.
 *  Ведёт на /profile, где уже есть полная карточка (имя/username/источник). */
export function ProfileChip({ user, variant }: { user: User | null; variant: "mobile" | "desktop" }) {
  const navigate = useNavigate();
  const name = displayName(user?.first_name, user?.last_name, user?.username);
  const init = initials(user?.first_name, user?.last_name, user?.username);

  if (variant === "desktop") {
    return (
      <button
        onClick={() => navigate("/profile")}
        title={name}
        aria-label={`Профиль: ${name}`}
        className="tap flex max-w-[180px] items-center gap-2 rounded-full py-1 pl-1 pr-3 transition-colors hover:bg-mutedbg"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent/10 text-xs font-bold text-accent">
          {init}
        </span>
        <span className="min-w-0 truncate text-sm font-medium text-text">{name}</span>
      </button>
    );
  }

  return (
    <button
      onClick={() => navigate("/profile")}
      aria-label={`Профиль: ${name}`}
      title={name}
      className="tap flex h-9 w-9 items-center justify-center rounded-full bg-white/15 text-xs font-bold text-white backdrop-blur"
    >
      {init}
    </button>
  );
}
