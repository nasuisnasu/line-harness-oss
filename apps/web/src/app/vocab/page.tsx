'use client'

/**
 * 英単語テスト の管理画面。
 *
 * 中身は `components/tests/vocab-admin.tsx` と共有。
 * ここは**どの教科を対象にするか**だけを決める。古文は `/kobun`。
 */

import VocabAdmin from '@/components/tests/vocab-admin'

export default function Page() {
  return <VocabAdmin title="単語テスト" subject="en" />
}
