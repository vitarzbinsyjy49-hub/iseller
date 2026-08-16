/** Экран визарда «Предложить товар» (/sell) — маркетплейс б/у товаров.
 *
 *  Пошаговый флоу (не диалог, как ScenarioChat, и не одна длинная форма):
 *  один шаг — один вопрос, категория → название → состояние → цена → фото →
 *  телефон → комментарий → превью → отправка. Переход между шагами —
 *  затухание через animateOpacity (lib/motion.ts), а не CSS-transition: на
 *  части устройств системное «уменьшить движение» глушит CSS-анимацию молча,
 *  и смена шага выглядела бы щелчком — тот же урок, что уже разобран в самом
 *  motion.ts на баннере главной.
 *
 *  Логика сборки/валидации — в lib/sellItem.ts (Task 18, покрыта
 *  unit-тестами и здесь не меняется); этот файл — только UI, навигация по
 *  шагам и вызовы api()/apiUploadFile().
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, apiUploadFile, ApiError } from "../lib/api";
import { track } from "../lib/analytics";
import { toast } from "../lib/toast";
import {
  buildSellItemLead, SELL_ITEM_STEPS, sellableCategories, validateSellItem,
  type SellItemStep, type SellItemValues,
} from "../lib/sellItem";
import { ProductImage } from "../components/ProductCard";
import { formatPrice } from "../lib/format";
import { animateOpacity, transitionDuration } from "../lib/motion";
import { Icon } from "../components/icons";

const STATE_OPTIONS = ["Отличное", "Хорошее, есть следы", "Есть дефекты"];
const MAX_PHOTOS = 10;

type Category = { key: string; label: string };

/** Можно ли уйти с шага дальше — только явно обязательные по validateSellItem
 *  поля блокируют «Далее»; необязательные (состояние, комментарий) пропускаются
 *  свободно, чтобы не выдумывать требование, которого нет в контракте заявки. */
function canAdvance(
  step: SellItemStep, values: SellItemValues, photos: string[], phone: string, uploading: boolean,
): boolean {
  switch (step) {
    case "category": return values.category.trim().length > 0;
    case "title": return values.title.trim().length > 0;
    case "price": {
      const price = Number(values.price);
      return values.price.trim().length > 0 && Number.isFinite(price) && price > 0;
    }
    case "photos": return !uploading && photos.length > 0;
    case "phone": return phone.trim().length > 0;
    default: return true; // state, comment — необязательны
  }
}

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
  const [stepIndex, setStepIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const autoAdvanceTimer = useRef<number | undefined>(undefined);

  const step = SELL_ITEM_STEPS[stepIndex];
  const stepNumber = stepIndex + 1;
  const totalSteps = SELL_ITEM_STEPS.length;

  function loadCategories() {
    setCategoriesError(false);
    api<{ categories: Category[] }>("/catalog/categories")
      .then((d) => setCategories(sellableCategories(d.categories)))
      .catch(() => setCategoriesError(true));
  }

  useEffect(loadCategories, []);
  useEffect(() => () => {
    if (autoAdvanceTimer.current) window.clearTimeout(autoAdvanceTimer.current);
  }, []);

  function set<K extends keyof SellItemValues>(key: K, v: SellItemValues[K]) {
    setValues((prev) => ({ ...prev, [key]: v }));
  }

  /** Уйти на соседний шаг с коротким затуханием панели — тот же мотор
   *  (rAF + easeOutQuint), что у прокрутки и прозрачности баннера, поэтому
   *  ведёт себя одинаково на всех устройствах, включая те, что глушат
   *  системную/CSS-анимацию. Выход короче входа (180 vs 220мс) — уход не
   *  должен ощущаться медленнее, чем появление нового шага. */
  function goToStep(nextIndex: number) {
    // Отменяем отложенный автопереход (см. selectAndAdvance) — любая другая
    // навигация (вручную «Далее», «Назад») делает его неактуальным; без
    // отмены таймер мог сработать позже и перескочить ещё один шаг.
    if (autoAdvanceTimer.current) { window.clearTimeout(autoAdvanceTimer.current); autoAdvanceTimer.current = undefined; }
    const el = panelRef.current;
    if (!el) { setStepIndex(nextIndex); return; }
    animateOpacity(el, 1, 0, transitionDuration(180), () => {
      setStepIndex(nextIndex);
      requestAnimationFrame(() => animateOpacity(el, 0, 1, transitionDuration(220)));
    });
  }

  function goNext() {
    if (!canAdvance(step, values, photos, phone, uploading)) return;
    if (stepIndex < SELL_ITEM_STEPS.length - 1) goToStep(stepIndex + 1);
  }
  function goBack() {
    if (stepIndex > 0) goToStep(stepIndex - 1);
  }
  /** Отправка формы шага (Enter физической клавиатуры или «Далее»/«Готово»
   *  на мобильной виртуальной — оба фактически шлют submit, а не keydown). */
  function onStepSubmit(e: FormEvent) {
    e.preventDefault();
    goNext();
  }
  /** Чипы (категория/состояние) — выбор сам по себе однозначен, ждать ещё и
   *  тап по «Далее» незачем. Небольшая задержка перед переходом — чтобы
   *  человек успел увидеть подсветку выбора, а не воспринял смену экрана как
   *  случайный скачок. Таймер, а не сразу: goToStep ссылается на актуальный
   *  stepIndex из этого рендера, поэтому отменять предыдущий обязательно —
   *  без этого двойной тап по разным чипам мог продвинуть на два шага сразу. */
  function selectAndAdvance<K extends keyof SellItemValues>(key: K, value: string) {
    set(key, value);
    if (autoAdvanceTimer.current) window.clearTimeout(autoAdvanceTimer.current);
    autoAdvanceTimer.current = window.setTimeout(() => goToStep(stepIndex + 1), 220);
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

  const advanceReady = canAdvance(step, values, photos, phone, uploading);

  return (
    // pb-cta вместо pb-8: кнопка действия ниже стала фиксированной (cta-dock,
    // тот же приём, что у «Добавить в корзину» на карточке товара), и без
    // этого резерва последнее поле шага (особенно сетка фото) уезжало под
    // непрозрачную панель — раньше кнопка была в потоке и просто отъезжала
    // за пределы экрана на длинных шагах, до неё приходилось докручивать.
    <div className="mx-auto flex min-h-screen max-w-md flex-col p-4 pb-cta lg:pb-8">
      {/* Шапка: назад + заголовок + прогресс — общая для всех шагов, не
          перерисовывается затуханием (только панель шага ниже). */}
      <div className="flex items-center gap-3">
        {stepIndex > 0 ? (
          // Зона нажатия 44×44 (тот же минимум, что у FavButton на карточке
          // товара) при визуально более компактной иконке — отступ вокруг
          // неё, а не сама кнопка, отвечает за размер.
          <button type="button" onClick={goBack} aria-label="Назад"
            className="tap -ml-2.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-text">
            <Icon name="chevron-down" className="h-5 w-5 rotate-90" />
          </button>
        ) : (
          <span className="h-11 w-11 shrink-0" aria-hidden />
        )}
        <h1 className="text-lg font-bold">Предложить товар</h1>
      </div>

      {/* Прогресс — сегменты, а не «Шаг N из 8» текстом: видно и пройденный
          путь, и то, сколько осталось, за один взгляд. */}
      <div
        role="progressbar" aria-valuemin={1} aria-valuemax={totalSteps} aria-valuenow={stepNumber}
        aria-label={`Шаг ${stepNumber} из ${totalSteps}`}
        className="mt-3 flex gap-1"
      >
        {SELL_ITEM_STEPS.map((s, i) => (
          <span key={s} aria-hidden
            className={`h-1 flex-1 rounded-full transition-colors duration-200 ${
              i <= stepIndex ? "bg-accent" : "bg-mutedbg"
            }`}
          />
        ))}
      </div>

      <div ref={panelRef} className="mt-6 flex-1">
        {step === "category" && (
          <StepHeading title="Какая это категория?" />
        )}
        {step === "category" && (
          categoriesError && categories.length === 0 ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-muted">
              <span>Не удалось загрузить категории</span>
              <button type="button" onClick={loadCategories} className="tap font-semibold text-accent">
                Повторить
              </button>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              {categories.map((c) => (
                <button key={c.key} type="button"
                  onClick={() => selectAndAdvance("category", c.key)}
                  className={`tap rounded-full px-4 py-2.5 text-sm font-medium ${
                    values.category === c.key ? "bg-accent text-white" : "bg-mutedbg text-text"
                  }`}>
                  {c.label}
                </button>
              ))}
            </div>
          )
        )}

        {step === "title" && (
          <form onSubmit={onStepSubmit}>
            <StepHeading title="Что за товар?" subtitle="Модель, объём памяти — как в объявлении" />
            <input autoFocus className="mt-4 w-full rounded-field border border-black/10 px-3 py-3 text-base"
              placeholder="Например, iPhone 13 Pro 128 ГБ" enterKeyHint="next"
              value={values.title} onChange={(e) => set("title", e.target.value)} />
          </form>
        )}

        {step === "state" && (
          <>
            <StepHeading title="В каком состоянии?" />
            <div className="mt-4 flex flex-col gap-2">
              {STATE_OPTIONS.map((s) => (
                <button key={s} type="button" onClick={() => selectAndAdvance("state", s)}
                  className={`tap flex items-center justify-between rounded-field border px-4 py-3.5 text-left text-sm font-medium ${
                    values.state === s
                      ? "border-accent bg-accent/5 text-text"
                      : "border-black/10 bg-surface text-text"
                  }`}>
                  {s}
                  <span
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${
                      values.state === s ? "border-accent bg-accent" : "border-black/15"
                    }`}
                  >
                    {values.state === s && <Icon name="check" className="h-3 w-3 text-white" />}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        {step === "price" && (
          <form onSubmit={onStepSubmit}>
            <StepHeading title="Сколько хотите получить?" subtitle="Окончательную цену магазин подтвердит при осмотре" />
            <div className="mt-4 flex items-baseline gap-2 border-b-2 border-black/10 pb-2 focus-within:border-accent">
              <input autoFocus className="w-full bg-transparent text-3xl font-bold tabular-nums outline-none"
                type="number" inputMode="numeric" placeholder="0" enterKeyHint="next"
                value={values.price} onChange={(e) => set("price", e.target.value)} />
              <span className="shrink-0 text-xl font-semibold text-muted">₽</span>
            </div>
          </form>
        )}

        {step === "photos" && (
          <>
            <StepHeading title="Добавьте фото" subtitle="До 10 фото — так вашу вещь быстрее одобрят" />
            <div className="mt-4 grid grid-cols-3 gap-2">
              {photos.map((url) => (
                <div key={url} className="relative aspect-square overflow-hidden rounded-field">
                  <ProductImage src={url} title="Фото товара" className="h-full w-full" />
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
          </>
        )}

        {step === "phone" && (
          <form onSubmit={onStepSubmit}>
            <StepHeading title="Как с вами связаться?" subtitle="Позвоним, если заявку одобрят" />
            <input autoFocus className="mt-4 w-full rounded-field border border-black/10 px-3 py-3 text-base"
              type="tel" placeholder="+7 900 000-00-00" enterKeyHint="next"
              value={phone} onChange={(e) => setPhone(e.target.value)} />
          </form>
        )}

        {step === "comment" && (
          <>
            <StepHeading title="Комментарий" subtitle="Необязательно — например, есть ли документы, коробка" />
            <textarea autoFocus className="mt-4 w-full rounded-field border border-black/10 px-3 py-3 text-base"
              rows={4} value={values.comment} onChange={(e) => set("comment", e.target.value)} />
          </>
        )}

        {step === "preview" && (
          <>
            <StepHeading title="Проверьте карточку" subtitle="Так товар увидит модератор" />
            <div className="mt-4 rounded-xl2 bg-surface p-3 shadow-card">
              <div className="flex gap-3">
                <div className="h-20 w-20 shrink-0 overflow-hidden rounded-field">
                  <ProductImage src={photos[0]} title={values.title} className="h-full w-full" />
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
            {error && <p className="mt-3 text-sm text-danger">{error}</p>}
          </>
        )}
      </div>

      {/* Кнопка действия — вне затухающей панели шага (сама не мигает при
          переходе, меняется только текст/обработчик) и вне обычного потока:
          cta-dock (index.css) — тот же приём, что у «Добавить в корзину» на
          карточке товара и у поля ввода в AI-чате. Прижата к низу НАД
          BottomNav (--bottom-nav-height в самом классе), непрозрачный фон —
          контент уходит строго под неё, а не просвечивает. На desktop — уже
          не fixed, а sticky-элемент в потоке (там нет BottomNav, которую
          нужно перекрывать). */}
      <div className="fixed inset-x-0 cta-dock z-30 border-t border-border bg-bg px-4 pt-2.5 lg:sticky lg:inset-x-auto lg:bottom-0 lg:mt-6 lg:rounded-xl2 lg:border lg:border-border lg:bg-surface lg:px-4 lg:py-3.5">
        <div className="mx-auto max-w-md">
          {step === "preview" ? (
            <button type="button" disabled={submitting} onClick={submit}
              className="tap w-full rounded-field bg-accent py-3.5 text-sm font-semibold text-white disabled:opacity-60">
              {submitting ? "Отправляем…" : "Отправить на модерацию"}
            </button>
          ) : (
            <button type="button" disabled={!advanceReady} onClick={goNext}
              className="tap w-full rounded-field bg-accent py-3.5 text-sm font-semibold text-white disabled:opacity-40">
              {uploading && step === "photos" ? "Загружаем…" : "Далее"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Заголовок шага: крупный вопрос + необязательная короткая подсказка под ним.
 *  Один вопрос на экран — заголовок несёт то, что раньше было мелкой подписью
 *  над полем, и должен читаться сразу, без прищура. */
function StepHeading({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div>
      <h2 className="text-[22px] font-bold leading-tight">{title}</h2>
      {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
    </div>
  );
}
