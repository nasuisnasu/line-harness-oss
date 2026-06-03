'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type TrackedLinkItem, type TrackedLinkDetail } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'

export default function TrackedLinksPage() {
  const [links, setLinks] = useState<TrackedLinkItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ name: '', originalUrl: '' })
  const [creating, setCreating] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [details, setDetails] = useState<Record<string, TrackedLinkDetail>>({})
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: '', originalUrl: '' })
  const [editSaving, setEditSaving] = useState(false)
  const { selectedAccount } = useAccount()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const res = await api.trackedLinks.list(params)
      if (res.success) setLinks(res.data)
      else setError(res.error)
    } catch {
      setError('トラッキングリンクの取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount])

  useEffect(() => { load() }, [load])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.name.trim() || !form.originalUrl.trim()) return
    setCreating(true)
    try {
      await api.trackedLinks.create({
        name: form.name,
        originalUrl: form.originalUrl,
        lineAccountId: selectedAccount?.id ?? null,
      })
      setForm({ name: '', originalUrl: '' })
      setShowCreate(false)
      load()
    } catch {
      setError('作成に失敗しました')
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('このリンクを削除しますか？')) return
    await api.trackedLinks.delete(id)
    load()
  }

  const startEdit = (link: TrackedLinkItem) => {
    setEditingId(link.id)
    setEditForm({ name: link.name, originalUrl: link.originalUrl })
  }
  const cancelEdit = () => {
    setEditingId(null)
    setEditForm({ name: '', originalUrl: '' })
  }
  const saveEdit = async (id: string) => {
    if (!editForm.name.trim() || !editForm.originalUrl.trim()) return
    setEditSaving(true)
    try {
      await api.trackedLinks.update(id, { name: editForm.name, originalUrl: editForm.originalUrl })
      cancelEdit()
      load()
    } catch {
      setError('更新に失敗しました')
    } finally {
      setEditSaving(false)
    }
  }

  const toggleExpand = async (id: string) => {
    const next = expandedId === id ? null : id
    setExpandedId(next)
    if (next && !details[id]) {
      try {
        const res = await api.trackedLinks.get(id)
        if (res.success) setDetails(prev => ({ ...prev, [id]: res.data }))
      } catch { /* ignore */ }
    }
  }

  const copyToClipboard = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1500)
    } catch { /* ignore */ }
  }

  return (
    <div>
      <Header
        title="トラッキングリンク"
        description="クリック数を計測する短縮URLの管理"
        action={
          <button
            onClick={() => setShowCreate(!showCreate)}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium"
            style={{ backgroundColor: '#06C755' }}
          >
            {showCreate ? 'キャンセル' : '+ 新規リンク'}
          </button>
        }
      />

      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {showCreate && (
        <form onSubmit={handleCreate} className="bg-white rounded-lg border border-gray-200 p-6 mb-6 space-y-4 max-w-lg">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">リンク名（管理用）</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm({ ...form, name: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="例: 5/2セミナー申込ボタン"
              required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">遷移先URL</label>
            <input
              type="url"
              value={form.originalUrl}
              onChange={e => setForm({ ...form, originalUrl: e.target.value })}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              placeholder="https://example.com/seminar"
              required
            />
          </div>
          <button
            type="submit"
            disabled={creating}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {creating ? '作成中...' : '作成'}
          </button>
        </form>
      )}

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">読み込み中...</div>
      ) : links.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          <p>トラッキングリンクが登録されていません</p>
          <p className="text-xs text-gray-300 mt-2">「新規リンク」から作成してください</p>
        </div>
      ) : (
        <div className="space-y-3">
          {links.map(link => {
            const isExpanded = expandedId === link.id
            const detail = details[link.id]
            const embedTag = `{link:${link.id}}`
            return (
              <div key={link.id} className="bg-white rounded-lg border border-gray-200">
                <div className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      {editingId === link.id ? (
                        <div className="space-y-2">
                          <input
                            value={editForm.name}
                            onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                            placeholder="タイトル"
                            className="w-full text-sm font-bold text-gray-900 border border-gray-300 rounded px-2 py-1"
                          />
                          <input
                            value={editForm.originalUrl}
                            onChange={(e) => setEditForm({ ...editForm, originalUrl: e.target.value })}
                            placeholder="遷移先URL"
                            className="w-full text-xs text-gray-700 font-mono border border-gray-300 rounded px-2 py-1"
                          />
                          <div className="flex gap-2">
                            <button
                              onClick={() => saveEdit(link.id)}
                              disabled={editSaving || !editForm.name.trim() || !editForm.originalUrl.trim()}
                              className="text-xs px-3 py-1 rounded font-medium text-white disabled:opacity-50"
                              style={{ backgroundColor: '#06C755' }}
                            >
                              {editSaving ? '保存中…' : '保存'}
                            </button>
                            <button
                              onClick={cancelEdit}
                              className="text-xs px-3 py-1 rounded text-gray-600 bg-gray-100 hover:bg-gray-200"
                            >
                              キャンセル
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <div className="flex items-center gap-2">
                            <h3 className="text-sm font-bold text-gray-900">{link.name}</h3>
                            <button
                              onClick={() => startEdit(link)}
                              title="タイトル/URL を編集"
                              className="text-xs text-gray-400 hover:text-gray-700"
                            >
                              ✎
                            </button>
                          </div>
                          <p className="text-xs text-gray-500 truncate mt-1">遷移先: {link.originalUrl}</p>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className="text-2xl font-bold text-gray-900">{link.clickCount}</span>
                      <span className="text-xs text-gray-500">クリック</span>
                    </div>
                  </div>

                  <div className="mt-3 space-y-2">
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">配信メッセージに埋め込む（自動的に個別URLに変換されます）</label>
                      <div className="flex gap-2">
                        <input readOnly value={embedTag} className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs font-mono bg-gray-50" />
                        <button
                          onClick={() => copyToClipboard(`tag-${link.id}`, embedTag)}
                          className="px-3 py-1 text-xs font-medium rounded text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200"
                        >
                          {copiedId === `tag-${link.id}` ? 'コピー済' : 'コピー'}
                        </button>
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">直接URL（友達識別なしで使う場合）</label>
                      <div className="flex gap-2">
                        <input readOnly value={link.trackingUrl} className="flex-1 border border-gray-200 rounded px-2 py-1 text-xs font-mono bg-gray-50" />
                        <button
                          onClick={() => copyToClipboard(`url-${link.id}`, link.trackingUrl)}
                          className="px-3 py-1 text-xs font-medium rounded text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200"
                        >
                          {copiedId === `url-${link.id}` ? 'コピー済' : 'コピー'}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
                    <button onClick={() => toggleExpand(link.id)} className="text-xs text-blue-600 hover:underline">
                      {isExpanded ? '詳細を閉じる' : 'クリック詳細を見る'}
                    </button>
                    <button onClick={() => handleDelete(link.id)} className="text-xs text-red-500 hover:text-red-700">
                      削除
                    </button>
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-gray-100 px-4 py-3 bg-gray-50">
                    {!detail ? (
                      <p className="text-xs text-gray-400">読み込み中...</p>
                    ) : detail.clicks.length === 0 ? (
                      <p className="text-xs text-gray-400">まだクリックされていません</p>
                    ) : (
                      <ul className="space-y-1 max-h-60 overflow-auto">
                        {detail.clicks.map(c => (
                          <li key={c.id} className="text-xs text-gray-600 flex items-center justify-between">
                            <span>{c.friendDisplayName ?? '(不明)'}</span>
                            <span className="text-gray-400">{new Date(c.clickedAt).toLocaleString('ja-JP')}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
