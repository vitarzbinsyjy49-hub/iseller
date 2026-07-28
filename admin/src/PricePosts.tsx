import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { C, card, btn, btnGhost, apiGet, apiPost } from "./ui";

/** Прайс канала: постоянные посты по разделам + навигационный пост.
 *
 *  Ключевая модель: пост публикуется ОДИН раз и дальше редактируется на том же
 *  message_id. Поэтому интерфейс построен вокруг вопроса «что изменится», а не
 *  «что отправить»: сначала план и diff, и только потом — подтверждённое
 *  применение. Ни одна кнопка не отправляет в канал ничего без диалога
 *  подтверждения. */

type PricePost = {
  slug: string; title: string; status: string; kind: string;
  telegram_message_id: number | null; channel_id: string | null;
  item_count: number; last_generated_at: string | null; last_synced_at: string | null;
  published_at: string | null; last_error: string | null; length: number;
};

type ListResp = {
  posts: PricePost[];
  missing_sections: { slug: string; title: string }[];
  channel_id: string | null;
  navigation_slug: string;
};

type PlanItem = {
  slug: string; section_slug: string; title: string; action: "create" | "update" | "unchanged";
  message_id: number | null; item_count: number; length: number; over_limit: boolean;
  price_changes: { name: string; old: number; new: number }[];
  added: string[]; removed: string[];
};

type PlanResp = {
  generated_for: string;
  summary: { create: number; update: number; unchanged: number; over_limit: number };
  posts: PlanItem[];
};

type ApplyResp = {
  dry_run: boolean; created: string[]; updated: string[]; unchanged: string[];
  failed: { slug: string; error: string }[]; navigation_message_id: number | null;
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Черновик", published: "Опубликован", outdated: "Устарел", error: "Ошибка",
};

const STATUS_COLOR: Record<string, string> = {
  draft: C.yellow, published: C.green, outdated: C.accent, error: C.red,
};

const ACTION_LABEL: Record<PlanItem["action"], string> = {
  create: "будет опубликован", update: "будет обновлён", unchanged: "без изменений",
};

function fmtDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return `${d.toLocaleDateString("ru-RU")} ${d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
}

function fmtPrice(value: number): string {
  return `${Math.round(value).toLocaleString("ru-RU").replace(/ /g, " ")} ₽`;
}

/** Ссылка на сообщение канала — та же схема, что и в кнопках навигации. */
function messageLink(channelId: string | null, messageId: number): string | null {
  if (!channelId) return null;
  if (channelId.startsWith("@")) return `https://t.me/${channelId.slice(1)}/${messageId}`;
  const internal = channelId.startsWith("-100") ? channelId.slice(4) : channelId.replace("-", "");
  return `https://t.me/c/${internal}/${messageId}`;
}

export function PricePosts({ token }: { token: string }) {
  const [data, setData] = useState<ListResp | null>(null);
  const [plan, setPlan] = useState<PlanResp | null>(null);
  const [preview, setPreview] = useState<{ slug: string; text: string; keyboard: unknown[][] } | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; message: string; run: () => void } | null>(null);
  const [result, setResult] = useState<ApplyResp | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      setData(await apiGet<ListResp>("/admin/price-posts", token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить прайс-посты");
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  async function loadPlan() {
    setBusy(true); setError(""); setResult(null);
    try {
      setPlan(await apiGet<PlanResp>("/admin/price-posts/plan", token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось построить план");
    } finally { setBusy(false); }
  }

  async function generateDrafts() {
    setBusy(true); setError(""); setResult(null);
    try {
      await apiPost("/admin/price-posts/generate", token, {});
      await load(); await loadPlan();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сформировать прайсы");
    } finally { setBusy(false); }
  }

  async function showPreview(slug: string) {
    setBusy(true); setError("");
    try {
      setPreview(await apiGet(`/admin/price-posts/${slug}/preview`, token));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось получить превью");
    } finally { setBusy(false); }
  }

  async function apply(path: string, body: Record<string, unknown>) {
    setBusy(true); setError(""); setResult(null);
    try {
      setResult(await apiPost<ApplyResp>(path, token, body));
      await load(); await loadPlan();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Операция не выполнена");
    } finally { setBusy(false); setConfirm(null); }
  }

  const askPublish = (slugs?: string[]) => {
    const count = slugs ? slugs.length : (plan ? plan.summary.create + plan.summary.update : 0);
    setConfirm({
      title: slugs ? "Обновить раздел в канале" : "Применить изменения в канале",
      message: `Будет затронуто постов: ${count}. Новые — опубликованы, изменившиеся — отредактированы `
        + "на тех же message_id. Действие видно всем подписчикам канала.",
      run: () => apply("/admin/price-posts/publish", { confirm: true, slugs }),
    });
  };

  const askNavigation = () => setConfirm({
    title: "Обновить навигационный пост",
    message: "Существующий пост не публикуется заново — обновится только его клавиатура. "
      + "Если поста ещё нет, он будет создан.",
    run: () => apply("/admin/price-posts/navigation", { confirm: true }),
  });

  const posts = data?.posts ?? [];
  const planBySlug = new Map((plan?.posts ?? []).map((p) => [p.slug, p]));

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <button style={btn} disabled={busy} onClick={generateDrafts}>
          Сформировать все прайсы из каталога
        </button>
        <button style={btnGhost} disabled={busy} onClick={loadPlan}>Показать план и diff</button>
        <button style={btnGhost} disabled={busy}
          onClick={() => apply("/admin/price-posts/publish", { dry_run: true })}>
          Пробный прогон
        </button>
        <button style={{ ...btn, background: C.green }} disabled={busy || !plan}
          onClick={() => askPublish()}>
          Применить в канале
        </button>
        <button style={btnGhost} disabled={busy} onClick={askNavigation}>Обновить навигацию</button>
        <span style={{ marginLeft: "auto", color: C.sub, fontSize: 13 }}>
          канал: {data?.channel_id || "НЕ НАСТРОЕН"}
        </span>
      </div>

      {!data?.channel_id && (
        <Notice color={C.red}>
          TELEGRAM_CHANNEL_ID не задан — публикация невозможна. Превью и план работают.
        </Notice>
      )}
      {error && <Notice color={C.red}>{error}</Notice>}
      {result && <ApplySummary result={result} />}
      {plan && <PlanSummary plan={plan} />}

      {data && data.missing_sections.length > 0 && (
        <Notice color={C.yellow}>
          Ещё не сформированы: {data.missing_sections.map((s) => s.title).join(", ")}
        </Notice>
      )}

      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ background: C.bg, textAlign: "left" }}>
              <th style={th}>Раздел</th>
              <th style={th}>Статус</th>
              <th style={th}>Message ID</th>
              <th style={th}>Товаров</th>
              <th style={th}>Длина</th>
              <th style={th}>Синхронизирован</th>
              <th style={th}>Что изменится</th>
              <th style={th}></th>
            </tr>
          </thead>
          <tbody>
            {posts.length === 0 && (
              <tr><td style={td} colSpan={8}>
                <span style={{ color: C.sub }}>
                  Прайс-постов пока нет. Нажмите «Сформировать все прайсы из каталога» —
                  будут созданы черновики, без публикации.
                </span>
              </td></tr>
            )}
            {posts.map((post) => {
              const item = planBySlug.get(post.slug);
              const link = post.telegram_message_id
                ? messageLink(post.channel_id ?? data?.channel_id ?? null, post.telegram_message_id)
                : null;
              return (
                <tr key={post.slug} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{post.title}</div>
                    <div style={{ color: C.sub, fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                      {post.slug}
                    </div>
                    {post.last_error && (
                      <div style={{ color: C.red, fontSize: 12, marginTop: 4 }}>{post.last_error}</div>
                    )}
                  </td>
                  <td style={td}>
                    <span style={{
                      background: (STATUS_COLOR[post.status] ?? C.sub) + "22",
                      color: STATUS_COLOR[post.status] ?? C.sub,
                      padding: "3px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                    }}>{STATUS_LABEL[post.status] ?? post.status}</span>
                  </td>
                  <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                    {post.telegram_message_id ?? "—"}
                  </td>
                  <td style={td}>{post.item_count}</td>
                  <td style={{ ...td, color: post.length > 4096 ? C.red : C.text }}>
                    {post.length}/4096
                  </td>
                  <td style={{ ...td, color: C.sub, fontSize: 13 }}>{fmtDate(post.last_synced_at)}</td>
                  <td style={td}>{item ? <PlanCell item={item} /> : <span style={{ color: C.sub }}>—</span>}</td>
                  <td style={td}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button style={smallGhost} disabled={busy}
                        onClick={() => showPreview(post.slug)}>Превью</button>
                      {item && item.action !== "unchanged" && (
                        <button style={smallBtn} disabled={busy}
                          onClick={() => askPublish([post.slug])}>
                          {item.action === "create" ? "Опубликовать" : "Обновить"}
                        </button>
                      )}
                      {link && (
                        <a href={link} target="_blank" rel="noreferrer"
                          style={{ ...smallGhost, textDecoration: "none", display: "inline-block" }}>
                          Открыть пост
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {preview && <PreviewModal preview={preview} onClose={() => setPreview(null)} />}
      {confirm && (
        <ConfirmModal spec={confirm} busy={busy} onCancel={() => setConfirm(null)} />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- части UI */

function PlanCell({ item }: { item: PlanItem }) {
  if (item.over_limit) {
    return <span style={{ color: C.red, fontWeight: 600 }}>превышен лимит Telegram</span>;
  }
  if (item.action === "unchanged") return <span style={{ color: C.sub }}>без изменений</span>;
  const bits: string[] = [];
  if (item.price_changes.length) bits.push(`цен: ${item.price_changes.length}`);
  if (item.added.length) bits.push(`новых: ${item.added.length}`);
  if (item.removed.length) bits.push(`убрано: ${item.removed.length}`);
  return (
    <div>
      <div style={{ color: item.action === "create" ? C.green : C.accent, fontWeight: 600 }}>
        {ACTION_LABEL[item.action]}
      </div>
      {bits.length > 0 && <div style={{ color: C.sub, fontSize: 12 }}>{bits.join(", ")}</div>}
      {item.price_changes.slice(0, 3).map((change) => (
        <div key={change.name} style={{ fontSize: 12, color: C.sub }}>
          {change.name}: <s>{fmtPrice(change.old)}</s> → <b style={{ color: C.text }}>{fmtPrice(change.new)}</b>
        </div>
      ))}
      {item.price_changes.length > 3 && (
        <div style={{ fontSize: 12, color: C.sub }}>…ещё {item.price_changes.length - 3}</div>
      )}
    </div>
  );
}

function PlanSummary({ plan }: { plan: PlanResp }) {
  const { summary } = plan;
  return (
    <div style={{ ...card, marginBottom: 12, display: "flex", gap: 20, flexWrap: "wrap" }}>
      <Stat label="Будет опубликовано" value={summary.create} color={C.green} />
      <Stat label="Будет обновлено" value={summary.update} color={C.accent} />
      <Stat label="Без изменений" value={summary.unchanged} color={C.sub} />
      {summary.over_limit > 0 && (
        <Stat label="Превышен лимит" value={summary.over_limit} color={C.red} />
      )}
      <div style={{ marginLeft: "auto", color: C.sub, fontSize: 13, alignSelf: "center" }}>
        план на {plan.generated_for}
      </div>
    </div>
  );
}

function ApplySummary({ result }: { result: ApplyResp }) {
  return (
    <Notice color={result.failed.length ? C.red : C.green}>
      {result.dry_run && <b>Пробный прогон, в канал ничего не отправлено. </b>}
      Опубликовано: {result.created.length}, обновлено: {result.updated.length},
      без изменений: {result.unchanged.length}
      {result.failed.length > 0 && (
        <div style={{ marginTop: 6 }}>
          {result.failed.map((f) => <div key={f.slug}>{f.slug}: {f.error}</div>)}
        </div>
      )}
    </Notice>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
      <div style={{ color: C.sub, fontSize: 12 }}>{label}</div>
    </div>
  );
}

function Notice({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 12, fontSize: 14, lineHeight: 1.5, padding: "12px 14px",
      borderRadius: 10, background: `${color}14`, color: C.text,
      border: `1px solid ${color}33`,
    }}>{children}</div>
  );
}

function PreviewModal({
  preview, onClose,
}: { preview: { slug: string; text: string; keyboard: unknown[][] }; onClose: () => void }) {
  return (
    <Backdrop onClose={onClose}>
      <h3 style={{ margin: "0 0 4px" }}>Превью: {preview.slug}</h3>
      <div style={{ color: C.sub, fontSize: 13, marginBottom: 12 }}>
        {preview.text.length}/4096 символов. В канал ничего не отправлено.
      </div>
      {/* Показываем ровно тот HTML, который уйдёт в Telegram — в виде текста,
          а не отрендеренным: админ должен видеть разметку, а не её результат. */}
      <pre style={{
        background: C.bg, padding: 14, borderRadius: 8, whiteSpace: "pre-wrap",
        wordBreak: "break-word", fontSize: 13, maxHeight: "50vh", overflow: "auto",
        border: `1px solid ${C.border}`,
      }}>{preview.text}</pre>
      <div style={{ marginTop: 12, fontSize: 13, color: C.sub }}>Кнопки:</div>
      {(preview.keyboard as { text: string; url?: string; web_app?: { url: string } }[][]).map((row, i) => (
        <div key={i} style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
          {row.map((b) => (
            <span key={b.text} style={{
              border: `1px solid ${C.border}`, borderRadius: 8, padding: "6px 10px", fontSize: 13,
            }}>
              {b.text}
              <span style={{ color: C.sub, fontSize: 11, display: "block" }}>
                {b.url ?? b.web_app?.url}
              </span>
            </span>
          ))}
        </div>
      ))}
      <div style={{ marginTop: 16, textAlign: "right" }}>
        <button style={btn} onClick={onClose}>Закрыть</button>
      </div>
    </Backdrop>
  );
}

function ConfirmModal({
  spec, busy, onCancel,
}: { spec: { title: string; message: string; run: () => void }; busy: boolean; onCancel: () => void }) {
  return (
    <Backdrop onClose={onCancel}>
      <h3 style={{ margin: "0 0 8px" }}>{spec.title}</h3>
      <p style={{ margin: "0 0 18px", color: C.sub, fontSize: 14, lineHeight: 1.5 }}>{spec.message}</p>
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button style={btnGhost} onClick={onCancel} disabled={busy}>Отмена</button>
        <button style={{ ...btn, background: C.green }} onClick={spec.run} disabled={busy}>
          {busy ? "Выполняю…" : "Подтвердить"}
        </button>
      </div>
    </Backdrop>
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, background: "rgba(15,23,42,.55)", zIndex: 50,
        display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        ...card, maxWidth: 720, width: "100%", maxHeight: "85vh", overflow: "auto",
      }}>{children}</div>
    </div>
  );
}

const th: CSSProperties = { padding: "10px 12px", fontWeight: 600, fontSize: 13, color: C.sub };
const td: CSSProperties = { padding: "10px 12px", verticalAlign: "top" };
const smallBtn: CSSProperties = { ...btn, padding: "6px 10px", fontSize: 13 };
const smallGhost: CSSProperties = { ...btnGhost, padding: "6px 10px", fontSize: 13 };
