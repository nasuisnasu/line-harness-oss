/**
 * 受講生テストの共通スタイル
 *
 * 単語テスト（`vocab.ts`）と文法テスト（`grammar.ts`）が同じ見た目を使う。
 * **どちらか片方だけ色やサイズを変えないこと。** 生徒からは同じアプリの別ページに
 * 見えるので、片方だけ浮くとバグに見える。
 *
 * 追加のルールが要るページは、この CSS を入れたうえで自分のぶんを足す
 * （`injectTestStyles()` → 各ページの `injectStyles()`）。
 */

import { NUM_FONT_WOFF2_BASE64 } from './vocab-font.js';

export const TEST_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&family=Noto+Sans+JP:wght@400;500;700&display=swap');
/* 数字用。数字と記号だけのサブセットを埋め込んである（vocab-font.ts） */
@font-face{font-family:'ChakraNum';font-style:normal;font-weight:700;font-display:block;
  src:url(data:font/woff2;base64,${NUM_FONT_WOFF2_BASE64}) format('woff2')}
/* YouTube のトンマナに合わせたダーク配色で固定。端末の設定には追随しない。

   色はスライドから抽出した値をもとに、暗い地の上で沈まないよう彩度と明度を上げてある
   （抽出値 #983CF1 / #DFF04E → 実装 #A93BFF / #D8FF3A）。
   **発光（グロー）は使わない。** 色だけで蛍光感を出す。

   差し色は2色。役割を固定して混ぜないこと。
     --lime        … 押すところと、できたところ。主ボタン、選択中のチップ、
                      スライダーのつまみ、選択中のタブ、習得済み、正解、成績の数字
     --accent（紫）… ブランドの色。上端の進捗バーと出題カードの光の線だけ。
                      暗い地の上では輝度差が小さく、文字やボタンに使うと読みにくい
     --ng          … 誤答と「復習が必要」だけ。それ以外に使わない */
:root{
  --bg:#13161D; --surface:#1A1E27; --surface2:#232833;
  --line:#2A2F3B; --line2:#3A4150;
  --fg:#FFFFFF; --fg2:#A6ADBB; --fg3:#6E7686;
  --accent:#A93BFF; --accent2:#FFFFFF;
  --lime:#D8FF3A; --blue:#4990EF;
  --ok:#D8FF3A; --ng:#FF5A6E;
  --q:26px; --a:21px; --r:10px;
  /* 主役の数字は等幅をやめる。等幅は桁を揃えるための書体で、大きく出すと間延びする。
     ChakraNum は数字と記号だけのサブセット。**和文や英単語には使わない**（落ちる）。 */
  --num:'ChakraNum',-apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif;
  color-scheme: dark;
}
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:var(--bg);color:var(--fg);overflow-x:hidden;
  font-family:"Inter","Noto Sans JP",-apple-system,"Hiragino Sans",sans-serif;
  font-size:16px;line-height:1.75;letter-spacing:-.005em;
  font-feature-settings:"palt" 1;-webkit-font-smoothing:antialiased}
button,input{font-family:inherit;font-size:inherit}
.v-top{background:color-mix(in srgb,var(--bg) 82%,transparent);backdrop-filter:blur(14px);
  border-bottom:1px solid var(--line);padding:11px 16px;display:flex;align-items:center;gap:12px;
  position:sticky;top:0;z-index:5}
.v-top .ttl{font-size:15px;font-weight:700;letter-spacing:-.02em;white-space:nowrap;
  display:flex;align-items:center;gap:8px}
.v-top .ttl::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--lime)}
/* min-width:0 が無いと、flexアイテムの最小幅が中身の長さになって縮まず、
   単語帳名が長いときにヘッダーごと横に伸びて画面全体が横スクロールする。 */
.v-top .rng{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--fg3);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1}
.v-top .cnt{margin-left:auto;font-family:"JetBrains Mono",monospace;font-size:12.5px;font-weight:500;
  color:var(--fg2);border:1px solid var(--line2);padding:2px 10px;border-radius:99px;white-space:nowrap}
.v-bar{height:2px;background:var(--line)}
.v-bar i{display:block;height:100%;background:var(--accent);width:0;
  transition:width .25s cubic-bezier(.4,0,.2,1)}
.v-wrap{max-width:860px;margin:0 auto;padding:18px 14px 40px}
.v-hide{display:none !important}

h1{font-size:24px;font-weight:800;letter-spacing:-.03em;margin:6px 0 4px}
.v-sub{font-size:13px;color:var(--fg2);margin:0 0 18px}
.v-card{border:1px solid var(--line);background:var(--surface);border-radius:var(--r);
  padding:16px 16px;margin:0 0 12px}
.v-card > .lg{display:block;font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:.18em;
  color:var(--fg3);font-weight:500;margin-bottom:12px;text-transform:uppercase}
.v-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.v-num{width:88px;padding:10px;border:1px solid var(--line2);border-radius:8px;
  background:var(--surface2);color:var(--fg);
  font-family:"JetBrains Mono",monospace;font-size:16px;text-align:center;outline:none}
.v-num:focus{border-color:var(--accent)}
.v-hint{font-size:12.5px;color:var(--fg3)}
.v-chip{border:1px solid var(--line2);background:var(--surface2);color:var(--fg2);
  padding:8px 14px;border-radius:99px;cursor:pointer;font-size:13.5px;font-weight:500;transition:.15s}
/* 選択中はライム。紫は暗い地の上だと輝度差が小さく、選ばれているかが読み取りにくい。
   紫は主ボタン（実行）だけに残す。 */
.v-chip.on{border-color:var(--lime);background:color-mix(in srgb,var(--lime) 16%,transparent);
  color:var(--lime);font-weight:700}
.v-chip:active{transform:scale(.97)}
/* 主ボタンはライム地に暗い文字。暗い地の上では紫より圧倒的に読める。
   紫は上端の進捗バーと出題カードの光の線に残し、ブランドの色として効かせる。 */
.v-go{width:100%;margin-top:8px;padding:16px;border:none;background:var(--lime);color:var(--bg);
  font-size:16px;font-weight:800;border-radius:10px;cursor:pointer;letter-spacing:-.01em}
.v-go:active{transform:scale(.99)}
.v-go:disabled{background:var(--line2);color:var(--fg3);cursor:default}
.v-ghost{width:100%;margin-top:8px;padding:14px;border:1px solid var(--line2);background:var(--surface2);
  color:var(--fg);font-size:15px;font-weight:600;border-radius:10px;cursor:pointer}
.v-ghost:active{transform:scale(.99)}
/* ボタンの直後にカードが続くと詰まって見えるので、ここで区切りを作る */
.v-go + .v-card, .v-ghost + .v-card, .v-go + .v-list, .v-ghost + .v-list,
.v-go + .v-stats, .v-ghost + .v-stats{margin-top:26px}
.v-books{display:flex;flex-wrap:wrap;gap:8px}
.v-book{border:1px solid var(--line2);background:var(--surface2);color:var(--fg2);
  padding:10px 14px;border-radius:10px;cursor:pointer;font-size:14px;font-weight:500;
  text-align:left;line-height:1.35}
.v-book.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 14%,transparent);
  color:var(--accent);font-weight:600}
.v-book em{display:block;font-family:"JetBrains Mono",monospace;font-size:10.5px;
  font-style:normal;color:var(--fg3);margin-top:2px;letter-spacing:.03em}
.v-book.on em{color:color-mix(in srgb,var(--accent) 72%,var(--fg3))}

.v-lead{border:1px solid var(--line);background:var(--surface);border-radius:14px;
  padding:16px;margin:0 0 12px}
.v-lead .cap{font-size:13px;color:var(--fg2);margin-bottom:6px}
.v-lead .n{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:32px;font-weight:700;
  color:var(--fg);line-height:1.1;letter-spacing:-.02em}
.v-lead .n em{font-style:normal;font-size:14px;color:var(--fg2);margin-left:4px}

.v-spark{display:block;width:100%;height:118px;margin:8px 0 4px}
.v-stats{display:flex;gap:10px;flex-wrap:wrap}
.v-stat{flex:1;min-width:92px;border:1px solid var(--line);background:var(--surface);
  border-radius:var(--r);padding:13px 14px}
.v-stat b{display:block;font-family:var(--num);font-variant-numeric:tabular-nums;font-size:32px;
  font-weight:700;line-height:1.1;letter-spacing:-.02em}
.v-stat span{font-size:11.5px;color:var(--fg3)}

.v-list{background:var(--surface);border:1px solid var(--line);border-radius:12px;
  margin:0 0 12px;overflow:hidden}
.v-list h3{margin:0;padding:12px 15px;font-size:13px;font-weight:600;color:var(--fg2);
  border-bottom:1px solid var(--line);display:flex;align-items:center;gap:10px}
.v-list h3 em{font-family:"JetBrains Mono",monospace;font-size:10.5px;font-style:normal;
  color:var(--ng);border:1px solid color-mix(in srgb,var(--ng) 45%,transparent);
  padding:2px 9px;border-radius:99px}
.v-list h3.o em{color:var(--lime);border-color:color-mix(in srgb,var(--lime) 45%,transparent)}
.v-list ul{margin:0;padding:2px 0;list-style:none;max-height:300px;overflow:auto}
.v-list li{display:grid;grid-template-columns:40px 1fr;gap:2px 8px;padding:8px 15px;font-size:14.5px;
  border-bottom:1px solid var(--line)}
.v-list li:last-child{border-bottom:none}
.v-list li .n{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--fg3);padding-top:3px;
  grid-row:span 2}
.v-list li .e{font-weight:600;letter-spacing:-.01em}
.v-list li .j{color:var(--fg2);font-size:13.5px}
.v-list li .x{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--ng);margin-left:6px}
.v-list li .t{font-family:"JetBrains Mono",monospace;font-size:10px;color:var(--ng)}

/* ── 下部の固定タブ ── */
/* LINE内ブラウザは戻る操作がしづらいので、画面間の移動は必ずここでできるようにする。 */
.v-nav{position:fixed;left:0;right:0;bottom:0;z-index:20;display:flex;
  background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(14px);
  border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
.v-nav button{flex:1;background:none;border:none;color:var(--fg3);font-family:inherit;
  padding:9px 4px 8px;display:flex;flex-direction:column;align-items:center;gap:3px;
  font-size:11px;font-weight:600;letter-spacing:.02em;cursor:pointer}
.v-nav button svg{width:22px;height:22px;display:block;fill:none;stroke:currentColor;stroke-width:1.7;
  stroke-linecap:round;stroke-linejoin:round}
.v-nav button.on{color:var(--lime)}
.v-nav button:active{transform:scale(.97)}
/* タブに隠れないよう、本文の下に余白を作る */
.v-wrap{padding-bottom:96px}

/* ── 猫のカウントダウン ── */
.v-cat{display:flex;align-items:center;gap:12px;border:1px solid var(--line);
  background:var(--surface);border-radius:14px;padding:12px 14px;margin:0 0 12px}
.v-cat .av{width:52px;height:52px;border-radius:50%;background:#FFF;flex:none;
  display:flex;align-items:center;justify-content:center;overflow:hidden}
.v-cat .av img{width:44px;height:44px;object-fit:contain;display:block}
.v-cat .say{min-width:0}
.v-cat .say em{display:block;font-style:normal;font-size:12.5px;color:var(--fg2);line-height:1.5}
.v-cat .say b{display:block;font-family:var(--num);font-variant-numeric:tabular-nums;
  font-size:30px;font-weight:700;color:var(--lime);line-height:1.15;letter-spacing:-.02em}
.v-cat .say b i{font-style:normal;font-size:.48em;font-weight:700;color:var(--fg2);
  margin-left:4px;letter-spacing:0}
.v-cat .dt{margin-left:auto;text-align:right;font-family:var(--num);
  font-variant-numeric:tabular-nums;font-size:11px;color:var(--fg3);line-height:1.5;flex:none}

/* ── セクション一覧（テストタブ） ── */
.v-sec{display:block;width:100%;text-align:left;border:1px solid var(--line);background:var(--surface);
  color:var(--fg);border-radius:12px;padding:13px 14px;margin:0 0 8px;font-family:inherit;cursor:pointer}
.v-sec:active{transform:scale(.995)}
.v-sec .r1{display:flex;align-items:baseline;gap:10px}
.v-sec .rg{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:16px;font-weight:700;
  letter-spacing:-.01em}
.v-sec .pc{margin-left:auto;font-family:var(--num);font-variant-numeric:tabular-nums;font-size:16px;
  font-weight:700;color:var(--lime)}
.v-sec .pc.zero{color:var(--fg3)}
.v-sec .tr{height:6px;background:var(--surface2);border-radius:99px;overflow:hidden;display:flex;margin-top:8px}
.v-sec .tr i{display:block;height:100%;background:var(--lime)}
.v-sec .tr u{display:block;height:100%;background:color-mix(in srgb,var(--ng) 60%,transparent)}
.v-sec .sub{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:11px;color:var(--fg3);
  margin-top:5px;display:block}
details.v-adv{border:1px solid var(--line);background:var(--surface);border-radius:var(--r);
  padding:0 16px;margin:14px 0 0}
details.v-adv summary{cursor:pointer;padding:14px 0;font-size:13.5px;font-weight:600;color:var(--fg2);
  list-style:none;display:flex;align-items:center;gap:8px}
details.v-adv summary::-webkit-details-marker{display:none}
details.v-adv summary::before{content:"+";font-family:var(--num);color:var(--lime);font-weight:700}
details.v-adv[open] summary::before{content:"−"}
details.v-adv > div{padding-bottom:16px}

/* ── 実力テストのスコア ── */
.v-score-card{border:1px solid var(--line);background:var(--surface);border-radius:14px;
  padding:18px 16px;margin:0 0 12px}
.v-score-card .hd{display:flex;align-items:baseline;gap:10px;margin-bottom:2px}
.v-score-card .hd em{font-style:normal;font-size:13.5px;color:var(--fg2);font-weight:600}
.v-score-card .hd span{margin-left:auto;font-family:var(--num);font-variant-numeric:tabular-nums;
  font-size:11px;color:var(--fg3)}
.v-score-card .val{display:flex;align-items:baseline;gap:10px}
.v-score-card .val b{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:58px;
  font-weight:700;color:var(--lime);line-height:.95;letter-spacing:-.02em}
.v-score-card .val b i{font-style:normal;font-size:.34em;font-weight:700;color:var(--fg2);
  margin-left:4px;vertical-align:.5em;letter-spacing:0}
.v-score-card .val u{text-decoration:none;font-family:var(--num);font-variant-numeric:tabular-nums;
  font-size:13px;color:var(--fg2)}
.v-score-card .none{font-size:13.5px;color:var(--fg2);line-height:1.7}

/* ── 単語帳の選択 ── */
.v-pick{display:block;width:100%;text-align:left;border:1px solid var(--line2);background:var(--surface);
  color:var(--fg);border-radius:12px;padding:18px 16px;margin:0 0 10px;cursor:pointer}
.v-pick.on{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 10%,transparent)}
.v-pick b{display:block;font-size:16.5px;font-weight:700;letter-spacing:-.02em}
.v-pick em{display:block;font-style:normal;font-family:"JetBrains Mono",monospace;font-size:11.5px;
  color:var(--fg3);margin-top:4px}
.v-pick:active{transform:scale(.995)}
.v-switch{display:block;margin:2px 0 14px;background:none;border:none;color:var(--fg3);
  font-size:12.5px;text-decoration:underline;cursor:pointer;padding:0}

/* ── 習得の内訳 ── */
.v-note{font-size:12.5px;color:var(--fg3);line-height:1.7;margin:12px 0 0}

/* ── 範囲スライダー ── */
.v-rng{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:27px;font-weight:700;letter-spacing:-.01em;
  display:flex;align-items:baseline;gap:8px;margin:0 0 2px}
.v-rng small{font-size:12px;color:var(--fg3);font-weight:500}
.v-sl{display:flex;align-items:center;gap:12px;margin:14px 0 0}
.v-sl span{font-size:11.5px;color:var(--fg3);width:34px;flex:none}
.v-sl input[type=range]{flex:1;-webkit-appearance:none;appearance:none;background:transparent;height:28px;margin:0}
.v-sl input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:99px;background:var(--line2)}
.v-sl input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:26px;height:26px;
  border-radius:50%;background:var(--lime);border:none;margin-top:-11px;
  box-shadow:0 0 0 1px var(--bg),0 2px 8px rgba(0,0,0,.35)}
.v-sl input[type=range]::-moz-range-track{height:4px;border-radius:99px;background:var(--line2)}
.v-sl input[type=range]::-moz-range-thumb{width:26px;height:26px;border-radius:50%;
  background:var(--lime);border:none}

/* ── 出題 ── */
.v-stage{background:var(--surface);border:1px solid var(--line);border-radius:14px;
  padding:32px 20px;margin:0 0 12px;text-align:center;position:relative;overflow:hidden}
.v-stage::before{content:"";position:absolute;inset:0 0 auto 0;height:1px;
  background:linear-gradient(90deg,transparent,var(--accent),var(--blue),transparent);opacity:.75}
.v-tbar{position:absolute;top:0;left:0;right:0;height:3px;background:var(--line)}
.v-tbar i{display:block;height:100%;width:100%;background:var(--accent);
  transform-origin:left center;transition:background .2s}
.v-tbar.warn i{background:var(--ng)}
.v-tbar b{position:absolute;right:10px;top:9px;font-family:"JetBrains Mono",monospace;
  font-size:11px;font-weight:500;color:var(--fg3)}
.v-tbar.warn b{color:var(--ng)}
.v-qno{font-family:"JetBrains Mono",monospace;font-size:10.5px;letter-spacing:.2em;color:var(--fg3);
  font-weight:500;margin-bottom:14px}
.v-qword{font-size:var(--q);font-weight:700;line-height:1.35;letter-spacing:-.025em;word-break:break-word}
/* 例文穴埋め。単語1語より文が長いので、行間を広げて読ませる */
.v-cloze{font-size:20px;font-weight:600;line-height:1.75;letter-spacing:-.01em;text-align:left;
  word-break:normal;overflow-wrap:break-word;max-width:34em;margin:0 auto}
.v-blank{display:inline-block;width:5.5em;height:1.05em;vertical-align:-.16em;margin:0 .18em;
  border-bottom:2.5px solid var(--lime);border-radius:1px}
.v-cja{font-size:14px;font-weight:500;line-height:1.7;color:var(--fg2);text-align:left;
  max-width:34em;margin:10px auto 0}
.v-reveal{margin-top:20px;padding-top:18px;border-top:1px solid var(--line)}
.v-aword{font-size:var(--a);font-weight:600;color:var(--lime);line-height:1.5}
.v-opts{display:grid;gap:8px;margin:20px 0 0}
.v-opt{display:flex;align-items:center;gap:11px;padding:12px 13px;border:1px solid var(--line2);
  background:var(--surface2);color:var(--fg);border-radius:10px;cursor:pointer;
  text-align:left;font-size:15px;line-height:1.45;font-weight:500;transition:.14s;width:100%}
.v-opt > span:last-child{min-width:0;word-break:break-word}
.v-opt .k{font-family:"JetBrains Mono",monospace;font-size:11px;font-weight:500;color:var(--fg3);
  border:1px solid var(--line2);width:23px;height:23px;border-radius:6px;display:flex;
  align-items:center;justify-content:center;flex:none}
.v-opt.ok{border-color:var(--lime);background:color-mix(in srgb,var(--lime) 14%,transparent);color:var(--lime)}
.v-opt.ok .k{border-color:var(--lime);color:var(--lime)}
.v-opt.ng{border-color:var(--ng);background:color-mix(in srgb,var(--ng) 12%,transparent);color:var(--ng)}
.v-opt.ng .k{border-color:var(--ng);color:var(--ng)}
.v-acts{display:flex;gap:8px;flex-wrap:wrap}
.v-acts button{flex:1;min-width:120px;padding:14px;border-radius:10px;cursor:pointer;
  font-size:15.5px;font-weight:600;border:1px solid var(--line2);
  background:var(--surface2);color:var(--fg)}
.v-acts button:active{transform:scale(.99)}
.v-acts .pri{background:var(--lime);border-color:var(--lime);color:var(--bg);font-weight:800}
.v-acts .yes{border-color:color-mix(in srgb,var(--lime) 45%,transparent);color:var(--lime)}
.v-acts .no2{border-color:color-mix(in srgb,var(--ng) 45%,transparent);color:var(--ng)}
.v-abort{display:block;margin:16px auto 0;background:none;border:none;color:var(--fg3);
  font-size:12.5px;text-decoration:underline;cursor:pointer}

/* ── 結果 ── */
.v-score{display:flex;align-items:baseline;gap:14px;background:var(--surface);
  border:1px solid var(--line);border-radius:14px;padding:20px;margin:0 0 12px}
.v-score b{font-family:var(--num);font-size:42px;font-weight:700;font-variant-numeric:tabular-nums;
  color:var(--lime);line-height:1;letter-spacing:-.02em}
.v-score span{font-size:13.5px;color:var(--fg2);font-family:var(--num);font-variant-numeric:tabular-nums}
.v-delta{font-family:var(--num);font-variant-numeric:tabular-nums;font-size:14px;color:var(--fg2)}
.v-delta b{color:var(--lime);font-size:20px;font-weight:700}
.v-cp{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px}
.v-cp button{padding:10px 14px;border:1px solid var(--line2);background:var(--surface2);
  color:var(--fg2);border-radius:9px;cursor:pointer;font-size:12.5px;font-weight:600}
.v-cp button.done{border-color:var(--accent);color:var(--accent);
  background:color-mix(in srgb,var(--accent) 12%,transparent)}

/* ── 記録 ── */
.v-hist{width:100%;border-collapse:collapse;font-size:13px}
.v-hist th{font-family:"JetBrains Mono",monospace;font-size:10px;letter-spacing:.1em;color:var(--fg3);
  text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);font-weight:500}
.v-hist td{padding:9px 10px;border-bottom:1px solid var(--line);color:var(--fg2)}
.v-hist td.s{font-family:"JetBrains Mono",monospace;color:var(--fg);font-weight:600}
.v-blk{display:flex;align-items:center;gap:9px;margin-bottom:6px}
.v-blk .lb{font-family:"JetBrains Mono",monospace;font-size:10.5px;color:var(--fg3);width:64px;flex:none}
.v-blk .tr{flex:1;height:7px;background:var(--surface2);border-radius:99px;overflow:hidden}
.v-blk .tr i{display:block;height:100%;background:var(--lime)}
.v-blk .vl{font-family:"JetBrains Mono",monospace;font-size:11px;color:var(--fg2);width:38px;
  text-align:right;flex:none}
.v-empty{text-align:center;color:var(--fg2);font-size:14px;padding:26px 10px}
.v-err{border:1px solid color-mix(in srgb,var(--ng) 45%,transparent);
  background:color-mix(in srgb,var(--ng) 10%,transparent);color:var(--ng);
  border-radius:var(--r);padding:14px;font-size:14px;margin:0 0 12px}
.v-tabs{display:flex;gap:8px;margin:0 0 14px;flex-wrap:wrap}
`;

/** 同じ id では1回しか入らない。画面を描くたびに呼んでよい。 */
export function injectTestStyles(id = 'test-styles'): void {
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = TEST_CSS;
  document.head.appendChild(el);
}
