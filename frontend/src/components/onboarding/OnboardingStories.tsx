/** Сторис-онбординг при первом входе — общий движок, ничего не знает про
 *  контент конкретного слайда (см. slides.ts). Портал в document.body.
 *
 *  Жесты — как в сторис Telegram:
 *  - экран едет за пальцем и докатывается сам (releaseDirection);
 *  - короткий тап: левая треть — назад, остальное — вперёд;
 *  - удержание — пауза автопролистывания.
 *
 *  Смонтированы только текущий слайд и, пока идёт жест или докат, его сосед.
 *  Сосед заранее не монтируется намеренно: сцены проигрывают появление при
 *  монтировании, и заранее смонтированный слайд встречал бы человека уже
 *  застывшим. Так контент начинает проявляться ровно в момент въезда.
 *
 *  Всё движение — rAF (lib/motion): декларативную CSS-анимацию webview
 *  Telegram гасит целиком. Полоски прогресса пишутся в style напрямую, а не
 *  через state: перерисовывать сцены 60 раз в секунду ради полоски незачем. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { api } from "../../lib/api";
import { animateLinear, animateNumber, animateOpacity, prefersReducedMotion } from "../../lib/motion";
import { track } from "../../lib/analytics";
import { dragOffset, isTap, releaseDirection, tapZoneFor } from "../../lib/onboarding";
import { useAuthStore, type User } from "../../store/auth";
import { ONBOARDING_SLIDES } from "./slides";
import { Icon } from "../icons";

const SETTLE_MS = 420;
const CLOSE_MS = 220;

type Drag = { x0: number; t0: number; lastX: number; lastT: number; velocity: number; moved: boolean };

/** onFinished — вызывается при закрытии независимо от причины (скип или
 *  естественное завершение). Нужен повторному показу из Профиля: тот держит
 *  собственный флаг «активен ли повтор» (useOnboardingReplayStore) и должен
 *  узнать о закрытии, иначе оверлей тут же смонтируется заново. */
export function OnboardingStories({ onFinished }: { onFinished?: () => void } = {}) {
  const count = ONBOARDING_SLIDES.length;
  const [index, setIndex] = useState(0);
  const [peer, setPeer] = useState<number | null>(null);
  const [visible, setVisible] = useState(true);
  const [autoplayKey, setAutoplayKey] = useState(0);

  const rootRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);
  const fillRef = useRef(0);
  const offsetRef = useRef(0);
  const stopAutoplay = useRef<() => void>(() => {});
  const stopSettle = useRef<() => void>(() => {});
  /** Мгновенно завершить идущий докат: следующий свайп не должен теряться,
   *  пока предыдущий экран ещё доезжает (быстрое пролистывание подряд). */
  const finishSettle = useRef<(() => void) | null>(null);
  const drag = useRef<Drag | null>(null);
  const busy = useRef(false);
  /** После свайпа браузер шлёт click в точку, где отпустили палец. На
   *  въехавшем экране там может оказаться кнопка («Приведите друга») — и
   *  свайп сам нажал бы её. Такой клик гасим на фазе захвата. */
  const swallowClick = useRef(false);
  const closing = useRef(false);
  const shownRef = useRef(false);

  const slide = ONBOARDING_SLIDES[index];

  const setOffset = (px: number) => {
    offsetRef.current = px;
    if (trackRef.current) trackRef.current.style.transform = `translate3d(${px}px,0,0)`;
  };

  const paintBars = useCallback((current: number, fill: number) => {
    barRefs.current.forEach((bar, i) => {
      if (bar) bar.style.transform = `scaleX(${i < current ? 1 : i === current ? fill : 0})`;
    });
  }, []);

  const finish = useCallback((reason: "skipped" | "completed") => {
    if (closing.current) return;
    closing.current = true;
    stopAutoplay.current();
    stopSettle.current();
    track(reason === "skipped" ? "onboarding_skipped" : "onboarding_completed",
      { slide_index: index, slide_id: slide.id });
    const close = () => { setVisible(false); onFinished?.(); };
    // Закрытие — затуханием, а не щелчком: за оверлеем уже живая витрина,
    // и она должна проступить, а не выскочить.
    if (rootRef.current) animateOpacity(rootRef.current, 1, 0, prefersReducedMotion() ? 120 : CLOSE_MS, close);
    else close();
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

  /** Докатить к соседу (или обратно на место) от текущего сдвига. */
  const settle = useCallback((dir: "next" | "prev" | "stay") => {
    stopAutoplay.current();
    stopSettle.current();
    const width = window.innerWidth;
    if (dir === "next" && index === count - 1) { finish("completed"); return; }
    if (dir === "prev" && index === 0) dir = "stay";
    const target = dir === "next" ? index + 1 : dir === "prev" ? index - 1 : index;
    if (target !== index) setPeer(target);
    const to = dir === "next" ? -width : dir === "prev" ? width : 0;
    const from = offsetRef.current;
    busy.current = true;

    const done = () => {
      finishSettle.current = null;
      busy.current = false;
      if (target === index) {
        setPeer(null);
        setAutoplayKey((k) => k + 1);   // возобновить с того же места полоски
      } else {
        fillRef.current = 0;
        setIndex(target);                // сдвиг сбросит useLayoutEffect ниже
      }
    };

    // «Уменьшить движение»: без проезда, новый экран просто проявляется.
    if (prefersReducedMotion() && target !== index) {
      setOffset(to);
      done();
      return;
    }
    const distance = Math.abs(to - from);
    const ms = Math.max(160, SETTLE_MS * Math.min(1, distance / width + 0.15));
    // animateNumber сам тормозит по ease-out-quint — t уже «плавное».
    stopSettle.current = animateNumber(from, to, ms, setOffset, done);
    finishSettle.current = () => { stopSettle.current(); setOffset(to); done(); };
  }, [index, count, finish]);

  // Новый текущий слайд встал на место: трек обратно в ноль ДО кадра, иначе
  // на один кадр мелькнул бы сдвинутый на ширину экрана.
  useLayoutEffect(() => {
    setOffset(0);
    setPeer(null);
    if (prefersReducedMotion() && trackRef.current) {
      animateOpacity(trackRef.current, 0.2, 1, 180, () => { if (trackRef.current) trackRef.current.style.opacity = ""; });
    }
  }, [index]);

  // Автопролистывание и полоска — один мотор: по завершении интерполяции
  // листаем дальше, поэтому полоска не может «дойти до конца», а таймер —
  // сработать раньше или позже неё. Возобновление идёт с того же места.
  useEffect(() => {
    // Палец на экране (новый жест прервал докат) — ждём, пока отпустит:
    // pointerup сам либо листнёт, либо возобновит полоску.
    if (!visible || drag.current) return;
    const from = fillRef.current;
    const remaining = slide.durationMs * (1 - from);
    paintBars(index, from);
    stopAutoplay.current = animateLinear(from, 1, remaining, (v) => {
      fillRef.current = v;
      paintBars(index, v);
    // Последний экран сам не закрывается: на нём кнопка «Начать покупки» и
    // ссылки, и таймер выбрасывал бы человека посреди чтения. Дальше — его
    // решение: кнопка, крестик или тап вперёд.
    }, () => { if (index < count - 1) settle("next"); });
    return () => stopAutoplay.current();
    // settle намеренно не в зависимостях: он меняется вместе с index, а
    // перезапуск нужен только при смене слайда или явном возобновлении.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, visible, autoplayKey]);

  useEffect(() => {
    if (!visible) return;
    track("onboarding_slide_viewed", { slide_index: index, slide_id: slide.id });
  }, [index, visible, slide.id]);

  useEffect(() => {
    if (shownRef.current) return;
    shownRef.current = true;
    track("onboarding_shown", {});
  }, []);

  // Свернули Telegram во время показа — таймер замирает, а не тикает вслепую
  // в фоне (иначе можно вернуться на слайд, который уже сам себя пролистал).
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) stopAutoplay.current();
      else if (!busy.current) setAutoplayKey((k) => k + 1);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (closing.current) return;
    finishSettle.current?.();
    stopAutoplay.current();           // удержание = пауза
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x0: e.clientX, t0: e.timeStamp, lastX: e.clientX, lastT: e.timeStamp, velocity: 0, moved: false };
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.velocity = 0.8 * ((e.clientX - d.lastX) / dt) + 0.2 * d.velocity;
    d.lastX = e.clientX;
    d.lastT = e.timeStamp;
    if (!d.moved && Math.abs(dx) < 10) return;
    d.moved = true;
    const neighbour = dx < 0 ? index + 1 : index - 1;
    const next = neighbour >= 0 && neighbour < count ? neighbour : null;
    if (next !== peer) setPeer(next);
    setOffset(dragOffset(dx, index, count));
  }, [index, count, peer]);

  const onPointerUp = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && isTap(Math.abs(dx), e.timeStamp - d.t0)) {
      settle(tapZoneFor(e.clientX / window.innerWidth));
      return;
    }
    swallowClick.current = d.moved;
    if (!d.moved) {                   // отпустили после удержания — продолжаем
      setAutoplayKey((k) => k + 1);
      return;
    }
    settle(releaseDirection(dx, window.innerWidth, d.velocity));
  }, [settle]);

  if (!visible) return null;

  const mounted = peer !== null && peer !== index ? [index, peer] : [index];
  const dark = slide.tone === "dark";
  const chromeTop = "var(--app-content-top-offset, env(safe-area-inset-top, 0px))";

  return createPortal(
    <div
      ref={rootRef}
      className="fixed inset-0 z-[100] touch-none select-none overflow-hidden bg-black"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      // Новое касание — новый жест: флаг от прошлого свайпа (если клик за
      // ним так и не пришёл, что на тач-экранах бывает) не должен съесть
      // настоящий тап по кнопке. Захват — чтобы сработать раньше кнопок,
      // которые гасят всплытие pointerdown.
      onPointerDownCapture={() => { swallowClick.current = false; }}
      onClickCapture={(e) => {
        if (!swallowClick.current) return;
        swallowClick.current = false;
        e.stopPropagation();
        e.preventDefault();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Знакомство с АйСеллер"
    >
      <div ref={trackRef} className="absolute inset-0 will-change-transform">
        {mounted.map((i) => {
          const s = ONBOARDING_SLIDES[i];
          const Scene = s.Component;
          return (
            <div key={s.id} className="absolute inset-0" style={{ transform: `translate3d(${(i - index) * 100}%,0,0)` }}>
              <Scene onDone={() => finish("completed")} />
            </div>
          );
        })}
      </div>

      <div
        className="pointer-events-none absolute inset-x-3 z-10 flex gap-1.5"
        style={{ top: `calc(${chromeTop} + 12px)` }}
      >
        {ONBOARDING_SLIDES.map((s, i) => (
          <div key={s.id} className={`h-[3px] flex-1 overflow-hidden rounded-full ${dark ? "bg-white/25" : "bg-text/15"}`}>
            <div
              ref={(el) => { barRefs.current[i] = el; }}
              className={`h-full w-full origin-left ${dark ? "bg-white" : "bg-text"}`}
              style={{ transform: `scaleX(${i < index ? 1 : 0})` }}
            />
          </div>
        ))}
      </div>

      <button
        type="button"
        onPointerDown={(e) => { e.stopPropagation(); finish("skipped"); }}
        className={`absolute right-3 z-20 flex h-9 w-9 items-center justify-center rounded-full ${
          dark ? "bg-white/15 text-white" : "bg-text/[0.07] text-text"
        }`}
        style={{ top: `calc(${chromeTop} + 22px)` }}
        aria-label="Пропустить"
      >
        <Icon name="close" className="h-4 w-4" />
      </button>
    </div>,
    document.body,
  );
}
