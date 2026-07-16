/** v4: Import Center (файлы + preview/confirm), управление главной (баннеры,
 * категории), Медиа (ZIP-фото по SKU, разовая загрузка картинок). */
import { useEffect, useRef, useState } from "react";
import { C, card, input, btn, btnGhost, chip, apiGet, apiPost, apiPatch, apiSend, apiUpload } from "./ui";

// ==================== Import Center ====================

type ImportItem = { line: number; sku: string; action: "create" | "update"; title: string; price: number | null; stock: number };
type ImportReport = {
  total: number; created: number; updated: number; skipped: number; applied?: boolean;
  errors: { line: number; sku?: string | null; error: string }[];
  warnings: { line: number; sku: string; warning: string }[];
  items: ImportItem[];
};

export function ImportCenter({ token }: { token: string }) {
  const [file, setFile] = useState<File | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "preview" | "confirm">("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function run(mode: "preview" | "confirm") {
    if (!file) { setError("Сначала выберите файл"); return; }
    setError(""); setBusy(mode);
    try {
      const r = await apiUpload<ImportReport>(`/admin/import/products/${mode}`, token, file);
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось обработать файл");
    } finally { setBusy(""); }
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Импорт товаров: CSV / JSON / XLSX</h3>
        <p style={{ color: C.sub, fontSize: 14, marginTop: 4 }}>
          Ключ — колонка <b>sku</b>: существующий sku обновляется, новый создаётся, старые товары не удаляются.
          Для новых товаров обязательны <b>title</b> и <b>price</b>. Пустой stock = 0.
          Шаблон: <code>templates/products_template.csv</code> в репозитории (или скачайте пример ниже).
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
          <input ref={fileRef} type="file" accept=".csv,.json,.xlsx"
            onChange={(e) => { setFile(e.target.files?.[0] ?? null); setReport(null); setError(""); }} />
          <button style={btnGhost} disabled={!file || busy !== ""} onClick={() => run("preview")}>
            {busy === "preview" ? "Проверяем…" : "1 · Проверить (preview)"}
          </button>
          <button style={{ ...btn, opacity: report && !report.applied ? 1 : 0.5 }}
            disabled={!file || !report || !!report.applied || busy !== ""} onClick={() => run("confirm")}>
            {busy === "confirm" ? "Импортируем…" : "2 · Импортировать"}
          </button>
          <a href={"data:text/csv;charset=utf-8," + encodeURIComponent(CSV_TEMPLATE)}
            download="products_template.csv" style={{ color: C.accentDark, fontSize: 13 }}>
            Скачать шаблон CSV
          </a>
        </div>
        {error && <p style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{error}</p>}
      </div>

      {report && (
        <div style={{ ...card, marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>
            {report.applied ? "✅ Импорт выполнен" : "Предпросмотр (в базу пока ничего не записано)"}
          </h3>
          <div style={{ display: "flex", gap: 18, fontSize: 15, flexWrap: "wrap" }}>
            <span>строк: <b>{report.total}</b></span>
            <span style={{ color: C.green, fontWeight: 700 }}>создаётся: {report.created}</span>
            <span style={{ color: C.accentDark, fontWeight: 700 }}>обновляется: {report.updated}</span>
            <span style={{ color: report.skipped ? C.red : C.sub, fontWeight: 700 }}>пропущено: {report.skipped}</span>
          </div>

          {report.errors.length > 0 && (
            <div style={{ marginTop: 12, background: "#fff5f5", borderRadius: 10, padding: "10px 14px" }}>
              <b style={{ color: C.red, fontSize: 13 }}>Ошибки (строки пропущены):</b>
              {report.errors.map((e, i) => (
                <p key={i} style={{ color: C.red, fontSize: 13, margin: "4px 0" }}>
                  строка {e.line}{e.sku ? ` · ${e.sku}` : ""}: {e.error}
                </p>
              ))}
            </div>
          )}
          {report.warnings.length > 0 && (
            <div style={{ marginTop: 10, background: "#fffaf0", borderRadius: 10, padding: "10px 14px" }}>
              <b style={{ color: "#b57e00", fontSize: 13 }}>Предупреждения:</b>
              {report.warnings.map((w, i) => (
                <p key={i} style={{ color: "#b57e00", fontSize: 13, margin: "4px 0" }}>
                  строка {w.line} · {w.sku}: {w.warning}
                </p>
              ))}
            </div>
          )}

          {report.items.length > 0 && (
            <table style={{ width: "100%", marginTop: 12, borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ color: C.sub, textAlign: "left" }}>
                  <th style={th}>строка</th><th style={th}>sku</th><th style={th}>действие</th>
                  <th style={th}>товар</th><th style={th}>цена</th><th style={th}>остаток</th>
                </tr>
              </thead>
              <tbody>
                {report.items.map((it) => (
                  <tr key={it.line} style={{ borderTop: `1px solid ${C.border}` }}>
                    <td style={td}>{it.line}</td>
                    <td style={{ ...td, fontFamily: "monospace" }}>{it.sku}</td>
                    <td style={{ ...td, color: it.action === "create" ? C.green : C.accentDark, fontWeight: 600 }}>
                      {it.action === "create" ? "создать" : "обновить"}
                    </td>
                    <td style={td}>{it.title}</td>
                    <td style={td}>{it.price != null ? new Intl.NumberFormat("ru-RU").format(it.price) + " ₽" : "—"}</td>
                    <td style={td}>{it.stock}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

const th = { padding: "6px 8px" } as const;
const td = { padding: "6px 8px" } as const;

const CSV_TEMPLATE = `sku,title,brand,category,subcategory,price,old_price,stock,condition,warranty_months,color,memory,storage,description,specs,tags,image_1,image_2,image_3,is_hot,is_available_today,is_active
IPH15PRO128BLACK,iPhone 15 Pro 128 ГБ Black,Apple,смартфоны,,89990,99990,10,new,12,чёрный титан,,128 ГБ,"iPhone 15 Pro в титановом корпусе","{""экран"":""6.1"""",""чип"":""A17 Pro""}","хит,титан",,,,true,true,true
MBA13M2256,MacBook Air 13 M2 8/256,Apple,ноутбуки,,94990,104990,5,new,12,серый космос,8 ГБ,256 ГБ,"Тонкий и бесшумный MacBook Air",,"для работы",,,,false,true,true`;

// ==================== Главная: баннеры и категории ====================

type Banner = {
  id: number; title: string; subtitle: string | null; emoji: string | null;
  image_url: string | null; background_gradient: string | null;
  action_type: string; action_value: string | null; position: number; is_active: boolean;
};
type HomeCat = {
  id: number; title: string; emoji: string | null; icon_url: string | null;
  background_gradient: string | null; action_type: string; action_value: string | null;
  position: number; is_active: boolean;
};

const ACTION_LABELS: Record<string, string> = {
  category: "Категория", search: "Поиск", product: "Товар (id)",
  collection: "Подборка (hot/today/sale)", ai: "AI-запрос", external: "Внешняя ссылка",
};

export function HomeContent({ token }: { token: string }) {
  const [section, setSection] = useState<"banners" | "categories">("banners");
  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <button style={chip(section === "banners")} onClick={() => setSection("banners")}>Баннеры</button>
        <button style={chip(section === "categories")} onClick={() => setSection("categories")}>Кнопки категорий</button>
      </div>
      {section === "banners" ? <BannerList token={token} /> : <CategoryList token={token} />}
    </div>
  );
}

/** Общая форма редактирования баннера/категории: чем меньше разных форм, тем меньше багов. */
function EditFields({ obj, set, kind }: {
  obj: Record<string, unknown>; set: (patch: Record<string, unknown>) => void; kind: "banner" | "category";
}) {
  const row = { display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" as const };
  const half = { flex: 1, minWidth: 180 };
  return (
    <>
      <div style={row}>
        <label style={half}>
          <span style={lbl}>Заголовок *</span>
          <input style={input} value={(obj.title as string) ?? ""} onChange={(e) => set({ title: e.target.value })} />
        </label>
        {kind === "banner" && (
          <label style={half}>
            <span style={lbl}>Подзаголовок</span>
            <input style={input} value={(obj.subtitle as string) ?? ""} onChange={(e) => set({ subtitle: e.target.value })} />
          </label>
        )}
        <label style={{ width: 90 }}>
          <span style={lbl}>Эмодзи</span>
          <input style={input} value={(obj.emoji as string) ?? ""} onChange={(e) => set({ emoji: e.target.value })} />
        </label>
        <label style={{ width: 90 }}>
          <span style={lbl}>Позиция</span>
          <input style={input} type="number" value={(obj.position as number) ?? 0}
            onChange={(e) => set({ position: Number(e.target.value) })} />
        </label>
      </div>
      <div style={row}>
        <label style={half}>
          <span style={lbl}>Действие</span>
          <select style={input} value={(obj.action_type as string) ?? "search"}
            onChange={(e) => set({ action_type: e.target.value })}>
            {Object.entries(ACTION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label style={half}>
          <span style={lbl}>Значение действия</span>
          <input style={input} placeholder="напр. iphone / смартфоны / hot"
            value={(obj.action_value as string) ?? ""} onChange={(e) => set({ action_value: e.target.value })} />
        </label>
        <label style={half}>
          <span style={lbl}>CSS-градиент / цвет</span>
          <input style={input} placeholder="linear-gradient(135deg,#1a7fd4,#6d5ae0)"
            value={(obj.background_gradient as string) ?? ""} onChange={(e) => set({ background_gradient: e.target.value })} />
        </label>
      </div>
    </>
  );
}
const lbl = { fontSize: 12, color: C.sub } as const;

function BannerList({ token }: { token: string }) {
  const [items, setItems] = useState<Banner[]>([]);
  const [draft, setDraft] = useState<Partial<Banner> | null>(null);
  const [err, setErr] = useState("");

  const load = () => apiGet<{ banners: Banner[] }>("/admin/home/banners", token)
    .then((d) => setItems(d.banners)).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, [token]);

  async function save() {
    if (!draft) return;
    setErr("");
    try {
      if (draft.id) await apiPatch(`/admin/home/banners/${draft.id}`, token, draft);
      else await apiPost("/admin/home/banners", token, draft);
      setDraft(null); load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Ошибка сохранения"); }
  }
  async function toggle(b: Banner) {
    await apiPatch(`/admin/home/banners/${b.id}`, token, { is_active: !b.is_active }); load();
  }
  async function remove(b: Banner) {
    if (!confirm(`Удалить баннер «${b.title}»?`)) return;
    await apiSend("DELETE", `/admin/home/banners/${b.id}`, token); load();
  }
  async function uploadImage(f: File) {
    const { url } = await apiUpload<{ url: string }>("/admin/uploads/image", token, f);
    setDraft((d) => ({ ...d, image_url: url }));
  }

  return (
    <div>
      <button style={btn} onClick={() => setDraft({ action_type: "search", position: (items[items.length - 1]?.position ?? 0) + 1, is_active: true })}>
        + Новый баннер
      </button>
      {err && <p style={{ color: C.red, fontSize: 13 }}>{err}</p>}

      {draft && (
        <div style={{ ...card, marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>{draft.id ? `Баннер №${draft.id}` : "Новый баннер"}</h3>
          <EditFields obj={draft} set={(p) => setDraft({ ...draft, ...p })} kind="banner" />
          <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label style={{ fontSize: 13, color: C.sub }}>
              Картинка: <input type="file" accept="image/*"
                onChange={(e) => e.target.files?.[0] && uploadImage(e.target.files[0])} />
            </label>
            {draft.image_url && <img src={draft.image_url} alt="" style={{ height: 40, borderRadius: 8 }} />}
          </div>
          {/* Живой предпросмотр — как баннер будет выглядеть в Mini App */}
          <div style={{
            marginTop: 12, width: 280, height: 120, borderRadius: 16, padding: 16, color: "#fff",
            display: "flex", flexDirection: "column", justifyContent: "space-between", overflow: "hidden",
            position: "relative", background: draft.background_gradient || "linear-gradient(135deg,#1a7fd4,#6d5ae0)",
          }}>
            {draft.image_url && <img src={draft.image_url} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />}
            <span style={{ fontSize: 22, position: "relative" }}>{draft.emoji}</span>
            <div style={{ position: "relative", textShadow: "0 1px 3px rgba(0,0,0,.4)" }}>
              <b style={{ fontSize: 15 }}>{draft.title || "Заголовок"}</b>
              <p style={{ margin: "2px 0 0", fontSize: 12, opacity: 0.9 }}>{draft.subtitle}</p>
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button style={btn} onClick={save}>Сохранить</button>
            <button style={btnGhost} onClick={() => setDraft(null)}>Отмена</button>
          </div>
        </div>
      )}

      <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
        {items.map((b) => (
          <div key={b.id} style={{ ...card, padding: 14, display: "flex", gap: 14, alignItems: "center", opacity: b.is_active ? 1 : 0.55 }}>
            <div style={{
              width: 120, height: 52, borderRadius: 10, flexShrink: 0, color: "#fff", position: "relative",
              overflow: "hidden", display: "grid", placeItems: "center",
              background: b.background_gradient || "linear-gradient(135deg,#1a7fd4,#6d5ae0)",
            }}>
              {b.image_url
                ? <img src={b.image_url} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
                : <span style={{ fontSize: 20 }}>{b.emoji}</span>}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{b.title}</b> <span style={{ color: C.sub, fontSize: 13 }}>{b.subtitle}</span>
              <p style={{ margin: "3px 0 0", fontSize: 12, color: C.sub }}>
                #{b.position} · {ACTION_LABELS[b.action_type] ?? b.action_type}: {b.action_value || "—"}
              </p>
            </div>
            <button style={btnGhost} onClick={() => toggle(b)}>{b.is_active ? "Выключить" : "Включить"}</button>
            <button style={btnGhost} onClick={() => setDraft({ ...b })}>Изменить</button>
            <button style={{ ...btnGhost, color: C.red }} onClick={() => remove(b)}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function CategoryList({ token }: { token: string }) {
  const [items, setItems] = useState<HomeCat[]>([]);
  const [draft, setDraft] = useState<Partial<HomeCat> | null>(null);
  const [err, setErr] = useState("");

  const load = () => apiGet<{ categories: HomeCat[] }>("/admin/home/categories", token)
    .then((d) => setItems(d.categories)).catch((e) => setErr(String(e)));
  useEffect(() => { load(); }, [token]);

  async function save() {
    if (!draft) return;
    setErr("");
    try {
      if (draft.id) await apiPatch(`/admin/home/categories/${draft.id}`, token, draft);
      else await apiPost("/admin/home/categories", token, draft);
      setDraft(null); load();
    } catch (e) { setErr(e instanceof Error ? e.message : "Ошибка сохранения"); }
  }
  async function toggle(c: HomeCat) {
    await apiPatch(`/admin/home/categories/${c.id}`, token, { is_active: !c.is_active }); load();
  }
  async function remove(c: HomeCat) {
    if (!confirm(`Удалить кнопку «${c.title}»?`)) return;
    await apiSend("DELETE", `/admin/home/categories/${c.id}`, token); load();
  }

  return (
    <div>
      <button style={btn} onClick={() => setDraft({ action_type: "category", position: (items[items.length - 1]?.position ?? 0) + 1, is_active: true })}>
        + Новая кнопка
      </button>
      {err && <p style={{ color: C.red, fontSize: 13 }}>{err}</p>}

      {draft && (
        <div style={{ ...card, marginTop: 12 }}>
          <h3 style={{ marginTop: 0 }}>{draft.id ? `Кнопка №${draft.id}` : "Новая кнопка"}</h3>
          <EditFields obj={draft} set={(p) => setDraft({ ...draft, ...p })} kind="category" />
          <div style={{ display: "flex", gap: 10, marginTop: 14 }}>
            <button style={btn} onClick={save}>Сохранить</button>
            <button style={btnGhost} onClick={() => setDraft(null)}>Отмена</button>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        {items.map((c) => (
          <div key={c.id} style={{
            ...card, padding: 12, width: 150, textAlign: "center", opacity: c.is_active ? 1 : 0.55,
            background: c.background_gradient || C.surface,
          }}>
            <span style={{ fontSize: 26 }}>{c.emoji || "🛍️"}</span>
            <p style={{ margin: "6px 0 2px", fontWeight: 600, fontSize: 14 }}>{c.title}</p>
            <p style={{ margin: 0, fontSize: 11, color: C.sub }}>#{c.position} · {c.action_value || c.action_type}</p>
            <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "center" }}>
              <button style={{ ...btnGhost, padding: "4px 8px", fontSize: 12 }} onClick={() => toggle(c)}>{c.is_active ? "выкл" : "вкл"}</button>
              <button style={{ ...btnGhost, padding: "4px 8px", fontSize: 12 }} onClick={() => setDraft({ ...c })}>ред.</button>
              <button style={{ ...btnGhost, padding: "4px 8px", fontSize: 12, color: C.red }} onClick={() => remove(c)}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ==================== Медиа: ZIP-фото по SKU ====================

type ZipReport = {
  matched_products: { sku: string; product_id: number; title: string; images: number }[];
  unmatched_images: string[];
  products_without_images: { sku: string | null; id: number; title: string }[];
  errors: { file: string; error: string }[];
};

export function MediaTab({ token }: { token: string }) {
  const [report, setReport] = useState<ZipReport | null>(null);
  const [singleUrl, setSingleUrl] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function uploadZip(f: File) {
    setErr(""); setBusy(true); setReport(null);
    try {
      setReport(await apiUpload<ZipReport>("/admin/uploads/products/images-zip", token, f));
    } catch (e) { setErr(e instanceof Error ? e.message : "Ошибка загрузки"); }
    finally { setBusy(false); }
  }
  async function uploadSingle(f: File) {
    setErr("");
    try {
      const { url } = await apiUpload<{ url: string }>("/admin/uploads/image", token, f);
      setSingleUrl(url);
    } catch (e) { setErr(e instanceof Error ? e.message : "Ошибка загрузки"); }
  }

  return (
    <div style={{ maxWidth: 860 }}>
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>ZIP с фото товаров (авто-матчинг по SKU)</h3>
        <p style={{ color: C.sub, fontSize: 14, marginTop: 4 }}>
          Назовите файлы по артикулу: <code>IPH15PRO128BLACK.jpg</code> — главное фото,{" "}
          <code>IPH15PRO128BLACK-1.jpg</code>, <code>-2.jpg</code> — галерея (<code>_main</code> тоже понимается).
          Форматы: jpg, png, webp, gif; до 8 МБ на файл.
        </p>
        <input type="file" accept=".zip" disabled={busy}
          onChange={(e) => e.target.files?.[0] && uploadZip(e.target.files[0])} />
        {busy && <p style={{ color: C.sub, fontSize: 13 }}>Загружаем и сопоставляем…</p>}
        {err && <p style={{ color: C.red, fontSize: 13 }}>{err}</p>}
      </div>

      {report && (
        <div style={{ ...card, marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>Отчёт</h3>
          <p style={{ fontSize: 14 }}>
            <span style={{ color: C.green, fontWeight: 700 }}>товаров с фото: {report.matched_products.length}</span>
            {" · "}не сопоставлено файлов: {report.unmatched_images.length}
            {" · "}товаров без фото: {report.products_without_images.length}
            {" · "}ошибок: {report.errors.length}
          </p>
          {report.matched_products.map((m) => (
            <p key={m.sku} style={{ fontSize: 13, margin: "3px 0" }}>
              ✅ <code>{m.sku}</code> → {m.title} ({m.images} фото)
            </p>
          ))}
          {report.unmatched_images.map((f) => (
            <p key={f} style={{ fontSize: 13, margin: "3px 0", color: "#b57e00" }}>⚠️ {f} — SKU не найден</p>
          ))}
          {report.errors.map((e, i) => (
            <p key={i} style={{ fontSize: 13, margin: "3px 0", color: C.red }}>✕ {e.file}: {e.error}</p>
          ))}
          {report.products_without_images.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 13, color: C.sub, cursor: "pointer" }}>
                Товары без фото ({report.products_without_images.length})
              </summary>
              {report.products_without_images.map((p) => (
                <p key={p.id} style={{ fontSize: 13, margin: "3px 0", color: C.sub }}>
                  {p.sku ? <code>{p.sku}</code> : `id ${p.id}`} · {p.title}
                </p>
              ))}
            </details>
          )}
        </div>
      )}

      <div style={{ ...card, marginTop: 14 }}>
        <h3 style={{ marginTop: 0 }}>Загрузить одну картинку (для баннера/категории)</h3>
        <input type="file" accept="image/*" onChange={(e) => e.target.files?.[0] && uploadSingle(e.target.files[0])} />
        {singleUrl && (
          <p style={{ fontSize: 13, marginTop: 10 }}>
            URL: <code>{singleUrl}</code>{" "}
            <button style={{ ...btnGhost, padding: "3px 10px", fontSize: 12 }}
              onClick={() => navigator.clipboard.writeText(singleUrl)}>копировать</button>
          </p>
        )}
      </div>
    </div>
  );
}
