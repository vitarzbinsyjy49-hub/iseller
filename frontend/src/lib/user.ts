/** Утилиты профиля пользователя (без backend — только форматирование). */

export function initials(
  firstName?: string | null,
  lastName?: string | null,
  username?: string | null,
): string {
  const f = (firstName ?? "").trim();
  const l = (lastName ?? "").trim();
  if (f && l) return (f[0] + l[0]).toUpperCase();
  if (f) return f.slice(0, 2).toUpperCase();
  const u = (username ?? "").trim();
  if (u) return u.slice(0, 2).toUpperCase();
  return "?";
}

export function displayName(
  firstName?: string | null,
  lastName?: string | null,
  username?: string | null,
): string {
  const full = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (full) return full;
  if (username) return `@${username}`;
  return "Профиль";
}
