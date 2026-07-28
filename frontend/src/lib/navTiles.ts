import { NavCategory } from "./categoryCache";
import { actionRoute } from "./route";

/** Ось навигации на главной: разделы каталога или бренды. */
export type NavAxis = "category" | "brand";

/** Плитка главной в том виде, в каком её отдаёт GET /home. */
export type HomeTile = {
  id: number;
  title: string;
  emoji?: string | null;
  action_type: string;
  action_value?: string | null;
};

export type HomeAxes = { categories: HomeTile[]; brands?: HomeTile[] };

export type NavChip = { key: string; label: string; icon: string; route: string };

const FALLBACK_ICON = "🛍️";

function fromTiles(tiles: HomeTile[]): NavChip[] {
  return tiles.map((t) => ({
    key: String(t.id),
    label: t.title,
    icon: t.emoji || FALLBACK_ICON,
    route: actionRoute(t.action_type, t.action_value),
  }));
}

/** Чипы навигации для выбранной оси.
 *
 *  Кэш категорий (localStorage) подставляется ТОЛЬКО на оси категорий и только
 *  пока /home не ответил — он нужен, чтобы hero не прыгал при загрузке. У
 *  брендов кэша нет намеренно: ось брендов доступна лишь после ответа /home, а
 *  до него тумблер не показывается, так что подставлять нечего и незачем.
 *
 *  `brands` может отсутствовать: фронт новее бэкенда — обычное состояние во
 *  время выката, и ронять из-за этого навигацию нельзя.
 */
export function navTiles(
  axis: NavAxis,
  home: HomeAxes | null,
  cachedCategories: NavCategory[],
): NavChip[] {
  if (axis === "brand") return fromTiles(home?.brands ?? []);
  const managed = home?.categories ?? [];
  if (managed.length > 0) return fromTiles(managed);
  return cachedCategories.map((c) => ({
    key: c.key,
    label: c.label,
    icon: c.icon,
    route: actionRoute("category", c.key),
  }));
}
