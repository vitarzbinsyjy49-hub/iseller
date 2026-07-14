/** Избранное (демо): localStorage, без backend. Синхронизация между
 *  компонентами — через событие favorites-changed. */
import { useEffect, useState } from "react";

const KEY = "techshop_favorites";
const EVENT = "favorites-changed";

function read(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
}

export function isFavorite(id: number): boolean {
  return read().includes(id);
}

export function toggleFavorite(id: number): boolean {
  const list = read();
  const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* приватный режим — избранное просто не сохранится */
  }
  window.dispatchEvent(new Event(EVENT));
  return next.includes(id);
}

/** Хук: [в избранном?, переключить]. */
export function useFavorite(id: number): [boolean, () => void] {
  const [fav, setFav] = useState(() => isFavorite(id));
  useEffect(() => {
    setFav(isFavorite(id));
    const handler = () => setFav(isFavorite(id));
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, [id]);
  return [fav, () => toggleFavorite(id)];
}
