'use client'

import { useState, useEffect, useCallback } from 'react'
import type { Tag } from '@line-crm/shared'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'

const TAG_COLORS = [
  '#06C755', '#3B82F6', '#F59E0B', '#EC4899', '#6366F1',
  '#10B981', '#EF4444', '#8B5CF6', '#F97316', '#14B8A6',
]

export default function TagsPage() {
  const [tags, setTags] = useState<Tag[]>([])
  const [tagCounts, setTagCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newColor, setNewColor] = useState('#06C755')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const { selectedAccount } = useAccount()

  const loadTags = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const res = await api.tags.list(params)
      if (res.success) {
        setTags(res.data)
        // タグごとの友だち数を取得
        const counts: Record<string, number> = {}
        await Promise.all(
          res.data.map(async (tag) => {
            try {
              const p: Record<string, string> = { tagId: tag.id, limit: '1', offset: '0' }
              if (selectedAccount) p.lineAccountId = selectedAccount.id
              const r = await api.friends.list(p)
              if (r.success) counts[tag.id] = r.data.total
            } catch { /* ignore */ }
          })
        )
        setTagCounts(counts)
      } else {
        setError(res.error)
      }
    } catch {
      setError('タグの読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount])

  useEffect(() => { loadTags() }, [loadTags])

  const handleCreate = async () => {
    if (!newName.trim()) { setFormError('タグ名を入力してください'); return }
    setSaving(true)
    setFormError('')
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const res = await api.tags.create({ name: newName.trim(), color: newColor }, params)
      if (res.success) {
        setShowCreate(false)
        setNewName('')
        setNewColor('#06C755')
        loadTags()
      } else {
        setFormError(res.error)
      }
    } catch {
      setFormError('作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？`)) return
    try {
      await api.tags.delete(id)
      loadTags()
    } catch {
      setError('削除に失敗しました')
    }
  }

  return (
    <div>
      <Header
        title="タグ管理"
        action={
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規タグ
          </button>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {showCreate && (
        <div className="mb-6 bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-800 mb-4">新規タグを作成</h2>
          <div className="space-y-4 max-w-sm">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">タグ名 <span className="text-red-500">*</span></label>
              <input
                type="text"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                placeholder="例: セミナー001_4/25"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-2">カラー</label>
              <div className="flex flex-wrap gap-2">
                {TAG_COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setNewColor(c)}
                    className="w-7 h-7 rounded-full border-2 transition-transform hover:scale-110"
                    style={{
                      backgroundColor: c,
                      borderColor: newColor === c ? '#111' : 'transparent',
                    }}
                  />
                ))}
              </div>
            </div>
            {formError && <p className="text-xs text-red-600">{formError}</p>}
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={saving}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50"
                style={{ backgroundColor: '#06C755' }}
              >
                {saving ? '作成中...' : '作成'}
              </button>
              <button
                onClick={() => { setShowCreate(false); setFormError('') }}
                className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg"
              >
                キャンセル
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="bg-white rounded-lg border border-gray-200 p-4 animate-pulse space-y-2">
              <div className="h-3 bg-gray-200 rounded w-1/2" />
              <div className="h-5 bg-gray-100 rounded w-1/3" />
            </div>
          ))}
        </div>
      ) : tags.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">
          タグがありません。「+ 新規タグ」から作成してください。
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {tags.map((tag) => (
            <div
              key={tag.id}
              className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-2 group"
            >
              <div className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: tag.color }}
                />
                <span className="text-sm font-medium text-gray-800 truncate">{tag.name}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-2xl font-bold text-gray-900">
                  {tagCounts[tag.id] ?? '—'}
                </span>
                <span className="text-xs text-gray-400">人</span>
              </div>
              <div className="flex gap-2 mt-1">
                <a
                  href={`/friends?tagId=${tag.id}`}
                  className="text-xs text-blue-600 hover:underline"
                >
                  友だち一覧
                </a>
                <button
                  onClick={() => handleDelete(tag.id, tag.name)}
                  className="text-xs text-red-400 hover:text-red-600 ml-auto opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  削除
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
