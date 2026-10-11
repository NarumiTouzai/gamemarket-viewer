// 島のコマの位置（cells.json）とブース番号の並びから、mapdata.js に入れる「番号 → コマの範囲」を作る
//   node build_cells.js cells.json booths.json mapdata.js
const fs = require("fs");
const [, , cellsPath, boothsPath, mapPath] = process.argv;
const cells = JSON.parse(fs.readFileSync(cellsPath, "utf8").replace(/^﻿/, ""));
const booths = JSON.parse(fs.readFileSync(boothsPath, "utf8")).booths;
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

// 番号の並びが「右の列 1,2,3… → 左の列 続き」でない島（日曜は一部のブースがなく番号が飛ぶ）。地図の数字を見て書いたもの
// r / l: 右の列・左の列の上から順の番号。from: その列の何番目のコマから使うか（R と S は同じ列を上下で分けている）
const custom = {
  "2:N": { r: range(1, 17), l: range(23, 40) },
  "2:P": { r: range(1, 14), l: [...range(22, 34), 41] },
  "2:Q": { r: range(1, 18), l: range(23, 36) },
  "2:T": { r: range(8, 14), l: range(22, 29) },
  "2:U": { r: range(1, 6), l: range(11, 16) },
  "2:G": { r: range(1, 10), l: range(14, 20) },
  "2:R": { r: range(1, 4), l: range(5, 8) },
  "2:S": { r: range(1, 17), l: range(18, 31), rFrom: 4, lFrom: 4 },
};

const out = {};
const problems = [];
for (const [key, c] of Object.entries(cells)) {
  const r = c.r || [], l = c.l || [];
  let rn, ln, rFrom = 0, lFrom = 0;
  if (custom[key]) {
    ({ r: rn, l: ln } = custom[key]);
    rFrom = custom[key].rFrom || 0; lFrom = custom[key].lFrom || 0;
  } else {
    rn = range(1, r.length); ln = range(r.length + 1, r.length + l.length);
  }
  const rc = r.slice(rFrom, rFrom + rn.length), lc = l.slice(lFrom, lFrom + ln.length);
  if (rc.length !== rn.length || lc.length !== ln.length) { problems.push(`${key}: コマ数が合わない（右 ${rc.length}/${rn.length}, 左 ${lc.length}/${ln.length}）`); continue; }
  const m = {};
  rn.forEach((n, i) => (m[n] = [c.rx[0], rc[i][0], c.rx[1], rc[i][1]]));
  ln.forEach((n, i) => (m[n] = [c.lx[0], lc[i][0], c.lx[1], lc[i][1]]));
  out[key] = m;
}

// データのブースが全部コマに当たるか確認
let hit = 0, miss = [];
for (const b of booths) {
  const mm = (b.number || "").replace(/\s+/g, "").match(/^(土曜|日曜|両日)-([A-Z横])(\d+)/);
  if (!mm) continue;
  const days = mm[1] === "土曜" ? [1] : mm[1] === "日曜" ? [2] : [1, 2];
  for (const d of days) {
    const t = out[`${d}:${mm[2]}`];
    if (t && t[+mm[3]]) hit++;
    else miss.push(`${d}:${b.number}`);
  }
}
console.log("島:", Object.keys(out).length, "/ ブース×日 で位置あり:", hit, "/ 位置なし:", miss.length);
if (problems.length) console.log("問題:", problems.join(" | "));
const byIsland = {};
for (const x of miss) { const k = x.replace(/\d+$/, ""); byIsland[k] = (byIsland[k] || 0) + 1; }
console.log("位置なしの内訳:", JSON.stringify(byIsland));

// mapdata.js に書き込む（数値は小数1桁）
const lines = Object.entries(out).map(([k, m]) =>
  `    "${k}": {${Object.entries(m).map(([n, r]) => `${n}:[${r.map((v) => Math.round(v * 10) / 10).join(",")}]`).join(",")}},`);
let s = fs.readFileSync(mapPath, "utf8");
const block = `  // 一般ブースの島の中のコマ。"日:島" → { 番号: [x1, y1, x2, y2] }。
  // 公式マップ画像で島の右の列・左の列を上から調べ、線で区切られたコマを数えて番号を割り当てたもの（scratch の cells.ps1 / build_cells.js）。
  // 番号は右の列の上から 1,2,3… → 左の列の続き。日曜の一部の島は番号が飛ぶので、地図の数字を見て並びを指定している
  const cells = {
${lines.join("\n")}
  };
`;
s = s.replace(/  \/\/ 一般ブースの島の中のコマ。[\s\S]*?\n  \};\n/, "");
const anchor = "  const images = {";
if (!s.includes(anchor)) throw new Error("anchor");
s = s.replace(anchor, block + anchor);
fs.writeFileSync(mapPath, s);
