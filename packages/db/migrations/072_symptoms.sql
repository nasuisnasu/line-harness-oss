-- 072_symptoms.sql — 症状の観測と仮説（カルテの中身）
--
-- 正本の設計は `.company/英弱ニキ/lms/karte/01-症状コード_v1.md`。
--
-- ★ なぜ「観測」と「症状」を分けるのか
--   1コード＝1つの演習が作れる単位なので、生徒 × コードは1行でいい（friend_symptoms）。
--   だが**根拠は捨てられない。**「症状名に丸めると単元がずれる」ことが実測で出ている
--   （あみさんの「結果の分詞構文を動名詞と答えた」を「O と M が入れ替わる」に丸めた結果、
--   別の演習を作ってしまった）。だから**生徒が実際に何と答えたか**を観測として全部残す。
--
-- ★ なぜ「2つ以上のデータ源」を列に持たないのか
--   持つと必ず実体とずれる。数えるのは観測の DISTINCT source。
--   単発の観測を仮説に上げないのは、4択の25%と同じで1回では区別がつかないから。
--
-- ★ 状態は4つだけ（設計書のとおり）
--   候補   … AIが出した。まだ演習を出していない
--   検証中 … 演習を配った。結果待ち
--   確定   … 演習で落ちた。授業で扱う
--   棄却   … 演習を通った。カルテから落とす
--   **承認ステップを作らない。**演習が診断を兼ねるので、確定を待たずに配る。
--
-- 時刻はすべて JST。

-- 症状コード v1（44）。画面に名前を出すためだけに持つ。**正本は上の .md。**
-- v2 を作るときは、このテーブルを作り直す（コードの意味を変えて名前だけ差し替えない）。
CREATE TABLE IF NOT EXISTS symptom_codes (
  code       TEXT PRIMARY KEY,
  -- 読み方そのもの／語／文の要素／句／節／崩れた形／文と文／文章全体／設問
  layer      TEXT NOT NULL,
  name       TEXT NOT NULL,
  sign       TEXT,              -- 現れ方。授業で見分けるときの手がかり
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- 観測。**追記だけ。消さない。**
-- 棄却された症状の観測も残す（同じ誤りをまた拾ったとき、前に棄却したことが分かる）
CREATE TABLE IF NOT EXISTS friend_symptom_observations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  code        TEXT NOT NULL REFERENCES symptom_codes (code),
  -- どのデータ源が指したか。仮説に上げてよいかは**この種類の数**で決まる
  --   grammar | bas | vocab | transcript | submission | drill
  -- drill は症状ドリルの結果。設計書の「演習の結果が2つ目の源になる」がこれ
  source      TEXT NOT NULL,
  -- セッションID・VTTのファイル名・submission_id など。あとで現物に戻れるように
  source_ref  TEXT,
  -- **生徒が実際に何と答えたか。**ここを要約しない
  evidence    TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);

CREATE INDEX IF NOT EXISTS idx_symptom_obs_friend ON friend_symptom_observations (friend_id, code);
-- 抽出は launchd で何度も回る。同じ源の同じ根拠を二度積まない（冪等にする）。
-- evidence は長いので先頭120文字で見る（同じ源・同じ参照先で先頭が一致すれば同じ観測）
CREATE UNIQUE INDEX IF NOT EXISTS idx_symptom_obs_dedup
  ON friend_symptom_observations (friend_id, code, source, source_ref, substr(evidence, 1, 120));

-- 症状（生徒 × コード = 1行）
CREATE TABLE IF NOT EXISTS friend_symptoms (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  friend_id     TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  code          TEXT NOT NULL REFERENCES symptom_codes (code),
  -- candidate | testing | confirmed | rejected
  status        TEXT NOT NULL DEFAULT 'candidate',
  -- 打ち手と結果。人が書く欄（何を配ったか・どうだったか）
  note          TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (friend_id, code)
);

CREATE INDEX IF NOT EXISTS idx_friend_symptoms_friend ON friend_symptoms (friend_id, status);

DELETE FROM symptom_codes;
INSERT INTO symptom_codes (code, layer, name, sign, sort_order) VALUES
  ('P1', '読み方そのもの', '返り読み', '後ろから戻って訳を組む', 100),
  ('P2', '読み方そのもの', '逐語訳', '1語ずつ訳を当てる（transcript実証）', 101),
  ('P3', '読み方そのもの', '訳し下げが続かない', '前から読めるが途中で崩れる', 102),
  ('P4', '読み方そのもの', '保持が切れる', '長い主語・挿入で前を忘れる', 103),
  ('P5', '読み方そのもの', '名詞だけ拾う', '動詞の型を落として意味を作る（みよ癖3）', 104),
  ('P6', '読み方そのもの', '自己検知が効かない', '「読めた」と思った文が読めていない', 105),
  ('V1', '語', '未知語を常識で埋める', '文の要になる語も同じ強さで推測（みよ癖4）', 206),
  ('V2', '語', '多義語を最頻義で固定', '1つの訳で押し通す', 207),
  ('V3', '語', '語形を見ない', '接尾辞から品詞が出ない', 208),
  ('V4', '語', '語彙量そのもの', '単語テストの習得率', 209),
  ('S1', '文の要素', '述語(V)が特定できない', '準動詞を述語と見る／述語が2つに見える', 310),
  ('S2', '文の要素', '主語のカタマリを最短で切る', 'of / on / to の後ろを主語から外す（みよ癖2頻出）', 311),
  ('S3', '文の要素', '品詞で文の要素を決める', '「名詞だからO」「形容詞だからC」（報告書B）', 312),
  ('S4', '文の要素', 'O と M の取り違え', '前置詞句をOと見る／Mを本体と見る（あみ）', 313),
  ('S5', '文の要素', 'C が消える', 'SVOC の C を落とす（みよ癖3）', 314),
  ('K1', '句', 'to do の場所', 'S・O／C／名詞の直後／文修飾 の別が出ない', 415),
  ('K2', '句', '-ing の場所 ★', '動名詞（S・O）と分詞構文（文修飾）の別が出ない（あみ 2026-08-26）', 416),
  ('K3', '句', '-ed の場所', '過去分詞と述語の過去形の別が出ない', 417),
  ('K4', '句', '意味の方向（to do）', '目的・結果・判断の根拠・条件の別（あみ）', 418),
  ('K5', '句', '意味の方向（分詞構文）', '時・理由・条件・付帯・**結果** の別（あみ・みよ）', 419),
  ('K6', '句', '名詞の直後の to do', '主格・目的格・副詞的・同格（戻しテスト）', 420),
  ('N1', '節', '節の範囲が取れない', '`[ ]` の終わりが決まらない（あみ）', 521),
  ('N2', '節', '関係詞の格', '主格・目的格・前置詞＋関係詞', 522),
  ('N3', '節', '非制限用法', 'コンマ付き／前の文全体を受ける which（あみ）', 523),
  ('N4', '節', '同格の that', '関係詞の that と区別できない（transcript 10ファイル）', 524),
  ('N5', '節', 'that の省略', '節の始まりを見落とす', 525),
  ('N6', '節', '多義の接続詞', 'as / since / while / that の意味が固定', 526),
  ('N7', '節', '挿入を外せない', 'コンマに挟まれたカタマリで骨格を見失う', 527),
  ('X1', '崩れた形', '省略', '比較の as / than 以下、共通要素の省略', 628),
  ('X2', '崩れた形', '倒置', '否定語・場所句の文頭で主語を見失う', 629),
  ('X3', '崩れた形', 'and が結ぶもの ★', '種類の違うものを結ぼうとする／直前の小さいカタマリに飛びつく／後ろ側の省略に気づかず V を見失う（あみ 2026-08-26・みよ癖5）', 630),
  ('X4', '崩れた形', '形式主語・強調構文', 'it が何を指すか決まらない', 631),
  ('X5', '崩れた形', '比較の構造', '何と何を比べているかが出ない', 632),
  ('R1', '文と文', '因果を並列に潰す', '「。」の間にある矢印を見ない（みよ最重要）', 733),
  ('R2', '文と文', '指示語の指す先', 'this / that / such が何を指すか決めない', 734),
  ('R3', '文と文', '接続副詞を見落とす', 'however / thus / instead を流す', 735),
  ('R4', '文と文', '代名詞の対応', 'it / they の受け先を取り違える', 736),
  ('T1', '文章全体', '段落の役割が見えない', '主張・例・反論・まとめの別が出ない', 837),
  ('T2', '文章全体', '転換点を拾えない', '話の向きが変わる場所を通過する', 838),
  ('T3', '文章全体', '具体と抽象の往復', '例から主張に戻れない', 839),
  ('Q1', '設問', '根拠の場所を決めずに選ぶ', '本文に戻らない', 940),
  ('Q2', '設問', '常識で選択肢を選ぶ', '自分で作った理由に合う語を選ぶ（みよ問11）', 941),
  ('Q3', '設問', '言い換えを追えない', '本文語↔選択肢語の対応が出ない', 942),
  ('Q4', '設問', '時間配分', '前半で溶かす', 943);
