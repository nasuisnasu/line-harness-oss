'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'

interface EntryRoute {
  id: string
  refCode: string
  name: string
  tagId: string | null
  scenarioId: string | null
  isActive: boolean
  createdAt: string
  count: number
}

interface Tag { id: string; name: string; color: string }
interface Scenario { id: string; name: string; triggerType: string; isActive: boolean }

export default function EntryRoutesPage() {
  const [routes, setRoutes] = useState<EntryRoute[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState({ refCode: '', name: '', tagId: '', scenarioId: '' })
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ name: '', tagId: '', scenarioId: '' })
  const [editSaving, setEditSaving] = useState(false)
  const { selectedAccount } = useAccount()

  const copyUrl = (url: string, id: string) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(id)
      setTimeout(() => setCopied(null), 1500)
    })
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const [routesRes, tagsRes, scenariosRes] = await Promise.all([
        api.entryRoutes.list(params),
        api.tags.list(params),
        api.scenarios.list(params),
      ])
      if (routesRes.success) setRoutes(routesRes.data)
      if (tagsRes.success) setTags(tagsRes.data)
      if (scenariosRes.success) setScenarios(scenariosRes.data as Scenario[])
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount])

  useEffect(() => { load() }, [load])

  const handleCreate = async () => {
    if (!form.refCode || !form.name) return
    setSaving(true)
    try {
      const res = await api.entryRoutes.create({
        refCode: form.refCode,
        name: form.name,
        tagId: form.tagId || null,
        scenarioId: form.scenarioId || null,
        lineAccountId: selectedAccount?.id ?? null,
      })
      if (res.success) {
        setShowCreate(false)
        setForm({ refCode: '', name: '', tagId: '', scenarioId: '' })
        load()
      }
    } finally {
      setSaving(false)
    }
  }

  const openEdit = (r: EntryRoute) => {
    setEditingId(r.id)
    setEditForm({ name: r.name, tagId: r.tagId ?? '', scenarioId: r.scenarioId ?? '' })
  }

  const handleSaveEdit = async (id: string) => {
    setEditSaving(true)
    try {
      const res = await api.entryRoutes.update(id, {
        name: editForm.name,
        tagId: editForm.tagId || null,
        scenarioId: editForm.scenarioId || null,
      })
      if (res.success) {
        setEditingId(null)
        load()
      }
    } finally {
      setEditSaving(false)
    }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？`)) return
    await api.entryRoutes.delete(id)
    load()
  }

  const liffIdMap: Record<string, { liffId: string; botId: string }> = {
    'd49a3a13-8169-4b25-a669-3c8a4f4f964d': { liffId: '2009821004-brTkmVVK', botId: '@513qujqi' },
    '40adcb23-277b-4d9d-b6e2-92fde47d31fb': { liffId: '2006855304-UfNPHFOn', botId: '' },
  }
  const accountMeta = selectedAccount ? liffIdMap[selectedAccount.id] : null
  const liffId = accountMeta?.liffId ?? '2009821004-brTkmVVK'
  const botId = accountMeta?.botId ?? '@513qujqi'
  const baseUrl = `https://line.me/R/app/${liffId}`

  return (
    <div>
      <Header
        title="流入経路"
        action={
          <button
            onClick={() => setShowCreate(true)}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規追加
          </button>
        }
      />

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">{error}</div>}

      {showCreate && (
        <div className="mb-6 bg-white rounded-lg border border-gray-200 p-5 max-w-md">
          <h2 className="text-sm font-semibold mb-4">新規エントリールート</h2>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">名前 *</label>
              <input type="text" className="w-full border border-gray-300 rounded px-3 py-2 text-sm" placeholder="例: セミナー003" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">refコード * (URLに使用)</label>
              <input type="text" className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono" placeholder="例: seminar003" value={form.refCode} onChange={e => setForm({ ...form, refCode: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">自動付与タグ</label>
              <select className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white" value={form.tagId} onChange={e => setForm({ ...form, tagId: e.target.value })}>
                <option value="">なし</option>
                {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">自動配信シナリオ</label>
              <select className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white" value={form.scenarioId} onChange={e => setForm({ ...form, scenarioId: e.target.value })}>
                <option value="">なし</option>
                {scenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={handleCreate} disabled={saving || !form.refCode || !form.name} className="px-4 py-2 text-sm font-medium text-white rounded disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
                {saving ? '作成中...' : '作成'}
              </button>
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded">キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">{[...Array(3)].map((_, i) => <div key={i} className="h-16 bg-white rounded-lg border border-gray-200 animate-pulse" />)}</div>
      ) : routes.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">エントリールートがありません</div>
      ) : (
        <div className="space-y-3">
          {routes.map(r => {
            const tag = tags.find(t => t.id === r.tagId)
            const scenario = scenarios.find(s => s.id === r.scenarioId)
            const isEditing = editingId === r.id
            return (
              <div key={r.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                {/* カード本体 */}
                <div className="p-4 flex items-start justify-between group">
                  <div className="space-y-1 flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-900 text-sm">{r.name}</span>
                      {tag && (
                        <span className="text-xs px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: tag.color }}>{tag.name}</span>
                      )}
                      {scenario && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{scenario.name}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-gray-500 font-mono truncate">{baseUrl}?liff.state={encodeURIComponent(`?liffId=${liffId}&botId=${botId}&ref=${r.refCode}`)}</span>
                      <button
                        onClick={() => copyUrl(`${baseUrl}?liff.state=${encodeURIComponent(`?liffId=${liffId}&botId=${botId}&ref=${r.refCode}`)}`, r.id)}
                        className="flex-shrink-0 text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-100 transition-colors"
                      >
                        {copied === r.id ? 'コピー済' : 'コピー'}
                      </button>
                    </div>
                  </div>
                  <div className="mx-4 text-right flex-shrink-0">
                    <span className="text-2xl font-bold text-gray-900">{r.count}</span>
                    <span className="text-xs text-gray-400 ml-1">人</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => isEditing ? setEditingId(null) : openEdit(r)}
                      className="text-xs px-2 py-1 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      {isEditing ? '閉じる' : '設定'}
                    </button>
                    <button onClick={() => handleDelete(r.id, r.name)} className="text-xs text-red-400 hover:text-red-600 opacity-0 group-hover:opacity-100">削除</button>
                  </div>
                </div>

                {/* 設定パネル */}
                {isEditing && (
                  <div className="border-t border-gray-100 bg-gray-50 p-4">
                    <div className="grid grid-cols-1 gap-3 max-w-md">
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">名前</label>
                        <input
                          type="text"
                          className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white"
                          value={editForm.name}
                          onChange={e => setEditForm({ ...editForm, name: e.target.value })}
                        />
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">自動付与タグ</label>
                        <select
                          className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white"
                          value={editForm.tagId}
                          onChange={e => setEditForm({ ...editForm, tagId: e.target.value })}
                        >
                          <option value="">なし</option>
                          {tags.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">自動配信シナリオ</label>
                        <select
                          className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white"
                          value={editForm.scenarioId}
                          onChange={e => setEditForm({ ...editForm, scenarioId: e.target.value })}
                        >
                          <option value="">なし</option>
                          {scenarios.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </select>
                      </div>
                      <div className="flex gap-2 pt-1">
                        <button
                          onClick={() => handleSaveEdit(r.id)}
                          disabled={editSaving || !editForm.name}
                          className="px-4 py-2 text-sm font-medium text-white rounded disabled:opacity-50"
                          style={{ backgroundColor: '#06C755' }}
                        >
                          {editSaving ? '保存中...' : '保存'}
                        </button>
                        <button onClick={() => setEditingId(null)} className="px-4 py-2 text-sm text-gray-600 bg-white border border-gray-300 hover:bg-gray-50 rounded">
                          キャンセル
                        </button>
                      </div>
                    </div>
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
