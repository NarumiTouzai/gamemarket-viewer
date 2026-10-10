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
    { day: "sat", q: "", types: [], onlyStar: false, hideDone: false, onlyGames: false, view: "detail" },
    store.get("filters", {}),
    { q: "" }
  );

  let booths = [];
  const opened = new Set(); // リスト表示で詳細を開いているブース
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
      booths = data.booths.map((b, i) => {
        // 特設は specials.js、エリアは areas.js（番号 "エリア - 04" → "04"）
        const num = (b.number || "").replace(/\s+/g, "");
        const areaNo = (num.match(/^エリア-?(\d+)/) || [])[1];
        const description = cleanDesc(b.description);
        const guide = (window.GM_SPECIAL || {})[num] || (areaNo && (window.GM_AREA || {})[areaNo.padStart(2, "0")])
          || autoGuide(b, description);
        return {
          ...b,
          order: i,
          group: groupKey(b),
          description,
          guide, // 特設ブースの「どんな場所か」（specials.js）
          // 公式サイトのゲーム名は [ ] で囲まれているので外す
          games: (b.games || []).map((g) => ({ ...g, title: (g.title || "").replace(/^\s*\[(.*)\]\s*$/, "$1") })),
          hay: norm([b.name, b.number, b.type, ...(b.games || []).map((g) => g.title), description,
            guide && [guide.kind, ...guide.tags, guide.text].join(" ")].join("\n")),
        };
      });
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

  // 公式ページの本文から取った紹介文の、前後の定型部分（ページ上部の案内・入場チケットの告知）を外す
  function cleanDesc(t) {
    if (!t) return t;
    const i = t.indexOf("ブース概要");
    if (i >= 0) t = t.slice(i + "ブース概要".length);
    const j = t.search(/(\n|^)(その他\n)?開催位置\n/);
    if (j >= 0) t = t.slice(0, j);
    return t.trim() || null;
  }

  // 手書きの説明（specials.js / areas.js）がまだない特設・エリアブース用に、公式紹介文の冒頭を自動で出す
  function autoGuide(b, description) {
    if (b.type !== "特設" && b.type !== "エリア") return null;
    const first = (description || "").replace(/\s+/g, " ").trim();
    if (!first) return null;
    const text = first.length > 80 ? first.slice(0, 80) + "…" : first;
    return { kind: b.type, tags: ["公式紹介文より（自動）"], text };
  }

  // 種類の見出し。エリアの出展ジャンルは公式ホールマップと同じ色にする
  const KIND_COLOR = {
    "ボードゲーム": "#e5b845", "トレカ": "#87ae5d", "制作者支援": "#ecd0cd",
    "謎解き": "#cad650", "TRPG": "#c87048", "マーダーミステリー": "#957aa2",
  };
  const kindChip = (k) => KIND_COLOR[k]
    ? `<span class="kind" style="background:${KIND_COLOR[k]};color:#1d232b">${esc(k)}</span>`
    : `<span class="kind">${esc(k)}</span>`;

  // リンクの表示用の文字（https:// を外し、%E3… を日本語に戻す）
  function linkLabel(u) {
    const s = u.replace(/^https?:\/\/(www\.)?/, "");
    try { return decodeURIComponent(s); } catch { return s; }
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
      ? `<div class="links">${b.links.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener" title="${esc(u)}">${esc(linkLabel(u))}</a>`).join("")}</div>`
      : "";
    // 特設ブースのサムネイル。画像は公式サーバーのものをそのまま表示する（こちらには保存しない）。
    // 公式には「thumb_」を付けた小さい版があるのでそれを使う。読めなければ枠ごと消す
    const thumb = (b.type === "特設" || b.type === "エリア") && b.image
      ? `<a class="thumb" href="${esc(b.url)}" target="_blank" rel="noopener"><img loading="lazy" alt="" src="${esc(b.image.replace(/\/([^/]+)$/, "/thumb_$1"))}" onerror="this.parentElement.remove()"></a>`
      : "";
    // リスト表示で1行に収める、ゲーム名の要約
    // 特設ブースは「どんな場所か」（specials.js）を出す
    const g = b.guide;
    const guide = g
      ? `<div class="guide">${kindChip(g.kind)}${g.tags.map((t) => `<span class="gtag">${esc(t)}</span>`).join("")}<p>${highlight(g.text, terms)}</p></div>`
      : "";
    const sum = `<div class="sum">${b.day !== "both" ? `<span class="tag ${b.day}">${dayLabel[b.day]}</span>` : ""}${
      g ? `${kindChip(g.kind)}${esc(g.text)}`
      : b.games.length
        ? `${b.games.slice(0, 3).map((g) => highlight(g.title || "", terms)).join(" / ")}${b.games.length > 3 ? ` ほか${b.games.length - 3}件` : ""}`
        : `<span class="none">ゲーム登録なし</span>`}</div>`;
    return `<article class="card${s ? " star" : ""}${d ? " done" : ""}${opened.has(b.id) ? " open" : ""}" data-id="${b.id}">
      <button class="num" data-act="map" type="button" title="会場マップで場所を見る">${esc(b.number || "—")}<i>📍</i></button>
      <div class="name"><a href="${esc(b.url)}" target="_blank" rel="noopener">${highlight(b.name, terms)}</a></div>
      ${sum}
      <div class="acts">
        <button class="s${s ? " on" : ""}" data-act="star" aria-label="行きたい" aria-pressed="${s}">${s ? "★" : "☆"}</button>
        <button class="d${d ? " on" : ""}" data-act="done" aria-label="行った" aria-pressed="${d}">✓</button>
      </div>
      <div class="tags">
        <span class="tag ${b.day}">${dayLabel[b.day] || b.day}</span>
        ${b.type ? `<span class="tag type">${esc(b.type)}</span>` : ""}
        ${b.games.length ? `<span class="tag type">ゲーム ${b.games.length}</span>` : ""}
      </div>
      <div class="body">${guide}${thumb}${games}${desc}${links}</div>
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
    $("#list").classList.toggle("compact", state.view === "list");
    $("#jump").innerHTML = jump;
    $("#count").textContent = `${list.length} / ${booths.length} ブース　★${stars.size}　✓${done.size}`;
    // 地図に出しているブースが絞り込みで消えたら、地図は全体表示に戻す
    const curCard = current && document.querySelector(`.card[data-id="${current.id}"]`);
    if (curCard) curCard.classList.add("cur");
    else if (current) showMini(null, false);
  }

  function saveFilters() {
    const { q, ...rest } = state;
    store.set("filters", rest);
  }

  // ---------- events ----------
  // 参加日と表示の切り替え（全画面地図の土日ボタンは別に扱う）
  for (const [sel, key] of [["[data-day]", "day"], ["[data-view]", "view"]]) {
    const btns = document.querySelectorAll(sel);
    btns.forEach((btn) => {
      btn.setAttribute("aria-pressed", String(btn.dataset[key] === state[key]));
      btn.addEventListener("click", () => {
        state[key] = btn.dataset[key];
        btns.forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
        saveFilters(); render();
      });
    });
  }

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
    const cardEl = e.target.closest(".card");
    if (!btn) {
      // リンクや紹介文の開閉以外のところを押したら、そのブースを地図に出す。リスト表示では詳細も開閉する
      if (!cardEl || e.target.closest("a, summary, details p")) return;
      const id = Number(cardEl.dataset.id);
      if (state.view === "list" && !e.target.closest(".body")) {
        opened.has(id) ? opened.delete(id) : opened.add(id);
        cardEl.classList.toggle("open", opened.has(id));
      }
      selectBooth(booths.find((x) => x.id === id));
      return;
    }
    const id = Number(cardEl.dataset.id);
    if (btn.dataset.act === "map") { selectBooth(booths.find((x) => x.id === id)); return; }
    const set = btn.dataset.act === "star" ? stars : done;
    set.has(id) ? set.delete(id) : set.add(id);
    store.set("stars", [...stars]);
    store.set("done", [...done]);
    // 表示中の1枚だけ差し替え（スクロール位置を保つ）
    const b = booths.find((x) => x.id === id);
    const { terms } = filtered();
    const tmp = document.createElement("div");
    tmp.innerHTML = card(b, terms);
    if (current === b) tmp.firstElementChild.classList.add("cur");
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

  // ---------- 会場マップ ----------
  const M = window.GM_MAP;

  // 土曜のみ→土の地図、日曜のみ→日の地図、両日→いま選んでいる参加日
  const mapDayFor = (b) => (b && b.day === "sun" ? 2 : b && b.day === "sat" ? 1 : state.day === "sun" ? 2 : 1);
  const boothNo = (b) => b.number.replace(/^.*?([0-9]+)$/, "$1").replace(/^0+/, "");

  // 地図1枚分の表示（一覧の横の地図と、全画面の地図で共用）
  function MapView(p) {
    const el = (s) => document.getElementById(p + s);
    const v = { booth: null, day: 1, width: 0 };

    v.show = (b, day, width, recenter, smooth) => {
      v.booth = b; v.day = day; v.width = width;
      const img = el("Img");
      if (img.getAttribute("src") !== M.images[day]) img.src = M.images[day];
      el("Stage").style.width = `${width}px`;

      const loc = b && M.locate(b, day);
      const mark = el("Mark");
      mark.hidden = !loc;
      let note = "";
      if (b && !loc) {
        note = M.locate(b, 3 - day)
          ? `この日の地図にはありません（${day === 1 ? "日曜" : "土曜"}の地図にあります）`
          : "地図上の位置が分かりませんでした。公式の地図で確認してください。";
      } else if (loc && loc.island) {
        note = `${loc.island} の島（赤枠）の中の番号 ${boothNo(b)}`;
      }
      el("Note").textContent = note;
      el("Note").hidden = !note;
      if (!loc) return null;

      const pad = 6;
      const [x1, y1, x2, y2] = loc.pt ? [loc.pt[0] - 20, loc.pt[1] - 20, loc.pt[0] + 20, loc.pt[1] + 20] : loc.box;
      Object.assign(mark.style, {
        left: `${((x1 - pad) / M.W) * 100}%`, top: `${((y1 - pad) / M.H) * 100}%`,
        width: `${((x2 - x1 + pad * 2) / M.W) * 100}%`, height: `${((y2 - y1 + pad * 2) / M.H) * 100}%`,
      });
      mark.classList.toggle("round", !!loc.pt);
      if (recenter) v.centerOn((x1 + x2) / 2 / M.W, (y1 + y2) / 2 / M.H, smooth);
      return [x2 - x1 + pad * 2, y2 - y1 + pad * 2];
    };

    // 地図上の割合 (fx, fy) が枠の真ん中に来るようにスクロール
    v.centerOn = (fx, fy, smooth) => {
      const sc = el("Scroll");
      requestAnimationFrame(() => sc.scrollTo({
        left: fx * v.width - sc.clientWidth / 2,
        top: fy * v.width * (M.H / M.W) - sc.clientHeight / 2,
        behavior: smooth ? "smooth" : "auto",
      }));
    };

    // 枠の真ん中が地図のどこか（拡大・縮小で中心を保つため）
    v.center = () => {
      const sc = el("Scroll");
      return [(sc.scrollLeft + sc.clientWidth / 2) / v.width, (sc.scrollTop + sc.clientHeight / 2) / (v.width * (M.H / M.W))];
    };
    // 画面上の (cx, cy) の位置を動かさずに、地図の幅を w にする（ピンチ・ホイール拡大用）
    v.zoomAt = (w, cx, cy) => {
      if (!v.width) return;
      const sc = el("Scroll"), r = sc.getBoundingClientRect();
      const px = cx - r.left, py = cy - r.top;
      const fx = (sc.scrollLeft + px) / v.width, fy = (sc.scrollTop + py) / v.width;
      const fitAll = Math.min(sc.clientWidth, (sc.clientHeight * M.W) / M.H); // 地図全体が収まる大きさ
      v.width = Math.round(Math.min(Math.max(w, fitAll), Math.max(sc.clientWidth * 8, 6000)));
      el("Stage").style.width = `${v.width}px`;
      sc.scrollLeft = fx * v.width - px;
      sc.scrollTop = fy * v.width - py;
    };

    pinchZoom(el("Scroll"), v);
    return v;
  }

  // 地図の中での 2本指ピンチ と Ctrl+ホイール（PCのトラックパッドのピンチも含む）で、地図だけを拡大縮小する
  function pinchZoom(sc, v) {
    let p = null;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const mid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
    sc.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) p = { d: dist(e.touches), w: v.width };
    }, { passive: true });
    sc.addEventListener("touchmove", (e) => {
      if (!p || e.touches.length !== 2) return;
      e.preventDefault(); // ページ全体の拡大を止める
      const [cx, cy] = mid(e.touches);
      v.zoomAt(p.w * (dist(e.touches) / p.d), cx, cy);
    }, { passive: false });
    sc.addEventListener("touchend", (e) => { if (e.touches.length < 2) p = null; });
    // iOS Safari はページ拡大を gesture イベントで行うので、地図の上では止める
    sc.addEventListener("gesturestart", (e) => e.preventDefault());
    sc.addEventListener("wheel", (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      v.zoomAt(v.width * Math.exp(-e.deltaY * 0.004), e.clientX, e.clientY);
    }, { passive: false });
  }

  // ---- 一覧の横に出しておく地図 ----
  const mini = MapView("mini");
  let miniHidden = store.get("miniHidden", false);
  let current = null;     // 赤枠を出しているブース

  function miniWidthFor(size) {
    const sc = $("#miniScroll");
    const w = sc.clientWidth, h = sc.clientHeight;
    // 何も選んでいないときは地図全体を枠の中に収める（はみ出すとスワイプで地図が動いてしまう）
    if (!size) return Math.floor(Math.min(w, (h * M.W) / M.H));
    // 赤枠が枠に収まる範囲で大きく。エリアの小さな区画でも拡大しすぎない
    const fit = Math.min((0.8 * w * M.W) / size[0], (0.8 * h * M.W) / size[1]);
    return Math.round(Math.max(w, Math.min(fit, 1700, w * 5)));
  }

  function showMini(b, smooth) {
    current = b;
    document.querySelectorAll(".card.cur").forEach((c) => c.classList.remove("cur"));
    if (b) document.querySelector(`.card[data-id="${b.id}"]`)?.classList.add("cur");
    $("#miniTitle").textContent = b ? `${b.number}　${b.name}` : "会場マップ（一覧のブースを押すと場所が出ます）";
    if (miniHidden) return;
    const day = mapDayFor(b);
    const loc = b && M.locate(b, day);
    let size = null;
    if (loc) {
      const [x1, y1, x2, y2] = loc.pt ? [loc.pt[0] - 20, loc.pt[1] - 20, loc.pt[0] + 20, loc.pt[1] + 20] : loc.box;
      size = [x2 - x1 + 12, y2 - y1 + 12];
    }
    const width = miniWidthFor(size);
    mini.show(b, day, width, true, smooth && width === mini.width);
  }

  function setMiniHidden(h) {
    miniHidden = h;
    store.set("miniHidden", h);
    $("#miniBody").hidden = h;
    $("#mini").classList.toggle("closed", h);
    $("#miniHide").textContent = h ? "地図を出す" : "地図を隠す";
    updateBarHeight();
    if (!h) showMini(current, false);
  }

  // カードを押したら、そのブースを地図に出す
  function selectBooth(b) {
    if (miniHidden) { openMap(b); return; }
    showMini(b, true);
  }

  // 固定ヘッダーの高さを CSS に渡す（見出しへのジャンプ位置と、地図の固定位置に使う）
  function updateBarHeight() {
    const h = $(".bar").offsetHeight;
    document.documentElement.style.setProperty("--bar-h", `${h}px`);
    const mh = matchMedia("(min-width: 1000px)").matches ? 0 : $("#mini").offsetHeight;
    document.documentElement.style.setProperty("--mini-h", `${mh}px`);
  }
  new ResizeObserver(() => { updateBarHeight(); if (current) showMini(current, false); }).observe($(".bar"));
  window.addEventListener("resize", updateBarHeight);

  // PC ではマウスで地図をつかんで動かせるようにする（スマホ・タブレットは指でそのまま動く）
  function dragToPan(sc) {
    let drag = null;
    sc.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      drag = { x: e.clientX, y: e.clientY, l: sc.scrollLeft, t: sc.scrollTop };
      sc.setPointerCapture(e.pointerId);
      sc.classList.add("grabbing");
      e.preventDefault();
    });
    sc.addEventListener("pointermove", (e) => {
      if (!drag) return;
      sc.scrollLeft = drag.l - (e.clientX - drag.x);
      sc.scrollTop = drag.t - (e.clientY - drag.y);
    });
    const end = (e) => {
      // 少しでも動かしたら「押した」ではなく「動かした」扱いにする（地図タップでの移動と区別）
      if (drag) sc.dataset.moved = String(Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 5);
      drag = null; sc.classList.remove("grabbing");
    };
    sc.addEventListener("pointerup", end);
    sc.addEventListener("pointercancel", end);
  }
  dragToPan($("#miniScroll"));
  dragToPan($("#mapScroll"));

  // 地図を押したら、その場所のブースへ一覧を移動する。
  // エリア・特設はそのブース、一般ブースの島は島の先頭のブースへ
  function tapToJump(sc, v, afterJump) {
    sc.addEventListener("click", (e) => {
      if (sc.dataset.moved === "true") { sc.dataset.moved = "false"; return; }
      const r = sc.querySelector(".map-stage").getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * M.W, y = ((e.clientY - r.top) / r.height) * M.H;
      const b = boothAt(x, y, v.day);
      if (!b) return;
      afterJump && afterJump();
      jumpTo(b);
    });
  }

  function boothAt(x, y, day) {
    const shown = new Set([...document.querySelectorAll("#list .card")].map((c) => Number(c.dataset.id)));
    let best = null, bestArea = Infinity, island = null;
    for (const b of booths) {
      if (!shown.has(b.id)) continue;
      const loc = M.locate(b, day);
      if (!loc) continue;
      const [x1, y1, x2, y2] = loc.pt ? [loc.pt[0] - 22, loc.pt[1] - 22, loc.pt[0] + 22, loc.pt[1] + 22] : loc.box;
      if (x < x1 - 4 || x > x2 + 4 || y < y1 - 4 || y > y2 + 4) continue;
      if (loc.island) { island = island || b; continue; } // 一覧の順で最初のもの＝島の先頭
      const area = (x2 - x1) * (y2 - y1);                  // 重なっていたら小さい区画を優先
      if (area < bestArea) { best = b; bestArea = area; }
    }
    return best || island;
  }

  // 一覧をそのブースまでスクロールして、地図にも出す
  function jumpTo(b) {
    const c = document.querySelector(`#list .card[data-id="${b.id}"]`);
    if (!c) return;
    if (state.view === "list") { opened.add(b.id); c.classList.add("open"); }
    const wide = matchMedia("(min-width: 1000px)").matches;
    const cover = $(".bar").offsetHeight + (wide ? 0 : $("#mini").offsetHeight);
    window.scrollTo({ top: c.getBoundingClientRect().top + window.scrollY - cover - 8 });
    showMini(b, true);
  }


  // つまみをドラッグして地図の大きさを変える。広い画面は地図の幅、スマホは地図の高さ。端末に保存する
  const wideMQ = matchMedia("(min-width: 1000px)");
  const sizes = store.get("mapSize", {}); // { w: 幅px, h: 高さpx }
  function applyMapSize() {
    const root = document.documentElement.style;
    sizes.w ? root.setProperty("--map-w", `${sizes.w}px`) : root.removeProperty("--map-w");
    sizes.h ? root.setProperty("--map-h", `${sizes.h}px`) : root.removeProperty("--map-h");
  }
  applyMapSize();
  {
    const grip = $("#miniGrip");
    let dragging = false, start = null;
    grip.addEventListener("pointerdown", (e) => {
      dragging = true;
      // つかんだ位置からの移動量だけ大きさを変える（つかんだ瞬間に跳ねないように）
      start = { x: e.clientX, y: e.clientY, w: $("#mini").offsetWidth, h: $("#miniScroll").offsetHeight };
      grip.setPointerCapture(e.pointerId);
      grip.classList.add("dragging");
      e.preventDefault();
    });
    grip.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      if (wideMQ.matches) {
        sizes.w = Math.round(Math.min(Math.max(start.w - (e.clientX - start.x), 320), window.innerWidth - 360));
      } else {
        sizes.h = Math.round(Math.min(Math.max(start.h + (e.clientY - start.y), 100), window.innerHeight * 0.6));
      }
      applyMapSize();
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      grip.classList.remove("dragging");
      store.set("mapSize", sizes);
      updateBarHeight();
      showMini(current, false);
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    // ダブルクリック（ダブルタップ）で元の大きさに戻す
    grip.addEventListener("dblclick", () => {
      delete sizes[wideMQ.matches ? "w" : "h"];
      store.set("mapSize", sizes);
      applyMapSize(); updateBarHeight(); showMini(current, false);
    });
  }

  $("#miniHide").addEventListener("click", () => setMiniHidden(!miniHidden));
  $("#miniBig").addEventListener("click", () => openMap(current));

  // ---- 全画面の地図 ----
  const big = MapView("map");
  const ZOOMS = [1, 1.5, 2, 3, 4, 6];
  let bigZoom = 3;

  function openMap(b) {
    bigZoom = b ? 3 : 1;
    $("#mapTitle").textContent = b ? `${b.number}　${b.name}` : "会場マップ";
    $("#mapDlg").showModal();
    drawBig(b, mapDayFor(b), true);
  }

  function drawBig(b, day, recenter) {
    document.querySelectorAll("#mapDays button").forEach((x) => x.setAttribute("aria-pressed", String(+x.dataset.mday === day)));
    big.show(b, day, $("#mapScroll").clientWidth * bigZoom, recenter, false);
  }

  function zoomBy(dir) {
    // ピンチで中途半端な倍率になっていることがあるので、今の倍率から次の段階を探す
    const sc = $("#mapScroll");
    const cur = big.width / sc.clientWidth;
    const next = dir > 0 ? ZOOMS.find((z) => z > cur * 1.05) : [...ZOOMS].reverse().find((z) => z < cur * 0.95);
    if (!next) return;
    const r = sc.getBoundingClientRect();
    bigZoom = next;
    big.zoomAt(sc.clientWidth * next, r.left + sc.clientWidth / 2, r.top + sc.clientHeight / 2);
  }

  $("#openMap").addEventListener("click", () => openMap(current));
  $("#mapClose").addEventListener("click", () => $("#mapDlg").close());
  $("#zoomIn").addEventListener("click", () => zoomBy(1));
  $("#zoomOut").addEventListener("click", () => zoomBy(-1));
  $("#mapDays").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mday]");
    if (btn) drawBig(big.booth, +btn.dataset.mday, true);
  });

  tapToJump($("#miniScroll"), mini);
  tapToJump($("#mapScroll"), big, () => $("#mapDlg").close());

  setMiniHidden(miniHidden);
  load();
})();
