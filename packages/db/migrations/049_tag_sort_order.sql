-- タグの並び替え用カラム。既存タグは 0 で、未設定時は name 順にフォールバック。
ALTER TABLE tags ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
