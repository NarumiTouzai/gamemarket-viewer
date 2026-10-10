// 自動更新のあとに実行して、「手で入れているデータ」が足りないブースを知らせる。
//   - 地図上の位置（docs/mapdata.js）が分からないブース
//   - 特設・エリアなのに、ひとこと説明（docs/specials.js / docs/areas.js）がないブース
// GitHub Actions では ::warning:: として表示し、実行結果のまとめ（Summary）にも書く。
// 見つかっても失敗扱いにはしない（ページは自動の説明・島単位の表示などで動くため）。
//
//   node scripts/check-coverage.js [docs]

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const docs = process.argv[2] || "docs";
const window = {};
for (const f of ["mapdata.js", "specials.js", "areas.js"]) {
  vm.runInNewContext(fs.readFileSync(path.join(docs, f), "utf8"), { window });
}
const M = window.GM_MAP, SP = window.GM_SPECIAL || {}, AR = window.GM_AREA || {};
const { booths } = JSON.parse(fs.readFileSync(path.join(docs, "data", "booths.json"), "utf8"));

const noMap = [], noGuide = [];
for (const b of booths) {
  const days = b.day === "sat" ? [1] : b.day === "sun" ? [2] : [1, 2];
  if (days.some((d) => !M.locate(b, d))) noMap.push(b);
  const num = (b.number || "").replace(/\s+/g, "");
  const areaNo = (num.match(/^エリア-?(\d+)/) || [])[1];
  if (b.type === "特設" && !SP[num]) noGuide.push(b);
  if (b.type === "エリア" && !(areaNo && AR[areaNo.padStart(2, "0")])) noGuide.push(b);
}

const line = (b) => `${b.number}　${b.name}（${b.url}）`;
const lines = [];
if (noMap.length) lines.push(`地図上の位置が分からないブース ${noMap.length} 件（docs/mapdata.js に追加が必要）:`, ...noMap.map(line));
if (noGuide.length) lines.push(`ひとこと説明がない特設・エリアブース ${noGuide.length} 件（今は公式紹介文の冒頭を自動表示。docs/specials.js / areas.js に追加すると改善）:`, ...noGuide.map(line));

if (!lines.length) {
  console.log(`OK: 全 ${booths.length} ブースの地図位置と、特設・エリアの説明がそろっています。`);
} else {
  for (const l of lines) console.log(l);
  if (process.env.GITHUB_ACTIONS) {
    if (noMap.length) console.log(`::warning::地図上の位置が分からないブースが ${noMap.length} 件あります（詳細は Summary）`);
    if (noGuide.length) console.log(`::warning::ひとこと説明がない特設・エリアブースが ${noGuide.length} 件あります（詳細は Summary）`);
  }
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = lines.length
    ? "## 手で入れるデータの不足\n\n" + lines.map((l) => (l.endsWith(":") ? `\n**${l}**\n` : `- ${l}`)).join("\n") + "\n"
    : `## 手で入れるデータ\n\nOK: 全 ${booths.length} ブースの地図位置と、特設・エリアの説明がそろっています。\n`;
  fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
}
