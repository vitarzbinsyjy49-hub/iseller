/** Массив конфигов вместо захардкоженных веток — тот же паттерн «ключ →
 *  компонент», что уже есть в lib/routePreload.ts. Добавить/переставить/
 *  поправить хронометраж слайда — правка одной строки здесь.
 *
 *  tone — фон сцены: по нему движок красит полоски прогресса и крестик.
 *  Тёмные и светлые сцены чередуются намеренно: смена фона — самый заметный
 *  сигнал «это уже следующий экран», даже боковым зрением. */
import type { ComponentType } from "react";
import { SceneWelcome } from "./SceneWelcome";
import { SceneNew } from "./SceneNew";
import { SceneAi } from "./SceneAi";
import { SceneLoyalty } from "./SceneLoyalty";
import { SceneFriends } from "./SceneFriends";

export type SceneProps = { onDone: () => void };

export type OnboardingSlide = {
  id: string;
  durationMs: number;
  tone: "dark" | "light";
  Component: ComponentType<SceneProps>;
};

export const ONBOARDING_SLIDES: OnboardingSlide[] = [
  { id: "welcome", durationMs: 6500, tone: "dark", Component: SceneWelcome },
  { id: "new", durationMs: 6000, tone: "light", Component: SceneNew },
  { id: "ai", durationMs: 7500, tone: "dark", Component: SceneAi },
  { id: "loyalty", durationMs: 7000, tone: "light", Component: SceneLoyalty },
  { id: "friends", durationMs: 9000, tone: "dark", Component: SceneFriends },
];
