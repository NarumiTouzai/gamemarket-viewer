(() => {
  "use strict";

  const EVENT = "2026a";
  const KEY = `gm-${EVENT}-`;
  const $ = (s) => document.querySelector(s);

  // ---------- storage (この端末だけ) ----------
  const store = {
    get(k, def) {
      try { const v = localStorage.getItem(KEY + k); return v == null ? def : JSON.parse(v); }
      catch { return def; }
    },
    set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* private mode 等 */ } },
  };

  const stars = new Set(store.get("stars", []));
  const done = new Set(store.get("done", []));
  const state = Object.assign(
    { day: "sat", q: "", types: [], onlyStar: false, hideDone: false, onlyGames: false },
    store.get("filters", {}),
    { q: "" }
  );

  let booths = [];
  let typeOrder = [];

  // ---------- 検索用の正規化（全角半角・ひらがなカタカナ・大小文字を同一視） ----------
  const norm = (s) =>
    (s || "").normalize("NFKC").toLowerCase()
      .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function highlight(text, terms) {
    const safe = esc(text);
    if (!terms.length) return safe;
    // 正規化前後で文字数が変わる場合はハイライトを諦める（検索自体は効く）
    const n = norm(text);
    if (n.length !== text.length) return safe;
    const marks = new Array(text.length).fill(false);
    for (const t of terms) {
      let i = n.indexOf(t);
      while (t && i >= 0) { for (let k = i; k < i + t.length; k++) marks[k] = true; i = n.indexOf(t, i + 1); }
    }
    let out = "", open = false;
    for (let i = 0; i < text.length; i++) {
      if (marks[i] && !open) { out += "<mark>"; open = true; }
      if (!marks[i] && open) { out += "</mark>"; open = false; }
      out += esc(text[i]);
    }
    return open ? out + "</mark>" : out;
  }

  const groupKey = (b) => {
    const n = (b.number || "").trim();
    const k = n.replace(/[\s\-‐－–―]*[0-9０-９]+[a-zA-Zａ-ｚＡ-Ｚ]?$/, "").trim();
    return k || b.type || "その他";
  };

  const dayLabel = { sat: "土曜のみ", sun: "日曜のみ", both: "両日" };

  // ---------- data ----------
  async function load() {
    const sample = new URLSearchParams(location.search).has("sample");
    const url = sample ? "data/sample.json" : "data/booths.json";
    try {
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(res.status);
      const data = await res.json();
      booths = data.booths.map((b, i) => ({
        ...b,
        order: i,
        group: groupKey(b),
        games: b.games || [],
        hay: norm([b.name, b.number, b.type, ...(b.games || []).map((g) => g.title), b.description].join("\n")),
      }));
      typeOrder = [...new Set(booths.map((b) => b.type).filter(Boolean))];
      const gen = new Date(data.generatedAt);
      $("#meta").textContent =
        `${sample ? "【サンプルデータ】" : ""}データ取得: ${gen.toLocaleString("ja-JP")}　/　${booths.length} ブース・ゲーム ${booths.reduce((a, b) => a + b.games.length, 0)} 件`;
    } catch (e) {
      $("#list").innerHTML =
        `<p class="empty">データ（<code>${esc(url)}</code>）がまだありません。<br>GitHub の Actions タブで「ブース一覧を更新」を実行してください。</p>`;
      $("#count").textContent = "";
      return;
    }
    buildTypeChips();
    render();
  }

  // ---------- UI ----------
  function buildTypeChips() {
    const counts = {};
    for (const b of booths) counts[b.type] = (counts[b.type] || 0) + 1;
    $("#types").innerHTML = typeOrder
      .map((t) => `<button class="chip" data-type="${esc(t)}" aria-pressed="${state.types.includes(t)}">${esc(t)}<small>${counts[t]}</small></button>`)
      .join("");
  }

  function filtered() {
    const terms = norm(state.q).split(/\s+/).filter(Boolean);
    const list = booths.filter((b) => {
      if (state.day === "sat" && b.day === "sun") return false;
      if (state.day === "sun" && b.day === "sat") return false;
      if (state.types.length && !state.types.includes(b.type)) return false;
      if (state.onlyStar && !stars.has(b.id)) return false;
      if (state.hideDone && done.has(b.id)) return false;
      if (state.onlyGames && !b.games.length) return false;
      return terms.every((t) => b.hay.includes(t));
    });
    return { list, terms };
  }

  function card(b, terms) {
    const s = stars.has(b.id), d = done.has(b.id);
    const games = b.games.length
      ? `<ul class="games">${b.games.map((g) =>
          `<li><a href="${esc(g.url)}" target="_blank" rel="noopener">${highlight(g.title || `ゲーム #${g.id}`, terms)}</a></li>`).join("")}</ul>`
      : "";
    const descHit = terms.length && terms.some((t) => norm(b.description).includes(t));
    const desc = b.description
      ? `<details class="desc"${descHit ? " open" : ""}><summary>紹介文</summary><p>${highlight(b.description, terms)}</p></details>`
      : "";
    const links = (b.links || []).length
      ? `<div class="links">${b.links.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\/(www\.)?/, ""))}</a>`).join("")}</div>`
      : "";
    return `<article class="card${s ? " star" : ""}${d ? " done" : ""}" data-id="${b.id}">
      <span class="num">${esc(b.number || "—")}</span>
      <div class="name"><a href="${esc(b.url)}" target="_blank" rel="noopener">${highlight(b.name, terms)}</a></div>
      <div class="acts">
        <button class="s${s ? " on" : ""}" data-act="star" aria-label="行きたい" aria-pressed="${s}">${s ? "★" : "☆"}</button>
        <button class="d${d ? " on" : ""}" data-act="done" aria-label="行った" aria-pressed="${d}">✓</button>
      </div>
      <div class="tags">
        <span class="tag ${b.day}">${dayLabel[b.day] || b.day}</span>
        ${b.type ? `<span class="tag type">${esc(b.type)}</span>` : ""}
        ${b.games.length ? `<span class="tag type">ゲーム ${b.games.length}</span>` : ""}
      </div>
      <div class="body">${games}${desc}${links}</div>
    </article>`;
  }

  function render() {
    const { list, terms } = filtered();
    const groups = new Map();
    for (const b of list) {
      if (!groups.has(b.group)) groups.set(b.group, []);
      groups.get(b.group).push(b);
    }
    let i = 0, html = "", jump = "";
    for (const [g, items] of groups) {
      const id = `g${i++}`;
      jump += `<a href="#${id}">${esc(g)}</a>`;
      html += `<section class="group"><h2 id="${id}"><b>${esc(g)}</b>${items.length} ブース</h2><div class="cards">${items.map((b) => card(b, terms)).join("")}</div></section>`;
    }
    $("#list").innerHTML = html || `<p class="empty">条件に合うブースがありません。</p>`;
    $("#jump").innerHTML = jump;
    $("#count").textContent = `${list.length} / ${booths.length} ブース　★${stars.size}　✓${done.size}`;
  }

  function saveFilters() {
    const { q, ...rest } = state;
    store.set("filters", rest);
  }

  // ---------- events ----------
  document.querySelectorAll(".seg button").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.day === state.day));
    btn.addEventListener("click", () => {
      state.day = btn.dataset.day;
      document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
      saveFilters(); render();
    });
  });

  for (const key of ["onlyStar", "hideDone", "onlyGames"]) {
    const btn = $("#" + key);
    btn.setAttribute("aria-pressed", String(state[key]));
    btn.addEventListener("click", () => {
      state[key] = !state[key];
      btn.setAttribute("aria-pressed", String(state[key]));
      saveFilters(); render();
    });
  }

  $("#types").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-type]");
    if (!btn) return;
    const t = btn.dataset.type;
    state.types = state.types.includes(t) ? state.types.filter((x) => x !== t) : [...state.types, t];
    btn.setAttribute("aria-pressed", String(state.types.includes(t)));
    saveFilters(); render();
  });

  let timer;
  $("#q").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = e.target.value; render(); }, 150);
  });

  $("#list").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const id = Number(btn.closest(".card").dataset.id);
    const set = btn.dataset.act === "star" ? stars : done;
    set.has(id) ? set.delete(id) : set.add(id);
    store.set("stars", [...stars]);
    store.set("done", [...done]);
    // 表示中の1枚だけ差し替え（スクロール位置を保つ）
    const b = booths.find((x) => x.id === id);
    const { terms } = filtered();
    const tmp = document.createElement("div");
    tmp.innerHTML = card(b, terms);
    btn.closest(".card").replaceWith(tmp.firstElementChild);
    $("#count").textContent = $("#count").textContent.replace(/★\d+　✓\d+/, `★${stars.size}　✓${done.size}`);
  });

  $("#export").addEventListener("click", () => {
    const rows = booths
      .filter((b) => stars.has(b.id))
      .map((b) => {
        const day = state.day !== "all" && b.day !== "both" ? `［${dayLabel[b.day]}］` : "";
        const g = b.games.map((x) => x.title).filter(Boolean).join(" / ");
        return `${done.has(b.id) ? "✓" : "□"} ${b.number || "—"}　${b.name}${day}${g ? `\n    ${g}` : ""}`;
      });
    $("#exportText").value = rows.length
      ? `ゲムマ2026秋 行きたいブース（${rows.length}件）\n\n${rows.join("\n")}`
      : "☆ を押して行きたいブースを選んでください。";
    $("#exportDlg").showModal();
  });

  $("#copyBtn").addEventListener("click", async () => {
    const ta = $("#exportText");
    try { await navigator.clipboard.writeText(ta.value); }
    catch { ta.select(); document.execCommand("copy"); }
    $("#copyBtn").textContent = "コピーしました";
    setTimeout(() => ($("#copyBtn").textContent = "コピー"), 1500);
  });

  load();
})();
