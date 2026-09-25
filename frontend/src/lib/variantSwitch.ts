/** Переход между вариантами одной модели (цвет, память, регион).
 *
 *  Технически это смена адреса `/product/:id`, но для покупателя экран тот же:
 *  он крутит переключатель на карточке. Поэтому такой переход помечается в
 *  state навигации, и по этой метке:
 *  - Layout не восстанавливает прокрутку (иначе страница прыгала наверх или на
 *    позицию, запомненную для этого цвета при прошлом визите);
 *  - useRouteTransition не мигает всем экраном — меняется только содержимое.
 *
 *  Метка в state, а не в адресе: ссылка на товар, которой поделились, и
 *  перезагрузка должны открываться как обычный переход, сверху. */
const KEY = "variantSwitch";

export function variantSwitchState(): { [KEY]: true } {
  return { [KEY]: true };
}

export function isVariantSwitch(state: unknown): boolean {
  return typeof state === "object" && state !== null && (state as Record<string, unknown>)[KEY] === true;
}
