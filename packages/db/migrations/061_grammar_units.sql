-- 061_grammar_units.sql — 文法テストを単元（sub_category）単位で回せるようにする
--
-- 060 の時点で grammar_questions.sub_category は持っていたが、集計にも出題にも
-- 使っていなかった。分野（21）は粗すぎて「関係詞が弱い」までしか言えないので、
-- 単元（140）を出題の単位・苦手判定の軸にする。
--
-- grammar_answers には sub_category を持たせない。grammar_questions を JOIN すれば
-- 取れるうえ、単元名を直したときに解答側が古い名前のまま残るのを避けたい。
-- （category を冗長に持っているのは 060 時点の判断。こちらは今さら消さない）

-- どの単元を解いたセッションかを残す。NULL なら分野まるごと。
ALTER TABLE grammar_sessions ADD COLUMN sub_category TEXT;

-- 単元別の集計（苦手ランキング）と、単元を指定した出題のため
CREATE INDEX IF NOT EXISTS idx_gq_sub ON grammar_questions (book_id, category, sub_category, no);
