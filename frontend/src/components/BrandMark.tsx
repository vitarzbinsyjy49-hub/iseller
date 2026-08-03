/** Знак бренда — реальные файлы из C:/iseller-demo/frontend/public/assets/brand.
 *  Текст на lockup-версии тёмно-синий: держим её только на светлых
 *  поверхностях (desktop-шапка) или внутри белого чипа (тёмный hero на
 *  мобильном), иначе на тёмном фоне надпись потеряется. */
export function BrandIcon({
  size = 36, chip = false, className = "",
}: { size?: number; chip?: boolean; className?: string }) {
  const icon = (
    <img
      src="/assets/brand/logo-icon.png"
      alt="АйСеллер"
      width={size} height={size}
      className="block"
      style={{ width: size, height: size }}
    />
  );
  if (!chip) return icon;
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-xl bg-white p-[3px] shadow-[0_2px_8px_-2px_rgba(0,0,0,0.35)] ${className}`}>
      {icon}
    </span>
  );
}

/** Икона + слово одним файлом (lockup). Высота — единственный параметр,
 *  ширина считается из реальных пропорций файла (1059×259), чтобы не
 *  сплющивать буквы. */
export function BrandLockup({
  height = 28, chip = false, className = "",
}: { height?: number; chip?: boolean; className?: string }) {
  const img = (
    <img
      src="/assets/brand/logo-lockup.png"
      alt="АйСеллер"
      height={height}
      style={{ height, width: "auto" }}
    />
  );
  if (!chip) return <span className={className}>{img}</span>;
  return (
    <span className={`inline-flex shrink-0 items-center rounded-xl bg-white px-2 py-1 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.35)] ${className}`}>
      {img}
    </span>
  );
}
