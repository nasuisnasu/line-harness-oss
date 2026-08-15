-- 単語テストに「例文穴埋め」形式を足す。
--
-- example は空所を ___ で表した英文。pos は4択のダミーを同じ品詞から選ぶために持つ。
-- 空所には必ず原形（名詞は単数）が入る文脈だけを作る。活用形が答えを教えないため。
ALTER TABLE vocab_words ADD COLUMN example TEXT;
ALTER TABLE vocab_words ADD COLUMN example_ja TEXT;
ALTER TABLE vocab_words ADD COLUMN pos TEXT;   -- v / n / adj / adv

-- 例文があり、かつ同じ品詞の語を引く（ダミー選び・出題対象の抽出）
CREATE INDEX IF NOT EXISTS idx_vocab_words_pos
  ON vocab_words (book_id, pos) WHERE example IS NOT NULL;
