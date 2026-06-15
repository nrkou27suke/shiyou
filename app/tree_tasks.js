import React, { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { supabase } from "./supabaseClient";

/* =========================================================================
   枝葉（しよう）— 樹形図でやることを管理する
   葉＝タスク。木を育て、葉を締切順に摘む。予定への落とし込みは人間が。
   追加：テンプレ初期データ／気力タグ／くりかえし（もぐと生え直す）／
        出現日（この日まで封）／ゆっくり進める（急ぎじゃないが期日まで）／
        検索・絞り込み・進み具合・自動保存・使い方ポップアップ・アプリ表示対応
   ========================================================================= */

const WEEK = ["日","月","火","水","木","金","土"];
const startOfToday = () => { const d = new Date(); d.setHours(0,0,0,0); return d; };
const parseISO = (s) => { if (!s) return null; const d = new Date(s); return isNaN(d.getTime()) ? null : d; };
const fmtMD = (iso) => { const d = parseISO(iso); return d ? `${d.getMonth()+1}/${d.getDate()}（${WEEK[d.getDay()]}）` : ""; };
const shortMD = (iso) => { const d = parseISO(iso); return d ? `${d.getMonth()+1}/${d.getDate()}` : ""; };
const daysUntil = (iso) => { const d = parseISO(iso); if (!d) return null; const x = new Date(d); x.setHours(0,0,0,0); return Math.round((x.getTime() - startOfToday().getTime()) / 86400000); };
const isoPlus = (days, h = 9) => { const d = startOfToday(); d.setDate(d.getDate()+days); d.setHours(h,0,0,0); return d.toISOString(); };
const uid = () => `n_${Math.random().toString(36).slice(2, 9)}`;

const EN = { heavy: { jp: "重" }, normal: { jp: "普" }, light: { jp: "軽" } };
const UNIT_JP = { day: "日", week: "週", month: "月" };

const node = (title, o = {}) => ({
  id: uid(), title, deadline: o.deadline || null, deadlineNote: o.deadlineNote || null,
  done: false, scheduled: false, collapsed: o.collapsed || false, memo: o.memo || "", tags: o.tags || [],
  energy: o.energy || null, estimate: o.estimate || "", pace: o.pace || "normal", recur: o.recur || null, appearOn: o.appearOn || null,
  children: o.children || [],
});

function parseDeadline(text) {
  const t = (text || "").trim();
  if (!t) return { deadline: null, deadlineNote: null };
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return { deadline: new Date(+m[1], +m[2]-1, +m[3], 9).toISOString(), deadlineNote: null };
  m = t.match(/(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
  if (m) { const y = new Date().getFullYear(); let d = new Date(y, +m[1]-1, +m[2], 9); if (d.getTime() < startOfToday().getTime()) d = new Date(y+1, +m[1]-1, +m[2], 9); return { deadline: d.toISOString(), deadlineNote: null }; }
  return { deadline: null, deadlineNote: t };
}
function advance(iso, recur) {
  const base = parseISO(iso) || startOfToday();
  const d = new Date(base); const k = recur.every || 1;
  if (recur.unit === "day") d.setDate(d.getDate() + k);
  else if (recur.unit === "week") d.setDate(d.getDate() + 7*k);
  else if (recur.unit === "month") d.setMonth(d.getMonth() + k);
  return d.toISOString();
}
const isSealed = (n) => { const d = daysUntil(n.appearOn); return d != null && d > 0; };

const SEED = [
  node("仕事・プロジェクト", { children: [
    node("企画書を仕上げる", { children: [
      node("たたき台を書く", { energy: "heavy", estimate: "2時間" }),
      node("要点をレビュー依頼", { energy: "light" }),
    ]}),
  ]}),
  node("学業", { children: [
    node("毎週の課題を提出", { deadline: isoPlus(3), energy: "normal", estimate: "1時間", tags: ["課題"], recur: { every: 1, unit: "week" } }),
    node("期末レポート", { children: [
      node("参考文献の本を読む", { deadline: isoPlus(50), energy: "light", pace: "slow", memo: "時間がある時に少しずつ。学期末までに読み切る。" }),
      node("構成を考える", { energy: "normal" }),
    ]}),
  ]}),
  node("生活", { children: [
    node("部屋を片付ける", { energy: "light", recur: { every: 1, unit: "week" } }),
  ]}),
  node("夏休み", { appearOn: parseDeadline("8/1").deadline, collapsed: true, children: [
    node("行きたい場所を調べる"),
    node("読みたい本を選ぶ"),
  ]}),
  node("趣味"),
];

/* ---- 不変ツリー操作 ---- */
const mapNode = (ns, id, fn) => ns.map((n) => n.id === id ? fn(n) : { ...n, children: mapNode(n.children, id, fn) });
const removeNode = (ns, id) => ns.filter((n) => n.id !== id).map((n) => ({ ...n, children: removeNode(n.children, id) }));
const findNode = (ns, id) => { for (const n of ns) { if (n.id === id) return n; const r = findNode(n.children, id); if (r) return r; } return null; };
function addSiblingAfter(ns, id, fresh) { let done = false; const rec = (l) => { const i = l.findIndex((n) => n.id === id); if (i >= 0) { done = true; return [...l.slice(0, i+1), fresh, ...l.slice(i+1)]; } return l.map((n) => done ? n : { ...n, children: rec(n.children) }); }; return rec(ns); }
const addChild = (ns, id, fresh) => mapNode(ns, id, (n) => ({ ...n, collapsed: false, children: [...n.children, fresh] }));
function indentNode(ns, id) { let done = false; const rec = (l) => { if (!done) { const i = l.findIndex((n) => n.id === id); if (i > 0) { done = true; const nd = l[i]; const prev = { ...l[i-1], collapsed: false, children: [...l[i-1].children, nd] }; return [...l.slice(0, i-1), prev, ...l.slice(i+1)]; } } return l.map((n) => done ? n : { ...n, children: rec(n.children) }); }; return rec(ns); }
function outdentNode(ns, id) { let done = false; const rec = (l) => { for (let i = 0; i < l.length && !done; i++) { const p = l[i]; const ci = p.children.findIndex((c) => c.id === id); if (ci >= 0) { done = true; const nd = p.children[ci]; const np = { ...p, children: [...p.children.slice(0, ci), ...p.children.slice(ci+1)] }; return [...l.slice(0, i), np, nd, ...l.slice(i+1)]; } } return l.map((n) => done ? n : { ...n, children: rec(n.children) }); }; return rec(ns); }
function moveNode(ns, id, dir) { let done = false; const rec = (l) => { const i = l.findIndex((n) => n.id === id); if (i >= 0) { const j = i + dir; if (j < 0 || j >= l.length) { done = true; return l; } const c = [...l]; [c[i], c[j]] = [c[j], c[i]]; done = true; return c; } return l.map((n) => done ? n : { ...n, children: rec(n.children) }); }; return rec(ns); }
const flattenVisible = (ns, out = []) => { ns.forEach((n) => { out.push(n.id); if (!n.collapsed) flattenVisible(n.children, out); }); return out; };
function collectLeaves(ns, path = [], out = []) { ns.forEach((n) => { if (isSealed(n)) return; if (n.children.length === 0) out.push({ node: n, path }); else collectLeaves(n.children, [...path, n.title], out); }); return out; }
function leafStats(n) { if (isSealed(n)) return { total: 0, done: 0 }; if (n.children.length === 0) return { total: 1, done: n.done ? 1 : 0 }; let t = 0, d = 0; n.children.forEach((c) => { const s = leafStats(c); t += s.total; d += s.done; }); return { total: t, done: d }; }
const setAllCollapsed = (ns, v) => ns.map((n) => ({ ...n, collapsed: n.children.length ? v : n.collapsed, children: setAllCollapsed(n.children, v) }));
const allTags = (ns, set = new Set()) => { ns.forEach((n) => { (n.tags || []).forEach((t) => set.add(t)); allTags(n.children, set); }); return set; };

async function loadTree(userId) {
  try {
    const { data, error } = await supabase.from("trees").select("tree").eq("user_id", userId).maybeSingle();
    if (error) { console.error(error); return null; }
    return data ? data.tree : null;
  } catch (e) { console.error(e); return null; }
}
async function saveTree(userId, t) {
  try {
    await supabase.from("trees").upsert({ user_id: userId, tree: t, updated_at: new Date().toISOString() });
  } catch (e) { console.error(e); }
}

export default function TreeTasks() {
  const [session, setSession] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMode, setAuthMode] = useState("signin"); // signin | signup
  const [authMsg, setAuthMsg] = useState("");
  const [authSending, setAuthSending] = useState(false);
  const [tree, setTree] = useState(SEED);
  const [view, setView] = useState("tree");
  const [focusId, setFocusId] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [hideDone, setHideDone] = useState(false);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState(null);
  const [enFilter, setEnFilter] = useState(null);
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState("");
  const [loaded, setLoaded] = useState(false);
  const inputs = useRef({});
  const flash = (m) => { setToast(m); setTimeout(() => setToast(""), 2200); };

  // ログイン状態を監視
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthChecked(true); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); });
    return () => sub.subscription.unsubscribe();
  }, []);

  // ログインしたら、その人の木をクラウドから読み込む
  useEffect(() => {
    if (!session) { setLoaded(false); return; }
    (async () => {
      const t = await loadTree(session.user.id);
      if (t && Array.isArray(t) && t.length) setTree(t);
      else { setTree(SEED); await saveTree(session.user.id, SEED); }
      setLoaded(true);
    })();
  }, [session]);

  // 変更をクラウドへ保存（少し待ってまとめて保存）
  useEffect(() => {
    if (!loaded || !session) return;
    const id = setTimeout(() => { saveTree(session.user.id, tree); }, 600);
    return () => clearTimeout(id);
  }, [tree, loaded, session]);

  async function submitAuth() {
    const addr = email.trim();
    if (!addr || !password || authSending) return;
    if (password.length < 6) { setAuthMsg("パスワードは6文字以上にしてください。"); return; }
    setAuthSending(true); setAuthMsg("");
    if (authMode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email: addr, password });
      if (error) { setAuthMsg(error.message.includes("already") ? "このアドレスは登録済みです。「ログイン」に切り替えてください。" : "登録できませんでした。アドレスを確認してください。"); }
      else if (data.session) { /* 即ログイン成功（確認メールオフ時） */ }
      else { setAuthMsg("確認メールを送りました。メール内のリンクを押して登録を完了してください。"); }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: addr, password });
      if (error) setAuthMsg("ログインできませんでした。アドレスかパスワードを確認してください。");
    }
    setAuthSending(false);
  }
  async function signOut() { await supabase.auth.signOut(); setTree(SEED); setLoaded(false); }
  useEffect(() => { if (focusId && inputs.current[focusId]) { const el = inputs.current[focusId]; el.focus(); el.setSelectionRange(el.value.length, el.value.length); setFocusId(null); } }, [focusId, tree]);

  // 引き出しを外側クリックで閉じる（広い画面＝パソコンのみ。スマホは⋯で閉じる）
  useEffect(() => {
    if (!openId) return;
    const onDown = (e) => {
      if (window.innerWidth <= 560) return;
      const t = e.target;
      if (t.closest && (t.closest(".tt-drawer") || t.closest(".tt-more"))) return;
      setOpenId(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openId]);

  const visible = useMemo(() => flattenVisible(tree), [tree]);
  const onKey = useCallback((e, id) => {
    const el = e.target;
    if (e.key === "Enter") { e.preventDefault(); const f = node(""); setTree((t) => addSiblingAfter(t, id, f)); setFocusId(f.id); }
    else if (e.key === "Tab" && !e.shiftKey) { e.preventDefault(); setTree((t) => indentNode(t, id)); setFocusId(id); }
    else if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); setTree((t) => outdentNode(t, id)); setFocusId(id); }
    else if (e.key === "Backspace" && el.value === "") { e.preventDefault(); const i = visible.indexOf(id); const p = i > 0 ? visible[i-1] : null; setTree((t) => removeNode(t, id)); if (p) setFocusId(p); }
    else if (e.key === "ArrowUp") { e.preventDefault(); const i = visible.indexOf(id); if (i > 0) setFocusId(visible[i-1]); }
    else if (e.key === "ArrowDown") { e.preventDefault(); const i = visible.indexOf(id); if (i < visible.length-1) setFocusId(visible[i+1]); }
  }, [visible]);

  const setTitle = (id, title) => setTree((t) => mapNode(t, id, (n) => ({ ...n, title })));
  const setMemo = (id, memo) => setTree((t) => mapNode(t, id, (n) => ({ ...n, memo })));
  const setEnergy = (id, v) => setTree((t) => mapNode(t, id, (n) => ({ ...n, energy: v })));
  const setEstimate = (id, v) => setTree((t) => mapNode(t, id, (n) => ({ ...n, estimate: v })));
  const setPace = (id, v) => setTree((t) => mapNode(t, id, (n) => ({ ...n, pace: v })));
  const setRecur = (id, r) => setTree((t) => mapNode(t, id, (n) => ({ ...n, recur: r })));
  const setAppear = (id, text) => { const { deadline } = parseDeadline(text); setTree((t) => mapNode(t, id, (n) => ({ ...n, appearOn: deadline }))); };
  const toggleCollapse = (id) => setTree((t) => mapNode(t, id, (n) => ({ ...n, collapsed: !n.collapsed })));
  const toggleScheduled = (id) => setTree((t) => mapNode(t, id, (n) => ({ ...n, scheduled: !n.scheduled })));
  const toggleDone = (id) => {
    const n = findNode(tree, id);
    if (n && n.recur && !n.done) { const next = advance(n.deadline, n.recur); setTree((t) => mapNode(t, id, (x) => ({ ...x, deadline: next, done: false, scheduled: false }))); flash(`「${n.title || "タスク"}」完了。次は ${shortMD(next)}`); }
    else setTree((t) => mapNode(t, id, (x) => ({ ...x, done: !x.done })));
  };
  const addChildTo = (id) => { const f = node(""); setTree((t) => addChild(t, id, f)); setFocusId(f.id); };
  const del = (id) => { setTree((t) => removeNode(t, id)); if (openId === id) setOpenId(null); };
  const commitDeadline = (id, text) => setTree((t) => mapNode(t, id, (n) => ({ ...n, ...parseDeadline(text) })));
  const addTag = (id, tag) => { const v = tag.trim(); if (!v) return; setTree((t) => mapNode(t, id, (n) => ({ ...n, tags: n.tags.includes(v) ? n.tags : [...n.tags, v] }))); };
  const rmTag = (id, tag) => setTree((t) => mapNode(t, id, (n) => ({ ...n, tags: n.tags.filter((x) => x !== tag) })));
  const addRoot = () => { const f = node(""); setTree((t) => [...t, f]); setFocusId(f.id); };
  const move = (id, dir) => setTree((t) => moveNode(t, id, dir));
  const indent = (id) => setTree((t) => indentNode(t, id));
  const outdent = (id) => setTree((t) => outdentNode(t, id));

  const tagsList = useMemo(() => [...allTags(tree)], [tree]);

  const Drawer = ({ n }) => (
    <div className="tt-drawer">
      <div className="tt-drawer-acts">
        <button onClick={() => move(n.id, -1)}>↑ 上へ</button>
        <button onClick={() => move(n.id, 1)}>↓ 下へ</button>
        <button onClick={() => outdent(n.id)}>⤴ 上げる</button>
        <button onClick={() => indent(n.id)}>⤵ 下げる</button>
        <button onClick={() => addChildTo(n.id)}>＋ 子</button>
        <button className="tt-drawer-del" onClick={() => del(n.id)}>🗑 削除</button>
      </div>
      <div className="tt-drawer-field">
        <label>{n.pace === "slow" ? "目標日（この日までに）" : "期限"}</label>
        <input defaultValue={n.deadline ? shortMD(n.deadline) : (n.deadlineNote || "")} placeholder="6/14 ／ できるだけ早く"
          onBlur={(e) => commitDeadline(n.id, e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitDeadline(n.id, e.target.value); e.target.blur(); } }} />
      </div>
      <div className="tt-drawer-field">
        <label>気力</label>
        <div className="tt-energy">
          {[["heavy","重い"],["normal","ふつう"],["light","軽い"]].map(([v,l]) => (
            <button key={v} className={`tt-en-btn tt-en-btn--${v}${n.energy===v?" on":""}`} onClick={() => setEnergy(n.id, n.energy===v?null:v)}>{l}</button>
          ))}
        </div>
      </div>
      <div className="tt-drawer-field">
        <label>所要時間</label>
        <input defaultValue={n.estimate || ""} placeholder="30分 ／ 2時間 など"
          onBlur={(e) => setEstimate(n.id, e.target.value.trim())}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setEstimate(n.id, e.target.value.trim()); e.target.blur(); } }} />
      </div>
      <div className="tt-drawer-field">
        <label className="tt-pace"><input type="checkbox" checked={n.pace === "slow"} onChange={(e) => setPace(n.id, e.target.checked ? "slow" : "normal")} /> ゆっくり進める（急ぎではない・期日まで少しずつ）</label>
      </div>
      <div className="tt-drawer-field">
        <label>くりかえし</label>
        <div className="tt-recur">
          <label className="tt-recur-on"><input type="checkbox" checked={!!n.recur} onChange={(e) => setRecur(n.id, e.target.checked ? { every: 1, unit: "week" } : null)} /> くりかえす</label>
          {n.recur && <>
            <input className="tt-recur-num" type="number" min="1" value={n.recur.every} onChange={(e) => setRecur(n.id, { ...n.recur, every: Math.max(1, +e.target.value || 1) })} />
            <select className="tt-recur-unit" value={n.recur.unit} onChange={(e) => setRecur(n.id, { ...n.recur, unit: e.target.value })}>
              <option value="day">日ごと</option><option value="week">週ごと</option><option value="month">月ごと</option>
            </select>
          </>}
        </div>
        {n.recur && <div className="tt-hint-sm">完了するたび、次の期限へ自動で生え直します。</div>}
      </div>
      <div className="tt-drawer-field">
        <label>出現日（この日まで隠す）</label>
        <input defaultValue={n.appearOn ? shortMD(n.appearOn) : ""} placeholder="8/1（空なら常に表示）"
          onBlur={(e) => setAppear(n.id, e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setAppear(n.id, e.target.value); e.target.blur(); } }} />
      </div>
      <div className="tt-drawer-field">
        <label>メモ</label>
        <textarea rows={2} value={n.memo} placeholder="このタスクの中身・気をつけること" onChange={(e) => setMemo(n.id, e.target.value)} />
      </div>
      <div className="tt-drawer-field">
        <label>タグ</label>
        <div className="tt-tag-edit">
          {n.tags.map((t) => <span className="tt-tag tt-tag--edit" key={t}>{t}<button onClick={() => rmTag(n.id, t)}>×</button></span>)}
          <input placeholder="+ タグを追加" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(n.id, e.target.value); e.target.value = ""; } }} />
        </div>
      </div>
    </div>
  );

  const renderNode = (n) => {
    const isLeaf = n.children.length === 0;
    if (hideDone && isLeaf && n.done) return null;
    const future = isSealed(n);
    const dd = daysUntil(n.deadline);
    const st = !isLeaf ? leafStats(n) : null;
    return (
      <div className="tt-node" key={n.id}>
        <div className={`tt-row${n.done ? " done" : ""}${!n.done && n.scheduled ? " scheduled" : ""}${future ? " future" : ""}${openId === n.id ? " open" : ""}`}>
          {isLeaf ? <span className="tt-leaf" title="タスク（葉）" /> :
            <button className="tt-tw" onClick={() => toggleCollapse(n.id)} aria-label={n.collapsed ? "開く" : "閉じる"}>{n.collapsed ? "▸" : "▾"}</button>}
          {isLeaf && <button className={`tt-done${n.done ? " on" : ""}`} onClick={() => toggleDone(n.id)} aria-label="完了にする">{n.done ? "✓" : ""}</button>}
          {isLeaf && <button className={`tt-sched${n.scheduled ? " on" : ""}`} onClick={() => toggleScheduled(n.id)} aria-label={n.scheduled ? "予定済みを取り消す" : "予定に入れた"} title={n.scheduled ? "予定済み" : "カレンダーに入れたら押す"}>📅</button>}
          <input ref={(el) => { if (el) inputs.current[n.id] = el; }}
            className={`tt-title${isLeaf ? " leaf" : " branch"}`} value={n.title}
            placeholder={isLeaf ? "タスク名" : "目標名"}
            onChange={(e) => setTitle(n.id, e.target.value)} onKeyDown={(e) => onKey(e, n.id)} />
          {future && <span className="tt-future-when" title="この日から通常表示になります">{shortMD(n.appearOn)}に出現</span>}
          {isLeaf && n.energy && <span className={`tt-en tt-en--${n.energy}`} title={`気力 ${EN[n.energy].jp}`}>{EN[n.energy].jp}</span>}
          {isLeaf && n.estimate && <span className="tt-est" title={`所要 ${n.estimate}`}>⏱{n.estimate}</span>}
          {n.recur && <span className="tt-rc" title="くりかえし">↻{n.recur.every > 1 ? n.recur.every : ""}{UNIT_JP[n.recur.unit]}</span>}
          {n.pace === "slow" && <span className="tt-slow-chip">ゆっくり</span>}
          {n.tags.length > 0 && <span className="tt-tags">{n.tags.map((t) => <span className="tt-tag" key={t}>{t}</span>)}</span>}
          {(n.deadline || n.deadlineNote) && (
            <span className={`tt-dl${dd != null && dd <= 3 && n.pace !== "slow" ? " soon" : ""}`} onClick={() => setOpenId(openId === n.id ? null : n.id)}>
              {n.deadline ? shortMD(n.deadline) : n.deadlineNote}
              {dd != null && <span className="tt-dl-rel">{dd < 0 ? `${-dd}日超過` : dd === 0 ? "今日" : `あと${dd}`}</span>}
            </span>
          )}
          {n.memo && <span className="tt-memo-dot" title="メモあり" onClick={() => setOpenId(openId === n.id ? null : n.id)} />}
          {st && st.total > 0 && (
            <span className="tt-prog" title={`${st.done}/${st.total} 完了`}>
              <span className="tt-prog-bar"><span className="tt-prog-fill" style={{ width: `${st.total ? (st.done/st.total*100) : 0}%` }} /></span>
              <span className="tt-prog-n">{st.done}/{st.total}</span>
            </span>
          )}
          <button className={`tt-more${openId === n.id ? " on" : ""}`} onClick={() => setOpenId(openId === n.id ? null : n.id)} aria-label="操作・設定">⋯</button>
        </div>
        {openId === n.id && <Drawer n={n} />}
        {!n.collapsed && n.children.length > 0 && <div className="tt-children">{n.children.map(renderNode)}</div>}
      </div>
    );
  };

  /* ---- 締切順ビュー ---- */
  const leaves = useMemo(() => collectLeaves(tree), [tree]);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return leaves.filter((l) => {
      if (hideDone && l.node.done) return false;
      if (tagFilter && !l.node.tags.includes(tagFilter)) return false;
      if (enFilter && l.node.energy !== enFilter) return false;
      if (q) { const hay = (l.node.title + " " + l.node.memo + " " + l.node.tags.join(" ") + " " + l.path.join(" ")).toLowerCase(); if (!hay.includes(q)) return false; }
      return true;
    });
  }, [leaves, query, tagFilter, enFilter, hideDone]);
  const dated = filtered.filter((l) => l.node.deadline && l.node.pace !== "slow").sort((a, b) => ((a.node.scheduled?1:0) - (b.node.scheduled?1:0)) || (parseISO(a.node.deadline) - parseISO(b.node.deadline)));
  const slow = filtered.filter((l) => l.node.deadline && l.node.pace === "slow").sort((a, b) => parseISO(a.node.deadline) - parseISO(b.node.deadline));
  const noted = filtered.filter((l) => !l.node.deadline && l.node.deadlineNote);
  const none = filtered.filter((l) => !l.node.deadline && !l.node.deadlineNote && l.node.title.trim() !== "");

  const LeafRow = ({ l }) => {
    const n = l.node; const dd = daysUntil(n.deadline); const slowMode = n.pace === "slow";
    return (
      <div className={`tt-leafrow${n.done ? " done" : ""}${!n.done && n.scheduled ? " scheduled" : ""}`}>
        <button className={`tt-done${n.done ? " on" : ""}`} onClick={() => toggleDone(n.id)} aria-label="完了にする">{n.done ? "✓" : ""}</button>
        <button className={`tt-sched${n.scheduled ? " on" : ""}`} onClick={() => toggleScheduled(n.id)} title={n.scheduled ? "予定済み" : "カレンダーに入れたら押す"} aria-label={n.scheduled ? "予定済みを取り消す" : "予定に入れた"}>📅</button>
        <div className="tt-leafrow-main">
          <div className="tt-leafrow-title">
            {n.title || "（無題）"}
            {n.energy && <span className={`tt-en tt-en--${n.energy}`}>{EN[n.energy].jp}</span>}
            {n.estimate && <span className="tt-est">⏱{n.estimate}</span>}
            {n.recur && <span className="tt-rc">↻{n.recur.every > 1 ? n.recur.every : ""}{UNIT_JP[n.recur.unit]}</span>}
            {n.scheduled && !n.done && <span className="tt-sched-badge">予定済み</span>}
            {n.tags.map((t) => <span className="tt-tag" key={t}>{t}</span>)}
          </div>
          {l.path.length > 0 && <div className="tt-leafrow-path">{l.path.join(" › ")}</div>}
          {n.memo && <div className="tt-leafrow-memo">{n.memo}</div>}
        </div>
        {n.deadline ? (
          <div className={`tt-leafrow-dl${dd != null && dd <= (slowMode ? 7 : 3) ? " soon" : ""}${slowMode ? " slow" : ""}`}>
            <span className="tt-leafrow-date">{slowMode ? "目標 " : ""}{fmtMD(n.deadline)}</span>
            {dd != null && <span className="tt-leafrow-rel">{dd < 0 ? `${-dd}日超過` : dd === 0 ? "今日" : `あと${dd}日`}</span>}
          </div>
        ) : n.deadlineNote ? <div className="tt-leafrow-note">{n.deadlineNote}</div> : null}
      </div>
    );
  };

  if (!authChecked) {
    return (<div className="tt-root"><style>{css}</style><div className="tt-auth"><div className="tt-auth-card"><div className="tt-auth-logo"><span className="tt-leaf-mark" />枝葉</div><p className="tt-auth-sub">読み込み中…</p></div></div></div>);
  }
  if (!session) {
    return (
      <div className="tt-root">
        <style>{css}</style>
        <div className="tt-auth">
          <div className="tt-auth-card">
            <div className="tt-auth-logo"><span className="tt-leaf-mark" />枝葉<span className="tt-auth-read">しよう</span></div>
            <p className="tt-auth-sub">{authMode === "signup" ? "メールアドレスとパスワードを決めて、登録してください。どの端末でも、同じ木が開きます。" : "メールアドレスとパスワードでログインしてください。"}</p>
            <div className="tt-auth-tabs">
              <button className={authMode === "signin" ? "on" : ""} onClick={() => { setAuthMode("signin"); setAuthMsg(""); }}>ログイン</button>
              <button className={authMode === "signup" ? "on" : ""} onClick={() => { setAuthMode("signup"); setAuthMsg(""); }}>新規登録</button>
            </div>
            <input className="tt-auth-input" type="email" value={email} placeholder="you@example.com" autoComplete="email"
              onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitAuth(); }} />
            <input className="tt-auth-input" type="password" value={password} placeholder="パスワード（6文字以上）" autoComplete={authMode === "signup" ? "new-password" : "current-password"}
              onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submitAuth(); }} />
            <button className="tt-auth-btn" onClick={submitAuth} disabled={authSending}>{authSending ? "処理中…" : authMode === "signup" ? "登録してはじめる" : "ログイン"}</button>
            {authMsg && <p className="tt-auth-msg">{authMsg}</p>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="tt-root">
      <style>{css}</style>
      {toast && <div className="tt-toast">{toast}</div>}

      <header className="tt-head">
        <div className="tt-brand">
          <span className="tt-logo"><span className="tt-leaf-mark" />枝葉</span>
          <span className="tt-logo-read">しよう</span>
        </div>
        <div className="tt-head-btns">
          <button className="tt-help" onClick={() => setHelp(true)} aria-label="使い方を見る">？</button>
          <button className="tt-signout" onClick={signOut} aria-label="ログアウト">ログアウト</button>
        </div>
      </header>

      <div className="tt-bar">
        <div className="tt-toggle">
          <button className={view === "tree" ? "on" : ""} onClick={() => setView("tree")}>ツリー</button>
          <button className={view === "due" ? "on" : ""} onClick={() => setView("due")}>締切順</button>
        </div>
        <div className="tt-bar-actions">
          <button className={`tt-chip-btn${hideDone ? " on" : ""}`} onClick={() => setHideDone((v) => !v)}>完了を隠す</button>
          {view === "tree" && <>
            <button className="tt-chip-btn" onClick={() => setTree((t) => setAllCollapsed(t, true))}>すべて閉じる</button>
            <button className="tt-chip-btn" onClick={() => setTree((t) => setAllCollapsed(t, false))}>すべて開く</button>
          </>}
        </div>
      </div>

      {view === "tree" ? (
        <div className="tt-tree">
          {tree.map(renderNode)}
          <button className="tt-addroot" onClick={addRoot}>＋ 大きな目標を追加</button>
        </div>
      ) : (
        <div className="tt-due">
          <div className="tt-search">
            <input className="tt-search-input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="葉を検索（名前・メモ・タグ・場所）" />
            <div className="tt-filters">
              <div className="tt-enfilter">
                {[["heavy","重い"],["normal","ふつう"],["light","軽い"]].map(([v,l]) => (
                  <button key={v} className={`tt-tf${enFilter===v?" on":""}`} onClick={() => setEnFilter(enFilter===v?null:v)}>{l}</button>
                ))}
              </div>
              {tagsList.length > 0 && <div className="tt-tagfilter">{tagsList.map((t) => <button key={t} className={`tt-tf${tagFilter === t ? " on" : ""}`} onClick={() => setTagFilter(tagFilter === t ? null : t)}>#{t}</button>)}</div>}
            </div>
          </div>
          {dated.length === 0 && slow.length === 0 && noted.length === 0 && none.length === 0 && (
            <div className="tt-due-empty">{query || tagFilter || enFilter ? "条件に合う葉がありません。" : "まだ葉（タスク）がありません。ツリーで末端を作ると、ここに締切順で並びます。"}</div>
          )}
          {dated.length > 0 && <div className="tt-due-group"><div className="tt-due-cap">締切順</div>{dated.map((l) => <LeafRow key={l.node.id} l={l} />)}</div>}
          {slow.length > 0 && <div className="tt-due-group tt-due-group--slow"><div className="tt-due-cap">ゆっくり進める（急ぎではないが、この日までに）</div>{slow.map((l) => <LeafRow key={l.node.id} l={l} />)}</div>}
          {noted.length > 0 && <div className="tt-due-group"><div className="tt-due-cap">日付未定（急ぎ含む）</div>{noted.map((l) => <LeafRow key={l.node.id} l={l} />)}</div>}
          {none.length > 0 && <div className="tt-due-group tt-due-group--quiet"><div className="tt-due-cap">締切なし</div>{none.map((l) => <LeafRow key={l.node.id} l={l} />)}</div>}
          {(dated.length > 0 || slow.length > 0) && <p className="tt-tip">この順で見て、いつやるかは自分でカレンダーに落としてください。</p>}
        </div>
      )}

      {help && (
        <div className="tt-modal" onClick={() => setHelp(false)}>
          <div className="tt-modal-card" onClick={(e) => e.stopPropagation()}>
            <h2 className="tt-modal-title"><span className="tt-leaf-mark" />枝葉の使い方</h2>
            <p className="tt-modal-sub">大きな目標から、末端のタスクまで。葉が、実際にやること。</p>
            <div className="tt-modal-list">
              <div className="tt-modal-item"><span className="tt-modal-ic">＋</span><div><b>木を作る</b><br/>「大きな目標を追加」から枝を生やし、その先に葉（タスク）を付けます。緑の葉印が付いた末端が、実際に手を動かすもの。</div></div>
              <div className="tt-modal-item"><span className="tt-modal-ic">⋯</span><div><b>整える・設定する</b><br/>各行の ⋯ から、移動・階層の上げ下げ・期限・<b>気力（重い/ふつう/軽い）</b>・<b>くりかえし</b>・<b>出現日</b>・メモ・タグ・削除。</div></div>
              <div className="tt-modal-item"><span className="tt-modal-ic">↻</span><div><b>くりかえし</b><br/>毎週の課題などに。完了する（葉をもぐ）たびに、次の期限の葉へ自動で生え直します。</div></div>
              <div className="tt-modal-item"><span className="tt-modal-ic">🌗</span><div><b>出現日</b><br/>「8/1」と入れると、その日まで薄く表示され、当日から通常表示に。隠さないので、いつでも中身を編集できます（夏休みなど）。</div></div>
              <div className="tt-modal-item"><span className="tt-modal-ic">🌱</span><div><b>ゆっくり進める</b><br/>急ぎではないが期日までに少しずつ進めたいもの。締切リストとは分けて、残り日数つきで並びます。</div></div>
              <div className="tt-modal-item"><span className="tt-modal-ic">✓</span><div><b>進める</b><br/>葉のチェックで完了。📅 はカレンダーに入れたら押す印。「予定に入れたが、まだやっていない」を区別できます。</div></div>
              <div className="tt-modal-item"><span className="tt-modal-ic">⇅</span><div><b>締切順で見る</b><br/>「締切順」タブで葉だけを締切順に。検索・気力・タグで絞り込めます。予定に落とすのは、あなたが。</div></div>
              <div className="tt-modal-item"><span className="tt-modal-ic">⤓</span><div><b>保存とアプリ化</b><br/>変更はこの端末に自動保存。Web公開後はブラウザの「ホーム画面に追加」で、アプリのように全画面で使えます。</div></div>
            </div>
            <button className="tt-modal-close" onClick={() => setHelp(false)}>はじめる</button>
          </div>
        </div>
      )}
    </div>
  );
}

const css = `
:root{
  --paper:#ECEEEA; --surface:#FBFCF9; --ink:#232622; --muted:#888E84; --line:#DDE1D8;
  --leaf:#5B8456; --leaf-soft:rgba(91,132,86,.14); --soon:#B4623A; --branch:#A9AFA4; --branch-line:#9A7B5A;
  --slow:#4A7A86; --slow-soft:rgba(74,122,134,.12);
  --w-heavy:#2B302E; --w-normal:#7C857F; --w-light:#C2C8C2;
}
.tt-root{ font-family:'Hiragino Sans','Noto Sans JP',system-ui,-apple-system,sans-serif; color:var(--ink); background:var(--paper); padding:28px 20px 46px; border-radius:18px; -webkit-font-smoothing:antialiased; max-width:720px; margin:0 auto; position:relative; }
.tt-toast{ position:sticky; top:8px; z-index:30; margin:0 auto 10px; width:max-content; max-width:90%; background:var(--leaf); color:#fff; font-size:12.5px; padding:8px 16px; border-radius:999px; box-shadow:0 4px 14px rgba(91,132,86,.3); }

.tt-head{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:18px; }
.tt-brand{ display:flex; align-items:baseline; gap:9px; }
.tt-logo{ display:inline-flex; align-items:center; gap:9px; font-size:25px; font-weight:800; letter-spacing:.05em; color:var(--ink); }
.tt-leaf-mark{ width:13px; height:13px; border-radius:0 50% 50% 50%; background:var(--leaf); transform:rotate(45deg); display:inline-block; }
.tt-logo-read{ font-family:ui-monospace,monospace; font-size:11px; letter-spacing:.22em; color:var(--muted); }
.tt-help{ flex:0 0 auto; width:32px; height:32px; border:1px solid var(--line); background:var(--surface); color:var(--muted); border-radius:50%; cursor:pointer; font-size:14px; line-height:1; }
.tt-help:hover{ border-color:var(--leaf); color:var(--leaf); }

.tt-bar{ display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; margin-bottom:14px; }
.tt-toggle{ display:inline-flex; border:1px solid var(--line); border-radius:11px; overflow:hidden; background:var(--surface); }
.tt-toggle button{ border:0; background:transparent; color:var(--muted); padding:9px 22px; font-size:13.5px; cursor:pointer; font-family:inherit; }
.tt-toggle button.on{ background:var(--ink); color:#fff; font-weight:600; }
.tt-bar-actions{ display:flex; flex-wrap:wrap; gap:6px; }
.tt-chip-btn{ border:1px solid var(--line); background:var(--surface); color:var(--muted); border-radius:9px; padding:7px 12px; font-size:12px; cursor:pointer; font-family:inherit; }
.tt-chip-btn:hover{ border-color:var(--leaf); color:var(--ink); }
.tt-chip-btn.on{ background:var(--leaf-soft); border-color:var(--leaf); color:var(--leaf); }

.tt-tree{ background:var(--surface); border:1px solid var(--line); border-radius:15px; padding:12px 14px; }
.tt-children{ position:relative; margin-left:11px; padding-left:21px; }
.tt-node{ position:relative; }
/* 親から子へ伸びる枝（縦の幹）。太さ2.5px */
.tt-children > .tt-node::before{ content:""; position:absolute; left:-10px; top:0; bottom:0; width:2.5px; background:var(--branch-line); }
/* 最後の子は、枝の終わり（└）にするため幹をエルボーまでで止める */
.tt-children > .tt-node:last-child::before{ bottom:auto; height:18px; }
/* 幹から各行へ伸びる横枝（エルボー）。終点をマーク中央(左から約11px)に合わせる */
.tt-children > .tt-node::after{ content:""; position:absolute; left:-10px; top:18px; width:24px; height:2.5px; background:var(--branch-line); }
.tt-row{ position:relative; z-index:1; display:flex; align-items:center; gap:6px; padding:3px 0; border-radius:8px; }
.tt-row.open{ background:var(--leaf-soft); }
.tt-row.done{ opacity:.5; }
.tt-row.future{ opacity:.5; }
.tt-row.future:hover, .tt-row.future.open{ opacity:1; }
.tt-future-when{ flex:0 0 auto; font-family:ui-monospace,monospace; font-size:10px; color:var(--slow); border:1px solid var(--line); border-radius:999px; padding:2px 8px; white-space:nowrap; }
.tt-tw{ flex:0 0 auto; width:22px; height:22px; border:0; background:transparent; color:var(--branch); cursor:pointer; font-size:11px; padding:0; border-radius:6px; }
.tt-tw:hover{ background:var(--paper); }
.tt-leaf{ flex:0 0 auto; width:9px; height:9px; margin:0 6px; border-radius:0 50% 50% 50%; background:var(--leaf); transform:rotate(45deg); }
.tt-done{ flex:0 0 auto; width:24px; height:24px; border:1.5px solid var(--line); border-radius:7px; background:var(--paper); cursor:pointer; color:var(--leaf); font-size:12px; display:flex; align-items:center; justify-content:center; }
.tt-done.on{ border-color:var(--leaf); background:var(--leaf-soft); }
.tt-sched{ flex:0 0 auto; width:24px; height:24px; border:1.5px solid var(--line); border-radius:7px; background:var(--paper); cursor:pointer; font-size:11px; line-height:1; display:flex; align-items:center; justify-content:center; filter:grayscale(1) opacity(.55); }
.tt-sched:hover{ border-color:var(--leaf); filter:grayscale(.3) opacity(.85); }
.tt-sched.on{ border-color:var(--leaf); background:var(--leaf-soft); filter:none; }
.tt-row.scheduled .tt-title{ color:var(--muted); }
.tt-sched-badge{ font-size:10px; color:var(--leaf); background:var(--leaf-soft); border-radius:999px; padding:2px 8px; white-space:nowrap; }
.tt-leafrow.scheduled{ opacity:.66; }
.tt-title{ flex:1; min-width:50px; border:0; background:transparent; font-family:inherit; color:var(--ink); padding:7px 4px; font-size:14px; border-radius:6px; }
.tt-title.branch{ font-weight:700; }
.tt-title:focus{ outline:none; background:var(--leaf-soft); }
.tt-row.done .tt-title{ text-decoration:line-through; }

.tt-en{ flex:0 0 auto; width:18px; height:18px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:10px; font-weight:700; font-family:ui-monospace,monospace; }
.tt-en--heavy{ background:var(--w-heavy); color:#fff; }
.tt-en--normal{ background:var(--w-normal); color:#fff; }
.tt-en--light{ background:transparent; border:1.5px solid var(--w-light); color:var(--muted); }
.tt-rc{ flex:0 0 auto; font-family:ui-monospace,monospace; font-size:10px; color:var(--leaf); background:var(--leaf-soft); border-radius:999px; padding:2px 7px; white-space:nowrap; }
.tt-est{ flex:0 0 auto; font-family:ui-monospace,monospace; font-size:10px; color:var(--muted); background:var(--paper); border:1px solid var(--line); border-radius:999px; padding:2px 7px; white-space:nowrap; }
.tt-slow-chip{ flex:0 0 auto; font-size:10px; color:var(--slow); background:var(--slow-soft); border-radius:999px; padding:2px 8px; white-space:nowrap; }

.tt-tags{ display:inline-flex; gap:4px; flex:0 1 auto; flex-wrap:wrap; }
.tt-tag{ font-size:10px; color:var(--leaf); background:var(--leaf-soft); border-radius:999px; padding:2px 8px; white-space:nowrap; }
.tt-dl{ flex:0 0 auto; display:inline-flex; align-items:center; gap:5px; font-family:ui-monospace,monospace; font-size:11px; color:var(--ink); border:1px solid var(--line); background:var(--paper); border-radius:999px; padding:3px 10px; cursor:pointer; }
.tt-dl.soon{ border-color:var(--soon); color:var(--soon); }
.tt-dl-rel{ font-size:10px; color:var(--muted); } .tt-dl.soon .tt-dl-rel{ color:var(--soon); }
.tt-memo-dot{ flex:0 0 auto; width:6px; height:6px; border-radius:50%; background:var(--branch); cursor:pointer; }

.tt-prog{ flex:0 0 auto; display:inline-flex; align-items:center; gap:6px; }
.tt-prog-bar{ width:42px; height:5px; background:var(--line); border-radius:3px; overflow:hidden; }
.tt-prog-fill{ display:block; height:100%; background:var(--leaf); border-radius:3px; transition:width .3s; }
.tt-prog-n{ font-family:ui-monospace,monospace; font-size:10px; color:var(--muted); }

.tt-more{ flex:0 0 auto; width:28px; height:28px; border:0; background:transparent; color:var(--muted); cursor:pointer; font-size:17px; border-radius:7px; line-height:1; }
.tt-more:hover, .tt-more.on{ background:var(--paper); color:var(--ink); }

.tt-drawer{ margin:2px 0 8px 28px; background:var(--paper); border:1px solid var(--line); border-radius:11px; padding:11px 12px; display:flex; flex-direction:column; gap:10px; }
.tt-drawer-acts{ display:flex; flex-wrap:wrap; gap:6px; }
.tt-drawer-acts button{ border:1px solid var(--line); background:var(--surface); color:var(--ink); border-radius:8px; padding:7px 12px; font-size:12.5px; cursor:pointer; font-family:inherit; }
.tt-drawer-acts button:hover{ border-color:var(--leaf); }
.tt-drawer-del{ color:var(--soon)!important; }
.tt-drawer-field{ display:flex; flex-direction:column; gap:6px; }
.tt-drawer-field > label{ font-family:ui-monospace,monospace; font-size:10px; letter-spacing:.1em; color:var(--muted); }
.tt-drawer-field input[type=text], .tt-drawer-field > input, .tt-drawer-field textarea{ border:1px solid var(--line); background:var(--surface); border-radius:8px; padding:8px 10px; font-size:13px; font-family:inherit; color:var(--ink); resize:vertical; }
.tt-drawer-field > input:focus, .tt-drawer-field textarea:focus{ outline:2px solid var(--leaf-soft); border-color:var(--leaf); }
.tt-energy{ display:flex; gap:6px; }
.tt-en-btn{ flex:1; border:1px solid var(--line); background:var(--surface); color:var(--ink); border-radius:8px; padding:8px; font-size:12.5px; cursor:pointer; font-family:inherit; }
.tt-en-btn.on{ border-color:var(--leaf); background:var(--leaf-soft); font-weight:700; }
.tt-pace{ display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--ink); cursor:pointer; }
.tt-pace input{ width:16px; height:16px; accent-color:var(--slow); }
.tt-recur{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.tt-recur-on{ display:flex; align-items:center; gap:7px; font-size:12.5px; cursor:pointer; }
.tt-recur-on input{ width:16px; height:16px; accent-color:var(--leaf); }
.tt-recur-num{ width:54px; border:1px solid var(--line); background:var(--surface); border-radius:8px; padding:7px; font-size:13px; font-family:inherit; }
.tt-recur-unit{ border:1px solid var(--line); background:var(--surface); border-radius:8px; padding:7px; font-size:13px; font-family:inherit; }
.tt-hint-sm{ font-size:11px; color:var(--muted); line-height:1.5; }
.tt-tag-edit{ display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
.tt-tag--edit{ display:inline-flex; align-items:center; gap:4px; padding:3px 4px 3px 10px; }
.tt-tag--edit button{ border:0; background:transparent; color:var(--leaf); cursor:pointer; font-size:13px; line-height:1; padding:0 2px; }
.tt-tag-edit input{ border:1px dashed var(--line); background:transparent; border-radius:999px; padding:4px 10px; font-size:11px; font-family:inherit; min-width:110px; }

.tt-addroot{ margin-top:8px; border:1px dashed var(--line); background:transparent; color:var(--muted); border-radius:10px; padding:10px 14px; font-size:13px; cursor:pointer; width:100%; font-family:inherit; }
.tt-addroot:hover{ border-color:var(--leaf); color:var(--leaf); }
.tt-tip{ font-size:11.5px; color:var(--muted); line-height:1.8; margin:14px 2px 0; }

.tt-due{ display:flex; flex-direction:column; gap:16px; }
.tt-search{ display:flex; flex-direction:column; gap:9px; }
.tt-search-input{ width:100%; box-sizing:border-box; border:1px solid var(--line); background:var(--surface); border-radius:11px; padding:11px 14px; font-size:14px; font-family:inherit; color:var(--ink); }
.tt-search-input:focus{ outline:2px solid var(--leaf-soft); border-color:var(--leaf); }
.tt-filters{ display:flex; flex-wrap:wrap; gap:10px; }
.tt-enfilter, .tt-tagfilter{ display:flex; flex-wrap:wrap; gap:6px; }
.tt-tf{ border:1px solid var(--line); background:var(--surface); color:var(--muted); border-radius:999px; padding:5px 12px; font-size:12px; cursor:pointer; font-family:inherit; }
.tt-tf.on{ background:var(--leaf-soft); border-color:var(--leaf); color:var(--leaf); }
.tt-due-empty{ background:var(--surface); border:1px dashed var(--line); border-radius:13px; padding:34px 16px; text-align:center; color:var(--muted); font-size:13.5px; line-height:1.8; }
.tt-due-group{ background:var(--surface); border:1px solid var(--line); border-radius:14px; padding:6px 16px; }
.tt-due-group--quiet{ opacity:.72; }
.tt-due-group--slow{ border-color:var(--slow-soft); background:linear-gradient(0deg,var(--slow-soft),var(--slow-soft)),var(--surface); }
.tt-due-cap{ font-family:ui-monospace,monospace; font-size:10px; letter-spacing:.12em; color:var(--muted); padding:12px 0 6px; }
.tt-due-group--slow .tt-due-cap{ color:var(--slow); }
.tt-leafrow{ display:flex; align-items:flex-start; gap:9px; padding:11px 0; border-top:1px solid var(--line); }
.tt-leafrow.done{ opacity:.5; }
.tt-leafrow .tt-done, .tt-leafrow .tt-sched{ margin-top:0; }
.tt-leafrow-main{ flex:1; min-width:0; }
.tt-leafrow-title{ font-size:14px; font-weight:600; line-height:1.5; display:flex; align-items:center; flex-wrap:wrap; gap:6px; }
.tt-leafrow.done .tt-leafrow-title{ text-decoration:line-through; }
.tt-leafrow-path{ font-size:11px; color:var(--muted); margin-top:3px; }
.tt-leafrow-memo{ font-size:11.5px; color:var(--muted); margin-top:4px; line-height:1.55; }
.tt-leafrow-dl{ flex:0 0 auto; text-align:right; }
.tt-leafrow-date{ display:block; font-family:ui-monospace,monospace; font-size:12px; }
.tt-leafrow-rel{ display:block; font-size:10px; color:var(--muted); margin-top:1px; }
.tt-leafrow-dl.soon .tt-leafrow-date, .tt-leafrow-dl.soon .tt-leafrow-rel{ color:var(--soon); }
.tt-leafrow-dl.slow .tt-leafrow-date{ color:var(--slow); }
.tt-leafrow-note{ flex:0 0 auto; font-size:11px; color:var(--soon); border:1px solid var(--soon); border-radius:999px; padding:2px 9px; align-self:center; }

.tt-modal{ position:fixed; inset:0; background:rgba(35,38,34,.42); display:flex; align-items:center; justify-content:center; padding:20px; z-index:50; animation:fade .18s ease; }
.tt-modal-card{ background:var(--surface); border:1px solid var(--line); border-radius:16px; max-width:450px; width:100%; max-height:84vh; overflow-y:auto; padding:22px; box-shadow:0 24px 64px rgba(0,0,0,.22); }
.tt-modal-title{ font-size:18px; font-weight:700; margin:0 0 4px; display:flex; align-items:center; gap:9px; }
.tt-modal-sub{ font-size:12.5px; color:var(--muted); margin:0 0 17px; line-height:1.6; }
.tt-modal-list{ display:flex; flex-direction:column; gap:13px; }
.tt-modal-item{ display:flex; gap:11px; align-items:flex-start; }
.tt-modal-ic{ flex:0 0 auto; width:26px; height:26px; border-radius:7px; background:var(--leaf-soft); display:flex; align-items:center; justify-content:center; font-size:13px; margin-top:1px; }
.tt-modal-item > div{ font-size:13px; line-height:1.7; color:var(--ink); }
.tt-modal-close{ margin-top:19px; width:100%; border:0; background:var(--ink); color:#fff; border-radius:11px; padding:12px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit; }
.tt-modal-close:hover{ filter:brightness(1.12); }
@keyframes fade{ from{ opacity:0; } }

.tt-head-btns{ display:flex; align-items:center; gap:8px; flex:0 0 auto; }
.tt-signout{ border:1px solid var(--line); background:var(--surface); color:var(--muted); border-radius:9px; padding:7px 12px; font-size:12px; cursor:pointer; font-family:inherit; }
.tt-signout:hover{ border-color:var(--soon); color:var(--soon); }

.tt-auth{ min-height:60vh; display:flex; align-items:center; justify-content:center; padding:20px; }
.tt-auth-card{ background:var(--surface); border:1px solid var(--line); border-radius:18px; padding:30px 26px; max-width:380px; width:100%; box-shadow:0 14px 44px rgba(0,0,0,.07); }
.tt-auth-logo{ display:flex; align-items:center; gap:10px; font-size:26px; font-weight:800; letter-spacing:.05em; color:var(--ink); }
.tt-auth-read{ font-family:ui-monospace,monospace; font-size:11px; letter-spacing:.22em; color:var(--muted); font-weight:400; }
.tt-auth-sub{ font-size:13px; color:var(--muted); line-height:1.8; margin:14px 0 20px; }
.tt-auth-tabs{ display:flex; gap:6px; margin-bottom:12px; background:var(--paper); border-radius:11px; padding:4px; }
.tt-auth-tabs button{ flex:1; border:0; background:transparent; color:var(--muted); border-radius:8px; padding:9px; font-size:13px; cursor:pointer; font-family:inherit; }
.tt-auth-tabs button.on{ background:var(--surface); color:var(--ink); font-weight:700; box-shadow:0 1px 3px rgba(0,0,0,.06); }
.tt-auth-input + .tt-auth-input{ margin-top:10px; }
.tt-auth-input{ width:100%; box-sizing:border-box; border:1px solid var(--line); background:var(--paper); border-radius:11px; padding:12px 14px; font-size:15px; font-family:inherit; color:var(--ink); }
.tt-auth-input:focus{ outline:2px solid var(--leaf-soft); border-color:var(--leaf); }
.tt-auth-btn{ width:100%; margin-top:12px; border:0; background:var(--ink); color:#fff; border-radius:11px; padding:13px; font-size:14px; font-weight:600; cursor:pointer; font-family:inherit; }
.tt-auth-btn:hover{ filter:brightness(1.12); }
.tt-auth-btn:disabled{ opacity:.6; cursor:default; }
.tt-auth-msg{ font-size:12.5px; color:var(--leaf); line-height:1.7; margin:14px 0 0; }

@media (display-mode: standalone){ .tt-root{ padding-top:max(28px, env(safe-area-inset-top)); } }

/* ===== スマホ対応：横スクロールをなくし、⋯ を必ず画面内に ===== */
@media (max-width:560px){
  .tt-root{ padding:20px 12px 40px; }
  /* 行を折り返し可能にして、はみ出しをなくす */
  .tt-row{ flex-wrap:wrap; row-gap:4px; padding:5px 0; }
  /* タイトル入力を1行目で最大幅に。残りのバッジ類は2行目へ自然に折り返す */
  .tt-title{ flex:1 1 100%; order:1; min-width:0; font-size:16px; }
  /* 行頭のボタン類（開閉・完了・予定）は1行目の左に残す */
  .tt-tw, .tt-leaf, .tt-done, .tt-sched{ order:0; }
  /* ⋯ は1行目の右端に固定。常に画面内に見える */
  .tt-more{ order:0; margin-left:auto; }
  /* バッジ・締切・タグ・進捗は2行目に回す（横スクロール不要に） */
  .tt-en, .tt-rc, .tt-slow-chip, .tt-tags, .tt-dl, .tt-memo-dot, .tt-prog, .tt-future-when{ order:2; }
  .tt-tags{ flex-basis:auto; }
  /* 引き出し（⋯の中身）を画面幅に合わせて余裕を持たせる */
  .tt-drawer{ margin-left:12px; }
  .tt-drawer-acts button{ flex:1 1 auto; min-width:88px; text-align:center; }
  /* 締切順ビューも詰まらないように */
  .tt-leafrow-dl{ text-align:left; }
}
`;