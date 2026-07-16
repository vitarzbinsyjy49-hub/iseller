import { useEffect, useState } from "react";
import { C, card, input, btn, btnGhost, chip, apiGet, apiPatch, apiPost } from "./ui";

type PostStatus = "draft" | "approved" | "rejected" | "published";
type ChannelPost = {
  id: number; title: string; body: string; image_url: string | null; kind: string;
  sources: string[]; status: PostStatus; content_version: number;
  approved_version: number | null; published_at: string | null; created_at: string;
};

const STATUS: Record<PostStatus, string> = {
  draft: "Черновик", approved: "Одобрен", rejected: "Отклонён", published: "Опубликован",
};
const KIND: Record<string, string> = { news: "Новость", guide: "Польза", opinion: "Разбор" };

export function Posts({ token }: { token: string }) {
  const [posts, setPosts] = useState<ChannelPost[]>([]);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<ChannelPost | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  function load() {
    setLoading(true); setError("");
    const q = filter ? `?status_filter=${filter}` : "";
    apiGet<{ posts: ChannelPost[] }>(`/admin/posts${q}`, token)
      .then((d) => setPosts(d.posts)).catch((e) => setError(String(e))).finally(() => setLoading(false));
  }
  useEffect(load, [filter, token]);

  async function action(path: string, body: unknown = {}) {
    setError("");
    try { await apiPost(path, token, body); load(); } catch (e) { setError(String(e)); }
  }

  async function save() {
    if (!editing) return;
    setError("");
    try {
      await apiPatch(`/admin/posts/${editing.id}`, token, {
        title: editing.title, body: editing.body, image_url: editing.image_url,
        kind: editing.kind, sources: editing.sources,
      });
      setEditing(null); load();
    } catch (e) { setError(String(e)); }
  }

  async function publish(post: ChannelPost) {
    if (!window.confirm(`Опубликовать «${post.title}» в Telegram-канале? Отменить это действие будет нельзя.`)) return;
    await action(`/admin/posts/${post.id}/publish`, { confirm: true });
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap", marginBottom: 16 }}>
        <div><h2 style={{ margin: 0, fontSize: 22 }}>Посты</h2><p style={{ color: C.sub, margin: "5px 0 0" }}>Черновики не публикуются без вашего подтверждения.</p></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {["", "draft", "approved", "published", "rejected"].map((s) =>
            <button key={s || "all"} style={chip(filter === s)} onClick={() => setFilter(s)}>{s ? STATUS[s as PostStatus] : "Все"}</button>)}
        </div>
      </div>
      {error && <div style={{ ...card, color: C.red, marginBottom: 12, padding: 14 }}>{error}</div>}
      {loading ? <p style={{ color: C.sub }}>Загрузка…</p> : posts.length === 0 ? <Empty /> :
        <div style={{ display: "grid", gap: 14 }}>
          {posts.map((p) => <PostCard key={p.id} post={p} onEdit={() => setEditing({ ...p })}
            onApprove={() => action(`/admin/posts/${p.id}/approve`)} onReject={() => action(`/admin/posts/${p.id}/reject`)} onPublish={() => publish(p)} />)}
        </div>}
      {editing && <Editor post={editing} setPost={setEditing} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  );
}

function Empty() {
  return <div style={{ ...card, textAlign: "center", padding: 44 }}><div style={{ fontSize: 36 }}>✦</div><h3>Черновиков пока нет</h3><p style={{ color: C.sub, maxWidth: 520, margin: "0 auto" }}>После подключения генератора здесь ежедневно будут появляться три варианта: новость, полезный материал и аналитический разбор.</p></div>;
}

function PostCard({ post, onEdit, onApprove, onReject, onPublish }: { post: ChannelPost; onEdit: () => void; onApprove: () => void; onReject: () => void; onPublish: () => void }) {
  const color = post.status === "published" ? C.green : post.status === "approved" ? C.accent : post.status === "rejected" ? C.red : C.yellow;
  return <article style={{ ...card, display: "grid", gridTemplateColumns: post.image_url ? "190px minmax(0,1fr)" : "1fr", gap: 18 }}>
    {post.image_url && <img src={post.image_url} alt="" style={{ width: "100%", height: 160, borderRadius: 12, objectFit: "cover", background: C.muted }} />}
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color, background: `${color}18`, borderRadius: 999, padding: "4px 10px", fontSize: 12, fontWeight: 700 }}>{STATUS[post.status]}</span>
        <span style={{ color: C.sub, fontSize: 12 }}>{KIND[post.kind] || post.kind} · версия {post.content_version}</span>
      </div>
      <h3 style={{ margin: "10px 0 6px", fontSize: 18 }}>{post.title}</h3>
      <p style={{ margin: 0, color: C.text, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{post.body}</p>
      {post.sources.length > 0 && <div style={{ marginTop: 8, color: C.sub, fontSize: 12 }}>Источники: {post.sources.length}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
        {post.status !== "published" && <button style={btnGhost} onClick={onEdit}>Редактировать</button>}
        {post.status !== "approved" && post.status !== "published" && <button style={btn} onClick={onApprove}>Одобрить</button>}
        {post.status === "approved" && <button style={{ ...btn, background: C.green }} onClick={onPublish}>Опубликовать</button>}
        {post.status !== "rejected" && post.status !== "published" && <button style={{ ...btnGhost, color: C.red }} onClick={onReject}>Отклонить</button>}
      </div>
    </div>
  </article>;
}

function Editor({ post, setPost, onClose, onSave }: { post: ChannelPost; setPost: (p: ChannelPost) => void; onClose: () => void; onSave: () => void }) {
  return <div style={{ position: "fixed", inset: 0, background: "rgba(17,24,39,.45)", display: "grid", placeItems: "center", zIndex: 50, padding: 16 }} onMouseDown={onClose}>
    <div style={{ ...card, width: "min(720px, 100%)", maxHeight: "90vh", overflowY: "auto" }} onMouseDown={(e) => e.stopPropagation()}>
      <h2 style={{ marginTop: 0 }}>Редактирование поста</h2>
      <label style={{ color: C.sub, fontSize: 13 }}>Заголовок<input style={input} value={post.title} onChange={(e) => setPost({ ...post, title: e.target.value })} /></label>
      <label style={{ color: C.sub, fontSize: 13, display: "block", marginTop: 12 }}>Текст<textarea style={{ ...input, minHeight: 190, resize: "vertical" }} value={post.body} onChange={(e) => setPost({ ...post, body: e.target.value })} /></label>
      <label style={{ color: C.sub, fontSize: 13, display: "block", marginTop: 12 }}>URL изображения<input style={input} value={post.image_url || ""} onChange={(e) => setPost({ ...post, image_url: e.target.value || null })} /></label>
      <label style={{ color: C.sub, fontSize: 13, display: "block", marginTop: 12 }}>Источники — по одному URL на строку<textarea style={{ ...input, minHeight: 80 }} value={post.sources.join("\n")} onChange={(e) => setPost({ ...post, sources: e.target.value.split("\n").map((v) => v.trim()).filter(Boolean) })} /></label>
      <p style={{ color: C.sub, fontSize: 12 }}>После изменения прежнее одобрение автоматически снимается.</p>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}><button style={btnGhost} onClick={onClose}>Отмена</button><button style={btn} onClick={onSave}>Сохранить черновик</button></div>
    </div>
  </div>;
}
