/** Форма отзыва по завершённой заявке. Открывается из бота: «Оценить заказ».
 *
 *  Экран намеренно короткий. Человек уже сделал главное — купил; всё, что мы
 *  здесь просим, он делает по доброй воле и бесплатно. Поэтому обязательна
 *  только оценка: текст и фото — по желанию. Форма, требующая написать
 *  сочинение, чтобы поставить пять звёзд, собирает отзывы только у самых
 *  недовольных.
 *
 *  Отзыв всегда уходит на модерацию — об этом сказано прямо на экране, до
 *  отправки. Человек, чей отзыв не появился сразу, иначе решит, что сломалось.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, apiUploadFile } from "../lib/api";
import { Icon } from "../components/icons";
import { ErrorState } from "../components/StateViews";
import ScreenHeader from "../components/ScreenHeader";

type LeadBrief = {
  id: number; public_number: string; product_id: number | null;
  product_title: string | null; items_count: number;
};
type ReviewData = {
  rating: number; text: string; photos: string[]; status: string;
};
type FormState = {
  can_review: boolean; lead: LeadBrief; review: ReviewData | null;
};

const MAX_PHOTOS = 10;

export default function ReviewForm() {
  const { leadId } = useParams();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [state, setState] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api<FormState>(`/reviews/lead/${leadId}`)
      .then((d) => {
        setState(d);
        if (d.review) {
          setRating(d.review.rating);
          setText(d.review.text || "");
          setPhotos(d.review.photos || []);
          // Уже опубликованный отзыв правится только через менеджера — экран
          // показывает его как отправленный, а не приглашает переписать.
          if (d.review.status === "approved") setSent(true);
        }
      })
      .catch(() => setError("Не удалось открыть форму"));
  }, [leadId]);
  useEffect(() => { load(); }, [load]);

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    const room = MAX_PHOTOS - photos.length;
    if (room <= 0) return;
    setBusy(true);
    try {
      const uploaded: string[] = [];
      for (const file of Array.from(files).slice(0, room)) {
        const { url } = await apiUploadFile<{ url: string }>("/reviews/photo", file);
        uploaded.push(url);
      }
      setPhotos((prev) => [...prev, ...uploaded]);
    } catch {
      setError("Фото не загрузилось — попробуйте другое");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submit() {
    if (!rating) {
      setError("Поставьте оценку — это единственное, что обязательно");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/reviews/lead/${leadId}`, {
        method: "POST",
        body: JSON.stringify({ rating, text: text.trim() || null, photos }),
      });
      setSent(true);
    } catch {
      setError("Не удалось отправить отзыв");
    } finally {
      setBusy(false);
    }
  }

  if (error && !state) {
    return (
      <div className="mx-auto max-w-md">
        <ScreenHeader title="Отзыв" />
        <ErrorState message={error} onRetry={load} />
      </div>
    );
  }
  if (!state) {
    return <div className="mx-auto max-w-md p-4 text-sm text-muted">Загружаем…</div>;
  }
  if (!state.can_review) {
    return (
      <div className="mx-auto max-w-md">
        <ScreenHeader title="Отзыв" />
        <p className="px-4 text-sm text-muted">
          Отзыв можно оставить по завершённой покупке. Как только менеджер
          закроет заявку, мы напишем вам сами.
        </p>
      </div>
    );
  }

  if (sent) {
    return (
      <div className="mx-auto max-w-md">
        <ScreenHeader title="Спасибо" />
        <div className="px-4">
          <div className="rounded-xl2 bg-surface p-4 shadow-soft">
            <span className="flex h-11 w-11 items-center justify-center rounded-field bg-green/10 text-green">
              <Icon name="check" className="h-5 w-5" />
            </span>
            <p className="mt-3 text-[15px] font-semibold">Отзыв отправлен</p>
            <p className="mt-1 text-[13.5px] leading-[1.5] text-muted">
              Мы прочитаем его и опубликуем на странице товара. Обычно это
              занимает несколько часов.
            </p>
          </div>
          <button onClick={() => navigate("/")} className="tap mt-4 w-full rounded-field bg-accent py-3 text-[15px] font-semibold text-white">
            В каталог
          </button>
        </div>
      </div>
    );
  }

  const what = state.lead.product_title
    || (state.lead.items_count ? `${state.lead.items_count} позиций` : null);

  return (
    <div className="mx-auto max-w-md">
      <ScreenHeader title="Оцените заказ" subtitle={state.lead.public_number} />

      <div className="px-4 pb-8">
        {what && (
          <p className="mb-4 text-[13.5px] text-muted">{what}</p>
        )}

        <div className="rounded-xl2 bg-surface p-4 shadow-soft">
          <p className="text-[15px] font-semibold">Оценка</p>
          {/* Звёзды — кнопки, а не картинки: их нажимают, и скринридер должен
              это знать. Подпись рядом называет выбранное словом — цифра без
              слова читается как «из скольки?». */}
          <div className="mt-2 flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setRating(n)}
                aria-label={`Оценка ${n} из 5`}
                aria-pressed={rating === n}
                className="tap p-1"
              >
                <Icon
                  name="star"
                  filled={n <= rating}
                  className={`h-8 w-8 ${n <= rating ? "text-orange" : "text-border"}`}
                />
              </button>
            ))}
            {rating > 0 && (
              <span className="ml-2 text-[13px] text-muted">{RATING_WORDS[rating]}</span>
            )}
          </div>
        </div>

        <div className="mt-3 rounded-xl2 bg-surface p-4 shadow-soft">
          <p className="text-[15px] font-semibold">Что скажете?</p>
          <p className="mt-0.5 text-[13px] text-muted">По желанию</p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            maxLength={2000}
            placeholder="Как прошла покупка, что понравилось"
            className="mt-2 w-full resize-none rounded-field border border-border bg-bg p-3 text-[15px] outline-none focus:border-accent"
          />
        </div>

        <div className="mt-3 rounded-xl2 bg-surface p-4 shadow-soft">
          <p className="text-[15px] font-semibold">Фото</p>
          <p className="mt-0.5 text-[13px] leading-[1.45] text-muted">
            По желанию. Если рядом будет виден экран с нашим ботом или каналом —
            сразу понятно, что отзыв настоящий.
          </p>

          {photos.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {photos.map((url) => (
                <div key={url} className="relative">
                  <img src={url} alt="" className="h-16 w-16 rounded-field object-cover" />
                  <button
                    type="button"
                    onClick={() => setPhotos((prev) => prev.filter((p) => p !== url))}
                    aria-label="Убрать фото"
                    className="tap absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-text text-white"
                  >
                    <Icon name="close" className="h-3 w-3" strokeWidth={2.4} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {photos.length < MAX_PHOTOS && (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                onChange={(e) => addPhotos(e.target.files)}
                className="hidden"
              />
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                disabled={busy}
                className="tap mt-3 flex w-full items-center justify-center gap-2 rounded-field border border-border py-2.5 text-[14px] font-semibold disabled:opacity-50"
              >
                <Icon name="camera" className="h-4 w-4" />
                Добавить фото
              </button>
            </>
          )}
        </div>

        {error && <p className="mt-3 text-[13px] text-dangerink">{error}</p>}

        <p className="mt-4 text-[12.5px] leading-[1.45] text-muted">
          Отзыв появится на странице товара после проверки — обычно в тот же день.
        </p>

        <button
          onClick={submit}
          disabled={busy}
          className="tap mt-3 w-full rounded-field bg-accent py-3 text-[15px] font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Отправляем…" : "Отправить отзыв"}
        </button>
      </div>
    </div>
  );
}

const RATING_WORDS: Record<number, string> = {
  1: "плохо", 2: "так себе", 3: "нормально", 4: "хорошо", 5: "отлично",
};
