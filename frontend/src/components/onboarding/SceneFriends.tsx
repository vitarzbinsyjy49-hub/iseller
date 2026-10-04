/** Слайд 5 — приглашения и выкуп, и выход из онбординга.
 *
 *  Проценты приглашения — с сервера (lib/referral): их меняют в админке,
 *  и зашитая сюда цифра разошлась бы с тем, что реально начисляют. Если
 *  ответ не пришёл, строка говорит о выгоде без чисел, а не врёт старыми.
 *
 *  Кнопка «Начать покупки» гасит pointerdown: иначе движок сторис принял бы
 *  нажатие за тап «вперёд» и закрыл онбординг раньше, чем сработает клик. */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchReferral, termsLines, type ReferralAccount } from "../../lib/referral";
import { Icon, type IconName } from "../icons";
import { Appear } from "./Appear";
import type { SceneProps } from "./slides";

export function SceneFriends({ onDone }: SceneProps) {
  const navigate = useNavigate();
  const [ref, setRef] = useState<ReferralAccount | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchReferral()
      .then((d) => { if (!cancelled) setRef(d); })
      .catch(() => { /* без чисел — см. docstring */ });
    return () => { cancelled = true; };
  }, []);

  // Текст условий — тот же termsLines, что в Профиле: сначала выгода друга,
  // потом своя. Последняя строка («баллы после того, как друг забрал заказ»)
  // здесь лишняя — это подробность для экрана приглашения, не для знакомства.
  const friendText = ref
    ? termsLines(ref).slice(0, -1).join(". ")
    : "Другу — приветственные баллы, вам — баллы с его покупок";
  // link === null — бот не настроен, приглашать нечем (lib/referral).
  const showFriend = !(ref && ref.link === null);

  const go = (path: string) => { onDone(); navigate(path); };

  return (
    <div
      className="app-hero flex h-full flex-col px-6 text-white"
      style={{
        paddingTop: "calc(var(--app-content-top-offset, env(safe-area-inset-top, 0px)) + 72px)",
        paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 24px)",
      }}
    >
      <Appear className="text-[30px] font-extrabold leading-[1.1] tracking-[-0.03em] [text-wrap:balance]">
        <h1>
          Больше,
          <br />
          <span className="text-[#8fd4ff]">чем магазин</span>
        </h1>
      </Appear>

      <div className="mt-8 flex flex-col gap-3">
        {showFriend && (
          <Feature delayMs={180} icon="heart" title="Приведите друга" onOpen={() => go("/profile")}>
            {friendText}
          </Feature>
        )}
        <Feature delayMs={300} icon="refresh" title="Продайте свою технику нам" onOpen={() => go("/sell")}>
          Опишите вещь и назовите цену — окончательную магазин подтвердит при осмотре
        </Feature>
      </div>

      <div className="mt-auto pt-8">
        <Appear delayMs={520}>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={onDone}
            className="tap h-14 w-full rounded-card bg-white text-[16px] font-semibold text-[#14304d]"
          >
            Начать покупки
          </button>
        </Appear>
        <Appear delayMs={640} className="mt-3 text-center text-[12px] text-white/55">
          Знакомство можно посмотреть снова в Профиле
        </Appear>
      </div>
    </div>
  );
}

function Feature({ icon, title, delayMs, onOpen, children }: {
  icon: IconName; title: string; delayMs: number; onOpen: () => void; children: React.ReactNode;
}) {
  return (
    <Appear delayMs={delayMs}>
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={onOpen}
        className="tap flex w-full items-start gap-3.5 rounded-card bg-white/[0.09] p-4 text-left"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[#8fd4ff]/15 text-[#8fd4ff]">
          <Icon name={icon} className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block text-[16px] font-semibold">{title}</span>
          <span className="mt-1 block text-[13.5px] leading-snug text-white/70">{children}</span>
        </span>
        <Icon name="chevron-down" className="mt-1 h-4 w-4 shrink-0 -rotate-90 text-white/40" />
      </button>
    </Appear>
  );
}
