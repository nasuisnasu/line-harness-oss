'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { Tag } from '@line-crm/shared'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'
import GroupPicker from '@/components/group-picker'

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
  const [newGroup, setNewGroup] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editGroup, setEditGroup] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [groupFilter, setGroupFilter] = useState<string>('')
  // Draft groups: names created via "+ 新規グループ" before any tag is attached.
  // Persisted to localStorage so a refresh doesn't wipe them; once a tag with
  // that group_name is saved, the group also lives in the DB-derived list and
  // we drop it from drafts in the merge below.
  const [draftGroups, setDraftGroups] = useState<string[]>(() => {
    if (typeof window === 'undefined') return []
    try {
      const raw = localStorage.getItem('lh_tag_draft_groups')
      return raw ? (JSON.parse(raw) as string[]) : []
    } catch {
      return []
    }
  })
  const { selectedAccount } = useAccount()

  const dbGroups = useMemo(() => {
    const set = new Set<string>()
    for (const t of tags) {
      if (t.groupName) set.add(t.groupName)
    }
    return set
  }, [tags])

  const existingGroups = useMemo(() => {
    const set = new Set<string>(dbGroups)
    for (const g of draftGroups) {
      if (g) set.add(g)
    }
    return Array.from(set).sort()
  }, [dbGroups, draftGroups])

  // Garbage-collect draft groups once their tag exists in the DB so the
  // localStorage list doesn't grow forever.
  useEffect(() => {
    if (draftGroups.length === 0) return
    const stillDraft = draftGroups.filter(g => !dbGroups.has(g))
    if (stillDraft.length !== draftGroups.length) {
      setDraftGroups(stillDraft)
      try { localStorage.setItem('lh_tag_draft_groups', JSON.stringify(stillDraft)) } catch { /* ignore */ }
    }
  }, [dbGroups, draftGroups])

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
      const res = await api.tags.create(
        { name: newName.trim(), color: newColor, groupName: newGroup.trim() || null },
        params,
      )
      if (res.success) {
        setShowCreate(false)
        setNewName('')
        setNewColor('#06C755')
        setNewGroup('')
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

  const handleEdit = (tag: Tag) => {
    setEditingId(tag.id)
    setEditName(tag.name)
    setEditGroup(tag.groupName ?? '')
  }

  const handleSaveEdit = async (id: string) => {
    if (!editName.trim()) return
    setEditSaving(true)
    try {
      await api.tags.update(id, { name: editName.trim(), groupName: editGroup.trim() || null })
      setEditingId(null)
      loadTags()
    } finally {
      setEditSaving(false)
    }
  }

  const handleUpdateGroup = async (id: string, groupName: string | null) => {
    try {
      await api.tags.update(id, { groupName })
      loadTags()
    } catch {
      setError('グループの更新に失敗しました')
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
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">グループ（任意）</label>
              <GroupPicker
                value={newGroup}
                onChange={setNewGroup}
                existingGroups={existingGroups}
                placeholder="例: LP流入 / 属性 / アンケート結果"
              />
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

      {/* Group filter chips — mirrors scenarios page so the grouping concept
          is visible even when no tag has been categorized yet. */}
      {!loading && tags.length > 0 && (
        <div className="mb-3 flex items-center gap-2 flex-wrap">
          <span className="text-xs text-gray-500">グループ:</span>
          <button
            onClick={() => setGroupFilter('')}
            className={`text-xs px-2.5 py-1 rounded-full border ${groupFilter === '' ? 'text-white border-transparent' : 'text-gray-600 bg-white border-gray-300'}`}
            style={groupFilter === '' ? { backgroundColor: '#06C755' } : undefined}
          >
            すべて
          </button>
          {existingGroups.map(g => (
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
                  await api.tags.renameGroup(g, trimmed || null)
                  if (groupFilter === g) setGroupFilter(trimmed || '')
                  loadTags()
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
          {/* Groups don't have their own table — they exist only via tag.group_name.
              "新規グループ" stores the name in `draftGroups` (localStorage-backed)
              so the chip appears immediately without forcing the operator into
              the new-tag form. The group materializes in the DB the first time a
              tag is attached to it. */}
          <button
            onClick={() => {
              const name = window.prompt('新しいグループ名を入力')
              if (name === null) return
              const trimmed = name.trim()
              if (!trimmed) return
              if (existingGroups.includes(trimmed)) {
                setGroupFilter(trimmed)
                return
              }
              const next = [...draftGroups, trimmed]
              setDraftGroups(next)
              try { localStorage.setItem('lh_tag_draft_groups', JSON.stringify(next)) } catch { /* ignore */ }
              setGroupFilter(trimmed)
            }}
            className="text-xs px-2.5 py-1 rounded-full border border-dashed border-gray-400 text-gray-600 bg-white hover:bg-gray-50"
          >
            + 新規グループ
          </button>
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
      ) : (() => {
        const filtered = groupFilter === ''
          ? tags
          : groupFilter === '__none__'
            ? tags.filter(t => !t.groupName)
            : tags.filter(t => t.groupName === groupFilter)
        const buckets = new Map<string, Tag[]>()
        for (const t of filtered) {
          const key = t.groupName ?? '未分類'
          const arr = buckets.get(key) ?? []
          arr.push(t)
          buckets.set(key, arr)
        }
        const orderedGroups = Array.from(buckets.keys()).sort((a, b) => {
          if (a === '未分類') return 1
          if (b === '未分類') return -1
          return a.localeCompare(b)
        })
        return (
          <div className="space-y-6">
            {orderedGroups.map(groupName => {
              const items = buckets.get(groupName)!
              return (
                <div key={groupName}>
                  <div className="mb-2 text-xs font-semibold text-gray-700 px-1 py-1">
                    {groupName} <span className="text-gray-400 font-normal ml-1">({items.length})</span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                    {items.map((tag) => (
                      <div
                        key={tag.id}
                        className="bg-white rounded-lg border border-gray-200 p-4 flex flex-col gap-2 group"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="w-3 h-3 rounded-full flex-shrink-0"
                            style={{ backgroundColor: tag.color }}
                          />
                          {editingId === tag.id ? (
                            <input
                              type="text"
                              className="flex-1 border border-gray-300 rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-green-500"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(tag.id); if (e.key === 'Escape') setEditingId(null) }}
                              autoFocus
                            />
                          ) : (
                            <span className="text-sm font-medium text-gray-800 truncate">{tag.name}</span>
                          )}
                        </div>
                        {editingId === tag.id ? (
                          <>
                            <GroupPicker
                              value={editGroup}
                              onChange={setEditGroup}
                              existingGroups={existingGroups}
                              placeholder="例: LP流入 / 属性"
                            />
                            <div className="flex gap-2">
                              <button onClick={() => handleSaveEdit(tag.id)} disabled={editSaving} className="text-xs px-2 py-1 text-white rounded disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
                                {editSaving ? '保存中' : '保存'}
                              </button>
                              <button onClick={() => setEditingId(null)} className="text-xs px-2 py-1 text-gray-600 bg-gray-100 rounded">キャンセル</button>
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-center justify-between">
                              <span className="text-2xl font-bold text-gray-900">
                                {tagCounts[tag.id] ?? '—'}
                              </span>
                              <span className="text-xs text-gray-400">人</span>
                            </div>
                            {tag.groupName && (
                              <p className="text-[10px] text-gray-400 truncate">{tag.groupName}</p>
                            )}
                            <div className="flex gap-2 mt-1">
                              <a href={`/friends?tagId=${tag.id}`} className="text-xs text-blue-600 hover:underline">友だち一覧</a>
                              <select
                                value={tag.groupName ?? ''}
                                onChange={(e) => handleUpdateGroup(tag.id, e.target.value || null)}
                                className="text-[10px] text-gray-500 bg-transparent border-0 cursor-pointer hover:text-gray-700 opacity-0 group-hover:opacity-100 transition-opacity"
                                title="グループを変更"
                              >
                                <option value="">未分類</option>
                                {existingGroups.map(g => <option key={g} value={g}>{g}</option>)}
                              </select>
                              <button onClick={() => handleEdit(tag)} className="text-xs text-gray-400 hover:text-gray-600 opacity-0 group-hover:opacity-100 transition-opacity">編集</button>
                              <button onClick={() => handleDelete(tag.id, tag.name)} className="text-xs text-red-400 hover:text-red-600 ml-auto opacity-0 group-hover:opacity-100 transition-opacity">削除</button>
                            </div>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })()}
    </div>
  )
}
