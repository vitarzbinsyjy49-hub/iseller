import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { C, card, input, btn, btnGhost, apiGet, apiPost, apiSend } from "./ui";

/** Посты канала: гарантия, доставка, оплата и любые свои посты с кнопками.
 *
 *  Отличие от «Прайса канала»: там текст генерируется из каталога, здесь его
 *  пишет человек. Поэтому пост живёт по правилу «написал -> посмотрел превью ->
 *  опубликовал», а дальше правится на том же message_id: подписчикам не летят
 *  новые уведомления, ссылки из навигации не ломаются.
 *
 *  Кнопки задаются описанием (тип + подпись), а не готовым URL: ссылка на
 *  менеджера или канал живёт в настройках, и при её смене все посты подхватят
 *  новую вместо вмороженной старой. */

type Post = {
  slug: string; title: string; status: string; kind: string;
  telegram_message_id: number | null; channel_id: string | null;
  body: string | null; buttons: ButtonSpec[] | null;
  has_placeholders: boolean; editable: boolean;
  /** Есть ли заготовка в коде — от этого зависит кнопка «вернуть заготовку». */
  has_draft: boolean;
  last_synced_at: string | null; last_error: string | null; length: number;
};

type ButtonSpec = { text: string; kind: string; value?: string; row?: number };
type KindsResp = { kinds: { kind: string; label: string }[]; sections: { slug: string; title: string }[] };
type ListResp = { posts: Post[]; channel_id: string | null };
type ApplyResp = {
  dry_run: boolean; created: string[]; updated: string[]; unchanged: string[];
  failed: { slug: string; error: string }[];
};

const STATUS_LABEL: Record<string, string> = {
  draft: "Черновик", published: "Опубликован", outdated: "Есть правки", error: "Ошибка",
};
const STATUS_COLOR: Record<string, string> = {
  draft: C.yellow, published: C.green, outdated: C.accent, error: C.red,
};

function messageLink(channelId: string | null, messageId: number): string | null {
  if (!channelId) return null;
  if (channelId.startsWith("@")) return `https://t.me/${channelId.slice(1)}/${messageId}`;
  const internal = channelId.startsWith("-100") ? channelId.slice(4) : channelId.replace("-", "");
  return `https://t.me/c/${internal}/${messageId}`;
}

export function ChannelPosts({ token }: { token: string }) {
  const [data, setData] = useState<ListResp | null>(null);
  const [kinds, setKinds] = useState<KindsResp | null>(null);
  const [editing, setEditing] = useState<Post | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirm, setConfirm] = useState<{ title: string; message: string; run: () => void } | null>(null);
  const [result, setResult] = useState<ApplyResp | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError("");
    try {
      const all = await apiGet<{ posts: Post[]; channel_id: string | null }>("/admin/price-posts", token);
      setData({ posts: all.posts.filter((p) => p.editable), channel_id: all.channel_id });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось загрузить посты");
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { apiGet<KindsResp>("/admin/price-posts/info/button-kinds", token).then(setKinds).catch(() => {}); }, [token]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError(""); setResult(null);
    try { await fn(); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : "Не выполнено"); }
    finally { setBusy(false); setConfirm(null); }
  }

  const createDefaults = () => run(() => apiPost("/admin/price-posts/info/generate", token, {}));

  // Генерация чужой текст не трогает — и правильно делает. Но когда заготовку
  // в коде переписали, вернуть её было нечем, кроме копипаста HTML в поле.
  const askReset = (slug: string, title: string) => setConfirm({
    title: "Вернуть заготовку",
    message: `Текст поста «${title}» будет заменён версией из кода. `
      + "Ваши правки в этом посте пропадут. В канал изменение само не уйдёт — "
      + "понадобится «Обновить в канале».",
    run: () => run(() => apiPost(`/admin/price-posts/info/${slug}/reset`, token, {})),
  });

  const askPublish = (slugs?: string[]) => setConfirm({
    title: slugs ? "Опубликовать пост" : "Опубликовать все готовые посты",
    message: "Новые посты появятся в канале, изменённые — будут отредактированы на тех же "
      + "message_id. Посты с незаполненными местами пропускаются.",
    run: () => run(async () => {
      setResult(await apiPost<ApplyResp>("/admin/price-posts/info/publish", token,
        { confirm: true, slugs }));
    }),
  });

  const posts = data?.posts ?? [];
  const ready = posts.filter((p) => !p.has_placeholders).length;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        <button style={btn} disabled={busy} onClick={() => setCreating(true)}>Новый пост</button>
        <button style={btnGhost} disabled={busy} onClick={createDefaults}>
          Добавить типовые (гарантия, доставка, оплата…)
        </button>
        <button style={btnGhost} disabled={busy}
          onClick={() => run(async () => setResult(
            await apiPost<ApplyResp>("/admin/price-posts/info/publish", token, { dry_run: true })))}>
          Пробный прогон
        </button>
        <button style={{ ...btn, background: C.green }} disabled={busy || ready === 0}
          onClick={() => askPublish()}>
          Опубликовать готовые ({ready})
        </button>
        <span style={{ marginLeft: "auto", color: C.sub, fontSize: 13 }}>
          канал: {data?.channel_id || "не настроен"}
        </span>
      </div>

      {error && <Notice color={C.red}>{error}</Notice>}
      {result && (
        <Notice color={result.failed.length ? C.red : C.green}>
          {result.dry_run && <b>Пробный прогон, в канал ничего не отправлено. </b>}
          Опубликовано: {result.created.length}, обновлено: {result.updated.length},
          без изменений: {result.unchanged.length}
          {result.failed.map((f) => <div key={f.slug}>{f.slug}: {f.error}</div>)}
        </Notice>
      )}

      {posts.length === 0 && (
        <Notice color={C.sub}>
          Постов пока нет. «Добавить типовые» создаст черновики про гарантию, доставку,
          оплату, заказ под привоз и о магазине — их останется дописать под себя.
        </Notice>
      )}

      <div style={{ display: "grid", gap: 12 }}>
        {posts.map((post) => {
          const link = post.telegram_message_id
            ? messageLink(post.channel_id ?? data?.channel_id ?? null, post.telegram_message_id)
            : null;
          return (
            <div key={post.slug} style={card}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <b style={{ fontSize: 15 }}>{post.title}</b>
                <span style={{
                  background: (STATUS_COLOR[post.status] ?? C.sub) + "22",
                  color: STATUS_COLOR[post.status] ?? C.sub,
                  padding: "3px 8px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                }}>{STATUS_LABEL[post.status] ?? post.status}</span>
                {post.has_placeholders && (
                  <span style={{ color: C.red, fontSize: 12, fontWeight: 600 }}>
                    есть незаполненные места — публикация заблокирована
                  </span>
                )}
                <span style={{ marginLeft: "auto", color: C.sub, fontSize: 12, fontFamily: "ui-monospace, monospace" }}>
                  {post.slug}{post.telegram_message_id ? ` · msg ${post.telegram_message_id}` : ""}
                  {" · "}{post.length}/4096
                </span>
              </div>

              <pre style={{
                marginTop: 10, marginBottom: 10, background: C.bg, padding: 12, borderRadius: 8,
                whiteSpace: "pre-wrap", wordBreak: "break-word", fontSize: 13,
                maxHeight: 150, overflow: "auto", border: `1px solid ${C.border}`,
              }}>{post.body}</pre>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                {(post.buttons ?? []).map((b, i) => (
                  <span key={i} style={{
                    border: `1px solid ${C.border}`, borderRadius: 8, padding: "4px 9px", fontSize: 12,
                  }}>
                    {b.text}
                    <span style={{ color: C.sub, marginLeft: 6 }}>
                      {kinds?.kinds.find((k) => k.kind === b.kind)?.label ?? b.kind}
                    </span>
                  </span>
                ))}
              </div>

              {post.last_error && (
                <div style={{ color: C.red, fontSize: 12, marginBottom: 8 }}>{post.last_error}</div>
              )}

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button style={smallGhost} disabled={busy} onClick={() => setEditing(post)}>
                  Редактировать
                </button>
                {post.has_draft && (
                  <button style={smallGhost} disabled={busy}
                    onClick={() => askReset(post.slug, post.title)}>
                    Вернуть заготовку
                  </button>
                )}
                {!post.has_placeholders && (
                  <button style={smallBtn} disabled={busy} onClick={() => askPublish([post.slug])}>
                    {post.telegram_message_id ? "Обновить в канале" : "Опубликовать"}
                  </button>
                )}
                {link && (
                  <a href={link} target="_blank" rel="noreferrer"
                    style={{ ...smallGhost, textDecoration: "none", display: "inline-block" }}>
                    Открыть пост
                  </a>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editing && kinds && (
        <PostEditor post={editing} kinds={kinds} busy={busy} onClose={() => setEditing(null)}
          onSave={(body, buttons, title) => run(async () => {
            await apiSend("PATCH", `/admin/price-posts/info/${editing.slug}`, token, { body, buttons, title });
            setEditing(null);
          })} />
      )}
      {creating && kinds && (
        <PostEditor kinds={kinds} busy={busy} onClose={() => setCreating(false)}
          onCreate={(slug, title, body, buttons) => run(async () => {
            await apiPost("/admin/price-posts/info", token, { slug, title, body, buttons });
            setCreating(false);
          })} />
      )}
      {confirm && <ConfirmModal spec={confirm} busy={busy} onCancel={() => setConfirm(null)} />}
    </div>
  );
}

/* ---------------------------------------------------------------- редактор */

function PostEditor({
  post, kinds, busy, onClose, onSave, onCreate,
}: {
  post?: Post; kinds: KindsResp; busy: boolean; onClose: () => void;
  onSave?: (body: string, buttons: ButtonSpec[], title: string) => void;
  onCreate?: (slug: string, title: string, body: string, buttons: ButtonSpec[]) => void;
}) {
  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState(post?.title ?? "");
  const [body, setBody] = useState(post?.body ?? "");
  const [buttons, setButtons] = useState<ButtonSpec[]>(
    post?.buttons ?? [{ text: "🛍 Открыть каталог", kind: "catalog", row: 0 }]);

  const update = (index: number, patch: Partial<ButtonSpec>) =>
    setButtons(buttons.map((b, i) => (i === index ? { ...b, ...patch } : b)));

  return (
    <Backdrop onClose={onClose}>
      <h3 style={{ margin: "0 0 12px" }}>{post ? `Пост: ${post.slug}` : "Новый пост канала"}</h3>

      {!post && (
        <label style={label}>
          Идентификатор (латиницей, без пробелов)
          <input style={input} value={slug} onChange={(e) => setSlug(e.target.value)}
            placeholder="info_promo" />
        </label>
      )}
      <label style={label}>
        Название (видно только в админке)
        <input style={input} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>

      <label style={label}>
        Текст поста — HTML: &lt;b&gt;жирный&lt;/b&gt;, &lt;i&gt;курсив&lt;/i&gt;, &lt;a href="…"&gt;ссылка&lt;/a&gt;
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={14}
          style={{ ...input, fontFamily: "ui-monospace, monospace", fontSize: 13, lineHeight: 1.5 }} />
      </label>
      <div style={{ color: body.length > 4096 ? C.red : C.sub, fontSize: 12, marginTop: -6 }}>
        {body.length}/4096 символов
      </div>

      <div style={{ marginTop: 16, marginBottom: 8, fontWeight: 600, fontSize: 14 }}>Кнопки</div>
      <div style={{ display: "grid", gap: 8 }}>
        {buttons.map((button, index) => (
          <div key={index} style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input style={{ ...input, marginTop: 0, flex: "1 1 200px" }} value={button.text}
              placeholder="Подпись на кнопке"
              onChange={(e) => update(index, { text: e.target.value })} />
            <select style={{ ...input, marginTop: 0, width: "auto" }} value={button.kind}
              onChange={(e) => update(index, { kind: e.target.value, value: "" })}>
              {kinds.kinds.map((k) => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
            {button.kind === "section" && (
              <select style={{ ...input, marginTop: 0, width: "auto" }} value={button.value ?? ""}
                onChange={(e) => update(index, { value: e.target.value })}>
                <option value="">— раздел —</option>
                {kinds.sections.map((s) => <option key={s.slug} value={s.slug}>{s.title}</option>)}
              </select>
            )}
            {button.kind === "url" && (
              <input style={{ ...input, marginTop: 0, flex: "1 1 220px" }} value={button.value ?? ""}
                placeholder="https://…" onChange={(e) => update(index, { value: e.target.value })} />
            )}
            <input type="number" style={{ ...input, marginTop: 0, width: 70 }}
              value={button.row ?? index} title="Номер ряда — кнопки с одним номером встают рядом"
              onChange={(e) => update(index, { row: Number(e.target.value) })} />
            <button style={smallGhost}
              onClick={() => setButtons(buttons.filter((_, i) => i !== index))}>Убрать</button>
          </div>
        ))}
      </div>
      <button style={{ ...smallGhost, marginTop: 8 }}
        onClick={() => setButtons([...buttons, { text: "", kind: "manager", row: buttons.length }])}>
        + Кнопка
      </button>

      <div style={{ marginTop: 18, display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button style={btnGhost} onClick={onClose} disabled={busy}>Отмена</button>
        <button style={btn} disabled={busy || !body.trim() || (!post && !slug.trim())}
          onClick={() => (post
            ? onSave?.(body, buttons, title)
            : onCreate?.(slug, title || slug, body, buttons))}>
          {busy ? "Сохраняю…" : "Сохранить"}
        </button>
      </div>
      <div style={{ color: C.sub, fontSize: 12, marginTop: 8, textAlign: "right" }}>
        Сохранение не публикует пост — в канал он уйдёт отдельной кнопкой.
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

function Notice({ color, children }: { color: string; children: React.ReactNode }) {
  return (
    <div style={{
      marginBottom: 12, fontSize: 14, lineHeight: 1.5, padding: "12px 14px",
      borderRadius: 10, background: `${color}14`, color: C.text, border: `1px solid ${color}33`,
    }}>{children}</div>
  );
}

function Backdrop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "rgba(15,23,42,.55)", zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        ...card, maxWidth: 760, width: "100%", maxHeight: "88vh", overflow: "auto",
      }}>{children}</div>
    </div>
  );
}

const label: CSSProperties = { display: "block", fontSize: 13, color: C.sub, marginBottom: 10 };
const smallBtn: CSSProperties = { ...btn, padding: "6px 10px", fontSize: 13 };
const smallGhost: CSSProperties = { ...btnGhost, padding: "6px 10px", fontSize: 13 };
