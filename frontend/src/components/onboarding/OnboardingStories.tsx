/** Сторис-онбординг при первом входе — общий движок, ничего не знает про
 *  контент конкретного слайда (см. slides.ts). Портал в document.body, тап
 *  вправо/влево — вперёд/назад, полоска прогресса и автопролистывание
 *  считаются ОДНИМ animateNumber (lib/motion.ts) — визуальная полоска и
 *  таймер физически не могут разойтись. */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../../lib/api";
import { animateNumber } from "../../lib/motion";
import { track } from "../../lib/analytics";
import { advanceSlide, tapZoneFor } from "../../lib/onboarding";
import { useAuthStore, type User } from "../../store/auth";
import { ONBOARDING_SLIDES } from "./slides";
import { Icon } from "../icons";

/** onFinished — вызывается при закрытии независимо от причины (скип или
 *  естественное завершение). Нужен повторному показу из Профиля: тот держит
 *  собственный флаг «активен ли повтор» (useOnboardingReplayStore) и должен
 *  узнать о закрытии, иначе оверлей тут же смонтируется заново. */
export function OnboardingStories({ onFinished }: { onFinished?: () => void } = {}) {
  const [index, setIndex] = useState(0);
  const [fill, setFill] = useState(0);
  const [visible, setVisible] = useState(true);
  const [resumeKey, setResumeKey] = useState(0);
  const cancelRef = useRef<() => void>(() => {});
  const shownRef = useRef(false);

  const slide = ONBOARDING_SLIDES[index];

  const finish = useCallback((reason: "skipped" | "completed") => {
    cancelRef.current();
    track(reason === "skipped" ? "onboarding_skipped" : "onboarding_completed",
      { slide_index: index, slide_id: slide.id });
    // Скрываем сразу — не ждём сеть, ощущается мгновенным закрытием.
    setVisible(false);
    onFinished?.();
    void api<User>("/users/onboarding-seen", { method: "POST" })
      .then((me) => useAuthStore.getState().setUser(me))
      .catch(() => {
        // Офлайн/ошибка сети не должны блокировать закрытие — патчим стор
        // локально, чтобы онбординг хотя бы в этой сессии не всплыл снова.
        const current = useAuthStore.getState().user;
        if (current) {
          useAuthStore.getState().setUser({ ...current, onboarding_seen_at: new Date().toISOString() });
        }
      });
  }, [index, slide.id, onFinished]);

  // Один мотор на полоску прогресса и автопролистывание: по завершении
  // rAF-интерполяции переходим на следующий слайд, поэтому полоска не может
  // «дойти до конца», а таймер — сработать раньше/позже неё.
  useEffect(() => {
    if (!visible) return;
    track("onboarding_slide_viewed", { slide_index: index, slide_id: slide.id });
    setFill(0);
    const cancel = animateNumber(0, 1, slide.durationMs, setFill, () => {
      const next = advanceSlide(index, ONBOARDING_SLIDES.length, "next");
      if (next === "complete") finish("completed");
      else setIndex(next);
    });
    cancelRef.current = cancel;
    return cancel;
    // resumeKey намеренно в зависимостях: только он должен перезапускать
    // таймер БЕЗ смены слайда (возврат из свёрнутого Telegram).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, visible, resumeKey]);

  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    track("onboarding_shown", {});
  }, []);

  // Свернули Telegram во время показа — таймер замирает, а не тикает вслепую
  // в фоне (иначе можно вернуться на слайд, который уже сам себя пролистал).
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) cancelRef.current();
      else setResumeKey((k) => k + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const dir = tapZoneFor(e.clientX / window.innerWidth);
    const result = advanceSlide(index, ONBOARDING_SLIDES.length, dir);
    if (result === "complete") finish("completed");
    else setIndex(result);
  }, [index, finish]);

  if (!visible) return null;

  const Slide = slide.Component;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] overflow-hidden bg-black"
      onPointerDown={onPointerDown}
      role="dialog"
      aria-modal="true"
      aria-label="Знакомство с АйСеллер"
    >
      <div className="absolute inset-0">
        <Slide />
      </div>

      <div
        className="pointer-events-none absolute inset-x-3 z-10 flex gap-1.5"
        style={{ top: "max(12px, env(safe-area-inset-top, 0px))" }}
      >
        {ONBOARDING_SLIDES.map((s, i) => (
          <div key={s.id} className="h-[3px] flex-1 overflow-hidden rounded-full bg-white/30">
            <div
              className="h-full bg-white"
              style={{ width: `${i < index ? 100 : i === index ? fill * 100 : 0}%` }}
            />
          </div>
        ))}
      </div>

      <button
        type="button"
        onPointerDown={(e) => { e.stopPropagation(); finish("skipped"); }}
        className="absolute right-3 z-20 flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-white"
        style={{ top: "max(8px, env(safe-area-inset-top, 0px))" }}
        aria-label="Пропустить"
      >
        <Icon name="close" className="h-4 w-4" />
      </button>
    </div>,
    document.body,
  );
}
