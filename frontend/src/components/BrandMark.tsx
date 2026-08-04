/** Знак бренда — реальный файл из C:/iseller-demo/frontend/public/assets/brand.
 *
 *  Растровый lockup (знак + слово одной картинкой) отсюда убран вместе с
 *  BrandIcon: обе шапки перешли на BrandWordmark, где слово набрано вёрсткой.
 *  Мёртвые экспорты держать нельзя — следующий читатель решит, что выбор между
 *  тремя вариантами знака ещё существует, и добавит четвёртый.
 */

/** Знак + слово, собранные ВЁРСТКОЙ, а не одним растром.
 *
 *  Растровый lockup нёс собственный кегль, собственный тёмно-синий и требовал
 *  белую плашку под себя на тёмном hero — плашка и была тем, что читалось как
 *  наклейка поверх шапки. Здесь слово — обычный текст: наследует шрифт
 *  интерфейса, берёт цвет от `currentColor` (значит, живёт и на тёмном, и на
 *  светлом без подложки) и остаётся резким на любом DPI.
 *
 *  `size` — сторона иконки; кегль слова считается от неё, чтобы пропорция
 *  знака и надписи не разъезжалась при смене размера.
 */
export function BrandWordmark({
  size = 30, className = "",
}: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <img
        src="/assets/brand/logo-icon.png"
        alt=""
        aria-hidden
        width={size} height={size}
        className="block shrink-0 rounded-[22%]"
        style={{ width: size, height: size }}
      />
      <span
        className="font-bold leading-none tracking-[-0.02em]"
        style={{ fontSize: Math.round(size * 0.62) }}
      >
        АйСеллер
      </span>
    </span>
  );
}
