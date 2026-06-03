'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { api, type FormItem } from '@/lib/api'
import Header from '@/components/layout/header'

export default function FormsPage() {
  const [forms, setForms] = useState<FormItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.forms.list()
      if (res.success) setForms(res.data)
      else setError(res.error)
    } catch {
      setError('フォームの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？`)) return
    await api.forms.delete(id)
    load()
  }

  const copyUrl = async (id: string) => {
    const url = `${window.location.origin}/f?id=${id}&friend={friendId}`
    try {
      await navigator.clipboard.writeText(url)
      alert('回答URLをコピーしました')
    } catch {
      prompt('回答URL', url)
    }
  }

  return (
    <div>
      <Header
        title="フォーム"
        description="アンケート・申込フォームを作成"
        action={
          <Link
            href="/forms/edit"
            className="px-4 py-2 rounded-lg text-white text-sm font-medium"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規作成
          </Link>
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700 mb-4">{error}</div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">読み込み中...</div>
      ) : forms.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-400">
          <p>フォームがまだありません</p>
          <p className="text-xs mt-2">「+ 新規作成」から作成できます</p>
        </div>
      ) : (
        <div className="space-y-3">
          {forms.map(form => (
            <div key={form.id} className="bg-white rounded-lg border border-gray-200 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <h3 className="text-sm font-bold text-gray-900">{form.name}</h3>
                    {form.isActive ? (
                      <span className="text-xs px-2 py-0.5 rounded bg-green-100 text-green-700">公開中</span>
                    ) : (
                      <span className="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-500">停止中</span>
                    )}
                    <span className="text-xs text-gray-400">{form.fields.length}項目</span>
                    <span className="text-xs text-gray-400">回答 {form.submitCount}件</span>
                  </div>
                  {form.displayName && form.displayName !== form.name && (
                    <p className="text-xs text-gray-500 mb-1">回答者向け: 「{form.displayName}」</p>
                  )}
                  {form.description && <p className="text-xs text-gray-500 truncate mb-2">{form.description}</p>}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={() => copyUrl(form.id)}
                    className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
                  >
                    URLコピー
                  </button>
                  <Link
                    href={`/forms/submissions?id=${form.id}`}
                    className="text-xs px-2 py-1 rounded bg-blue-50 text-blue-700 border border-blue-200 hover:bg-blue-100"
                  >
                    回答一覧
                  </Link>
                  <Link
                    href={`/forms/edit?id=${form.id}`}
                    className="text-xs px-2 py-1 rounded bg-gray-100 text-gray-700 hover:bg-gray-200"
                  >
                    編集
                  </Link>
                  <button
                    onClick={() => handleDelete(form.id, form.name)}
                    className="text-xs text-red-500 hover:text-red-700 px-2 py-1"
                  >
                    削除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
