# なぜ HTML を no-store にしているか（vercel.json）

LINE内ブラウザ（LIFF）は HTML を強くキャッシュし、`max-age=0, must-revalidate` を
尊重しないことがある。古い HTML が残ると、そこに書かれた**古いハッシュ付き JS** を
読み続けるので、いくらデプロイしても画面が変わらない。

- `/(.*)` … HTML を毎回取りに行かせる（`no-store`）
- `/assets/(.*)` … ファイル名にハッシュが入るので中身が変われば別URL。長期キャッシュでよい

vercel.json に `comment` キーは書けない（`Invalid vercel.json` で build が落ちる）。
補足はこのファイルに書く。
