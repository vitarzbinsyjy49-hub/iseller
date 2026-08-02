import { describe, expect, it } from "vitest";

import {
  REVEAL_MAX_MS, REVEAL_MIN_MS, REVEAL_REDUCED_MAX_MS, revealDurationMs, revealedChars,
} from "./answerReveal";

describe("revealDurationMs", () => {
  it("пустой текст не набирается вовсе", () => {
    expect(revealDurationMs(0)).toBe(0);
    expect(revealDurationMs(-5)).toBe(0);
  });

  it("короткий ответ не мигает: длительность не ниже пола", () => {
    // 10 символов * 7мс = 70мс — на таком тексте набор был бы незаметной вспышкой
    expect(revealDurationMs(10)).toBe(REVEAL_MIN_MS);
  });

  it("длинный ответ не заставляет ждать: длительность не выше потолка", () => {
    // данные уже в браузере — растягивать показ на секунды значит ждать зря
    expect(revealDurationMs(5000)).toBe(REVEAL_MAX_MS);
  });

  it("внутри рабочего окна длительность растёт с длиной", () => {
    // Окно масштабирования: пол достигается на ~39 символах, потолок на ~311.
    // Берём длины внутри него.
    const short = revealDurationMs(80);
    const long = revealDurationMs(150);
    expect(long).toBeGreaterThan(short);
    expect(short).toBeGreaterThan(REVEAL_MIN_MS);
    expect(long).toBeLessThan(REVEAL_MAX_MS);
  });

  it("длинный ответ упирается в потолок и не тянется бесконечно", () => {
    // Данные уже в браузере: показ не должен расти пропорционально длине,
    // иначе ответ на 900 символов заставлял бы ждать секунды на пустом месте.
    expect(revealDurationMs(600)).toBe(REVEAL_MAX_MS);
    expect(revealDurationMs(2000)).toBe(REVEAL_MAX_MS);
  });

  it("при «уменьшить движение» набор короче, но НЕ выключается", () => {
    // Раньше он выключался целиком, и в Telegram на телефоне с этой настройкой
    // ответ возникал стеной. Текст при наборе не движется — он проявляется.
    const reduced = revealDurationMs(600, true);
    expect(reduced).toBe(REVEAL_REDUCED_MAX_MS);
    expect(reduced).toBeGreaterThan(0);
    expect(reduced).toBeLessThan(revealDurationMs(600));
    // Короткий ответ и здесь не мигает: пол общий.
    expect(revealDurationMs(10, true)).toBe(REVEAL_MIN_MS);
  });

  it("набор заметен глазом, а не мелькает", () => {
    // Смысл всей анимации: ответ должен ПЕЧАТАТЬСЯ. При прежних числах
    // 600 символов набирались за 1,5с — 400 знаков в секунду, то есть
    // мгновенно возникший блок текста.
    const typical = revealDurationMs(400);
    expect(typical).toBeGreaterThanOrEqual(2000);
  });
});

describe("revealedChars", () => {
  it("в нуле не показано ничего, в конце — весь текст", () => {
    expect(revealedChars(100, 0)).toBe(0);
    expect(revealedChars(100, -100)).toBe(0);
    expect(revealedChars(100, revealDurationMs(100))).toBe(100);
    expect(revealedChars(100, 99999)).toBe(100);
  });

  it("на середине показана примерно половина", () => {
    const len = 300;
    const half = revealedChars(len, revealDurationMs(len) / 2);
    expect(half).toBeGreaterThan(len * 0.4);
    expect(half).toBeLessThan(len * 0.6);
  });

  it("количество символов не убывает со временем", () => {
    const len = 400;
    const total = revealDurationMs(len);
    let prev = 0;
    for (let t = 0; t <= total; t += total / 20) {
      const n = revealedChars(len, t);
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it("никогда не выходит за длину текста", () => {
    const len = 55;
    for (let t = 0; t <= revealDurationMs(len) * 2; t += 25) {
      expect(revealedChars(len, t)).toBeLessThanOrEqual(len);
    }
  });

  it("пустой текст не даёт символов ни в какой момент", () => {
    expect(revealedChars(0, 500)).toBe(0);
  });
});
