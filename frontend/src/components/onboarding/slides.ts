/** Массив конфигов вместо 4 захардкоженных веток — тот же паттерн «ключ →
 *  компонент», что уже есть в lib/routePreload.ts. Добавить/переставить/
 *  поправить хронометраж слайда — правка одной строки здесь, а не
 *  многофайловая. */
import type { ComponentType } from "react";
import { SceneTrust } from "./SceneTrust";
import { SceneCatalog } from "./SceneCatalog";
import { SceneLoyalty } from "./SceneLoyalty";
import { SceneCart } from "./SceneCart";

export type OnboardingSlide = {
  id: string;
  durationMs: number;
  Component: ComponentType;
};

export const ONBOARDING_SLIDES: OnboardingSlide[] = [
  { id: "trust", durationMs: 4500, Component: SceneTrust },
  { id: "catalog", durationMs: 5000, Component: SceneCatalog },
  { id: "loyalty", durationMs: 5000, Component: SceneLoyalty },
  { id: "cart", durationMs: 5000, Component: SceneCart },
];
