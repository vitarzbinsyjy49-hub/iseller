/** Шторка правки товара для администратора (вариант C): цена, наличие,
 *  история цен и откат. Открывается и из списка «Цены», и с карточки товара. */
import { useEffect, useState } from "react";
import { SheetShell } from "./ScenarioSheet";
import { Icon } from "./icons";
import {
  isBigChange, parsePriceInput, patchStaffProduct, revertPrice, sourceLabel, staffHistory,
  StaffError, type PriceChange, type StaffProduct,
} from "../lib/staff";
import { haptic } from "../lib/telegram";

const fmt = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n).toLocaleString("ru-RU")} ₽`);

function when(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export default function StaffPriceSheet({
  product, onClose, onSaved,
}: {
  product: Pick<StaffProduct, "id" | "title" | "sku" | "price" | "in_stock">;
  onClose: () => void;
  onSaved: (p: StaffProduct) => void;
}) {
  const [value, setValue] = useState(product.price ? String(Math.round(product.price)) : "");
  const [inStock, setInStock] = useState(product.in_stock);
  const [history, setHistory] = useState<PriceChange[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmBig, setConfirmBig] = useState(false);

  useEffect(() => {
    staffHistory(product.id).then((r) => setHistory(r.items)).catch(() => setHistory([]));
  }, [product.id]);

  const parsed = parsePriceInput(value);
  const big = parsed != null && isBigChange(product.price, parsed);

  function bump(delta: number) {
    const base = parsed ?? product.price ?? 0;
    setValue(String(Math.max(1, Math.round(base + delta))));
    setConfirmBig(false);
    haptic("light");
  }

  async function save(close: () => void) {
    if (parsed == null) { setError("Введите цену цифрами"); return; }
    if (big && !confirmBig) { setConfirmBig(true); setError(null); return; }
    setBusy(true); setError(null);
    try {
      const body: { price?: number; in_stock?: boolean; confirm?: boolean } = {};
      if (parsed !== Math.round(product.price ?? 0)) { body.price = parsed; body.confirm = confirmBig || undefined; }
      if (inStock !== product.in_stock) body.in_stock = inStock;
      const saved = Object.keys(body).length ? await patchStaffProduct(product.id, body) : null;
      haptic("medium");
      if (saved) onSaved(saved);
      close();
    } catch (e) {
      if (e instanceof StaffError && e.code === "need_confirm") setConfirmBig(true);
      else setError(e instanceof Error ? e.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  async function undo(change: PriceChange) {
    setBusy(true); setError(null);
    try {
      const saved = await revertPrice(product.id, change.id);
      onSaved(saved);
      setValue(String(Math.round(saved.price ?? 0)));
      const r = await staffHistory(product.id);
      setHistory(r.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось откатить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SheetShell onClose={onClose} labelledBy="staff-price-title">
      {(close) => (
        <div className="px-4 pb-4 pt-4">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h2 id="staff-price-title" className="text-[16px] font-bold leading-5">{product.title}</h2>
              <p className="mt-0.5 text-[12.5px] text-muted">{product.sku ?? "без артикула"} · сейчас {fmt(product.price)}</p>
            </div>
            <button onClick={() => close()} aria-label="Закрыть"
              className="tap -mr-1 -mt-1.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-muted hover:bg-mutedbg">
              <Icon name="close" className="h-4 w-4" strokeWidth={2.2} />
            </button>
          </div>

          <label className="mt-4 block text-[12px] text-muted" htmlFor="staff-price-input">Цена, ₽</label>
          <input
            id="staff-price-input"
            inputMode="numeric"
            autoComplete="off"
            value={value}
            onChange={(e) => { setValue(e.target.value); setConfirmBig(false); setError(null); }}
            className="mt-1 min-h-11 w-full rounded-field border border-border bg-surface px-3 text-[20px] font-bold outline-none focus:border-accent"
          />
          <div className="mt-2 grid grid-cols-4 gap-2">
            {[-1000, -500, 500, 1000].map((d) => (
              <button key={d} onClick={() => bump(d)}
                className="tap min-h-11 rounded-field border border-border text-[14px] font-semibold">
                {d > 0 ? `+${d}` : d}
              </button>
            ))}
          </div>

          <p className="mt-4 text-[12px] text-muted">Наличие</p>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {[true, false].map((v) => (
              <button key={String(v)} onClick={() => setInStock(v)}
                className={`tap min-h-11 rounded-field border text-[14px] font-semibold ${
                  inStock === v ? "border-accent bg-accent/10 text-accent" : "border-border"}`}>
                {v ? "В наличии" : "Нет в наличии"}
              </button>
            ))}
          </div>

          {confirmBig && parsed != null && (
            <p className="mt-3 rounded-field bg-dangerbg px-3 py-2 text-[13px] text-dangerink">
              Цена меняется больше чем на 30%: {fmt(product.price)} → {fmt(parsed)}. Нажмите ещё раз, если всё верно.
            </p>
          )}
          {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}

          <button onClick={() => save(close)} disabled={busy}
            className="tap mt-4 min-h-11 w-full rounded-field bg-accent px-4 text-[15px] font-semibold text-white disabled:opacity-60">
            {busy ? "Сохраняю…" : confirmBig ? "Да, сохранить" : "Сохранить"}
          </button>

          <p className="mt-5 text-[12px] text-muted">История цены</p>
          {history == null ? (
            <p className="mt-1 text-[13px] text-muted">Загружаю…</p>
          ) : history.length === 0 ? (
            <p className="mt-1 text-[13px] text-muted">Изменений пока не было — история пишется с 07.10.2026.</p>
          ) : (
            <ul className="mt-1 divide-y divide-border">
              {history.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-2 py-2 text-[13px]">
                  <div className="min-w-0">
                    <p>{fmt(h.old_price)} → <span className="font-semibold">{fmt(h.new_price)}</span></p>
                    <p className="text-[11.5px] text-muted">{when(h.created_at)} · {sourceLabel(h.source)}{h.note ? ` · ${h.note}` : ""}</p>
                  </div>
                  {h.old_price != null && (
                    <button onClick={() => undo(h)} disabled={busy}
                      className="tap shrink-0 rounded-field border border-border px-3 py-1.5 text-[12.5px] font-semibold">
                      Вернуть {fmt(h.old_price)}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </SheetShell>
  );
}
