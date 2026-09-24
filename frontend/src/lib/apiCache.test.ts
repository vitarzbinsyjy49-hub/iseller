import { afterEach, describe, expect, it, vi } from "vitest";

/** Сеть: ответ приходит, когда тест скажет. Отмена по сигналу — как у fetch. */
const pending: { path: string; signal?: AbortSignal | null; resolve: (v: unknown) => void;
  reject: (e: unknown) => void }[] = [];

vi.mock("./api", () => ({
  api: (path: string, options: RequestInit = {}) =>
    new Promise((resolve, reject) => {
      const signal = options.signal;
      if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      pending.push({ path, signal, resolve, reject });
    }),
}));

const { cachedApi, queryClient } = await import("./apiCache");

afterEach(() => {
  pending.length = 0;
  queryClient.clear();
});

describe("cachedApi", () => {
  it("отмена одного вызова не роняет другой вызов того же пути", async () => {
    // Сценарий каталога: экран отменил свой запрос и сразу запросил тот же
    // путь заново (двойной эффект, быстрый уход и возврат). Одинаковые
    // запросы склеиваются — и раньше второй получал ошибку первого.
    const first = new AbortController();
    const a = cachedApi("/catalog/list?query=x", { signal: first.signal });
    first.abort();
    const b = cachedApi("/catalog/list?query=x", { signal: new AbortController().signal });

    await expect(a).rejects.toMatchObject({ name: "AbortError" });
    pending[0].resolve({ cards: [1] });
    await expect(b).resolves.toEqual({ cards: [1] });
  });

  it("одинаковые запросы в один момент — один поход в сеть", async () => {
    const a = cachedApi("/home");
    const b = cachedApi("/home");
    expect(pending).toHaveLength(1);
    pending[0].resolve({ ok: true });
    await expect(Promise.all([a, b])).resolves.toEqual([{ ok: true }, { ok: true }]);
  });
});
