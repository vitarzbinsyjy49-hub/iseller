/** Ручной повторный показ сторис-онбординга (Профиль → «Показать вступление»).
 *  Отдельно от shouldShowOnboarding: тот решает по «видел ли пользователь
 *  когда-либо», этот — по «попросили ли показать сейчас», независимо от флага. */
import { create } from "zustand";

type OnboardingReplayState = {
  active: boolean;
  start: () => void;
  stop: () => void;
};

export const useOnboardingReplayStore = create<OnboardingReplayState>((set) => ({
  active: false,
  start: () => set({ active: true }),
  stop: () => set({ active: false }),
}));
