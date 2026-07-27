/** Обмен refresh-токена (v5.4.2).
 *
 * Backend сделал refresh одноразовым: его jti отзывается при обмене. Значит
 * параллельные 401 НЕ должны слать несколько обменов — иначе второй предъявит
 * уже отозванный токен, получит 401 и разлогинит живого пользователя.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";
import { useAuthStore } from "../store/auth";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("api token refresh", () => {
  beforeEach(() => {
    useAuthStore.setState({ accessToken: "expired", refreshToken: "refresh-1", user: null });
    vi.restoreAllMocks();
  });

  it("параллельные 401 обменивают токен ОДИН раз (single-flight)", async () => {
    let refreshCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/auth/refresh")) {
        refreshCalls += 1;
        return jsonResponse({ access_token: "new-access", refresh_token: "refresh-2" });
      }
      // до обновления — 401, после — успех
      return useAuthStore.getState().accessToken === "new-access"
        ? jsonResponse({ ok: true })
        : jsonResponse({ detail: "unauthorized" }, 401);
    });
    vi.stubGlobal("fetch", fetchMock);

    await Promise.all([api("/catalog/feed"), api("/catalog/list"), api("/favorites/ids")]);

    expect(refreshCalls).toBe(1);
    expect(useAuthStore.getState().refreshToken).toBe("refresh-2");
  });

  it("сохраняет НОВЫЙ refresh-токен (иначе следующий обмен отвалится)", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/auth/refresh")) {
        return jsonResponse({ access_token: "a2", refresh_token: "rotated" });
      }
      return useAuthStore.getState().accessToken === "a2"
        ? jsonResponse({ ok: true })
        : jsonResponse({ detail: "unauthorized" }, 401);
    });
    vi.stubGlobal("fetch", fetchMock);

    await api("/catalog/feed");
    expect(useAuthStore.getState().refreshToken).toBe("rotated");
    expect(useAuthStore.getState().accessToken).toBe("a2");
  });

  it("неудачный обмен чистит сессию", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("/auth/refresh")) return jsonResponse({}, 401);
      return jsonResponse({ detail: "unauthorized" }, 401);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api("/catalog/feed")).rejects.toThrow();
    expect(useAuthStore.getState().refreshToken).toBeNull();
  });
});
