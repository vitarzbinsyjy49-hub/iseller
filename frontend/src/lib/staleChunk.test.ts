import { describe, expect, it, vi } from "vitest";
import { isChunkLoadError, shouldReloadForStaleChunk, withStaleChunkReload } from "./staleChunk";

/** Сообщения, которыми браузеры отвечают на исчезнувший chunk. Формулировки
 *  разные у каждого движка, и ловить надо все три — иначе на половине
 *  устройств вместо самопочинки останется экран ошибки. */
const CHUNK_ERRORS = [
  new TypeError("Failed to fetch dynamically imported module: https://host/assets/Requests-abc123.js"),
  new TypeError("error loading dynamically imported module"),
  new TypeError("Importing a module script failed."),
  new Error("Unable to preload CSS for /assets/Requests-abc123.css"),
];

describe("isChunkLoadError", () => {
  it("узнаёт сбой загрузки chunk во всех браузерах", () => {
    for (const e of CHUNK_ERRORS) expect(isChunkLoadError(e)).toBe(true);
  });

  it("не принимает за него обычную ошибку внутри модуля", () => {
    // Если перезагружать на любой ошибке, настоящий баг превратится в
    // бесконечную перезагрузку, а причина исчезнет из виду.
    expect(isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'map')"))).toBe(false);
    expect(isChunkLoadError(new Error("Не удалось загрузить заявки"))).toBe(false);
    expect(isChunkLoadError("строка вместо ошибки")).toBe(false);
    expect(isChunkLoadError(null)).toBe(false);
  });
});

describe("shouldReloadForStaleChunk", () => {
  it("перезагружает, когда chunk не нашёлся и это первая попытка", () => {
    expect(shouldReloadForStaleChunk(CHUNK_ERRORS[0], false)).toBe(true);
  });

  it("вторая подряд перезагрузка запрещена", () => {
    // Иначе при реально отсутствующем файле приложение уйдёт в цикл.
    expect(shouldReloadForStaleChunk(CHUNK_ERRORS[0], true)).toBe(false);
  });

  it("на прочих ошибках не перезагружает никогда", () => {
    expect(shouldReloadForStaleChunk(new TypeError("x is not a function"), false)).toBe(false);
  });
});

describe("withStaleChunkReload", () => {
  function env() {
    let reloaded = false;
    return {
      hasReloaded: () => reloaded,
      markReloaded: () => { reloaded = true; },
      reload: vi.fn(),
    };
  }

  it("успешную загрузку отдаёт как есть", async () => {
    const mod = { default: "page" };
    const load = withStaleChunkReload(() => Promise.resolve(mod), env());
    await expect(load()).resolves.toBe(mod);
  });

  it("на пропавшем chunk перезагружает приложение", async () => {
    const e = env();
    const load = withStaleChunkReload(() => Promise.reject(CHUNK_ERRORS[0]), e);
    // Промис намеренно не резолвится: страница уже уходит на перезагрузку, и
    // отдать в React отказ значит показать экран ошибки поверх неё.
    void load();
    await Promise.resolve();
    expect(e.reload).toHaveBeenCalledTimes(1);
    expect(e.hasReloaded()).toBe(true);
  });

  it("после уже случившейся перезагрузки отдаёт ошибку наверх", async () => {
    const e = env();
    e.markReloaded();
    const load = withStaleChunkReload(() => Promise.reject(CHUNK_ERRORS[0]), e);
    await expect(load()).rejects.toThrow(/Failed to fetch/);
    expect(e.reload).not.toHaveBeenCalled();
  });

  it("обычную ошибку модуля пропускает наверх, не трогая страницу", async () => {
    const e = env();
    const boom = new TypeError("x is not a function");
    const load = withStaleChunkReload(() => Promise.reject(boom), e);
    await expect(load()).rejects.toBe(boom);
    expect(e.reload).not.toHaveBeenCalled();
  });
});
