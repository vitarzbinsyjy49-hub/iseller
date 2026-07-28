/** v4: Import Center (файлы + preview/confirm), управление главной (баннеры,
 * категории), Медиа (ZIP-фото по SKU, разовая загрузка картинок). */
import { useEffect, useRef, useState } from "react";
import { C, card, input, btn, btnGhost, chip, apiGet, apiPost, apiPatch, apiSend, apiUpload } from "./ui";

// ==================== Batch Import Center (v5.2) ====================

type BatchRow = {
  source_file: string; source_sheet: string | null; source_line: number;
  sku: string | null; action: string | null;
  changes: Record<string, unknown>;
  diff?: Record<string, { old: unknown; new: unknown }>;
  warnings: string[]; errors: string[]; info: string[];
};
type BatchSummary = {
  files_total: number; data_files: number; zip_images: number; rows_total: number;
  create: number; update: number; unchanged: number; skip: number;
  errors: number; warnings: number; images_matched: number; images_unmatched: number;
  products_without_photos: number; duplicates: number;
  catalog_total_price_before: number; catalog_total_price_after: number;
  catalog_avg_price_before: number; catalog_avg_price_after: number;
};
type BatchPreview = {
  job_id: string; expires_at: number; summary: BatchSummary;
  files: { name: string; sheet: string | null; rows: number; errors: number }[];
  rows: BatchRow[];
  duplicates: { sku: string; winner?: string; loser?: string; first?: string; second?: string; policy: string }[];
  images: { sku: string; matched_images: number; main_file: string; files: string[] }[];
  unmatched_images: string[]; products_without_photos: string[];
  scan_info: { file: string; info: string }[]; scan_errors: { file: string; error: string }[];
  mode: string; duplicate_policy: string;
};
type ConfirmResult = {
  job_id: string; status: string; applied: boolean; partial: boolean;
  summary: BatchSummary; image_errors: { sku: string; error: string }[];
  images_applied: { sku: string; matched_images: number }[]; idempotent?: boolean;
};

async function apiUploadMany<T>(path: string, token: string, files: File[],
                                fields: Record<string, string>): Promise<T> {
  const fd = new FormData();
  files.forEach((f) => fd.append("files", f));
  Object.entries(fields).forEach(([k, v]) => fd.append(k, v));
  const r = await fetch(`/api${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: fd });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(typeof data.detail === "string" ? data.detail : `HTTP ${r.status}`);
  }
  return r.json();
}

const fmtSize = (n: number) => n > 1048576 ? `${(n / 1048576).toFixed(1)} МБ` : `${Math.ceil(n / 1024)} КБ`;
const fmtVal = (v: unknown) => v === null || v === undefined ? "—"
  : typeof v === "object" ? JSON.stringify(v).slice(0, 40) : String(v);

type RowFilter = "" | "errors" | "warnings" | "create" | "update" | "unchanged";

export function ImportCenter({ token }: { token: string }) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [dupPolicy, setDupPolicy] = useState<"error" | "last_wins">("error");
  const [mode, setMode] = useState("create_or_update");
  const [preview, setPreview] = useState<BatchPreview | null>(null);
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<"" | "preview" | "confirm" | "cancel">("");
  const [filter, setFilter] = useState<RowFilter>("");
  const [skuSearch, setSkuSearch] = useState("");
  const [openFiles, setOpenFiles] = useState<Record<string, boolean>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | File[]) {
    const incoming = Array.from(list);
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...incoming.filter((f) => !seen.has(f.name + f.size))];
    });
    setPreview(null); setResult(null); setError("");
  }

  async function runPreview() {
    if (!files.length) { setError("Добавьте файлы пакета"); return; }
    setError(""); setBusy("preview"); setResult(null);
    try {
      const r = await apiUploadMany<BatchPreview>("/admin/import/batch/preview", token, files,
        { mode, duplicate_policy: dupPolicy });
      setPreview(r); setFilter(""); setSkuSearch("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось проверить пакет");
    } finally { setBusy(""); }
  }

  async function runConfirm() {
    if (!preview) return;
    const s = preview.summary;
    const ok = window.confirm(
      `Импортировать ${s.create + s.update} товаров и ${s.images_matched} изображений?\n` +
      `Создать: ${s.create} · Обновить: ${s.update} · Без изменений: ${s.unchanged}`);
    if (!ok) return;
    setError(""); setBusy("confirm");
    try {
      const r = await apiPost<ConfirmResult>(`/admin/import/batch/${preview.job_id}/confirm`, token, {});
      setResult(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось применить пакет");
    } finally { setBusy(""); }
  }

  async function cancelJob() {
    if (!preview) return;
    setBusy("cancel");
    try { await apiSend("DELETE", `/admin/import/batch/${preview.job_id}`, token); } catch { /* уже удалена */ }
    setPreview(null); setResult(null); setBusy("");
  }

  function downloadErrorsCsv() {
    if (!preview) return;
    const rows = preview.rows.filter((r) => r.errors.length);
    const csv = "file;sheet;line;sku;errors\n" + rows.map((r) =>
      [r.source_file, r.source_sheet ?? "", r.source_line, r.sku ?? "", r.errors.join(" | ")]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\n");
    const a = document.createElement("a");
    a.href = "data:text/csv;charset=utf-8,﻿" + encodeURIComponent(csv);
    a.download = "import_errors.csv";
    a.click();
  }

  const visibleRows = (preview?.rows ?? []).filter((r) => {
    if (filter === "errors" && !r.errors.length) return false;
    if (filter === "warnings" && !r.warnings.length) return false;
    if ((filter === "create" || filter === "update" || filter === "unchanged") && r.action !== filter) return false;
    if (skuSearch && !(r.sku ?? "").toLowerCase().includes(skuSearch.toLowerCase())) return false;
    return true;
  }).slice(0, 300);

  const blocking = (preview?.summary.errors ?? 0) > 0;

  return (
    <div style={{ maxWidth: 1100 }}>
      {/* ===== Зона загрузки ===== */}
      <div style={card}>
        <h3 style={{ marginTop: 0 }}>Пакетный импорт: CSV / XLSX / JSON / ZIP</h3>
        <p style={{ color: C.sub, fontSize: 14, marginTop: 4 }}>
          Перетащите сразу несколько прайсов и ZIP с фото (или один Import Pack ZIP).
          Ключ — колонка <b>sku</b>. Пустые поля у существующих товаров <b>не изменяются</b>.
          <a href={"data:text/csv;charset=utf-8," + encodeURIComponent(CSV_TEMPLATE)}
            download="products_template.csv" style={{ color: C.accentDark, marginLeft: 8 }}>Шаблон CSV</a>
        </p>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); addFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          style={{
            marginTop: 12, padding: "28px 16px", textAlign: "center", cursor: "pointer",
            border: `2px dashed ${dragOver ? C.accent : C.border}`, borderRadius: 14,
            background: dragOver ? "#eef7fd" : C.muted, color: C.sub, fontSize: 14,
          }}
        >
          {dragOver ? "Отпустите файлы здесь" : "Перетащите файлы сюда или нажмите для выбора"}
          <input ref={inputRef} type="file" multiple accept=".csv,.json,.xlsx,.zip"
            style={{ display: "none" }}
            onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.currentTarget.value = ""; }} />
        </div>

        {files.length > 0 && (
          <div style={{ marginTop: 12 }}>
            {files.map((f, i) => (
              <div key={f.name + i} style={{ display: "flex", gap: 10, alignItems: "center", padding: "6px 4px", borderBottom: `1px solid ${C.border}`, fontSize: 13 }}>
                <span style={{ fontFamily: "monospace", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{f.name}</span>
                <span style={{ color: C.sub }}>{f.name.split(".").pop()?.toUpperCase()}</span>
                <span style={{ color: C.sub, width: 70, textAlign: "right" }}>{fmtSize(f.size)}</span>
                <button style={{ ...btnGhost, padding: "3px 9px", fontSize: 12, color: C.red }}
                  onClick={() => { setFiles(files.filter((_, j) => j !== i)); setPreview(null); setResult(null); }}>✕</button>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 14, flexWrap: "wrap" }}>
          <select value={mode} onChange={(e) => setMode(e.target.value)} style={{ ...input, marginTop: 0, width: "auto" }}>
            <option value="create_or_update">Создавать и обновлять</option>
            <option value="update_only">Только обновлять</option>
            <option value="create_only">Только создавать</option>
          </select>
          <select value={dupPolicy} onChange={(e) => setDupPolicy(e.target.value as "error" | "last_wins")}
            style={{ ...input, marginTop: 0, width: "auto" }}>
            <option value="error">Дубль SKU между файлами = ошибка</option>
            <option value="last_wins">Дубль SKU: последний файл побеждает</option>
          </select>
          <button style={btnGhost} disabled={!files.length || busy !== ""} onClick={runPreview}>
            {busy === "preview" ? "Проверяем пакет…" : "1 · Проверить пакет"}
          </button>
          <button style={{ ...btn, opacity: preview && !blocking && !result ? 1 : 0.5 }}
            disabled={!preview || blocking || !!result || busy !== ""} onClick={runConfirm}
            title={blocking ? "Сначала исправьте ошибки" : ""}>
            {busy === "confirm" ? "Применяем…" : "2 · Применить пакет"}
          </button>
          {preview && !result && (
            <button style={{ ...btnGhost, color: C.red }} disabled={busy !== ""} onClick={cancelJob}>
              {busy === "cancel" ? "Отменяем…" : "Отменить job"}
            </button>
          )}
        </div>
        {error && <p style={{ color: C.red, fontSize: 13, marginTop: 10 }}>{error}</p>}
        {busy === "preview" && <p style={{ color: C.sub, fontSize: 13, marginTop: 8 }}>Загружаем и разбираем файлы — большие ZIP могут занять до минуты…</p>}
      </div>

      {/* ===== Результат confirm ===== */}
      {result && (
        <div style={{ ...card, marginTop: 14, borderLeft: `4px solid ${result.partial ? C.yellow : C.green}` }}>
          <h3 style={{ marginTop: 0 }}>
            {result.idempotent ? "Пакет уже был применён ранее (повторный confirm)"
              : result.partial ? "⚠️ Пакет применён, но часть фото с ошибками" : "✅ Пакет применён"}
          </h3>
          <p style={{ fontSize: 13, color: C.sub, margin: "4px 0" }}>job: <code>{result.job_id}</code></p>
          <p style={{ fontSize: 14, margin: "6px 0" }}>
            Создано: <b style={{ color: C.green }}>{result.summary?.create ?? "—"}</b> ·
            Обновлено: <b style={{ color: C.accentDark }}> {result.summary?.update ?? "—"}</b> ·
            Фото загружено: <b> {(result.images_applied ?? []).reduce((a, r) => a + r.matched_images, 0)}</b>
          </p>
          {(result.image_errors ?? []).length > 0 && (
            <div style={{ background: "#fff5f5", borderRadius: 10, padding: "8px 12px", marginTop: 6 }}>
              {result.image_errors.map((e, i) => (
                <p key={i} style={{ color: C.red, fontSize: 13, margin: "3px 0" }}>{e.sku}: {e.error}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ===== Preview ===== */}
      {preview && !result && (
        <>
          <div style={{ ...card, marginTop: 14 }}>
            <h3 style={{ marginTop: 0 }}>Предпросмотр пакета <span style={{ color: C.sub, fontSize: 13, fontWeight: 400 }}>(в базу ничего не записано; job истекает через 30 минут)</span></h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8, fontSize: 13 }}>
              <Stat label="Файлов" value={preview.summary.files_total} />
              <Stat label="Строк" value={preview.summary.rows_total} />
              <Stat label="Создать" value={preview.summary.create} color={C.green} />
              <Stat label="Обновить" value={preview.summary.update} color={C.accentDark} />
              <Stat label="Без изменений" value={preview.summary.unchanged} />
              <Stat label="Пропущено" value={preview.summary.skip} />
              <Stat label="Ошибки" value={preview.summary.errors} color={preview.summary.errors ? C.red : undefined} />
              <Stat label="Предупреждения" value={preview.summary.warnings} color={preview.summary.warnings ? "#b57e00" : undefined} />
              <Stat label="Фото сопоставлено" value={preview.summary.images_matched} />
              <Stat label="Фото без SKU" value={preview.summary.images_unmatched} color={preview.summary.images_unmatched ? "#b57e00" : undefined} />
              <Stat label="Товары без фото" value={preview.summary.products_without_photos} color={preview.summary.products_without_photos ? "#b57e00" : undefined} />
              <Stat label="Дубли SKU" value={preview.summary.duplicates} color={preview.summary.duplicates ? "#b57e00" : undefined} />
            </div>
            <p style={{ fontSize: 13, color: C.sub, marginTop: 10 }}>
              Каталог: средняя цена {fmtPriceShort(preview.summary.catalog_avg_price_before)} → {fmtPriceShort(preview.summary.catalog_avg_price_after)},
              суммарная {fmtPriceShort(preview.summary.catalog_total_price_before)} → {fmtPriceShort(preview.summary.catalog_total_price_after)}
            </p>
            {blocking && <p style={{ color: C.red, fontSize: 13, marginTop: 4 }}>
              Применение заблокировано: исправьте {preview.summary.errors} строк с ошибками (или уберите файл из пакета).
              <button style={{ ...btnGhost, marginLeft: 10, padding: "4px 10px", fontSize: 12 }} onClick={downloadErrorsCsv}>Скачать ошибки CSV</button>
            </p>}
            {!blocking && preview.summary.errors === 0 && (
              <button style={{ ...btnGhost, marginTop: 6, padding: "4px 10px", fontSize: 12 }} onClick={downloadErrorsCsv}>Скачать отчёт об ошибках (пусто)</button>
            )}

            {/* по-файловые отчёты */}
            <div style={{ marginTop: 12 }}>
              {preview.files.map((f) => (
                <div key={f.name} style={{ borderTop: `1px solid ${C.border}`, padding: "6px 0", fontSize: 13 }}>
                  <button style={{ ...btnGhost, padding: "4px 10px", fontSize: 12 }}
                    onClick={() => setOpenFiles((o) => ({ ...o, [f.name]: !o[f.name] }))}>
                    {openFiles[f.name] ? "▾" : "▸"} {f.name}{f.sheet ? ` · лист «${f.sheet}»` : ""} — строк: {f.rows}, ошибок: {f.errors}
                  </button>
                  {openFiles[f.name] && (
                    <div style={{ padding: "4px 12px", color: C.sub }}>
                      {preview.rows.filter((r) => r.source_file === f.name && (r.errors.length || r.warnings.length || r.info.length))
                        .slice(0, 30).map((r, i) => (
                          <p key={i} style={{ margin: "3px 0", color: r.errors.length ? C.red : r.warnings.length ? "#b57e00" : C.sub }}>
                            строка {r.source_line}{r.sku ? ` · ${r.sku}` : ""}: {[...r.errors, ...r.warnings, ...r.info].join("; ")}
                          </p>
                        ))}
                    </div>
                  )}
                </div>
              ))}
              {(preview.scan_info.length > 0 || preview.scan_errors.length > 0) && (
                <div style={{ marginTop: 6, fontSize: 12, color: C.sub }}>
                  {preview.scan_errors.map((e, i) => <p key={"e" + i} style={{ color: C.red, margin: "2px 0" }}>{e.file}: {e.error}</p>)}
                  {preview.scan_info.slice(0, 10).map((s, i) => <p key={"i" + i} style={{ margin: "2px 0" }}>{s.file}: {s.info}</p>)}
                </div>
              )}
            </div>
          </div>

          {/* таблица строк */}
          <div style={{ ...card, marginTop: 14 }}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              {([["", "Все"], ["errors", "Ошибки"], ["warnings", "Warning"], ["create", "Создать"],
                 ["update", "Обновить"], ["unchanged", "Без изменений"]] as [RowFilter, string][]).map(([k, label]) => (
                <button key={k || "all"} style={chip(filter === k)} onClick={() => setFilter(k)}>{label}</button>
              ))}
              <input placeholder="Поиск по SKU" value={skuSearch} onChange={(e) => setSkuSearch(e.target.value)}
                style={{ ...input, marginTop: 0, width: 190 }} />
              <span style={{ color: C.sub, fontSize: 12 }}>показано {visibleRows.length}</span>
            </div>
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 760 }}>
                <thead><tr style={{ color: C.sub, textAlign: "left" }}>
                  <th style={th}>файл</th><th style={th}>строка</th><th style={th}>sku</th>
                  <th style={th}>действие</th><th style={th}>изменения</th><th style={th}>замечания</th>
                </tr></thead>
                <tbody>
                  {visibleRows.map((r, i) => (
                    <tr key={i} style={{ borderTop: `1px solid ${C.border}`, background: r.errors.length ? "#fff5f5" : undefined }}>
                      <td style={{ ...td, color: C.sub }}>{r.source_file}{r.source_sheet ? `·${r.source_sheet}` : ""}</td>
                      <td style={td}>{r.source_line}</td>
                      <td style={{ ...td, fontFamily: "monospace" }}>{r.sku ?? "—"}</td>
                      <td style={{ ...td, fontWeight: 600, color: r.action === "create" ? C.green : r.action === "update" ? C.accentDark : C.sub }}>
                        {r.action === "create" ? "создать" : r.action === "update" ? "обновить"
                          : r.action === "unchanged" ? "без изменений" : r.action === "superseded" ? "перекрыт" : "пропуск"}
                      </td>
                      <td style={td}>
                        {r.action === "update" && r.diff
                          ? Object.entries(r.diff).slice(0, 4).map(([k, v]) => (
                              <div key={k} style={{ whiteSpace: "nowrap" }}>
                                {k}: <span style={{ color: C.sub }}>{fmtVal(v.old)}</span> → <b>{fmtVal(v.new)}</b>
                              </div>
                            ))
                          : r.action === "create"
                            ? `${fmtVal(r.changes.title)} · ${fmtVal(r.changes.price)} ₽ · склад ${fmtVal(r.changes.stock)}`
                            : "—"}
                      </td>
                      <td style={{ ...td, maxWidth: 260 }}>
                        {r.errors.map((e, j) => <div key={"e" + j} style={{ color: C.red }}>{e}</div>)}
                        {r.warnings.map((w, j) => <div key={"w" + j} style={{ color: "#b57e00" }}>{w}</div>)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {preview.unmatched_images.length > 0 && (
              <div style={{ marginTop: 12, fontSize: 13 }}>
                <b style={{ color: "#b57e00" }}>Фото без подходящего SKU ({preview.unmatched_images.length}):</b>
                <p style={{ color: C.sub, margin: "4px 0", fontFamily: "monospace", fontSize: 12 }}>
                  {preview.unmatched_images.slice(0, 15).join(", ")}{preview.unmatched_images.length > 15 ? "…" : ""}
                </p>
              </div>
            )}
            {preview.summary.products_without_photos > 0 && (
              <p style={{ color: "#b57e00", fontSize: 13, marginTop: 8 }}>
                ⚠️ {preview.summary.products_without_photos} создаваемых товаров останутся без фото:
                {" "}{preview.products_without_photos.slice(0, 10).join(", ")}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={{ background: C.muted, borderRadius: 10, padding: "8px 10px" }}>
      <div style={{ color: C.sub, fontSize: 11 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 16, color: color ?? C.text }}>{value}</div>
    </div>
  );
}

const fmtPriceShort = (v: number) => new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(v) + " ₽";

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
  category: "Категория", brand: "Бренд", search: "Поиск", product: "Товар (id)",
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
          <input style={input} placeholder="напр. iphone / смартфоны / Dyson / hot"
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
  excess_images?: { sku: string; file: string; reason: string }[];
  products_without_images: { sku: string | null; id: number; title: string }[];
  errors: { file: string; error: string }[];
};

// ==================== Photo coverage (read-only аудит покрытия фото) ====================
type CoverageSummary = {
  total_active: number; no_photo: number; one_photo: number; two_three: number;
  four_plus: number; placeholder: number; coverage_pct: number;
};
type CoverageItem = {
  id: number; sku: string | null; title: string; brand: string | null; category: string | null;
  image_group_key: string | null; in_stock: boolean; current_images: number;
  placeholder: boolean; priority: string;
};
type CoverageResp = {
  summary: CoverageSummary; items: CoverageItem[]; total: number; page: number; pages: number;
  categories: string[]; brands: string[];
};

const PR_COLOR: Record<string, string> = { P0: C.red, P1: "#b57e00", P2: C.sub };

function PhotoCoverage({ token }: { token: string }) {
  const [data, setData] = useState<CoverageResp | null>(null);
  const [filter, setFilter] = useState("");
  const [category, setCategory] = useState("");
  const [brand, setBrand] = useState("");
  const [inStock, setInStock] = useState("");
  const [err, setErr] = useState("");

  function qs(pageSize: number) {
    const q = new URLSearchParams();
    if (filter) q.set("filter", filter);
    if (category) q.set("category", category);
    if (brand) q.set("brand", brand);
    if (inStock) q.set("in_stock", inStock);
    q.set("page_size", String(pageSize));
    return q.toString();
  }
  function load() {
    setErr("");
    apiGet<CoverageResp>(`/admin/photo-coverage?${qs(50)}`, token).then(setData)
      .catch((e) => setErr(e instanceof Error ? e.message : "Ошибка загрузки"));
  }
  useEffect(load, [filter, category, brand, inStock]);   // eslint-disable-line react-hooks/exhaustive-deps

  async function exportCsv() {
    const d = await apiGet<CoverageResp>(`/admin/photo-coverage?${qs(1000)}`, token);
    const header = ["id", "sku", "title", "brand", "category", "image_group_key", "in_stock", "current_images", "priority"];
    const rows = d.items.map((i) => [i.id, i.sku ?? "", i.title, i.brand ?? "", i.category ?? "",
      i.image_group_key ?? "", i.in_stock, i.current_images, i.priority]);
    const csv = [header, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `photo-coverage-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const s = data?.summary;
  const filterBtn = (key: string, label: string) => (
    <button onClick={() => setFilter(filter === key ? "" : key)} style={chip(filter === key)}>{label}</button>
  );

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h3 style={{ marginTop: 0, marginBottom: 0 }}>Покрытие каталога фото (read-only)</h3>
        <button style={{ ...btnGhost, padding: "6px 12px", fontSize: 13 }} onClick={exportCsv} disabled={!data}>
          Экспорт CSV
        </button>
      </div>
      {err && <p style={{ color: C.red, fontSize: 13 }}>{err}</p>}
      {s && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10, marginTop: 12 }}>
          <CovStat label="Активных" value={s.total_active} />
          <CovStat label="Покрытие" value={`${s.coverage_pct}%`} accent />
          <CovStat label="Без фото" value={s.no_photo} />
          <CovStat label="Только 1" value={s.one_photo} />
          <CovStat label="2–3" value={s.two_three} />
          <CovStat label="4+" value={s.four_plus} />
        </div>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
        {filterBtn("no_photo", "Без фото")}
        {filterBtn("one", "Только одно")}
        {filterBtn("placeholder", "Плейсхолдер")}
        <span style={{ width: 8 }} />
        <select value={category} onChange={(e) => setCategory(e.target.value)} style={{ ...chip(category !== ""), appearance: "none" }}>
          <option value="">Категория: все</option>
          {(data?.categories ?? []).map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={brand} onChange={(e) => setBrand(e.target.value)} style={{ ...chip(brand !== ""), appearance: "none" }}>
          <option value="">Бренд: все</option>
          {(data?.brands ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={inStock} onChange={(e) => setInStock(e.target.value)} style={{ ...chip(inStock !== ""), appearance: "none" }}>
          <option value="">Наличие: все</option>
          <option value="true">В наличии</option>
          <option value="false">Нет в наличии</option>
        </select>
      </div>

      {data && (
        <div style={{ marginTop: 12, maxHeight: 360, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: "left", color: C.sub, position: "sticky", top: 0, background: C.surface }}>
                <th style={{ padding: "6px 8px" }}>Приоритет</th>
                <th style={{ padding: "6px 8px" }}>Товар</th>
                <th style={{ padding: "6px 8px" }}>SKU</th>
                <th style={{ padding: "6px 8px" }}>Группа</th>
                <th style={{ padding: "6px 8px" }}>Фото</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => (
                <tr key={it.id} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: "6px 8px" }}>
                    <span style={{ color: "#fff", background: PR_COLOR[it.priority] ?? C.sub, borderRadius: 999, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>{it.priority}</span>
                  </td>
                  <td style={{ padding: "6px 8px", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.title}</td>
                  <td style={{ padding: "6px 8px", color: C.sub }}>
                    {it.sku ? <code>{it.sku}</code> : "—"}
                    {it.sku && (
                      <button title="Скопировать SKU (найти в «Товары»)" onClick={() => navigator.clipboard.writeText(it.sku!)}
                        style={{ ...btnGhost, padding: "1px 6px", fontSize: 11, marginLeft: 6 }}>⧉</button>
                    )}
                  </td>
                  <td style={{ padding: "6px 8px", color: C.sub, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {it.image_group_key || "—"}
                  </td>
                  <td style={{ padding: "6px 8px", fontWeight: 600 }}>{it.current_images}{it.placeholder ? " (плейсхолдер)" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.total > data.items.length && (
            <p style={{ fontSize: 12, color: C.sub, marginTop: 8 }}>
              Показаны первые {data.items.length} из {data.total}. Уточните фильтр или выгрузите CSV.
            </p>
          )}
        </div>
      )}
      <p style={{ fontSize: 12, color: C.sub, marginTop: 10 }}>
        Считается по эффективным группам фото, без внешних URL-проверок. Полный аудит с MD/CSV/JSON —
        скрипт <code>scripts/photo_coverage_audit.py</code>.
      </p>
    </div>
  );
}

function CovStat({ label, value, accent }: { label: string; value: number | string; accent?: boolean }) {
  return (
    <div style={{ background: accent ? C.accent : C.muted, borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ fontSize: 12, color: accent ? "rgba(255,255,255,.85)" : C.sub }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 700, color: accent ? "#fff" : C.text }}>{value}</div>
    </div>
  );
}

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
      <PhotoCoverage token={token} />
      <div style={{ ...card, marginTop: 14 }}>
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
          {report.excess_images && report.excess_images.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 13, color: "#b57e00", cursor: "pointer" }}>
                Не применено (лимит 10 фото): {report.excess_images.length}
              </summary>
              {report.excess_images.map((x, i) => (
                <p key={i} style={{ fontSize: 13, margin: "3px 0", color: "#b57e00" }}>
                  ↷ <code>{x.sku}</code> · {x.file} — {x.reason}
                </p>
              ))}
            </details>
          )}
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
