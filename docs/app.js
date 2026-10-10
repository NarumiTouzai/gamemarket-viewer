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
      <button class="num" data-act="map" type="button" title="会場マップで場所を見る">${esc(b.number || "—")}<i>📍</i></button>
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
    // 絞り込みで一覧が変わったら、見えている先頭のブースを地図に出し直す
    current = null;
    pinnedUntil = 0;
    requestAnimationFrame(followScroll);
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
    const cardEl = e.target.closest(".card");
    if (!btn) {
      // リンクや紹介文の開閉以外のところを押したら、そのブースを地図に出す
      if (cardEl && !e.target.closest("a, summary, details p")) selectBooth(booths.find((x) => x.id === Number(cardEl.dataset.id)));
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
    return v;
  }

  // ---- 一覧の横に出しておく地図 ----
  const mini = MapView("mini");
  let miniHidden = store.get("miniHidden", false);
  let current = null;     // 赤枠を出しているブース
  let pinnedUntil = 0;    // カードを押した直後はスクロール追従を少し止める

  function miniWidthFor(size) {
    const sc = $("#miniScroll");
    const w = sc.clientWidth, h = sc.clientHeight;
    if (!size) return w;
    // 赤枠が枠に収まる範囲で大きく。エリアの小さな区画でも拡大しすぎない
    const fit = Math.min((0.8 * w * M.W) / size[0], (0.8 * h * M.W) / size[1]);
    return Math.round(Math.max(w, Math.min(fit, 1700, w * 5)));
  }

  function showMini(b, smooth) {
    current = b;
    document.querySelectorAll(".card.cur").forEach((c) => c.classList.remove("cur"));
    if (b) document.querySelector(`.card[data-id="${b.id}"]`)?.classList.add("cur");
    $("#miniTitle").textContent = b ? `${b.number}　${b.name}` : "会場マップ";
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

  // 一覧の見えている先頭のカードを探す
  function followScroll() {
    if (Date.now() < pinnedUntil || !booths.length) return;
    const top = $("#mini").getBoundingClientRect();
    const wide = matchMedia("(min-width: 1000px)").matches;
    const y = (wide ? $(".bar").getBoundingClientRect().bottom : top.bottom) + 12;
    const x = $("#list").getBoundingClientRect().left + 40;
    let c = null;
    for (const dy of [0, 30, 60, 100, 150]) {
      c = document.elementFromPoint(x, y + dy)?.closest(".card");
      if (c) break;
    }
    if (!c) return;
    const b = booths.find((x) => x.id === Number(c.dataset.id));
    if (b && b !== current) showMini(b, true);
  }

  let scrollTick = false;
  window.addEventListener("scroll", () => {
    if (scrollTick) return;
    scrollTick = true;
    requestAnimationFrame(() => { scrollTick = false; followScroll(); });
  }, { passive: true });

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
    pinnedUntil = Date.now() + 600;
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
    const i = ZOOMS.indexOf(bigZoom) + dir;
    if (i < 0 || i >= ZOOMS.length) return;
    const [fx, fy] = big.center();
    bigZoom = ZOOMS[i];
    drawBig(big.booth, big.day, false);
    big.centerOn(fx, fy);
  }

  $("#openMap").addEventListener("click", () => openMap(current));
  $("#mapClose").addEventListener("click", () => $("#mapDlg").close());
  $("#zoomIn").addEventListener("click", () => zoomBy(1));
  $("#zoomOut").addEventListener("click", () => zoomBy(-1));
  $("#mapDays").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-mday]");
    if (btn) drawBig(big.booth, +btn.dataset.mday, true);
  });

  setMiniHidden(miniHidden);
  load();
})();
