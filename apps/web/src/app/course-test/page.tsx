'use client'

/**
 * 文法講座テスト の管理画面。
 *
 * 中身は `components/tests/test-admin.tsx` と共有。
 * ここは**どの問題集を対象にするか**だけを決める。
 * 文法講座（全17講）の確認テスト。講に1対1で対応する。
 */

import TestAdmin from '@/components/tests/test-admin'

export default function Page() {
  return <TestAdmin title="文法講座テスト" match={(s) => s === 'grammar-course'} />
}
