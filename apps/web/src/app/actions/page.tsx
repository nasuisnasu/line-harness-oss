'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type BulkActionItem, type FormFieldItem } from '@/lib/api'
import type { Tag, Scenario } from '@line-crm/shared'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'
import { withGroup } from '@/lib/format-group'

// Disambiguates against the shared `FormFieldItem` import (we don't actually
// need it here — only kept to silence editor auto-imports if they collide).
void (null as unknown as FormFieldItem)

type ActionType = 'enroll_scenario' | 'add_tag' | 'set_richmenu'
type TargetMode = 'all' | 'tag_include' | 'tag_exclude'

const actionTypeLabels: Record<ActionType, string> = {
  enroll_scenario: 'シナリオ配信',
  add_tag: 'タグ付与',
  set_richmenu: 'リッチメニュー切替',
}

const statusLabels: Record<BulkActionItem['status'], string> = {
  pending: '待機中',
  running: '実行中',
  completed: '完了',
  failed: '失敗',
}

const statusColors: Record<BulkActionItem['status'], string> = {
  pending: 'bg-gray-100 text-gray-600',
  running: 'bg-blue-50 text-blue-600',
  completed: 'bg-green-50 text-green-700',
  failed: 'bg-red-50 text-red-700',
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export default function ActionsPage() {
  const [actions, setActions] = useState<BulkActionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [tags, setTags] = useState<Tag[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [richMenus, setRichMenus] = useState<{ id: string; name: string; lineRichmenuId: string | null }[]>([])

  const [name, setName] = useState('')
  const [actionType, setActionType] = useState<ActionType>('enroll_scenario')
  const [scenarioId, setScenarioId] = useState('')
  const [payloadTagId, setPayloadTagId] = useState('')
  const [richMenuId, setRichMenuId] = useState('')
  const [targetMode, setTargetMode] = useState<TargetMode>('tag_include')
  const [targetTagId, setTargetTagId] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [resultMsg, setResultMsg] = useState('')

  const { selectedAccount } = useAccount()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const [actionsRes, tagsRes, scenariosRes, richRes] = await Promise.all([
        api.actions.list(params),
        api.tags.list(params),
        api.scenarios.list(params),
        api.richMenus.list(params),
      ])
      if (actionsRes.success) setActions(actionsRes.data)
      else setError(actionsRes.error)
      if (tagsRes.success) setTags(tagsRes.data)
      if (scenariosRes.success) setScenarios(scenariosRes.data)
      if (richRes.success) setRichMenus(richRes.data.map(r => ({ id: r.id, name: r.name, lineRichmenuId: r.lineRichmenuId })))
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount])

  useEffect(() => { load() }, [load])

  const reset = () => {
    setName('')
    setActionType('enroll_scenario')
    setScenarioId('')
    setPayloadTagId('')
    setRichMenuId('')
    setTargetMode('tag_include')
    setTargetTagId('')
    setFormError('')
  }

  const execute = async () => {
    if (!selectedAccount) {
      setFormError('LINEアカウントを左上で選択してください')
      return
    }
    if (!name.trim()) {
      setFormError('アクション名を入力してください')
      return
    }
    if (actionType === 'enroll_scenario' && !scenarioId) {
      setFormError('配信するシナリオを選択してください')
      return
    }
    if (actionType === 'add_tag' && !payloadTagId) {
      setFormError('付与するタグを選択してください')
      return
    }
    if (actionType === 'set_richmenu' && !richMenuId) {
      setFormError('切替先のリッチメニューを選択してください')
      return
    }
    if ((targetMode === 'tag_include' || targetMode === 'tag_exclude') && !targetTagId) {
      setFormError('対象のタグを選択してください')
      return
    }
    if (!confirm('このアクションを実行しますか？対象全員に即時適用されます')) return

    setSaving(true)
    setFormError('')
    setResultMsg('')
    try {
      const payload: { scenarioId?: string; tagId?: string; richMenuId?: string } = {}
      if (actionType === 'enroll_scenario') payload.scenarioId = scenarioId
      if (actionType === 'add_tag') payload.tagId = payloadTagId
      if (actionType === 'set_richmenu') payload.richMenuId = richMenuId

      const res = await api.actions.create({
        lineAccountId: selectedAccount.id,
        name: name.trim(),
        actionType,
        actionPayload: payload,
        targetSpec: {
          mode: targetMode,
          tagId: targetMode === 'all' ? null : targetTagId,
        },
      })
      if (res.success) {
        setResultMsg(`実行完了: ${res.data.processed}/${res.data.totalTargets}件処理（失敗 ${res.data.failed}件）`)
        setShowCreate(false)
        reset()
        load()
      } else {
        setFormError(res.error)
      }
    } catch {
      setFormError('実行に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('この実行履歴を削除しますか？（実行済みの効果は取り消せません）')) return
    await api.actions.delete(id)
    load()
  }

  const describePayload = (a: BulkActionItem): string => {
    if (a.actionType === 'enroll_scenario') {
      const s = scenarios.find(x => x.id === a.actionPayload.scenarioId)
      return s ? withGroup(s.name, s.groupName) : '（不明なシナリオ）'
    }
    if (a.actionType === 'add_tag') {
      const t = tags.find(x => x.id === a.actionPayload.tagId)
      return t ? withGroup(t.name, t.groupName) : '（不明なタグ）'
    }
    if (a.actionType === 'set_richmenu') {
      const m = richMenus.find(x => x.id === a.actionPayload.richMenuId)
      return m ? m.name : '（不明なリッチメニュー）'
    }
    return ''
  }

  const describeTarget = (a: BulkActionItem): string => {
    if (a.targetSpec.mode === 'all') return '全員'
    const t = tags.find(x => x.id === a.targetSpec.tagId)
    const tagName = t ? withGroup(t.name, t.groupName) : '（不明なタグ）'
    return a.targetSpec.mode === 'tag_include' ? `${tagName} あり` : `${tagName} なし`
  }

  return (
    <div>
      <Header
        title="アクション"
        action={
          <button
            onClick={() => { reset(); setShowCreate(true) }}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規アクション
          </button>
        }
      />

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>}
      {resultMsg && <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded text-sm text-green-700">{resultMsg}</div>}

      {showCreate && (
        <div className="mb-6 bg-white rounded-lg border border-gray-200 p-6 max-w-2xl">
          <h2 className="text-sm font-semibold text-gray-800 mb-4">新規アクションを実行</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">アクション名 <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例: セミナー欠席者を再案内"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">アクション種別 <span className="text-red-500">*</span></label>
              <div className="flex gap-2 flex-wrap">
                {(Object.keys(actionTypeLabels) as ActionType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setActionType(t)}
                    className={`text-xs px-3 py-1.5 rounded border ${actionType === t ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}
                  >
                    {actionTypeLabels[t]}
                  </button>
                ))}
              </div>
            </div>

            {actionType === 'enroll_scenario' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">配信するシナリオ <span className="text-red-500">*</span></label>
                <select
                  value={scenarioId}
                  onChange={(e) => setScenarioId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  <option value="">シナリオを選択...</option>
                  {scenarios.map((s) => (
                    <option key={s.id} value={s.id}>{withGroup(s.name, s.groupName)}</option>
                  ))}
                </select>
              </div>
            )}

            {actionType === 'add_tag' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">付与するタグ <span className="text-red-500">*</span></label>
                <select
                  value={payloadTagId}
                  onChange={(e) => setPayloadTagId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  <option value="">タグを選択...</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>{withGroup(t.name, t.groupName)}</option>
                  ))}
                </select>
              </div>
            )}

            {actionType === 'set_richmenu' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">切替先リッチメニュー <span className="text-red-500">*</span></label>
                <select
                  value={richMenuId}
                  onChange={(e) => setRichMenuId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  <option value="">リッチメニューを選択...</option>
                  {richMenus.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.lineRichmenuId}>
                      {m.name}{!m.lineRichmenuId ? '（未公開）' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="border-t border-gray-100 pt-4">
              <label className="block text-xs font-medium text-gray-600 mb-1">対象 <span className="text-red-500">*</span></label>
              <div className="flex gap-2 flex-wrap mb-2">
                <button type="button" onClick={() => setTargetMode('tag_include')} className={`text-xs px-3 py-1.5 rounded border ${targetMode === 'tag_include' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}>このタグがついている人</button>
                <button type="button" onClick={() => setTargetMode('tag_exclude')} className={`text-xs px-3 py-1.5 rounded border ${targetMode === 'tag_exclude' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}>このタグがついていない人</button>
                <button type="button" onClick={() => setTargetMode('all')} className={`text-xs px-3 py-1.5 rounded border ${targetMode === 'all' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}>全員</button>
              </div>
              {targetMode !== 'all' && (
                <select
                  value={targetTagId}
                  onChange={(e) => setTargetTagId(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  <option value="">タグを選択...</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>{withGroup(t.name, t.groupName)}</option>
                  ))}
                </select>
              )}
            </div>

            {formError && <p className="text-xs text-red-600">{formError}</p>}

            <div className="flex gap-2">
              <button onClick={execute} disabled={saving} className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
                {saving ? '実行中...' : '実行する'}
              </button>
              <button onClick={() => { setShowCreate(false); reset() }} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-sm text-gray-400">読み込み中...</div>
      ) : actions.length === 0 ? (
        <div className="text-center py-12 text-sm text-gray-400">アクションの実行履歴はまだありません。「+ 新規アクション」から実行してください。</div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">名前</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">種別</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">内容</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">対象</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500">処理</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">状態</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">実行日時</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {actions.map((a) => (
                  <tr key={a.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900">{a.name}</td>
                    <td className="px-4 py-3 text-gray-600">{actionTypeLabels[a.actionType]}</td>
                    <td className="px-4 py-3 text-gray-700">{describePayload(a)}</td>
                    <td className="px-4 py-3 text-gray-700">{describeTarget(a)}</td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {a.processedCount}/{a.totalTargets}
                      {a.failedCount > 0 && <span className="text-red-500 ml-1">({a.failedCount}失敗)</span>}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${statusColors[a.status]}`}>
                        {statusLabels[a.status]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{a.executedAt ? formatDate(a.executedAt) : '-'}</td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => handleDelete(a.id)} className="text-xs text-red-500 hover:text-red-700">削除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
