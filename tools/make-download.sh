#!/usr/bin/env bash
# ダウンロード用の一式（public/download/）を作り直します。
# public/ 配下は静的配信されるので、ここに置いたものはそのまま URL で落とせます。
# 生成物はスナップショットです。正本はリポジトリ側のファイルなので、
# ファイルを更新したらこのスクリプトを実行し直してください。
set -euo pipefail

cd "$(dirname "$0")/.."
root="$PWD"
out="public/download"
stamp="$(date +%Y%m%d)"
zip_name="r9-kibo-chosei-$stamp.zip"

rm -rf "$out"
mkdir -p "$out"

# 個別ダウンロード用のコピー（public/ の外にあるファイルは配信されないため）
cp AGENTS.md            "$out/AGENTS.md"
cp HANDOFF.md           "$out/HANDOFF.md"
cp README.md            "$out/README.md"
cp CLAUDE.md            "$out/CLAUDE.md"
cp supabase/README.md   "$out/supabase-README.md"
cp supabase/matching.sql "$out/matching.sql"

# ソース一式。.git / 生成物 / ローカル専用ファイルは含めません
tmp="$(mktemp -d)"
pkg="$tmp/r9-kibo-chosei"
mkdir -p "$pkg"
cp -R public "$pkg/public"
rm -rf "$pkg/public/download"
cp -R supabase "$pkg/supabase"
cp -R tools "$pkg/tools"
cp AGENTS.md CLAUDE.md HANDOFF.md README.md netlify.toml .gitignore "$pkg/"
( cd "$tmp" && zip -q -r -X "$root/$out/$zip_name" r9-kibo-chosei )
rm -rf "$tmp"

# du -h はブロック単位で切り上がるので実バイト数から出す
human() {
  awk -v b="$(wc -c < "$1")" 'BEGIN {
    if (b < 1024) printf "%d B", b;
    else if (b < 1024*1024) printf "%.1f KB", b/1024;
    else printf "%.1f MB", b/(1024*1024);
  }'
}

{
  cat <<HTML
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>ファイルのダウンロード — R9 黒潮医療人養成プロジェクト 希望調整</title>
<link rel="stylesheet" href="/css/style.css" />
<style>
/* このページ専用。共有の style.css は変更しない */
.dl-main { padding: 16px; max-width: 860px; margin: 0 auto; }
a.dl-btn {
  display: inline-block; text-decoration: none;
  background: var(--color-accent); color: #fff;
  border-radius: 10px; padding: 12px 16px; font-weight: 700; font-size: 0.95rem;
}
.dl-table { min-width: 0; }
.dl-table td:first-child { white-space: nowrap; font-weight: 700; }
.dl-table td:last-child { white-space: nowrap; text-align: right; }
.dl-note li { margin-bottom: 6px; }
</style>
</head>
<body>
<div id="app">
  <div class="header">
    <div class="header-inner">
      <div class="header-title">ファイルのダウンロード</div>
      <div class="header-sub">R9 黒潮医療人養成プロジェクト 希望調整 / 生成日 $(date +%Y-%m-%d)</div>
    </div>
  </div>
  <main class="dl-main">
    <div class="card">
      <h2>ソース一式</h2>
      <p class="muted">フロントエンド（public/）、Supabase 用の SQL、引き継ぎ資料をまとめた ZIP です。</p>
      <p><a class="dl-btn" href="/download/$zip_name" download>$zip_name（$(human "$out/$zip_name")）をダウンロード</a></p>
    </div>

    <div class="card">
      <h2>個別のファイル</h2>
      <div class="table-wrap">
      <table class="dl-table">
        <thead><tr><th>ファイル</th><th>内容</th><th>サイズ</th></tr></thead>
        <tbody>
          <tr><td><a href="/download/HANDOFF.md" download>HANDOFF.md</a></td><td>引き継ぎ資料・運用手順・未対応事項</td><td>$(human "$out/HANDOFF.md")</td></tr>
          <tr><td><a href="/download/matching.sql" download>matching.sql</a></td><td>1次／2次マッチングの SQL（Supabase の SQL Editor に貼り付けて実行）</td><td>$(human "$out/matching.sql")</td></tr>
          <tr><td><a href="/download/supabase-README.md" download>supabase-README.md</a></td><td>SQL の適用手順</td><td>$(human "$out/supabase-README.md")</td></tr>
          <tr><td><a href="/download/AGENTS.md" download>AGENTS.md</a></td><td>スキーマの実態と実装上の前提（技術的な正典）</td><td>$(human "$out/AGENTS.md")</td></tr>
          <tr><td><a href="/download/CLAUDE.md" download>CLAUDE.md</a></td><td>クラウド版の Claude Code が最初に読む入口</td><td>$(human "$out/CLAUDE.md")</td></tr>
          <tr><td><a href="/download/README.md" download>README.md</a></td><td>プロジェクト概要・ローカル起動</td><td>$(human "$out/README.md")</td></tr>
          <tr><td><a href="/js/app.js" download>app.js</a></td><td>アプリ本体（画面・ルーティング・Supabase 呼び出し）</td><td>$(human public/js/app.js)</td></tr>
          <tr><td><a href="/css/style.css" download>style.css</a></td><td>スタイル</td><td>$(human public/css/style.css)</td></tr>
          <tr><td><a href="/index.html" download>index.html</a></td><td>HTML の外枠</td><td>$(human public/index.html)</td></tr>
        </tbody>
      </table>
      </div>
    </div>

    <div class="card">
      <h2>注意</h2>
      <ul class="muted dl-note">
        <li>ここにあるのは生成時点のスナップショットです。正本はリポジトリのファイルなので、更新したら <code>tools/make-download.sh</code> を実行し直してください。</li>
        <li>秘密情報は含まれていません。<code>app.js</code> の Supabase キーは公開前提の publishable / anon キーのみです。</li>
        <li><code>matching.sql</code> はこのリポジトリからは実行されません。Supabase の SQL Editor に全文を貼り付けて実行してください。</li>
      </ul>
    </div>
  </main>
  <footer>R9 黒潮医療人養成プロジェクト</footer>
</div>
</body>
</html>
HTML
} > "$out/index.html"

echo "generated $out:"
ls -l "$out"
