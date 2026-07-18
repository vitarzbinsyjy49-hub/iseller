import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { C, card, input, btn, btnGhost, apiGet, apiPatch, apiPost, apiSend, apiUpload } from "./ui";

/** Управление товарами: поиск, массовые действия, безопасное удаление,
 *  наличие, цены, флаги, редактирование, добавление. */

export type Prod = {
  id: number; sku: string | null; title: string; brand: string | null; category: string | null;
  price: number; old_price: number | null; stock: number; in_stock: boolean;
  is_active: boolean; is_hot: boolean; is_available_today: boolean;
  popularity: number; rating: number;
  // Полные поля (to_admin) — используются модалкой редактирования
  description?: string | null; specs?: Record<string, unknown>; tags?: string[];
  image?: string | null; images?: string[]; warranty_months?: number; condition?: string;
  color?: string | null; memory?: string | null; storage?: string | null;
  screen_size?: string | null; cpu?: string | null; ram?: string | null; source?: string;
};

type ProdFull = Prod;

type ListResp = {
  products: Prod[]; total: number; page: number; page_size: number; pages: number;
  categories: string[]; brands: string[];
};
type BulkAction = "activate" | "deactivate" | "set_out_of_stock" | "delete";
type BulkResult = {
  action: string; requested: number; deleted: number; hidden: number; updated: number;
  skipped: number; skipped_details: { id: number; reason: string }[]; processed: number;
};
type ConfirmSpec = { title: string; message: string; danger?: boolean; confirmLabel: string; onConfirm: () => void };

function pluralTovar(n: number): string {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "товар";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return "товара";
  return "товаров";
}

function summarize(action: BulkAction, r: BulkResult): string {
  const tail = r.skipped ? `, пропущено ${r.skipped}` : "";
  if (action === "delete") return `Удалено ${r.deleted}, скрыто ${r.hidden}, пропущено ${r.skipped}`;
  if (action === "activate") return `Показано в каталоге: ${r.updated}${tail}`;
  if (action === "deactivate") return `Скрыто из каталога: ${r.updated}${tail}`;
  return `Отмечено «нет в наличии»: ${r.updated}${tail}`;
}

export function Products({ token }: { token: string }) {
  const [items, setItems] = useState<Prod[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [categories, setCategories] = useState<string[]>([]);
  const [brands, setBrands] = useState<string[]>([]);

  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");        // debounced версия search
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState("");

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [confirm, setConfirm] = useState<ConfirmSpec | null>(null);

  const [editing, setEditing] = useState<Prod | null>(null);
  const [creating, setCreating] = useState(false);

  // debounce поиска (по названию и SKU — фильтрует бэкенд)
  useEffect(() => {
    const t = setTimeout(() => { setQuery(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(() => {
    setLoading(true); setError("");
    const qs = new URLSearchParams();
    if (query) qs.set("q", query);
    if (category) qs.set("category", category);
    if (brand) qs.set("brand", brand);
    qs.set("page", String(page));
    qs.set("page_size", String(pageSize));
    return apiGet<ListResp>(`/admin/products?${qs.toString()}`, token)
      .then((d) => {
        setItems(d.products); setTotal(d.total); setPages(d.pages);
        setCategories(d.categories); setBrands(d.brands);
        // после массового удаления последняя страница могла опустеть
        if (d.products.length === 0 && page > 1 && d.total > 0) setPage((p) => Math.max(1, p - 1));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Не удалось загрузить товары"))
      .finally(() => setLoading(false));
  }, [token, query, category, brand, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  async function patch(id: number, body: Record<string, unknown>) {
    try { await apiPatch(`/admin/products/${id}`, token, body); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Не удалось сохранить изменение"); }
  }

  // ---- Выбор строк ----
  const allPageSelected = items.length > 0 && items.every((p) => selected.has(p.id));
  const somePageSelected = items.some((p) => selected.has(p.id));
  function toggleOne(id: number) {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }
  function toggleAllOnPage() {
    setSelected((s) => {
      const n = new Set(s);
      if (items.every((p) => n.has(p.id))) items.forEach((p) => n.delete(p.id));
      else items.forEach((p) => n.add(p.id));
      return n;
    });
  }
  const selCount = selected.size;

  // ---- Массовые действия ----
  function askBulk(action: BulkAction) {
    if (selCount === 0) return;
    setSummary("");
    const q = `Изменить ${selCount} ${pluralTovar(selCount)}?`;
    if (action === "delete") {
      setConfirm({
        title: "Удаление товаров", message: q, danger: true, confirmLabel: "Продолжить",
        onConfirm: () => setConfirm({
          title: "Подтвердите удаление", danger: true, confirmLabel: `Удалить ${selCount}`,
          message: "Товар будет полностью удалён. Восстановление возможно только из резервной копии.",
          onConfirm: () => doBulk("delete"),
        }),
      });
    } else {
      const titles: Record<Exclude<BulkAction, "delete">, string> = {
        activate: "Показать в каталоге", deactivate: "Скрыть из каталога", set_out_of_stock: "Отметить «нет в наличии»",
      };
      setConfirm({ title: titles[action], message: q, confirmLabel: "Подтвердить", onConfirm: () => doBulk(action) });
    }
  }

  async function doBulk(action: BulkAction) {
    setConfirm(null); setBusy(true); setError(""); setSummary("");
    try {
      const ids = Array.from(selected);
      const res = await apiPost<BulkResult>("/admin/products/bulk-action", token, { product_ids: ids, action });
      setSelected(new Set());
      await load();
      setSummary(summarize(action, res));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Массовая операция не выполнена");
    } finally { setBusy(false); }
  }

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div>
      {/* Панель поиска и фильтров */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Поиск по названию или SKU" value={search} onChange={(e) => setSearch(e.target.value)}
          style={{ ...input, marginTop: 0, width: 260 }} />
        <select value={category} onChange={(e) => { setCategory(e.target.value); setPage(1); }} style={{ ...input, marginTop: 0, width: "auto" }}>
          <option value="">Категория: все</option>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={brand} onChange={(e) => { setBrand(e.target.value); setPage(1); }} style={{ ...input, marginTop: 0, width: "auto" }}>
          <option value="">Бренд: все</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }} style={{ ...input, marginTop: 0, width: "auto" }} title="Товаров на странице">
          <option value={50}>50 на стр.</option>
          <option value={100}>100 на стр.</option>
        </select>
        <span style={{ flex: 1 }} />
        <button style={btn} onClick={() => setCreating(true)}>+ Добавить товар</button>
      </div>

      {/* Итог последней операции / ошибка */}
      {summary && (
        <div style={{ ...card, padding: "10px 14px", marginBottom: 12, borderColor: C.green, color: C.text, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>✓ {summary}</span>
          <button style={{ ...btnGhost, padding: "4px 8px", fontSize: 12 }} onClick={() => setSummary("")}>×</button>
        </div>
      )}
      {error && (
        <div style={{ ...card, padding: "10px 14px", marginBottom: 12, borderColor: C.red, color: C.red }}>
          {error}
        </div>
      )}

      {/* Панель массовых действий */}
      {selCount > 0 && (
        <div style={{
          ...card, padding: "10px 14px", marginBottom: 12, display: "flex", gap: 10, alignItems: "center",
          flexWrap: "wrap", position: "sticky", top: 64, zIndex: 5, borderColor: C.accent,
        }}>
          <strong style={{ fontSize: 14 }}>Выбрано: {selCount}</strong>
          <button style={{ ...btnGhost, padding: "7px 12px", fontSize: 13 }} disabled={busy} onClick={() => askBulk("activate")}>Показать</button>
          <button style={{ ...btnGhost, padding: "7px 12px", fontSize: 13 }} disabled={busy} onClick={() => askBulk("deactivate")}>Скрыть</button>
          <button style={{ ...btnGhost, padding: "7px 12px", fontSize: 13 }} disabled={busy} onClick={() => askBulk("set_out_of_stock")}>Нет в наличии</button>
          <button style={{ ...btn, padding: "7px 12px", fontSize: 13, background: C.red }} disabled={busy} onClick={() => askBulk("delete")}>Удалить</button>
          <span style={{ flex: 1 }} />
          <button style={{ ...btnGhost, padding: "7px 12px", fontSize: 13 }} disabled={busy} onClick={() => setSelected(new Set())}>Снять выбор</button>
        </div>
      )}

      {/* Таблица со sticky-заголовком; скролл — только внутри контейнера */}
      <div style={{ ...card, padding: 0, overflow: "auto", maxHeight: "calc(100vh - 260px)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: 40 }} /><col style={{ width: 116 }} /><col />
            <col style={{ width: 116 }} /><col style={{ width: 104 }} /><col style={{ width: 96 }} />
            <col style={{ width: 78 }} /><col style={{ width: 64 }} /><col style={{ width: 78 }} /><col style={{ width: 104 }} />
          </colgroup>
          <thead>
            <tr style={{ color: C.sub, textAlign: "left" }}>
              <th style={thCell}><HeaderCheckbox checked={allPageSelected} indeterminate={somePageSelected && !allPageSelected} onChange={toggleAllOnPage} /></th>
              <th style={thCell}>SKU</th>
              <th style={thCell}>Товар</th>
              <th style={thCell}>Цена, ₽</th>
              <th style={thCell}>Старая, ₽</th>
              <th style={thCell}>Склад</th>
              <th style={thCell}>Активен</th>
              <th style={thCell}>Хит</th>
              <th style={thCell}>Сегодня</th>
              <th style={thCell}></th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => {
              const sel = selected.has(p.id);
              return (
                <tr key={p.id} style={{ borderBottom: `1px solid ${C.border}`, opacity: p.is_active ? 1 : 0.5, background: sel ? "#eaf5fd" : "transparent" }}>
                  <td style={tdCell}>
                    <input type="checkbox" checked={sel} onChange={() => toggleOne(p.id)} style={{ cursor: "pointer", width: 16, height: 16 }} />
                  </td>
                  <td style={tdCell}>
                    <span title={p.sku ?? ""} style={{ fontFamily: "ui-monospace, monospace", fontSize: 11, color: C.sub, display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {p.sku || "—"}
                    </span>
                  </td>
                  <td style={tdCell}>
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p.title}>{p.title}</div>
                    <div style={{ color: C.sub, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{[p.brand, p.category].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td style={tdCell}><PriceCell value={p.price} onSave={(v) => patch(p.id, { price: v })} /></td>
                  <td style={tdCell}><PriceCell value={p.old_price} onSave={(v) => patch(p.id, { old_price: v })} allowEmpty /></td>
                  <td style={tdCell}><StockCell value={p.stock} inStock={p.in_stock} onSave={(v) => patch(p.id, { stock: v })} /></td>
                  <td style={tdCell}><Toggle on={p.is_active} onClick={() => patch(p.id, { is_active: !p.is_active })} /></td>
                  <td style={tdCell}><Toggle on={p.is_hot} color={C.yellow} onClick={() => patch(p.id, { is_hot: !p.is_hot })} /></td>
                  <td style={tdCell}><Toggle on={p.is_available_today} color={C.green} onClick={() => patch(p.id, { is_available_today: !p.is_available_today })} /></td>
                  <td style={tdCell}>
                    <button style={{ ...btnGhost, padding: "6px 10px", fontSize: 13 }} onClick={() => setEditing(p)}>Изменить</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {loading && <p style={{ color: C.sub, padding: 16 }}>Загрузка…</p>}
        {!loading && items.length === 0 && <p style={{ color: C.sub, padding: 16 }}>Ничего не найдено</p>}
      </div>

      {/* Пагинация */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
        <span style={{ color: C.sub, fontSize: 13 }}>
          {total > 0 ? `Показаны ${from}–${to} из ${total}` : "Нет товаров"}
        </span>
        <span style={{ flex: 1 }} />
        <button style={{ ...btnGhost, padding: "6px 12px", fontSize: 13, opacity: page <= 1 ? 0.5 : 1 }}
          disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>← Назад</button>
        <span style={{ color: C.sub, fontSize: 13 }}>Стр. {page} из {Math.max(1, pages)}</span>
        <button style={{ ...btnGhost, padding: "6px 12px", fontSize: 13, opacity: page >= pages ? 0.5 : 1 }}
          disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Вперёд →</button>
      </div>

      {confirm && <ConfirmDialog spec={confirm} onCancel={() => setConfirm(null)} />}

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

const thCell: CSSProperties = {
  padding: "10px 10px", position: "sticky", top: 0, background: C.surface, zIndex: 1,
  borderBottom: `1px solid ${C.border}`, fontWeight: 600, whiteSpace: "nowrap",
};
const tdCell: CSSProperties = { padding: "8px 10px", verticalAlign: "middle" };

function HeaderCheckbox({ checked, indeterminate, onChange }: { checked: boolean; indeterminate: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} onChange={onChange} title="Выбрать все на странице" style={{ cursor: "pointer", width: 16, height: 16 }} />;
}

function ConfirmDialog({ spec, onCancel }: { spec: ConfirmSpec; onCancel: () => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(17,24,39,.45)", display: "grid", placeItems: "center", zIndex: 60, padding: 16 }} onClick={onCancel}>
      <div style={{ ...card, width: 420, maxWidth: "100%" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, color: spec.danger ? C.red : C.text }}>{spec.title}</h3>
        <p style={{ color: C.sub, fontSize: 14, marginTop: 10, lineHeight: 1.5 }}>{spec.message}</p>
        <div style={{ display: "flex", gap: 8, marginTop: 16, justifyContent: "flex-end" }}>
          <button style={btnGhost} onClick={onCancel}>Отмена</button>
          <button style={{ ...btn, background: spec.danger ? C.red : C.accent }} onClick={spec.onConfirm}>{spec.confirmLabel}</button>
        </div>
      </div>
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

const GROUP = new Intl.NumberFormat("ru-RU");

function PriceCell({ value, onSave, allowEmpty }: { value: number | null; onSave: (v: number | null) => void; allowEmpty?: boolean }) {
  const [v, setV] = useState(value == null ? "" : String(Math.round(value)));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setV(value == null ? "" : String(Math.round(value))); }, [value, focused]);
  // Вне фокуса — с разделителями (99 990); в фокусе — сырые цифры для правки.
  const shown = focused ? v : (value == null ? (allowEmpty ? "—" : "") : GROUP.format(Math.round(value)));
  return (
    <input
      value={shown} inputMode="numeric"
      onChange={(e) => setV(e.target.value.replace(/\D/g, ""))}
      onFocus={(e) => { setFocused(true); e.target.style.border = `1px solid ${C.accent}`; }}
      onBlur={(e) => {
        setFocused(false);
        e.target.style.border = "1px solid transparent";
        if (v === "" && allowEmpty) { if (value != null) onSave(null); return; }
        const n = Number(v);
        if (v !== "" && !Number.isNaN(n) && n !== value) onSave(n);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      style={{ ...input, marginTop: 0, width: "100%", padding: "6px 8px", background: "transparent", border: "1px solid transparent" }}
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
      setForm({ title: "", sku: "", brand: "", category: "", price: "", old_price: "", stock: "0", image: "", description: "", warranty_months: "12", condition: "new" });
      setSpecsText("{}");
      return;
    }
    // Список /admin/products уже отдаёт полный товар (to_admin), поэтому
    // берём переданную строку напрямую — без повторной загрузки всего каталога.
    setFull(product);
    setForm({
      title: product.title ?? "", sku: product.sku ?? "",
      brand: product.brand ?? "", category: product.category ?? "",
      price: String(Math.round(product.price)), old_price: product.old_price == null ? "" : String(Math.round(product.old_price)),
      stock: String(product.stock ?? 0), image: product.image ?? "",
      description: product.description ?? "", warranty_months: String(product.warranty_months ?? 12),
      condition: product.condition ?? "new",
    });
    setImages(product.images ?? []);
    setSpecsText(JSON.stringify(product.specs ?? {}, null, 2));
  }, [product]);

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
      title: form.title.trim(), sku: form.sku.trim() || null,
      brand: form.brand.trim() || null, category: form.category.trim() || null,
      price: Number(form.price), old_price: form.old_price === "" ? null : Number(form.old_price),
      stock: Number(form.stock || 0), image: form.image.trim() || null,
      description: form.description.trim() || null, warranty_months: Number(form.warranty_months || 12),
      condition: form.condition || "new",
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
    // «Выключить» = скрыть из каталога (is_active=false). Физическое удаление —
    // только через массовое действие с двойным подтверждением.
    if (isNew || !product) return;
    setSaving(true);
    try {
      await apiPatch(`/admin/products/${product.id}`, token, { is_active: false });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось скрыть товар");
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
            SKU (артикул для импорта и фото)
            <input style={input} value={form.sku ?? ""} onChange={(e) => set("sku", e.target.value.toUpperCase())} placeholder="IPH15PRO128BLACK" />
          </label>
          <label style={{ fontSize: 13, color: C.sub }}>
            Состояние
            <select style={input} value={form.condition ?? "new"} onChange={(e) => set("condition", e.target.value)}>
              <option value="new">Новый</option>
              <option value="used">Б/у</option>
              <option value="refurbished">Восстановленный</option>
            </select>
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
