/** Экран визарда «Предложить товар» (/sell) — v: маркетплейс б/у товаров.
 *
 *  Линейная форма (не диалог, как ScenarioChat): категория → название →
 *  состояние → цена → фото → телефон → комментарий → превью → отправка.
 *  Логика сборки/валидации — в lib/sellItem.ts (Task 18, уже покрыта
 *  unit-тестами); здесь только UI и вызовы api()/apiUploadFile().
 */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, apiUploadFile, ApiError } from "../lib/api";
import { track } from "../lib/analytics";
import { toast } from "../lib/toast";
import {
  buildSellItemLead, sellableCategories, validateSellItem, type SellItemValues,
} from "../lib/sellItem";
import { ProductImage } from "../components/ProductCard";
import { formatPrice } from "../lib/format";

const STATE_OPTIONS = ["Отличное", "Хорошее, есть следы", "Есть дефекты"];
const MAX_PHOTOS = 10;

type Category = { key: string; label: string };

export default function SellItem() {
  const navigate = useNavigate();
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoriesError, setCategoriesError] = useState(false);
  const [values, setValues] = useState<SellItemValues>({
    category: "", title: "", state: "", price: "", comment: "",
  });
  const [photos, setPhotos] = useState<string[]>([]);
  const [phone, setPhone] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  function loadCategories() {
    setCategoriesError(false);
    api<{ categories: Category[] }>("/catalog/categories")
      .then((d) => setCategories(sellableCategories(d.categories)))
      .catch(() => setCategoriesError(true));
  }

  useEffect(loadCategories, []);

  function set<K extends keyof SellItemValues>(key: K, v: SellItemValues[K]) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  async function onFilesSelected(files: FileList | null) {
    if (!files || files.length === 0) return;
    const remaining = MAX_PHOTOS - photos.length;
    if (files.length > remaining) {
      toast(`Можно добавить ещё не больше ${remaining} фото`, "error");
    }
    const toUpload = Array.from(files).slice(0, remaining);
    setUploading(true);
    try {
      for (const file of toUpload) {
        const { url } = await apiUploadFile<{ url: string }>("/leads/uploads/marketplace-photo", file);
        setPhotos((prev) => [...prev, url]);
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не удалось загрузить фото", "error");
    } finally {
      setUploading(false);
    }
  }

  function removePhoto(url: string) {
    setPhotos((prev) => prev.filter((p) => p !== url));
  }

  async function submit() {
    const validationError = validateSellItem(values, photos, phone);
    if (validationError) { setError(validationError); return; }
    setError(null);
    setSubmitting(true);
    try {
      await api("/leads", { method: "POST", body: JSON.stringify(buildSellItemLead(values, photos, phone)) });
      track("sell_item_submitted", { category: values.category });
      setDone(true);
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не удалось отправить заявку, попробуйте ещё раз", "error");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-lg font-bold">Заявка отправлена</p>
        <p className="text-sm text-muted">
          Заявку рассмотрит модератор. Если всё ок, свяжемся по телефону, чтобы забрать товар —
          самовывоз или согласуем удобный способ.
        </p>
        <button className="tap rounded-field bg-accent px-5 py-3 text-sm font-semibold text-white"
          onClick={() => navigate("/requests")}>
          Посмотреть заявку
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md p-4 pb-28">
      <h1 className="text-xl font-bold">Предложить товар</h1>
      <p className="mt-1 text-sm text-muted">
        Расскажите о товаре, добавьте фото — окончательную цену магазин подтвердит при осмотре.
      </p>

      <label className="mt-5 block text-sm font-semibold">Категория</label>
      {categoriesError && categories.length === 0 ? (
        <div className="mt-2 flex items-center gap-2 text-sm text-muted">
          <span>Не удалось загрузить категории</span>
          <button type="button" onClick={loadCategories} className="tap font-semibold text-accent">
            Повторить
          </button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap gap-2">
          {categories.map((c) => (
            <button key={c.key} type="button"
              onClick={() => set("category", c.key)}
              className={`tap rounded-full px-3 py-1.5 text-sm font-medium ${
                values.category === c.key ? "bg-accent text-white" : "bg-mutedbg text-text"
              }`}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      <label className="mt-5 block text-sm font-semibold">Что за товар</label>
      <input className="mt-2 w-full rounded-field border border-black/10 px-3 py-2.5 text-sm"
        placeholder="Например, iPhone 13 Pro 128 ГБ"
        value={values.title} onChange={(e) => set("title", e.target.value)} />

      <label className="mt-5 block text-sm font-semibold">Состояние</label>
      <div className="mt-2 flex flex-wrap gap-2">
        {STATE_OPTIONS.map((s) => (
          <button key={s} type="button" onClick={() => set("state", s)}
            className={`tap rounded-full px-3 py-1.5 text-sm font-medium ${
              values.state === s ? "bg-accent text-white" : "bg-mutedbg text-text"
            }`}>
            {s}
          </button>
        ))}
      </div>

      <label className="mt-5 block text-sm font-semibold">Желаемая цена</label>
      <input className="mt-2 w-full rounded-field border border-black/10 px-3 py-2.5 text-sm"
        type="number" inputMode="numeric" placeholder="Например, 45000"
        value={values.price} onChange={(e) => set("price", e.target.value)} />

      <label className="mt-5 block text-sm font-semibold">Фото ({photos.length}/{MAX_PHOTOS})</label>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {photos.map((url) => (
          <div key={url} className="relative aspect-square overflow-hidden rounded-field">
            <ProductImage src={url} title="Фото товара" />
            <button type="button" onClick={() => removePhoto(url)}
              className="tap absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/60 text-xs text-white">
              ✕
            </button>
          </div>
        ))}
        {photos.length < MAX_PHOTOS && (
          <label className="tap flex aspect-square cursor-pointer items-center justify-center rounded-field border-2 border-dashed border-black/15 text-sm text-muted">
            {uploading ? "…" : "+"}
            <input type="file" accept="image/*" multiple className="hidden" disabled={uploading}
              onChange={(e) => { onFilesSelected(e.target.files); e.target.value = ""; }} />
          </label>
        )}
      </div>

      <label className="mt-5 block text-sm font-semibold">Телефон</label>
      <input className="mt-2 w-full rounded-field border border-black/10 px-3 py-2.5 text-sm"
        type="tel" placeholder="+7 900 000-00-00"
        value={phone} onChange={(e) => setPhone(e.target.value)} />

      <label className="mt-5 block text-sm font-semibold">Комментарий (необязательно)</label>
      <textarea className="mt-2 w-full rounded-field border border-black/10 px-3 py-2.5 text-sm"
        rows={3} value={values.comment} onChange={(e) => set("comment", e.target.value)} />

      {values.title && values.price && (
        <div className="mt-6 rounded-xl2 bg-surface p-3 shadow-card">
          <p className="text-xs font-semibold uppercase text-muted">Превью карточки</p>
          <div className="mt-2 flex gap-3">
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded-field">
              <ProductImage src={photos[0]} title={values.title} />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{values.title}</p>
              <p className="text-sm font-bold">{formatPrice(Number(values.price) || 0)}</p>
              <span className="mt-1 inline-block rounded-full bg-mutedbg px-2 py-0.5 text-[11px] font-semibold text-muted">
                На модерации
              </span>
            </div>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}

      <button type="button" disabled={submitting || uploading} onClick={submit}
        className="tap mt-6 w-full rounded-field bg-accent py-3 text-sm font-semibold text-white disabled:opacity-60">
        {submitting ? "Отправляем…" : "Отправить на модерацию"}
      </button>
    </div>
  );
}
