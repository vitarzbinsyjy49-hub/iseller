import { create } from "zustand";

export type User = {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  /** Аватар из Telegram initData. Не у всех есть — закрытый профиль или
   *  профиль без фото присылает null, тогда витрина показывает инициалы. */
  photo_url: string | null;
  role: string;
  /** Сторис-онбординг при первом входе. null — ещё не видел (и для новых, и
   *  для уже существующих пользователей одинаково). */
  onboarding_seen_at: string | null;
};

type AuthState = {
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  setTokens: (access: string, refresh: string) => void;
  setUser: (user: User) => void;
  clear: () => void;
};

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  refreshToken: null,
  user: null,
  setTokens: (accessToken, refreshToken) => set({ accessToken, refreshToken }),
  setUser: (user) => set({ user }),
  clear: () => set({ accessToken: null, refreshToken: null, user: null }),
}));
