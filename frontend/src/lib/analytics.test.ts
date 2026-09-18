/** track() подмешивает раскладку и платформу в КАЖДОЕ событие.
 *
 *  Проверяется именно точка подмешивания, а не бакетизация (та живёт в
 *  analyticsContext.test.ts): смысл решения в том, что полусотне вызовов track
 *  по коду не нужно знать о служебных полях, и сломаться это может ровно
 *  здесь — если контекст перестанет добавляться или затрёт данные события.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { track } from "./analytics";
import { useAuthStore } from "../store/auth";

function sentBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse(fetchMock.mock.calls[0][1].body as string);
}

describe("track — служебный контекст события", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    useAuthStore.setState({ accessToken: "token-1", refreshToken: null, user: null });
    fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("window", { innerWidth: 1280 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    useAuthStore.setState({ accessToken: null, refreshToken: null, user: null });
  });

  it("добавляет раскладку в событие без своего payload", () => {
    track("app_opened");

    expect(sentBody(fetchMock).payload).toMatchObject({ viewport: "md" });
  });

  it("не теряет поля самого события", () => {
    track("search_query_submitted", { query_length: 7, source: "desktop_enter" });

    expect(sentBody(fetchMock).payload).toMatchObject({
      query_length: 7,
      source: "desktop_enter",
      viewport: "md",
    });
  });

  /** Порядок слияния — не вкусовщина. Событие знает про себя больше, чем
   *  служебный сборщик, и его поле обязано побеждать: иначе однажды заведённое
   *  событие с собственным `platform` начнёт молча писать не то, и заметить
   *  это будет нечем. */
  it("поле события важнее служебного при совпадении имени", () => {
    track("app_opened", { viewport: "собственное значение" });

    expect(sentBody(fetchMock).payload.viewport).toBe("собственное значение");
  });

  it("без токена не шлёт ничего — контекст этого не меняет", () => {
    useAuthStore.setState({ accessToken: null, refreshToken: null, user: null });

    track("app_opened");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
