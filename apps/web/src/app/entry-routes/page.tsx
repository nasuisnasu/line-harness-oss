'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import GroupPicker from '@/components/group-picker'
import { useAccount } from '@/lib/account-context'
import { withGroup } from '@/lib/format-group'

interface EntryRoute {
  id: string
  refCode: string
  name: string
  tagId: string | null
  tagIds: string[]
  scenarioId: string | null
  lineAccountId?: string | null
  isActive: boolean
  groupName: string | null
  createdAt: string
  count: number
  totalRevenue: number
}

interface Tag { id: string; name: string; color: string; groupName?: string | null }
interface Scenario { id: string; name: string; triggerType: string; isActive: boolean; groupName?: string | null }

export default function EntryRoutesPage() {
  const [routes, setRoutes] = useState<EntryRoute[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [form, setForm] = useState<{ refCode: string; name: string; tagIds: string[]; scenarioId: string; groupName: string }>({ refCode: '', name: '', tagIds: [], scenarioId: '', groupName: '' })
  const [saving, setSaving] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<{ name: string; tagIds: string[]; scenarioId: string; groupName: string }>({ name: '', tagIds: [], scenarioId: '', groupName: '' })
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [groupFilter, setGroupFilter] = useState<string>('')
  const existingGroups = useMemo(
    () => Array.from(new Set(routes.map(r => r.groupName).filter((g): g is string => !!g))).sort(),
    [routes],
  )
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
    if (!form.name) return
    setSaving(true)
    try {
      const res = await api.entryRoutes.create({
        refCode: form.refCode || undefined,
        name: form.name,
        tagIds: form.tagIds,
        scenarioId: form.scenarioId || null,
        lineAccountId: selectedAccount?.id ?? null,
        groupName: form.groupName.trim() || null,
      })
      if (res.success) {
        setShowCreate(false)
        setForm({ refCode: '', name: '', tagIds: [], scenarioId: '', groupName: '' })
        load()
      }
    } finally {
      setSaving(false)
    }
  }

  const openEdit = (r: EntryRoute) => {
    setEditingId(r.id)
    setEditForm({ name: r.name, tagIds: r.tagIds ?? [], scenarioId: r.scenarioId ?? '', groupName: r.groupName ?? '' })
  }

  const handleSaveEdit = async (id: string) => {
    setEditSaving(true)
    try {
      const res = await api.entryRoutes.update(id, {
        name: editForm.name,
        tagIds: editForm.tagIds,
        scenarioId: editForm.scenarioId || null,
        groupName: editForm.groupName.trim() || null,
      })
      if (res.success) {
        setEditingId(null)
        load()
      }
    } finally {
      setEditSaving(false)
    }
  }

  const toggleTag = (tagId: string, current: string[], setter: (next: string[]) => void) => {
    setter(current.includes(tagId) ? current.filter(id => id !== tagId) : [...current, tagId])
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`「${name}」を削除しますか？`)) return
    await api.entryRoutes.delete(id)
    load()
  }

  const liffIdMap: Record<string, { liffId: string; botId: string }> = {
    'd49a3a13-8169-4b25-a669-3c8a4f4f964d': { liffId: '2009821004-brTkmVVK', botId: '@513qujqi' },
    '40adcb23-277b-4d9d-b6e2-92fde47d31fb': { liffId: '2006855304-UfNPHFOn', botId: '@893nrbyp' },
  }
  // Get LIFF meta for a specific route (uses route's own line_account_id, falls back to selected account)
  const getRouteMeta = (r: EntryRoute) => {
    const accountId = r.lineAccountId ?? selectedAccount?.id ?? ''
    return liffIdMap[accountId] ?? liffIdMap['d49a3a13-8169-4b25-a669-3c8a4f4f964d']
  }

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
              <label className="block text-xs font-medium text-gray-600 mb-1">refコード（任意・URL末尾に使用）</label>
              <input type="text" className="w-full border border-gray-300 rounded px-3 py-2 text-sm font-mono" placeholder="未入力なら自動採番（例: r-a1b2c3d4）" value={form.refCode} onChange={e => setForm({ ...form, refCode: e.target.value })} />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">グループ（任意）</label>
              <GroupPicker
                value={form.groupName}
                onChange={(v) => setForm({ ...form, groupName: v })}
                existingGroups={existingGroups}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">自動付与タグ（複数選択可）</label>
              <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto border border-gray-200 rounded p-2 bg-gray-50">
                {tags.length === 0 ? (
                  <span className="text-xs text-gray-400">タグがありません</span>
                ) : tags.map(t => {
                  const selected = form.tagIds.includes(t.id)
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => toggleTag(t.id, form.tagIds, (next) => setForm({ ...form, tagIds: next }))}
                      className={`text-xs px-2.5 py-1 rounded-full border transition-all ${selected ? 'text-white border-transparent' : 'text-gray-600 bg-white border-gray-300 hover:border-gray-400'}`}
                      style={selected ? { backgroundColor: t.color } : undefined}
                    >
                      {selected ? '✓ ' : ''}{t.name}
                    </button>
                  )
                })}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">自動配信シナリオ</label>
              <select className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white" value={form.scenarioId} onChange={e => setForm({ ...form, scenarioId: e.target.value })}>
                <option value="">なし</option>
                {scenarios.map(s => <option key={s.id} value={s.id}>{withGroup(s.name, s.groupName)}</option>)}
              </select>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={handleCreate} disabled={saving || !form.name} className="px-4 py-2 text-sm font-medium text-white rounded disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
                {saving ? '作成中...' : '作成'}
              </button>
              <button onClick={() => setShowCreate(false)} className="px-4 py-2 text-sm text-gray-600 bg-gray-100 hover:bg-gray-200 rounded">キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {!loading && routes.length > 0 && (() => {
        const groupNames = Array.from(new Set(routes.map(r => r.groupName).filter((g): g is string => !!g))).sort()
        return (
          <div className="mb-3 flex items-center gap-2 flex-wrap">
            <span className="text-xs text-gray-500">グループ:</span>
            <button
              onClick={() => setGroupFilter('')}
              className={`text-xs px-2.5 py-1 rounded-full border ${groupFilter === '' ? 'text-white border-transparent' : 'text-gray-600 bg-white border-gray-300'}`}
              style={groupFilter === '' ? { backgroundColor: '#06C755' } : undefined}
            >
              すべて
            </button>
            {groupNames.map(g => (
              <span key={g} className={`inline-flex items-center text-xs rounded-full border ${groupFilter === g ? 'text-white border-transparent' : 'text-gray-600 bg-white border-gray-300'}`} style={groupFilter === g ? { backgroundColor: '#06C755' } : undefined}>
                <button
                  onClick={() => setGroupFilter(g)}
                  className="pl-2.5 pr-1 py-1"
                >
                  {g}
                </button>
                <button
                  onClick={async () => {
                    const next = window.prompt(`グループ名を編集（空欄で「未分類」へ移動）`, g)
                    if (next === null) return
                    const trimmed = next.trim()
                    if (trimmed === g) return
                    await api.entryRoutes.renameGroup(g, trimmed || null)
                    if (groupFilter === g) setGroupFilter(trimmed || '')
                    load()
                  }}
                  title="グループ名を編集"
                  className={`pl-1 pr-2 py-1 text-[10px] ${groupFilter === g ? 'text-white/70 hover:text-white' : 'text-gray-400 hover:text-gray-600'}`}
                >
                  ✎
                </button>
              </span>
            ))}
            <button
              onClick={() => setGroupFilter('__none__')}
              className={`text-xs px-2.5 py-1 rounded-full border ${groupFilter === '__none__' ? 'text-white border-transparent' : 'text-gray-500 bg-white border-gray-300'}`}
              style={groupFilter === '__none__' ? { backgroundColor: '#9CA3AF' } : undefined}
            >
              未分類
            </button>
          </div>
        )
      })()}
      {loading ? (
        <div className="space-y-3">{[...Array(3)].map((_, i) => <div key={i} className="h-16 bg-white rounded-lg border border-gray-200 animate-pulse" />)}</div>
      ) : routes.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">エントリールートがありません</div>
      ) : (
        (() => {
          const filtered = groupFilter === ''
            ? routes
            : groupFilter === '__none__'
              ? routes.filter(r => !r.groupName)
              : routes.filter(r => r.groupName === groupFilter)
          // Bucket by group, '未分類' for null. Preserve creation-desc order
          // within each bucket (the API already returns DESC).
          const buckets = new Map<string, EntryRoute[]>()
          for (const r of filtered) {
            const key = r.groupName ?? '未分類'
            const arr = buckets.get(key) ?? []
            arr.push(r)
            buckets.set(key, arr)
          }
          // Sort group names alphabetically; keep '未分類' last for cosmetic reasons.
          const orderedGroups = Array.from(buckets.keys()).sort((a, b) => {
            if (a === '未分類') return 1
            if (b === '未分類') return -1
            return a.localeCompare(b)
          })
          return (
            <div className="space-y-6">
              {orderedGroups.map(groupName => {
                const items = buckets.get(groupName)!
                const collapsed = collapsedGroups.has(groupName)
                return (
                  <div key={groupName}>
                    <button
                      type="button"
                      onClick={() => {
                        setCollapsedGroups(prev => {
                          const next = new Set(prev)
                          if (next.has(groupName)) next.delete(groupName)
                          else next.add(groupName)
                          return next
                        })
                      }}
                      className="w-full mb-2 flex items-center justify-between text-left text-xs font-semibold text-gray-700 px-1 py-1 hover:text-gray-900"
                    >
                      <span>
                        {collapsed ? '▶' : '▼'} {groupName} <span className="text-gray-400 font-normal ml-1">({items.length})</span>
                      </span>
                    </button>
                    {!collapsed && <div className="space-y-3">
                      {items.map(r => {
            const routeTags = (r.tagIds ?? []).map(id => tags.find(t => t.id === id)).filter(Boolean) as Tag[]
            const scenario = scenarios.find(s => s.id === r.scenarioId)
            const isEditing = editingId === r.id
            return (
              <div key={r.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
                {/* カード本体 */}
                <div className="p-4 flex items-start justify-between group">
                  <div className="space-y-1 flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-900 text-sm">{r.name}</span>
                      {routeTags.map(tag => (
                        <span key={tag.id} title={tag.groupName ? `グループ: ${tag.groupName}` : undefined} className="text-xs px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: tag.color }}>{tag.name}{tag.groupName ? <span className="opacity-70 ml-0.5">（{tag.groupName}）</span> : null}</span>
                      ))}
                      {scenario && (
                        <span className="text-xs px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{withGroup(scenario.name, scenario.groupName)}</span>
                      )}
                      {/* Inline group setter — pick a group / create one
                          without opening the full edit panel. */}
                      <select
                        value={r.groupName ?? ''}
                        onChange={async (e) => {
                          const v = e.target.value
                          if (v === '__new__') {
                            const name = window.prompt('新しいグループ名を入力')?.trim()
                            if (!name) return
                            await api.entryRoutes.update(r.id, { groupName: name })
                            load()
                            return
                          }
                          await api.entryRoutes.update(r.id, { groupName: v || null })
                          load()
                        }}
                        className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5 bg-white text-gray-700"
                      >
                        <option value="">未分類</option>
                        {existingGroups.map((g) => (
                          <option key={g} value={g}>{g}</option>
                        ))}
                        <option value="__new__">+ 新規グループ…</option>
                      </select>
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      {(() => { const m = getRouteMeta(r); const url = `https://liff.line.me/${m.liffId}?ref=${encodeURIComponent(r.refCode)}&liffId=${m.liffId}&botId=${encodeURIComponent(m.botId)}`; return (<><span className="text-xs text-gray-500 font-mono truncate">{url}</span><button onClick={() => copyUrl(url, r.id)}
                        className="flex-shrink-0 text-xs px-2 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-gray-100 transition-colors">{copied === r.id ? 'コピー済' : 'コピー'}</button></>) })()}
                    </div>
                  </div>
                  <div className="mx-4 text-right flex-shrink-0 flex items-baseline gap-4">
                    <div>
                      <span className="text-2xl font-bold text-gray-900">{r.count}</span>
                      <span className="text-xs text-gray-400 ml-1">人</span>
                    </div>
                    <div>
                      <span className={`text-lg font-semibold ${r.totalRevenue > 0 ? 'text-green-600' : 'text-gray-300'}`}>
                        ¥{(r.totalRevenue ?? 0).toLocaleString('ja-JP')}
                      </span>
                      <span className="text-xs text-gray-400 ml-1">累計売上</span>
                    </div>
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
                        <label className="block text-xs font-medium text-gray-600 mb-1">自動付与タグ（複数選択可）</label>
                        <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto border border-gray-200 rounded p-2 bg-white">
                          {tags.length === 0 ? (
                            <span className="text-xs text-gray-400">タグがありません</span>
                          ) : tags.map(t => {
                            const selected = editForm.tagIds.includes(t.id)
                            return (
                              <button
                                key={t.id}
                                type="button"
                                onClick={() => toggleTag(t.id, editForm.tagIds, (next) => setEditForm({ ...editForm, tagIds: next }))}
                                className={`text-xs px-2.5 py-1 rounded-full border transition-all ${selected ? 'text-white border-transparent' : 'text-gray-600 bg-white border-gray-300 hover:border-gray-400'}`}
                                style={selected ? { backgroundColor: t.color } : undefined}
                              >
                                {selected ? '✓ ' : ''}{t.name}
                              </button>
                            )
                          })}
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">自動配信シナリオ</label>
                        <select
                          className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white"
                          value={editForm.scenarioId}
                          onChange={e => setEditForm({ ...editForm, scenarioId: e.target.value })}
                        >
                          <option value="">なし</option>
                          {scenarios.map(s => <option key={s.id} value={s.id}>{withGroup(s.name, s.groupName)}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-medium text-gray-600 mb-1">グループ（任意）</label>
                        <GroupPicker
                          value={editForm.groupName}
                          onChange={(v) => setEditForm({ ...editForm, groupName: v })}
                          existingGroups={existingGroups}
                        />
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
                    </div>}
                  </div>
                )
              })}
            </div>
          )
        })()
      )}
    </div>
  )
}
