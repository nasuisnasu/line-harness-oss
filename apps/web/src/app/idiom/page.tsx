'use client'

/**
 * 熟語テスト の管理画面。
 *
 * 中身は `components/tests/test-admin.tsx` と共有。
 * ここは**どの問題集を対象にするか**だけを決める。
 * ターゲット1000・速読英熟語・パス単。意味／熟語／例文の穴埋めの3方向。
 */

import TestAdmin from '@/components/tests/test-admin'

export default function Page() {
  return <TestAdmin title="熟語テスト" match={(s) => s.startsWith('idiom-')} />
}
