import { useEffect, useMemo, useState } from "react";
import { C, card, input, btn, btnGhost, apiGet, apiPatch, apiPost, apiSend, apiUpload } from "./ui";

/** Управление товарами: наличие, цены, флаги, редактирование, добавление. */

export type Prod = {
  id: number; title: string; brand: string | null; category: string | null;
  price: number; old_price: number | null; stock: number; in_stock: boolean;
  is_active: boolean; is_hot: boolean; is_available_today: boolean;
  popularity: number; rating: number;
};

type ProdFull = Prod & {
  description?: string; specs?: Record<string, unknown>; tags?: string[];
  image?: string; images?: string[]; warranty_months?: number;
};

export function Products({ token }: { token: string }) {
  const [items, setItems] = useState<Prod[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");
  const [editing, setEditing] = useState<Prod | null>(null);
  const [creating, setCreating] = useState(false);

  function load() {
    setLoading(true);
    apiGet<{ products: Prod[] }>("/admin/products", token).then((d) => setItems(d.products)).finally(() => setLoading(false));
  }
  useEffect(load, []);

  async function patch(id: number, body: Record<string, unknown>) {
    await apiPatch(`/admin/products/${id}`, token, body);
    load();
  }

  const categories = useMemo(() => Array.from(new Set(items.map((p) => p.category).filter(Boolean))) as string[], [items]);
  const brands = useMemo(() => Array.from(new Set(items.map((p) => p.brand).filter(Boolean))) as string[], [items]);

  const visible = items.filter((p) =>
    (!search || p.title.toLowerCase().includes(search.toLowerCase())) &&
    (!category || p.category === category) &&
    (!brand || p.brand === brand),
  );

  if (loading) return <p style={{ color: C.sub }}>Загрузка…</p>;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Поиск по названию" value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ ...input, marginTop: 0, width: 240 }} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...input, marginTop: 0, width: "auto" }}>
          <option value="">Категория: все</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={brand} onChange={(e) => setBrand(e.target.value)} style={{ ...input, marginTop: 0, width: "auto" }}>
          <option value="">Бренд: все</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <span style={{ flex: 1 }} />
        <button style={btn} onClick={() => setCreating(true)}>+ Добавить товар</button>
      </div>

      <div style={{ ...card, padding: 0, overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ color: C.sub, textAlign: "left", borderBottom: `1px solid ${C.border}` }}>
              <th style={{ padding: "12px 14px" }}>Товар</th>
              <th>Цена, ₽</th><th>Старая, ₽</th><th>Склад</th>
              <th>Активен</th><th>Хит</th><th>Сегодня</th><th></th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p) => (
              <tr key={p.id} style={{ borderBottom: `1px solid ${C.border}`, opacity: p.is_active ? 1 : 0.45 }}>
                <td style={{ padding: "10px 14px", maxWidth: 280 }}>
                  <div style={{ fontWeight: 600 }}>{p.title}</div>
                  <div style={{ color: C.sub, fontSize: 12 }}>{p.brand} · {p.category}</div>
                </td>
                <td><PriceCell value={p.price} onSave={(v) => patch(p.id, { price: v })} /></td>
                <td><PriceCell value={p.old_price} onSave={(v) => patch(p.id, { old_price: v })} allowEmpty /></td>
                <td><StockCell value={p.stock} inStock={p.in_stock} onSave={(v) => patch(p.id, { stock: v })} /></td>
                <td><Toggle on={p.is_active} onClick={() => patch(p.id, { is_active: !p.is_active })} /></td>
                <td><Toggle on={p.is_hot} color={C.yellow} onClick={() => patch(p.id, { is_hot: !p.is_hot })} /></td>
                <td><Toggle on={p.is_available_today} color={C.green} onClick={() => patch(p.id, { is_available_today: !p.is_available_today })} /></td>
                <td style={{ padding: "10px 14px" }}>
                  <button style={{ ...btnGhost, padding: "6px 10px", fontSize: 13 }} onClick={() => setEditing(p)}>Изменить</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <p style={{ color: C.sub, padding: 16 }}>Ничего не найдено</p>}
      </div>

      {(editing || creating) && (
        <ProductModal
          token={token}
          product={editing}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); load(); }}
        />
      )}
    </div>
  );
}

function Toggle({ on, onClick, color = C.accent }: { on: boolean; onClick: () => void; color?: string }) {
  return (
    <button onClick={onClick} aria-pressed={on}
      style={{
        width: 40, height: 24, borderRadius: 999, border: "none", cursor: "pointer", position: "relative",
        background: on ? color : "#d6dae0", transition: "background 150ms",
      }}>
      <span style={{
        position: "absolute", top: 3, left: on ? 19 : 3, width: 18, height: 18, borderRadius: "50%",
        background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,.2)", transition: "left 150ms",
      }} />
    </button>
  );
}

function PriceCell({ value, onSave, allowEmpty }: { value: number | null; onSave: (v: number | null) => void; allowEmpty?: boolean }) {
  const [v, setV] = useState(value == null ? "" : String(Math.round(value)));
  useEffect(() => { setV(value == null ? "" : String(Math.round(value))); }, [value]);
  return (
    <input
      value={v} inputMode="numeric"
      onChange={(e) => setV(e.target.value.replace(/\D/g, ""))}
      onBlur={() => {
        if (v === "" && allowEmpty) { if (value != null) onSave(null); return; }
        const n = Number(v);
        if (v !== "" && !Number.isNaN(n) && n !== value) onSave(n);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      style={{ ...input, marginTop: 0, width: 90, padding: "6px 8px", background: "transparent", border: `1px solid transparent` }}
      onFocus={(e) => (e.target.style.border = `1px solid ${C.accent}`)}
    />
  );
}

function StockCell({ value, inStock, onSave }: { value: number; inStock: boolean; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <input
        value={v} inputMode="numeric"
        onChange={(e) => setV(e.target.value.replace(/\D/g, ""))}
        onBlur={() => { const n = Number(v || 0); if (n !== value) onSave(n); }}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        style={{ ...input, marginTop: 0, width: 56, padding: "6px 8px", background: "transparent", border: "1px solid transparent" }}
        onFocus={(e) => (e.target.style.border = `1px solid ${C.accent}`)}
      />
      <span style={{ width: 8, height: 8, borderRadius: "50%", background: inStock ? C.green : "#d6dae0" }} title={inStock ? "В наличии" : "Нет в наличии"} />
    </span>
  );
}

// ---------- Модалка редактирования/создания ----------
function ProductModal({
  token, product, onClose, onSaved,
}: { token: string; product: Prod | null; onClose: () => void; onSaved: () => void }) {
  const isNew = product == null;
  const [full, setFull] = useState<ProdFull | null>(product ? null : ({} as ProdFull));
  const [form, setForm] = useState<Record<string, string>>({});
  const [specsText, setSpecsText] = useState("{}");
  const [images, setImages] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!product) {
      setForm({ title: "", brand: "", category: "", price: "", old_price: "", stock: "0", image: "", description: "", warranty_months: "12" });
      setSpecsText("{}");
      return;
    }
    // Полные данные товара берём из публичной детальной ручки нельзя (JWT юзера),
    // поэтому используем то, что есть в списке + подгружать description/specs можно через PATCH-ответ.
    apiGet<{ products: ProdFull[] }>(`/admin/products?limit=500`, token).then((d) => {
      const p = d.products.find((x) => x.id === product.id) as ProdFull | undefined;
      const merged = { ...product, ...(p ?? {}) };
      setFull(merged);
      setForm({
        title: merged.title ?? "", brand: merged.brand ?? "", category: merged.category ?? "",
        price: String(Math.round(merged.price)), old_price: merged.old_price == null ? "" : String(Math.round(merged.old_price)),
        stock: String(merged.stock ?? 0), image: merged.image ?? "",
        description: merged.description ?? "", warranty_months: String(merged.warranty_months ?? 12),
      });
      setImages(merged.images ?? []);
      setSpecsText(JSON.stringify(merged.specs ?? {}, null, 2));
    });
  }, [product, token]);

  function set(k: string, v: string) { setForm((f) => ({ ...f, [k]: v })); }

  // ---- Фотографии: загрузка / выбор главной / удаление (сохраняются сразу) ----
  async function uploadPhoto(file: File) {
    if (!product) return;
    setError(""); setUploading(true);
    try {
      const p = await apiUpload<ProdFull>(`/admin/products/${product.id}/images`, token, file);
      setImages(p.images ?? []);
      set("image", p.image ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить фото");
    } finally {
      setUploading(false);
    }
  }

  async function makeMain(url: string) {
    if (!product) return;
    try {
      const p = await apiPost<ProdFull>(`/admin/products/${product.id}/images/main`, token, { url });
      setImages(p.images ?? []);
      set("image", p.image ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сменить главную");
    }
  }

  async function removePhoto(url: string) {
    if (!product) return;
    try {
      const p = await apiSend<ProdFull>("DELETE", `/admin/products/${product.id}/images`, token, { url });
      setImages(p.images ?? []);
      set("image", p.image ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось удалить фото");
    }
  }

  async function save() {
    setError("");
    if (!form.title.trim() || !form.price) { setError("Название и цена обязательны"); return; }
    let specs: Record<string, unknown>;
    try { specs = JSON.parse(specsText || "{}"); } catch { setError("Характеристики: некорректный JSON"); return; }
    const body: Record<string, unknown> = {
      title: form.title.trim(), brand: form.brand.trim() || null, category: form.category.trim() || null,
      price: Number(form.price), old_price: form.old_price === "" ? null : Number(form.old_price),
      stock: Number(form.stock || 0), image: form.image.trim() || null,
      description: form.description.trim() || null, warranty_months: Number(form.warranty_months || 12),
      specs,
    };
    setSaving(true);
    try {
      if (isNew) await apiPost("/admin/products", token, body);
      else await apiPatch(`/admin/products/${product!.id}`, token, body);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setSaving(false);
    }
  }

  async function deactivate() {
    if (isNew || !product) return;
    setSaving(true);
    try {
      await apiSend("DELETE", `/admin/products/${product.id}`, token);
      onSaved();
    } finally {
      setSaving(false);
    }
  }

  if (!isNew && !full) return null;

  return (
    <div
      style={{ position: "fixed", inset: 0, background: "rgba(17,24,39,.45)", display: "grid", placeItems: "center", zIndex: 50, padding: 16 }}
      onClick={onClose}
    >
      <div style={{ ...card, width: 560, maxWidth: "100%", maxHeight: "90vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>{isNew ? "Новый товар" : "Редактирование товара"}</h3>
          <button onClick={onClose} style={{ ...btnGhost, padding: "6px 10px" }}>✕</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 14 }}>
          <label style={{ gridColumn: "1 / -1", fontSize: 13, color: C.sub }}>
            Название<input style={input} value={form.title ?? ""} onChange={(e) => set("title", e.target.value)} />
          </label>
          <label style={{ fontSize: 13, color: C.sub }}>
            Бренд<input style={input} value={form.brand ?? ""} onChange={(e) => set("brand", e.target.value)} />
          </label>
          <label style={{ fontSize: 13, color: C.sub }}>
            Категория<input style={input} value={form.category ?? ""} onChange={(e) => set("category", e.target.value)} placeholder="смартфоны / ноутбуки / dyson…" />
          </label>
          <label style={{ fontSize: 13, color: C.sub }}>
            Цена, ₽<input style={input} inputMode="numeric" value={form.price ?? ""} onChange={(e) => set("price", e.target.value.replace(/\D/g, ""))} />
          </label>
          <label style={{ fontSize: 13, color: C.sub }}>
            Старая цена, ₽<input style={input} inputMode="numeric" value={form.old_price ?? ""} onChange={(e) => set("old_price", e.target.value.replace(/\D/g, ""))} />
          </label>
          <label style={{ fontSize: 13, color: C.sub }}>
            Склад, шт<input style={input} inputMode="numeric" value={form.stock ?? ""} onChange={(e) => set("stock", e.target.value.replace(/\D/g, ""))} />
          </label>
          <label style={{ fontSize: 13, color: C.sub }}>
            Гарантия, мес<input style={input} inputMode="numeric" value={form.warranty_months ?? ""} onChange={(e) => set("warranty_months", e.target.value.replace(/\D/g, ""))} />
          </label>
          <div style={{ gridColumn: "1 / -1" }}>
            <div style={{ fontSize: 13, color: C.sub, marginBottom: 6 }}>
              Фотографии{images.length > 0 ? ` · ${images.length}` : ""}
              <span style={{ color: C.sub, fontWeight: 400 }}> — первая загруженная становится главной, можно выбрать другую</span>
            </div>
            {isNew ? (
              <p style={{ fontSize: 13, color: C.sub, margin: 0 }}>
                Сначала создайте товар (кнопка ниже) — затем откройте его и добавьте фото.
              </p>
            ) : (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                {images.map((url) => {
                  const isMain = url === form.image;
                  return (
                    <div key={url} style={{ width: 96 }}>
                      <div style={{
                        position: "relative", width: 96, height: 96, borderRadius: 10, overflow: "hidden",
                        border: `2px solid ${isMain ? C.accent : C.border}`,
                      }}>
                        <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
                        {isMain && (
                          <span style={{
                            position: "absolute", left: 4, top: 4, background: C.accent, color: "#fff",
                            fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 999,
                          }}>Главная</span>
                        )}
                      </div>
                      <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
                        {!isMain && (
                          <button style={{ ...btnGhost, padding: "3px 8px", fontSize: 11, flex: 1 }}
                            onClick={() => makeMain(url)}>Главная</button>
                        )}
                        <button style={{ ...btnGhost, padding: "3px 8px", fontSize: 11, color: C.red }}
                          onClick={() => removePhoto(url)} title="Удалить фото">✕</button>
                      </div>
                    </div>
                  );
                })}
                <label style={{
                  width: 96, height: 96, borderRadius: 10, border: `1px dashed ${C.border}`,
                  display: "grid", placeItems: "center", cursor: uploading ? "wait" : "pointer",
                  color: C.sub, fontSize: 12, textAlign: "center", background: C.muted,
                }}>
                  {uploading ? "Загрузка…" : "+ Фото"}
                  <input type="file" accept="image/*" style={{ display: "none" }} disabled={uploading}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); e.currentTarget.value = ""; }} />
                </label>
              </div>
            )}
          </div>
          <label style={{ gridColumn: "1 / -1", fontSize: 13, color: C.sub }}>
            Image URL (внешняя ссылка, если без загрузки)<input style={input} value={form.image ?? ""} onChange={(e) => set("image", e.target.value)} placeholder="https://…" />
          </label>
          <label style={{ gridColumn: "1 / -1", fontSize: 13, color: C.sub }}>
            Описание
            <textarea style={{ ...input, resize: "vertical" }} rows={3} value={form.description ?? ""} onChange={(e) => set("description", e.target.value)} />
          </label>
          <label style={{ gridColumn: "1 / -1", fontSize: 13, color: C.sub }}>
            Характеристики (JSON)
            <textarea style={{ ...input, fontFamily: "ui-monospace, monospace", fontSize: 13, resize: "vertical" }} rows={5}
              value={specsText} onChange={(e) => setSpecsText(e.target.value)} />
          </label>
        </div>

        {error && <p style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{error}</p>}

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <button style={{ ...btn, flex: 1 }} onClick={save} disabled={saving}>
            {saving ? "Сохраняем…" : isNew ? "Создать товар" : "Сохранить"}
          </button>
          {!isNew && (
            <button style={{ ...btnGhost, color: C.red }} onClick={deactivate} disabled={saving}>
              Выключить
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- Импорт JSON ----------
const IMPORT_EXAMPLE = `[
  {
    "title": "iPhone 15 Pro 128 ГБ",
    "sku": "IP15P-128",
    "brand": "Apple",
    "category": "смартфоны",
    "price": 87990,
    "old_price": 99990,
    "stock": 10,
    "is_hot": true,
    "is_available_today": true,
    "description": "Обновлённая цена по акции",
    "specs": { "память": "128 ГБ" }
  }
]`;

type ImportReport = { created: number; updated: number; skipped: number; errors: { index: number; title?: string; error: string }[] };

export function ImportTab({ token }: { token: string }) {
  const [text, setText] = useState(IMPORT_EXAMPLE);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function run() {
    setError(""); setReport(null);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { setError("Некорректный JSON — проверьте синтаксис"); return; }
    setBusy(true);
    try {
      const r = await apiPost<ImportReport>("/admin/products/import", token, parsed);
      setReport(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Импорт не выполнен");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 760 }}>
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Импорт / обновление товаров (JSON)</h3>
        <p style={{ color: C.sub, fontSize: 14, marginTop: 4 }}>
          Вставьте JSON-массив товаров. Совпадение по <b>sku</b> или точному <b>title</b> — обновление,
          иначе — создание. Существующие товары не удаляются.
        </p>
        <textarea
          value={text} onChange={(e) => setText(e.target.value)} rows={16} spellCheck={false}
          style={{ ...input, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 13, resize: "vertical" }}
        />
        {error && <p style={{ color: C.red, fontSize: 13 }}>{error}</p>}
        <button style={{ ...btn, marginTop: 10 }} onClick={run} disabled={busy}>
          {busy ? "Импортируем…" : "Импортировать"}
        </button>
      </div>

      {report && (
        <div style={{ ...card, marginTop: 14 }}>
          <h3 style={{ marginTop: 0 }}>Отчёт</h3>
          <div style={{ display: "flex", gap: 18, fontSize: 15 }}>
            <span style={{ color: C.green, fontWeight: 700 }}>создано: {report.created}</span>
            <span style={{ color: C.accentDark, fontWeight: 700 }}>обновлено: {report.updated}</span>
            <span style={{ color: C.sub, fontWeight: 700 }}>пропущено: {report.skipped}</span>
          </div>
          {report.errors.length > 0 && (
            <div style={{ marginTop: 10 }}>
              {report.errors.map((e, i) => (
                <p key={i} style={{ color: C.red, fontSize: 13, margin: "4px 0" }}>
                  #{e.index}{e.title ? ` (${e.title})` : ""}: {e.error}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
