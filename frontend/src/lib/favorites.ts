/** Избранное: серверное хранение (/api/favorites) с localStorage как быстрым
 *  кэшем и оффлайн-fallback. Личность пользователя — существующая (JWT из
 *  Telegram-авторизации), отдельной идентичности не заводим.
 *
 *  - при загрузке модуля состояние берём из localStorage (сердечки видны
 *    мгновенно, без запроса);
 *  - при входе (после setUser) вызываем hydrateFavorites(): сливаем локальное
 *    в серверное (не затирая серверное пустым локальным) и берём серверный
 *    список как истину;
 *  - toggle оптимистичный: UI меняется сразу, при ошибке сервера — откат;
 *  - антидабл-клик: пока запрос по товару летит, повторный игнорируется;
 *  - синхронизация между компонентами — событие favorites-changed. */
import { useEffect, useState } from "react";
import { api } from "./api";

const KEY = "techshop_favorites";
const EVENT = "favorites-changed";

function readLocal(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
}

let ids = new Set<number>(readLocal());
const inFlight = new Set<number>(); // товары с летящим запросом

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...ids]));
  } catch {
    /* приватный режим — просто не кэшируем */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function isFavorite(id: number): boolean {
  return ids.has(id);
}

export function favoriteIds(): number[] {
  return [...ids];
}

/** Гидратация с сервера при входе. Пустой локальный список НЕ затирает
 *  серверное избранное (merge вызывается только при непустом локальном). */
export async function hydrateFavorites(): Promise<void> {
  try {
    const local = [...ids];
    const res = local.length
      ? await api<{ ids: number[] }>("/favorites/merge", {
          method: "POST",
          body: JSON.stringify({ ids: local }),
        })
      : await api<{ ids: number[] }>("/favorites/ids");
    ids = new Set((res.ids || []).filter((x) => typeof x === "number"));
    persist();
  } catch {
    /* сервер недоступен — остаёмся на localStorage-состоянии */
  }
}

/** Переключить избранное. Оптимистично + откат при ошибке сервера.
 *  Возвращает финальное состояние (в избранном ли товар). */
export async function toggleFavorite(id: number): Promise<boolean> {
  if (inFlight.has(id)) return ids.has(id);
  const wasFav = ids.has(id);
  if (wasFav) ids.delete(id);
  else ids.add(id);
  persist(); // оптимистично
  inFlight.add(id);
  try {
    await api(`/favorites/${id}`, { method: wasFav ? "DELETE" : "PUT" });
  } catch (e) {
    if (wasFav) ids.add(id);
    else ids.delete(id); // откат
    persist();
    throw e;
  } finally {
    inFlight.delete(id);
  }
  return ids.has(id);
}

/** Хук карточки/деталей: [в избранном?, переключить(async), занят?]. */
export function useFavorite(id: number): [boolean, () => Promise<boolean>, boolean] {
  const [fav, setFav] = useState(() => ids.has(id));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const handler = () => setFav(ids.has(id));
    handler();
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, [id]);
  const toggle = async () => {
    if (busy || inFlight.has(id)) return ids.has(id);
    setBusy(true);
    try {
      return await toggleFavorite(id);
    } finally {
      setBusy(false);
    }
  };
  return [fav, toggle, busy];
}

/** Хук для экрана «Избранное» и счётчика в профиле: реактивный список id. */
export function useFavoriteIds(): number[] {
  const [list, setList] = useState<number[]>(() => [...ids]);
  useEffect(() => {
    const handler = () => setList([...ids]);
    handler();
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);
  return list;
}
