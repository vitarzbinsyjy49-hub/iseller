import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTERS,
  activeFilterCount,
  filterButtonLabel,
  hasActiveFilters,
  sortButtonLabel,
  type CatalogFilters,
} from "./catalogFilters";

const f = (patch: Partial<CatalogFilters> = {}): CatalogFilters => ({ ...EMPTY_FILTERS, ...patch });

describe("activeFilterCount", () => {
  it("пустые фильтры не считаются", () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  it("считает каждый включённый фильтр", () => {
    expect(activeFilterCount(f({ onlyStock: true }))).toBe(1);
    expect(activeFilterCount(f({ onlyStock: true, onlyToday: true }))).toBe(2);
    expect(activeFilterCount(f({ onlyStock: true, onlyToday: true, brand: "Apple" }))).toBe(3);
    expect(activeFilterCount(f({
      onlyStock: true, onlyToday: true, brand: "Apple", priceMax: "150000",
    }))).toBe(4);
  });

  it("пустая цена и цена «0» фильтром не считаются", () => {
    // Поле цены можно открыть и закрыть, ничего не введя. «До 0 ₽» смысла не
    // имеет, а на кнопке дало бы единицу и отправило искать ограничение,
    // которого нет.
    expect(activeFilterCount(f({ priceMax: "" }))).toBe(0);
    expect(activeFilterCount(f({ priceMax: "0" }))).toBe(0);
    expect(activeFilterCount(f({ priceMax: "00" }))).toBe(0);
    expect(activeFilterCount(f({ priceMax: "1" }))).toBe(1);
  });

  it("бренд из одних пробелов — это «не выбран»", () => {
    expect(activeFilterCount(f({ brand: "   " }))).toBe(0);
    expect(activeFilterCount(f({ brand: "Dyson" }))).toBe(1);
  });
});

describe("filterButtonLabel", () => {
  it("без активных фильтров счётчик не показывается", () => {
    // «Фильтры · 0» сообщало бы о нуле громче, чем о самой возможности фильтровать.
    expect(filterButtonLabel(EMPTY_FILTERS)).toBe("Фильтры");
  });

  it("со счётчиком, когда есть что считать", () => {
    expect(filterButtonLabel(f({ onlyStock: true }))).toBe("Фильтры · 1");
    expect(filterButtonLabel(f({ onlyStock: true, brand: "Apple", priceMax: "90000" }))).toBe("Фильтры · 3");
  });
});

describe("sortButtonLabel", () => {
  const SORTS = [
    { key: "popularity", label: "Популярные" },
    { key: "price_asc", label: "Дешевле" },
  ];

  it("показывает выбранную сортировку, а не слово «Сортировка»", () => {
    // Свёрнутый в кнопку выбор обязан читаться без нажатия.
    expect(sortButtonLabel(SORTS, "popularity")).toBe("Популярные");
    expect(sortButtonLabel(SORTS, "price_asc")).toBe("Дешевле");
  });

  it("неизвестный ключ не оставляет кнопку без подписи", () => {
    expect(sortButtonLabel(SORTS, "rating")).toBe("Сортировка");
  });
});
