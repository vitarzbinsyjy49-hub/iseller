/** Флаги регионов поставки — SVG, не эмодзи.
 *
 *  Флаг-эмодзи технически пара «региональных индикаторов» (двух латинских
 *  букв в специальном юникод-блоке), и рисует картинку из них ШРИФТ, а не
 *  сам юникод. Windows штатно этого не делает: показывает буквы как есть.
 *  У одного региона это читалось бы как «HK», терпимо; у нескольких подряд
 *  буквы слипаются без разделителя — «🇮🇳🇺🇸🇭🇰» на Windows превращается в
 *  нечитаемое «INUSHK». В канале то же самое рисуется нормально — у
 *  Telegram-клиентов свой шрифт эмодзи, не зависящий от ОС.
 *
 *  Рисунки упрощены до пары геометрических фигур — для бейджа 16×12px
 *  этого достаточно, чтобы регион узнавался, повторять сложные гербы
 *  (британский Union Jack, тайгык Кореи) в деталях смысла нет.
 */
import type { CSSProperties } from "react";

export type RegionCode =
  | "US" | "HK" | "IN" | "JP" | "KR" | "EU" | "GB" | "KW"
  | "CN" | "SG" | "RU" | "AE" | "TR" | "VN" | "UA";

const W = 20;
const H = 15;

function Flag({ code, children }: { code: RegionCode; children: React.ReactNode }) {
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={code}>
      <clipPath id={`clip-${code}`}>
        <rect width={W} height={H} rx="2" />
      </clipPath>
      <g clipPath={`url(#clip-${code})`}>{children}</g>
    </svg>
  );
}

const stripes3 = (colors: [string, string, string], vertical = false) =>
  colors.map((c, i) => {
    const style: CSSProperties = vertical
      ? { fill: c }
      : { fill: c };
    return vertical
      ? <rect key={i} x={(W / 3) * i} y="0" width={W / 3} height={H} style={style} />
      : <rect key={i} x="0" y={(H / 3) * i} width={W} height={H / 3} style={style} />;
  });

const FLAGS: Record<RegionCode, React.ReactNode> = {
  US: <>
    <rect width={W} height={H} fill="#B22234" />
    {[...Array(6)].map((_, i) => (
      <rect key={i} y={(i * 2 + 1) * (H / 13)} width={W} height={H / 13} fill="#fff" />
    ))}
    <rect width={W * 0.4} height={H * 0.55} fill="#3C3B6E" />
  </>,
  GB: <>
    <rect width={W} height={H} fill="#00247D" />
    <rect x={W / 2 - 1.4} width="2.8" height={H} fill="#fff" />
    <rect y={H / 2 - 1} width={W} height="2" fill="#fff" />
    <rect x={W / 2 - 0.8} width="1.6" height={H} fill="#CF142B" />
    <rect y={H / 2 - 0.6} width={W} height="1.2" fill="#CF142B" />
  </>,
  RU: stripes3(["#fff", "#0039A6", "#D52B1E"]),
  UA: <>
    <rect width={W} height={H / 2} fill="#0057B7" />
    <rect y={H / 2} width={W} height={H / 2} fill="#FFD700" />
  </>,
  CN: <>
    <rect width={W} height={H} fill="#DE2910" />
    <circle cx="4" cy="4.5" r="1.6" fill="#FFDE00" />
    {[[8, 2], [9.5, 4], [9.3, 6.5], [7.5, 7.5]].map(([x, y], i) => (
      <circle key={i} cx={x} cy={y} r="0.5" fill="#FFDE00" />
    ))}
  </>,
  JP: <>
    <rect width={W} height={H} fill="#fff" />
    <circle cx={W / 2} cy={H / 2} r={H * 0.32} fill="#BC002D" />
  </>,
  KR: <>
    <rect width={W} height={H} fill="#fff" />
    <circle cx={W / 2} cy={H / 2} r={H * 0.24} fill="#C60C30" />
    <path d={`M ${W / 2} ${H / 2 - H * 0.24} A ${H * 0.12} ${H * 0.12} 0 0 1 ${W / 2} ${H / 2} A ${H * 0.12} ${H * 0.12} 0 0 0 ${W / 2} ${H / 2 + H * 0.24} Z`} fill="#003478" />
  </>,
  IN: <>
    {stripes3(["#FF9933", "#fff", "#138808"])}
    <circle cx={W / 2} cy={H / 2} r="1.4" fill="none" stroke="#000080" strokeWidth="0.25" />
  </>,
  SG: <>
    <rect width={W} height={H / 2} fill="#EF3340" />
    <rect y={H / 2} width={W} height={H / 2} fill="#fff" />
    <circle cx="4.5" cy="4" r="1.6" fill="#fff" />
    <circle cx="5.2" cy="4" r="1.3" fill="#EF3340" />
  </>,
  HK: <>
    <rect width={W} height={H} fill="#DE2910" />
    <circle cx={W / 2} cy={H / 2} r="2.6" fill="#fff" />
  </>,
  EU: <>
    <rect width={W} height={H} fill="#003399" />
    {[...Array(12)].map((_, i) => {
      const a = (i / 12) * Math.PI * 2;
      return <circle key={i} cx={W / 2 + Math.sin(a) * 4.5} cy={H / 2 - Math.cos(a) * 4.5} r="0.5" fill="#FFCC00" />;
    })}
  </>,
  AE: <>
    <rect width={W} height={H / 3} fill="#00732F" />
    <rect y={H / 3} width={W} height={H / 3} fill="#fff" />
    <rect y={(H / 3) * 2} width={W} height={H / 3} fill="#000" />
    <rect width={W * 0.25} height={H} fill="#FF0000" />
  </>,
  TR: <>
    <rect width={W} height={H} fill="#E30A17" />
    <circle cx="8" cy={H / 2} r="2.4" fill="#fff" />
    <circle cx="8.8" cy={H / 2} r="1.9" fill="#E30A17" />
  </>,
  VN: <>
    <rect width={W} height={H} fill="#DA251D" />
    <path d="M10 5 L10.9 7.6 L13.6 7.6 L11.4 9.2 L12.2 11.8 L10 10.2 L7.8 11.8 L8.6 9.2 L6.4 7.6 L9.1 7.6 Z" fill="#FFFF00" />
  </>,
  KW: <>
    {stripes3(["#007A3D", "#fff", "#000"])}
    <path d={`M0 0 L${W * 0.22} ${H / 2} L0 ${H} Z`} fill="#CE1126" />
  </>,
};

/** Один флаг региона. Код неизвестен — молча ничего не рисуем: лучше
 *  пропустить бейдж, чем показать пустой прямоугольник или «undefined». */
export function RegionFlag({ code, className }: { code: string; className?: string }) {
  const svg = FLAGS[code as RegionCode];
  if (!svg) return null;
  return (
    <span className={`inline-block overflow-hidden rounded-[2px] align-middle ${className ?? ""}`}>
      <Flag code={code as RegionCode}>{svg}</Flag>
    </span>
  );
}

/** Ряд флагов региона (у товара их может быть 1–3). Зазор между флагами —
 *  их и не понять, где один кончается и начинается другой, если слепить
 *  вплотную, как раньше делала строка эмодзи. */
export function RegionFlags({ codes, className }: { codes: string[]; className?: string }) {
  if (!codes.length) return null;
  return (
    <span className={`inline-flex items-center gap-[3px] ${className ?? ""}`}>
      {codes.map((code, i) => <RegionFlag key={`${code}-${i}`} code={code} />)}
    </span>
  );
}
