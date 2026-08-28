'use client'

/**
 * 古文単語テスト の管理画面。
 *
 * 中身は `components/tests/vocab-admin.tsx` と共有。
 * 生徒から見て英単語テストとは別のテスト（LIFFの入り口も別）なので、
 * 管理画面も分ける。まとめると「古文を解いた生徒が英単語の画面に出る」ことになる。
 */

import VocabAdmin from '@/components/tests/vocab-admin'

export default function Page() {
  return <VocabAdmin title="古文単語テスト" subject="kobun" />
}
