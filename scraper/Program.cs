// ゲームマーケット公式サイトのブース一覧を取得して JSON にまとめるツール
//
//   dotnet run --project scraper -- [--event 2026a] [--out docs/data/booths.json]
//                                   [--refresh] [--stale-days 2] [--max-refetch 700] [--no-details] [--delay 700] [--max-pages N]
//
// --refresh    : 前回取得済みのブース詳細も全部取り直す
// --stale-days : 前回の取得からこの日数以上たったブースの詳細を取り直す（既定 2）
// --max-refetch: 1回で取り直す古いブースの上限（既定 700。古い順。新規ブースはこれと別に必ず取る）
// --no-details : 一覧だけ取得する（ブース名・番号・出展日のみ。数分で終わる）
// --max-games  : 1回で取りに行くゲーム詳細（人数・時間・価格など）の上限（既定 800）。取得済みのゲームは取り直さない
//
// 公式サイトへの負荷を避けるため、リクエストは 1 本ずつ、間隔(--delay ms)を空けて送ります。

using System.Net;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Text.Unicode;

var opt = Options.Parse(args);
const string Base = "https://gamemarket.jp";

var jsonOptions = new JsonSerializerOptions
{
    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    WriteIndented = true,
    DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    Encoder = JavaScriptEncoder.Create(UnicodeRanges.All),
};

// 前回の結果（詳細のキャッシュとして使う）
var previous = new Dictionary<int, Booth>();
if (File.Exists(opt.Out))
{
    try
    {
        var old = JsonSerializer.Deserialize<BoothData>(await File.ReadAllTextAsync(opt.Out), jsonOptions);
        if (old?.Event == opt.Event)
            foreach (var b in old.Booths) previous[b.Id] = b;
        Console.WriteLine($"前回データ: {previous.Count} 件");
    }
    catch (Exception e) { Console.WriteLine($"前回データを読めませんでした（無視して続行）: {e.Message}"); }
}

using var http = new HttpClient(new HttpClientHandler { AutomaticDecompression = DecompressionMethods.All })
{
    Timeout = TimeSpan.FromSeconds(30),
};
http.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (compatible; gamemarket-viewer/1.0; personal visit planning)");
http.DefaultRequestHeaders.AcceptLanguage.ParseAdd("ja");

var debugDir = Path.Combine(Path.GetDirectoryName(Path.GetFullPath(opt.Out))!, "..", "..", "debug");

// ---- 1. ブース一覧（ページ送り） ----
var booths = new Dictionary<int, Booth>();
var order = new List<int>();
int lastPage = 1;
for (int page = 1; page <= lastPage && page <= opt.MaxPages; page++)
{
    var url = $"{Base}/booth/?target_gm={opt.Event}&page={page}";
    var html = await Fetch(url);
    if (page == 1)
    {
        SaveDebug("list_page1.html", html);
        lastPage = Parser.LastPage(html);
        Console.WriteLine($"一覧: 全 {lastPage} ページ（総件数表示: {Parser.TotalCount(html)?.ToString() ?? "不明"}）");
    }

    int added = 0;
    foreach (var b in Parser.ParseList(html))
    {
        if (booths.TryAdd(b.Id, b)) { order.Add(b.Id); added++; }
        else booths[b.Id] = Parser.Merge(booths[b.Id], b);
    }
    Console.WriteLine($"  page {page}/{lastPage}: +{added} (計 {booths.Count})");
    if (added == 0 && page > 1) { Console.WriteLine("  新しいブースが無いので一覧の取得を終了"); break; }
}

if (booths.Count == 0)
{
    Console.Error.WriteLine("ブースを1件も読み取れませんでした。公式サイトの HTML 構造が変わった可能性があります。debug/list_page1.html を確認してください。");
    return 1;
}

// ---- 2. ブース詳細（出品ゲーム・紹介文） ----
if (!opt.NoDetails)
{
    // 取りに行くブースを決める。
    //  必ず取る: 新規ブース／詳細が未取得／画像URLを取る前のデータしかない特設・エリア／--refresh
    //  古いものは取り直す: 前回の取得から stale-days 以上たったもの（古い順に max-refetch 件まで）
    //  → 毎日少しずつ取り直して、どのブースも数日以内の情報に保つ（公式サイトへの負担を一度に集中させない）
    var now = DateTimeOffset.UtcNow;
    var toFetch = new HashSet<int>();
    var staleList = new List<(int Id, DateTimeOffset At)>();
    foreach (var id in order)
    {
        if (opt.Refresh || !previous.TryGetValue(id, out var pv) || pv.DetailFetchedAt is not { } at
            || (pv.Image is null && booths[id].Type is "特設" or "エリア"))
            toFetch.Add(id);
        else if (now - at >= TimeSpan.FromDays(opt.StaleDays))
            staleList.Add((id, at));
    }
    int newCount = toFetch.Count;
    foreach (var s in staleList.OrderBy(x => x.At).Take(opt.MaxRefetch)) toFetch.Add(s.Id);
    Console.WriteLine($"詳細の取得予定: {toFetch.Count} 件（新規など {newCount} 件、{opt.StaleDays} 日以上前の取り直し {toFetch.Count - newCount} 件／対象 {staleList.Count} 件）");

    int i = 0, fetched = 0;
    foreach (var id in order)
    {
        i++;
        var b = booths[id];
        if (!toFetch.Contains(id) && previous.TryGetValue(id, out var prev))
        {
            b.Games = prev.Games; b.Description = prev.Description; b.Links = prev.Links; b.Image = prev.Image; b.DetailFetchedAt = prev.DetailFetchedAt;
            continue;
        }
        try
        {
            var html = await Fetch(b.Url);
            if (fetched == 0) SaveDebug("booth_detail_sample.html", html);
            Parser.ApplyDetail(b, html);
            b.DetailFetchedAt = DateTimeOffset.UtcNow;
            fetched++;
            if (fetched % 50 == 0) Console.WriteLine($"  詳細 {i}/{order.Count}（今回取得 {fetched}）");
        }
        catch (Exception e)
        {
            Console.WriteLine($"  詳細取得失敗 {b.Url}: {e.Message}");
            if (previous.TryGetValue(id, out var p)) { b.Games = p.Games; b.Description = p.Description; b.Links = p.Links; b.Image = p.Image; }
        }
    }
    Console.WriteLine($"詳細: 今回 {fetched} 件取得、{order.Count - fetched} 件は前回データを利用");
}
else
{
    foreach (var id in order)
        if (previous.TryGetValue(id, out var p))
        { var b = booths[id]; b.Games = p.Games; b.Description = p.Description; b.Links = p.Links; b.Image = p.Image; b.DetailFetchedAt = p.DetailFetchedAt; }
}

// ---- 2b. ゲーム詳細（人数・時間・年齢・価格・発売時期・タグ） ----
// ゲームの情報はあまり変わらないので、取得済みのものは前回の値を使い、まだのものだけ取りに行く（1回 max-games 件まで）
if (!opt.NoDetails && opt.MaxGames > 0)
{
    var known = new Dictionary<int, GameRef>();
    foreach (var pb in previous.Values)
        foreach (var pg in pb.Games)
            if (pg.FetchedAt is not null) known.TryAdd(pg.Id, pg);
    var games = order.SelectMany(id => booths[id].Games).ToList();
    var fetchedNow = new Dictionary<int, GameRef>();
    int gFetched = 0, gFailed = 0;
    foreach (var g in games)
    {
        if (g.FetchedAt is not null) continue;
        if (fetchedNow.TryGetValue(g.Id, out var done) || known.TryGetValue(g.Id, out done)) { g.CopyDetail(done); continue; }
        if (gFetched + gFailed >= opt.MaxGames) continue;
        try
        {
            var html = await Fetch(g.Url);
            if (gFetched == 0) SaveDebug("game_detail_sample.html", html);
            Parser.ApplyGame(g, html);
            g.FetchedAt = DateTimeOffset.UtcNow;
            fetchedNow[g.Id] = g;
            gFetched++;
            if (gFetched % 100 == 0) Console.WriteLine($"  ゲーム詳細 今回取得 {gFetched}");
        }
        catch (Exception e) { gFailed++; Console.WriteLine($"  ゲーム詳細取得失敗 {g.Url}: {e.Message}"); }
    }
    int left = games.Where(g => g.FetchedAt is null).Select(g => g.Id).Distinct().Count();
    Console.WriteLine($"ゲーム詳細: 今回 {gFetched} 件取得（失敗 {gFailed}）、未取得 {left} 件");
}

// ---- 3. 保存 ----
var data = new BoothData
{
    Event = opt.Event,
    GeneratedAt = DateTimeOffset.UtcNow,
    Source = $"{Base}/booth/?target_gm={opt.Event}",
    Booths = order.Select(id => booths[id]).ToList(),
};
Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(opt.Out))!);
await File.WriteAllTextAsync(opt.Out, JsonSerializer.Serialize(data, jsonOptions), new UTF8Encoding(false));

var byDay = data.Booths.GroupBy(b => b.Day).Select(g => $"{g.Key}={g.Count()}");
Console.WriteLine($"保存しました: {opt.Out}  ({data.Booths.Count} ブース, ゲーム {data.Booths.Sum(b => b.Games.Count)} 件, {string.Join(" ", byDay)})");
return 0;

// ---------------------------------------------------------------

async Task<string> Fetch(string url)
{
    for (int attempt = 1; ; attempt++)
    {
        await Task.Delay(opt.DelayMs);
        try
        {
            using var res = await http.GetAsync(url);
            if ((int)res.StatusCode == 429 || (int)res.StatusCode >= 500)
                throw new HttpRequestException($"HTTP {(int)res.StatusCode}");
            res.EnsureSuccessStatusCode();
            return await res.Content.ReadAsStringAsync();
        }
        catch (Exception) when (attempt < 4)
        {
            await Task.Delay(TimeSpan.FromSeconds(5 * attempt));
        }
    }
}

void SaveDebug(string name, string html)
{
    try { Directory.CreateDirectory(debugDir); File.WriteAllText(Path.Combine(debugDir, name), html); } catch { /* 任意 */ }
}

// ===============================================================

record Options(string Event, string Out, bool Refresh, bool NoDetails, int DelayMs, int MaxPages, double StaleDays, int MaxRefetch, int MaxGames)
{
    public static Options Parse(string[] a)
    {
        string ev = "2026a", outPath = "docs/data/booths.json";
        bool refresh = false, noDetails = false; int delay = 700, maxPages = 1000, maxRefetch = 700, maxGames = 800; double staleDays = 2;
        for (int i = 0; i < a.Length; i++)
        {
            switch (a[i])
            {
                case "--event": ev = a[++i]; break;
                case "--out": outPath = a[++i]; break;
                case "--refresh": refresh = true; break;
                case "--no-details": noDetails = true; break;
                case "--delay": delay = int.Parse(a[++i]); break;
                case "--max-pages": maxPages = int.Parse(a[++i]); break;
                case "--stale-days": staleDays = double.Parse(a[++i], System.Globalization.CultureInfo.InvariantCulture); break;
                case "--max-refetch": maxRefetch = int.Parse(a[++i]); break;
                case "--max-games": maxGames = int.Parse(a[++i]); break;
                case "": break;
                default: throw new ArgumentException($"不明なオプション: {a[i]}");
            }
        }
        return new Options(ev, outPath, refresh, noDetails, Math.Max(delay, 300), maxPages, staleDays, Math.Max(maxRefetch, 0), Math.Max(maxGames, 0));
    }
}

class BoothData
{
    public string Event { get; set; } = "";
    public DateTimeOffset GeneratedAt { get; set; }
    public string Source { get; set; } = "";
    public List<Booth> Booths { get; set; } = new();
}

class Booth
{
    public int Id { get; set; }
    public string Name { get; set; } = "";
    /// <summary>特設 / エリア / 一般両日 / 一般土曜 / 一般日曜 など（公式のブースタイプ表記）</summary>
    public string? Type { get; set; }
    /// <summary>ブース番号（公式表記のまま）</summary>
    public string? Number { get; set; }
    /// <summary>both / sat / sun</summary>
    public string Day { get; set; } = "both";
    public string Url { get; set; } = "";
    public string? Description { get; set; }
    public List<GameRef> Games { get; set; } = new();
    public List<string> Links { get; set; } = new();
    /// <summary>ブース画像のURL（公式サーバー上。こちらでは保存しない）</summary>
    public string? Image { get; set; }
    public DateTimeOffset? DetailFetchedAt { get; set; }
}

class GameRef
{
    public int Id { get; set; }
    public string Title { get; set; } = "";
    public string Url { get; set; } = "";
    /// <summary>プレイ人数（公式表記のまま。例 "2〜4人"）</summary>
    public string? Players { get; set; }
    /// <summary>プレイ時間（例 "30〜60分"）</summary>
    public string? Time { get; set; }
    /// <summary>対象年齢（例 "10歳〜"）</summary>
    public string? Age { get; set; }
    /// <summary>価格（例 "3,000円"）</summary>
    public string? Price { get; set; }
    /// <summary>発売時期（例 "2026秋"。今回のイベントなら新作）</summary>
    public string? Release { get; set; }
    /// <summary>予約（"可" / "不可"）</summary>
    public string? Reserve { get; set; }
    /// <summary>対戦・協力など</summary>
    public List<string>? Btype { get; set; }
    /// <summary>テーマ（現代・ファンタジーなど）</summary>
    public List<string>? Theme { get; set; }
    /// <summary>ゲーム体験（スタンダード・キッズ・1～2人用 など）</summary>
    public List<string>? Exp { get; set; }
    public DateTimeOffset? FetchedAt { get; set; }

    public void CopyDetail(GameRef o)
    {
        Players = o.Players; Time = o.Time; Age = o.Age; Price = o.Price; Release = o.Release; Reserve = o.Reserve;
        Btype = o.Btype; Theme = o.Theme; Exp = o.Exp; FetchedAt = o.FetchedAt;
    }
}

static class Parser
{
    const string Base = "https://gamemarket.jp";
    static readonly RegexOptions RO = RegexOptions.Singleline | RegexOptions.IgnoreCase | RegexOptions.CultureInvariant;

    // ブースタイプ。長いものから順に照合する
    static readonly string[] KnownTypes = { "一般両日", "一般土曜", "一般日曜", "エリア", "特設", "一般" };

    static readonly Regex BoothAnchor = new(
        @"<a\b(?<pre>[^>]*?)\bhref\s*=\s*[""'](?:https?://(?:www\.)?gamemarket\.jp)?/booth/(?<id>\d+)/?[""'](?<post>[^>]*)>(?<inner>.*?)</a\s*>", RO);
    static readonly Regex GameAnchor = new(
        @"<a\b(?<pre>[^>]*?)\bhref\s*=\s*[""'](?:https?://(?:www\.)?gamemarket\.jp)?/game/(?<id>\d+)/?[""'](?<post>[^>]*)>(?<inner>.*?)</a\s*>", RO);
    static readonly Regex TitleAttr = new(@"\btitle\s*=\s*[""'](?<t>[^""']*)[""']", RO);
    static readonly Regex AltAttr = new(@"\balt\s*=\s*[""'](?<t>[^""']*)[""']", RO);
    static readonly Regex PageParam = new(@"[?&](?:amp;)?page=(?<p>\d+)", RO);
    static readonly Regex Total = new(@"ブース一覧\s*[（(]\s*(?<n>[\d,]+)\s*件", RO);
    static readonly Regex ScriptStyle = new(@"<(script|style|noscript|svg)\b.*?</\1\s*>", RO);
    static readonly Regex BlockTag = new(@"<\s*(br|/p|/div|/li|/dd|/dt|/h\d|/tr|/section|/article)\b[^>]*>", RO);
    // ブース画像: <div class="image"><figure><img src="https://img.gamemarket.jp/..."> の最初の1枚
    static readonly Regex BoothImage = new(@"<div\s+class\s*=\s*[""']image[""'][^>]*>\s*<figure[^>]*>\s*<img[^>]+src\s*=\s*[""'](?<u>https://img\.gamemarket\.jp/[^""']+)[""']", RO);
    static readonly Regex AnyTag = new(@"<[^>]+>", RO);
    static readonly Regex Sns = new(@"https?://(?:www\.)?(?:x\.com|twitter\.com|bsky\.app/profile|instagram\.com|youtube\.com|booth\.pm|[\w-]+\.booth\.pm)[^\s""'<>]*", RO);

    public static int LastPage(string html)
    {
        int max = 1;
        foreach (Match m in PageParam.Matches(html))
            if (int.TryParse(m.Groups["p"].Value, out var p) && p > max) max = p;
        return max;
    }

    public static int? TotalCount(string html)
    {
        var m = Total.Match(StripTags(html));
        return m.Success && int.TryParse(m.Groups["n"].Value.Replace(",", ""), out var n) ? n : null;
    }

    public static IEnumerable<Booth> ParseList(string html)
    {
        foreach (Match m in BoothAnchor.Matches(html))
        {
            int id = int.Parse(m.Groups["id"].Value);
            var attrs = m.Groups["pre"].Value + " " + m.Groups["post"].Value;
            var title = Decode(TitleAttr.Match(attrs) is { Success: true } t ? t.Groups["t"].Value : "");
            var tokens = TextLines(m.Groups["inner"].Value);
            if (tokens.Count == 0 && title == "") continue;

            var name = title != "" ? title : tokens[0];
            // 名前以外の部分からタイプと番号を読む
            var rest = tokens.Where(s => s != name).ToList();
            if (rest.Count == 0 && tokens.Count == 1 && tokens[0].StartsWith(name) && tokens[0].Length > name.Length)
                rest.Add(tokens[0][name.Length..]);

            string? type = null, number = null;
            var joined = string.Join(" ", rest);
            foreach (var kt in KnownTypes)
            {
                if (rest.Any(r => r == kt)) { type = kt; break; }
                if (joined.StartsWith(kt)) { type = kt; break; }
            }
            if (rest.Count > 0)
            {
                var last = rest[^1];
                if (type != null && last.StartsWith(type) && rest.Count == 1)
                {
                    // 「特設特設01」のように1つのテキストに繋がっている場合
                    var tail = last[type.Length..].Trim();
                    number = tail.Length > 0 ? tail : null;
                }
                else if (last != type) number = last;
            }

            yield return new Booth
            {
                Id = id,
                Name = name,
                Type = type,
                Number = number,
                Day = DayOf(type, name),
                Url = $"{Base}/booth/{id}",
            };
        }
    }

    public static Booth Merge(Booth a, Booth b)
    {
        if (string.IsNullOrEmpty(a.Name)) a.Name = b.Name;
        a.Type ??= b.Type;
        a.Number ??= b.Number;
        a.Day = DayOf(a.Type, a.Name);
        return a;
    }

    public static string DayOf(string? type, string name)
    {
        if (type?.Contains("土曜") == true || name.Contains("土曜限定")) return "sat";
        if (type?.Contains("日曜") == true || name.Contains("日曜限定")) return "sun";
        return "both";
    }

    // ゲームページ: <table class="gameStatusDetail"> の th(項目名) と td(値)、<ul class="tag uxTag"> のタグ、「ゲーム体験」の一覧
    static readonly Regex StatusRow = new(@"<th[^>]*>\s*<span[^>]*>(?<k>[^<]+)</span>\s*</th>\s*<td[^>]*>(?<v>.*?)</td>", RO);
    static readonly Regex UxTagList = new(@"<ul\s+class\s*=\s*""tag uxTag[^""]*""[^>]*>(?<in>.*?)</ul>", RO);
    static readonly Regex UxTagItem = new(@"<a\s+href\s*=\s*""[^""]*m_(?<kind>btype|theme)[^""]*""[^>]*>\s*<span>(?<t>[^<]+)</span>", RO);
    static readonly Regex Experience = new(@"<header\s+class\s*=\s*""experience""[^>]*>.*?</header>(?<in>.*?)(?:<header|<div\s+class\s*=\s*""(?:btn|back|share|sns))", RO);

    public static void ApplyGame(GameRef g, string html)
    {
        foreach (Match m in StatusRow.Matches(html))
        {
            // 数字のない値（「歳〜」「〜分」など未入力）は空にする。「120〜120分」は「120分」にする
            string? v = StripTags(m.Groups["v"].Value).Trim();
            v = Regex.Replace(v, @"^(\d+)〜\1(\D*)$", "$1$2");
            if (!Regex.IsMatch(v, @"\d") && Decode(m.Groups["k"].Value) is "プレイ人数" or "プレイ時間" or "対象年齢" or "価格") v = null;
            if (v == "") v = null;
            switch (Decode(m.Groups["k"].Value))
            {
                case "プレイ人数": g.Players = v; break;
                case "プレイ時間": g.Time = v; break;
                case "対象年齢": g.Age = v; break;
                case "価格": g.Price = v; break;
                case "発売時期": g.Release = v; break;
                case "予約": g.Reserve = v; break;
            }
        }
        if (UxTagList.Match(html) is { Success: true } ul)
        {
            var items = UxTagItem.Matches(ul.Groups["in"].Value).Select(x => (Kind: x.Groups["kind"].Value, T: Decode(x.Groups["t"].Value))).ToList();
            var bt = items.Where(x => x.Kind == "btype").Select(x => x.T).Distinct().ToList();
            var th = items.Where(x => x.Kind == "theme").Select(x => x.T).Distinct().ToList();
            g.Btype = bt.Count > 0 ? bt : null;
            g.Theme = th.Count > 0 ? th : null;
        }
        if (Experience.Match(html) is { Success: true } ex)
        {
            var list = StripTags(ex.Groups["in"].Value).Split(new[] { ',', '、', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(x => x.Trim()).Where(x => x != "" && x.Length <= 20).Distinct().ToList();
            g.Exp = list.Count > 0 ? list : null;
        }
    }

    public static void ApplyDetail(Booth b, string html)
    {
        var content = MainContent(html);
        // 画像がないブースは "" にして、「まだ調べていない(null)」と区別する
        b.Image = BoothImage.Match(html) is { Success: true } im ? Decode(im.Groups["u"].Value) : "";

        var games = new Dictionary<int, GameRef>();
        foreach (Match m in GameAnchor.Matches(content))
        {
            int id = int.Parse(m.Groups["id"].Value);
            var attrs = m.Groups["pre"].Value + " " + m.Groups["post"].Value;
            var title = Decode(TitleAttr.Match(attrs) is { Success: true } t ? t.Groups["t"].Value : "");
            if (title == "") title = TextLines(m.Groups["inner"].Value).FirstOrDefault() ?? "";
            if (title == "") title = Decode(AltAttr.Match(m.Groups["inner"].Value) is { Success: true } a ? a.Groups["t"].Value : "");
            if (games.TryGetValue(id, out var g)) { if (g.Title == "" && title != "") g.Title = title; continue; }
            games[id] = new GameRef { Id = id, Title = title, Url = $"{Base}/game/{id}" };
        }
        b.Games = games.Values.ToList();

        b.Links = Sns.Matches(content).Select(m => Decode(m.Value).TrimEnd('/', '.', ')'))
            .Where(u => !u.Contains("GameMarket_", StringComparison.OrdinalIgnoreCase) && !u.Contains("/intent/") && !u.Contains("/share"))
            .Distinct().Take(5).ToList();

        // 紹介文: 本文のテキストから、ブース名・ゲーム名の行を除いたもの
        var gameTitles = new HashSet<string>(b.Games.Select(g => g.Title));
        var lines = TextLines(content)
            .Where(l => l != b.Name && !gameTitles.Contains(l) && l != b.Number && l != b.Type)
            .ToList();
        var text = string.Join("\n", lines);
        b.Description = text.Length == 0 ? null : (text.Length > 800 ? text[..800] + "…" : text);
    }

    /// <summary>ヘッダ（グローバルナビ）とフッタを除いた本文部分。見つからなければ body 全体。</summary>
    static string MainContent(string html)
    {
        var s = html;
        var body = s.IndexOf("<body", StringComparison.OrdinalIgnoreCase);
        if (body >= 0) s = s[body..];
        // フッタはロゴ画像(img-logo_w.png)のリンクから始まる
        var footer = s.IndexOf("img-logo_w.png", StringComparison.OrdinalIgnoreCase);
        if (footer > 0)
        {
            var a = s.LastIndexOf("<a", footer, StringComparison.OrdinalIgnoreCase);
            s = s[..(a > 0 ? a : footer)];
        }
        // ヘッダは「出展申し込み」(/entry) へのリンクで終わる
        var entry = s.LastIndexOf("/entry", StringComparison.OrdinalIgnoreCase);
        if (entry > 0)
        {
            var close = s.IndexOf("</a>", entry, StringComparison.OrdinalIgnoreCase);
            if (close > 0) s = s[(close + 4)..];
        }
        return s;
    }

    static List<string> TextLines(string html)
    {
        var s = ScriptStyle.Replace(html, " ");
        s = BlockTag.Replace(s, "\n");
        s = AnyTag.Replace(s, "\n");
        return Decode(s).Split('\n')
            .Select(l => Regex.Replace(l, @"\s+", " ").Trim())
            .Where(l => l.Length > 0)
            .ToList();
    }

    static string StripTags(string html) => Decode(AnyTag.Replace(ScriptStyle.Replace(html, " "), " "));

    static string Decode(string s) => WebUtility.HtmlDecode(s).Replace(' ', ' ').Trim();
}
