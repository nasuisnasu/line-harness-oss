# apps/liff のデプロイ先

## ⚠️ Cloudflare Pages。Vercel ではない。

| | 配信元 |
|---|---|
| **LIFF（このディレクトリ）** | **Cloudflare Pages `readash-liff`** → https://readash-liff.pages.dev |
| 管理画面（`apps/web`） | Vercel `insider-line-crm` |

**LIFFと管理画面でデプロイ先が違う。** ここが事故る。

以前このディレクトリには `vercel.json` があり、Vercel にも `insider-liff` という
プロジェクトが実在した。そのため `vercel deploy` が**成功と表示されるのに
生徒には一切届かない**という状態が起きる。2026-08-14 に半日溶かしたので
`vercel.json` は削除した。`insider-liff` に出さないこと。

## 出しかた

git連携なし・直接アップロードのみ。

```bash
npx vite build
npx wrangler pages deploy dist --project-name readash-liff --branch main
```

## 出したら必ず配信元で検証する

```bash
curl -s https://readash-liff.pages.dev/version.txt
curl -s https://readash-liff.pages.dev/ | grep -o '/assets/index-[^"]*\.js'
```

`public/version.txt` はデプロイのたびに書き換える。LIFFを開かずに
（＝LINEの外から）配信されている版を確認できる唯一の手段。

## 反映されないときは、まず配信元を特定する

キャッシュを疑う前に、実機がどのホストからAPIを叩いているかを見る。

```bash
cd ../worker && npx wrangler tail --format json | grep -i origin
# → この状態で実機からLIFFを開く。Origin ヘッダに配信元がそのまま出る
```

## public/_headers について

LINE内ブラウザはHTMLを抱え込み、古いHTMLが古いハッシュ付きJSを読み続ける。
そのため HTML と `version.txt` は `no-store`、`/assets/*` は `immutable`。

**Cloudflare の `_headers` はマッチしたルールを重ねる（上書きではない）。**
`/*` に `no-store` を書くと assets にも付いて `immutable` と矛盾するので、
`/` `/index.html` `/version.txt` を個別に指定している。
