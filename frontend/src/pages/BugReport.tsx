/** «Сообщить об ошибке» — вход из профиля.
 *
 *  Экран короткий, по образцу формы отзыва (ReviewForm): человек делает нам
 *  одолжение, и всё, что сверх пары слов, — по желанию. Обязательный только
 *  текст: скриншот без слов не говорит, что именно пошло не так.
 *
 *  Сообщение уходит владельцу в Telegram и во вкладку «Ошибки» админки.
 *  Устройство прикладываем сами (lib/bugReport.ts) и прямо об этом пишем.
 */
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, api, apiUploadFile } from "../lib/api";
import { bugContext, canSendBugReport, MAX_BUG_SCREENSHOTS } from "../lib/bugReport";
import { getTelegram } from "../lib/telegram";
import { Icon } from "../components/icons";
import ScreenHeader from "../components/ScreenHeader";

export default function BugReport() {
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    const room = MAX_BUG_SCREENSHOTS - photos.length;
    if (room <= 0) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded: string[] = [];
      for (const file of Array.from(files).slice(0, room)) {
        const { url } = await apiUploadFile<{ url: string }>("/bug-reports/photo", file);
        uploaded.push(url);
      }
      setPhotos((prev) => [...prev, ...uploaded]);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 429
        ? "На сегодня скриншотов достаточно — опишите остальное словами"
        : "Скриншот не загрузился — попробуйте другой");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function submit() {
    if (!canSendBugReport(text, busy)) return;
    setBusy(true);
    setError(null);
    try {
      await api("/bug-reports", {
        method: "POST",
        body: JSON.stringify({
          text: text.trim(),
          photos,
          context: bugContext({ window, navigator, telegram: getTelegram() }),
        }),
      });
      setSent(true);
    } catch (e) {
      setError(e instanceof ApiError && e.status === 429
        ? "Сегодня вы уже прислали несколько сообщений — спасибо! Остальное лучше написать менеджеру"
        : "Не удалось отправить — попробуйте ещё раз");
    } finally {
      setBusy(false);
    }
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
            <p className="mt-3 text-[15px] font-semibold">Сообщение отправлено</p>
            <p className="mt-1 text-[13.5px] leading-[1.5] text-muted">
              Мы посмотрим и починим. Когда исправим — напишем вам в чате с ботом.
            </p>
          </div>
          <button onClick={() => navigate("/profile")} className="tap mt-4 w-full rounded-field bg-accent py-3 text-[15px] font-semibold text-white">
            В профиль
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md">
      <ScreenHeader title="Сообщить об ошибке" />

      <div className="px-4 pb-8">
        <div className="rounded-xl2 bg-surface p-4 shadow-soft">
          <p className="text-[15px] font-semibold">Что случилось?</p>
          <p className="mt-0.5 text-[13px] leading-[1.45] text-muted">
            Что вы нажали и что увидели — так мы быстрее найдём ошибку.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={5}
            maxLength={2000}
            placeholder="Например: нажимаю «В корзину», а товар не добавляется"
            className="mt-2 w-full resize-none rounded-field border border-border bg-bg p-3 text-[15px] outline-none focus:border-accent"
          />
        </div>

        <div className="mt-3 rounded-xl2 bg-surface p-4 shadow-soft">
          <p className="text-[15px] font-semibold">Скриншоты</p>
          <p className="mt-0.5 text-[13px] text-muted">По желанию, до {MAX_BUG_SCREENSHOTS} штук</p>

          {photos.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {photos.map((url) => (
                <div key={url} className="relative">
                  <img src={url} alt="" className="h-16 w-16 rounded-field object-cover" />
                  <button
                    type="button"
                    onClick={() => setPhotos((prev) => prev.filter((p) => p !== url))}
                    aria-label="Убрать скриншот"
                    className="tap absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-text text-white"
                  >
                    <Icon name="close" className="h-3 w-3" strokeWidth={2.4} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {photos.length < MAX_BUG_SCREENSHOTS && (
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
                Добавить скриншот
              </button>
            </>
          )}
        </div>

        {error && <p className="mt-3 text-[13px] text-dangerink">{error}</p>}

        <p className="mt-4 text-[12.5px] leading-[1.45] text-muted">
          К сообщению приложим тип устройства, версию Telegram и размер экрана —
          без них ошибку часто не повторить.
        </p>

        <button
          onClick={submit}
          disabled={!canSendBugReport(text, busy)}
          className="tap mt-3 w-full rounded-field bg-accent py-3 text-[15px] font-semibold text-white disabled:opacity-60"
        >
          {busy ? "Отправляем…" : "Отправить"}
        </button>
      </div>
    </div>
  );
}
