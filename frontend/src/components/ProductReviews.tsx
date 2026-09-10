/** Отзывы на странице товара.
 *
 *  Блока нет вовсе, пока нет ни одного одобренного отзыва. Пустая рубрика
 *  «Отзывов пока нет» занимает место и сообщает ровно одно: у этого товара
 *  никто ничего не покупал. Молчание здесь честнее и дешевле.
 *
 *  Каждый отзыв идёт с отметкой «покупка подтверждена». Это не украшение: на
 *  сервере отзыв не может существовать без завершённой заявки, поэтому отметка
 *  всегда правда. Убирать её нельзя — она и есть причина, по которой блок
 *  вообще работает на доверие.
 */
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Icon } from "./icons";

type Review = {
  id: number;
  author_name: string;
  rating: number;
  text: string;
  photos: string[];
  created_at: string | null;
  verified: boolean;
};
type Payload = { rating: number; count: number; items: Review[] };

/** Сколько отзывов показываем сразу. Остальные — по кнопке: страница товара
 *  не должна превращаться в ленту отзывов, за ней приходят не за этим. */
const PREVIEW = 3;

export function Stars({ value, className = "" }: { value: number; className?: string }) {
  return (
    <span className={`inline-flex ${className}`} aria-label={`Оценка ${value} из 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Icon
          key={n}
          name="star"
          filled={n <= Math.round(value)}
          className={`h-3.5 w-3.5 ${n <= Math.round(value) ? "text-orange" : "text-border"}`}
        />
      ))}
    </span>
  );
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

export default function ProductReviews({ productId }: { productId: number }) {
  const [data, setData] = useState<Payload | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api<Payload>(`/reviews/product/${productId}`)
      .then((d) => { if (!cancelled) setData(d); })
      // Отзывы — дополнение к карточке, а не её часть: если запрос не удался,
      // товар обязан остаться работоспособным, а блок просто не появится.
      .catch(() => { if (!cancelled) setData(null); });
    return () => { cancelled = true; };
  }, [productId]);

  if (!data || data.count === 0) return null;

  const shown = all ? data.items : data.items.slice(0, PREVIEW);
  const photos = data.items.flatMap((r) => r.photos).slice(0, 8);

  return (
    <div className="mt-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-[17px] font-bold leading-5">Отзывы</h2>
        <span className="shrink-0 text-xs text-muted">
          {data.count} {plural(data.count)}
        </span>
      </div>

      <div className="mt-2 flex items-center gap-2.5">
        <span className="text-[26px] font-bold leading-none">
          {data.rating.toFixed(1).replace(".", ",")}
        </span>
        <Stars value={data.rating} />
      </div>

      {photos.length > 0 && (
        // Лента фото отдельно от текстов: снимки убеждают быстрее слов, и
        // человек должен увидеть их, не вчитываясь.
        <div className="mt-3 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {photos.map((url) => (
            <img
              key={url}
              src={url}
              alt=""
              loading="lazy"
              className="h-16 w-16 shrink-0 rounded-field object-cover"
            />
          ))}
        </div>
      )}

      <div className="mt-3 space-y-3">
        {shown.map((r) => (
          <div key={r.id} className="rounded-xl2 bg-surface p-3.5 shadow-soft">
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/10 text-[12px] font-semibold text-accent">
                {(r.author_name || "П").trim().charAt(0).toUpperCase()}
              </span>
              <span className="truncate text-[14px] font-semibold">{r.author_name}</span>
              <span className="shrink-0 text-[12px] text-muted">{formatDate(r.created_at)}</span>
            </div>

            <div className="mt-1.5 flex items-center gap-2">
              <Stars value={r.rating} />
              {r.verified && (
                <span className="inline-flex items-center gap-1 rounded-full bg-green/10 px-2 py-0.5 text-[11px] font-medium text-green">
                  <Icon name="check" className="h-3 w-3" strokeWidth={2.4} />
                  покупка подтверждена
                </span>
              )}
            </div>

            {r.text && (
              <p className="mt-2 text-[14px] leading-[1.55]">{r.text}</p>
            )}

            {r.photos.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {r.photos.map((url) => (
                  <img key={url} src={url} alt="" loading="lazy"
                    className="h-14 w-14 rounded-field object-cover" />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {!all && data.items.length > PREVIEW && (
        <button
          onClick={() => setAll(true)}
          className="tap mt-3 w-full rounded-field border border-border py-2.5 text-[14px] font-semibold"
        >
          Все {data.count} {plural(data.count)}
        </button>
      )}
    </div>
  );
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "отзыв";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "отзыва";
  return "отзывов";
}
