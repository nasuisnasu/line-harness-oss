'use client'

import { useState, useEffect, useCallback } from 'react'
import { api, type AutoReplyItem } from '@/lib/api'
import type { Tag, Scenario } from '@line-crm/shared'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'
import { withGroup } from '@/lib/format-group'

type ResponseType = 'text' | 'template' | 'add_tag' | 'enroll_scenario'

const responseTypeLabels: Record<ResponseType, string> = {
  text: 'テキストを送信',
  template: 'テンプレートを送信',
  add_tag: 'タグを付与',
  enroll_scenario: 'シナリオを開始',
}

interface FormState {
  keyword: string
  matchType: 'exact' | 'contains'
  responseType: ResponseType
  responseContent: string
  isActive: boolean
}

const empty: FormState = {
  keyword: '',
  matchType: 'contains',
  responseType: 'text',
  responseContent: '',
  isActive: true,
}

export default function AutoRepliesPage() {
  const [rules, setRules] = useState<AutoReplyItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(empty)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')
  const [tags, setTags] = useState<Tag[]>([])
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [templates, setTemplates] = useState<{ id: string; name: string; messageType: string; category: string }[]>([])
  const { selectedAccount } = useAccount()

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const [rulesRes, tagsRes, scenariosRes, tplRes] = await Promise.all([
        api.autoReplies.list(params),
        api.tags.list(params),
        api.scenarios.list(params),
        api.templates.list(undefined, params),
      ])
      if (rulesRes.success) setRules(rulesRes.data)
      else setError(rulesRes.error)
      if (tagsRes.success) setTags(tagsRes.data)
      if (scenariosRes.success) setScenarios(scenariosRes.data)
      if (tplRes.success) setTemplates(tplRes.data.map(t => ({ id: t.id, name: t.name, messageType: t.messageType, category: t.category })))
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount])

  useEffect(() => { load() }, [load])

  const openCreate = () => {
    setEditingId(null)
    setForm(empty)
    setFormError('')
    setShowForm(true)
  }

  const openEdit = (rule: AutoReplyItem) => {
    setEditingId(rule.id)
    setForm({
      keyword: rule.keyword,
      matchType: rule.matchType,
      responseType: (['text', 'template', 'add_tag', 'enroll_scenario'].includes(rule.responseType)
        ? rule.responseType
        : 'text') as ResponseType,
      responseContent: rule.responseContent,
      isActive: rule.isActive,
    })
    setFormError('')
    setShowForm(true)
  }

  const cancel = () => {
    setShowForm(false)
    setEditingId(null)
    setForm(empty)
    setFormError('')
  }

  const handleSave = async () => {
    if (!form.keyword.trim()) { setFormError('キーワードを入力してください'); return }
    if (!form.responseContent) { setFormError('アクションの内容を選択／入力してください'); return }
    setSaving(true)
    setFormError('')
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const payload = {
        keyword: form.keyword.trim(),
        matchType: form.matchType,
        responseType: form.responseType,
        responseContent: form.responseContent,
        isActive: form.isActive,
      }
      const res = editingId
        ? await api.autoReplies.update(editingId, payload)
        : await api.autoReplies.create(payload, params)
      if (res.success) {
        cancel()
        load()
      } else {
        setFormError(res.error)
      }
    } catch {
      setFormError(editingId ? '更新に失敗しました' : '作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('このルールを削除しますか？')) return
    await api.autoReplies.delete(id)
    load()
  }

  const handleToggle = async (rule: AutoReplyItem) => {
    await api.autoReplies.update(rule.id, { isActive: !rule.isActive })
    load()
  }

  const describeContent = (rule: AutoReplyItem): string => {
    if (rule.responseType === 'text') return rule.responseContent.slice(0, 50) + (rule.responseContent.length > 50 ? '...' : '')
    if (rule.responseType === 'template') {
      const t = templates.find(x => x.id === rule.responseContent)
      return t ? t.name : '（不明なテンプレート）'
    }
    if (rule.responseType === 'add_tag') {
      const t = tags.find(x => x.id === rule.responseContent)
      return t ? withGroup(t.name, t.groupName) : '（不明なタグ）'
    }
    if (rule.responseType === 'enroll_scenario') {
      const s = scenarios.find(x => x.id === rule.responseContent)
      return s ? withGroup(s.name, s.groupName) : '（不明なシナリオ）'
    }
    return rule.responseContent.slice(0, 30)
  }

  return (
    <div>
      <Header
        title="キーワード自動応答"
        action={
          <button
            onClick={openCreate}
            className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90"
            style={{ backgroundColor: '#06C755' }}
          >
            + 新規ルール
          </button>
        }
      />

      {error && <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">{error}</div>}

      {showForm && (
        <div className="mb-6 bg-white rounded-lg border border-gray-200 p-6 max-w-2xl">
          <h2 className="text-sm font-semibold text-gray-800 mb-4">{editingId ? 'ルールを編集' : '新規ルール'}</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">キーワード <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={form.keyword}
                onChange={(e) => setForm({ ...form, keyword: e.target.value })}
                placeholder="例: 受講"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">マッチング方式</label>
              <div className="flex gap-2">
                <button type="button" onClick={() => setForm({ ...form, matchType: 'exact' })} className={`text-xs px-3 py-1.5 rounded border ${form.matchType === 'exact' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}>
                  完全一致
                </button>
                <button type="button" onClick={() => setForm({ ...form, matchType: 'contains' })} className={`text-xs px-3 py-1.5 rounded border ${form.matchType === 'contains' ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}>
                  部分一致
                </button>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">アクション種別</label>
              <div className="flex gap-2 flex-wrap">
                {(Object.keys(responseTypeLabels) as ResponseType[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setForm({ ...form, responseType: t, responseContent: '' })}
                    className={`text-xs px-3 py-1.5 rounded border ${form.responseType === t ? 'border-[#06C755] bg-[#06C755]/10 text-[#06C755]' : 'border-gray-300 text-gray-600 bg-white'}`}
                  >
                    {responseTypeLabels[t]}
                  </button>
                ))}
              </div>
            </div>

            {form.responseType === 'text' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">送信するテキスト <span className="text-red-500">*</span></label>
                <textarea
                  value={form.responseContent}
                  onChange={(e) => setForm({ ...form, responseContent: e.target.value })}
                  rows={4}
                  placeholder="例: お問い合わせありがとうございます！"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-none"
                />
              </div>
            )}

            {form.responseType === 'template' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">送信するテンプレート <span className="text-red-500">*</span></label>
                <select
                  value={form.responseContent}
                  onChange={(e) => setForm({ ...form, responseContent: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  <option value="">テンプレートを選択...</option>
                  {Object.entries(
                    templates.reduce<Record<string, typeof templates>>((acc, t) => {
                      const key = t.category || 'general'
                      if (!acc[key]) acc[key] = []
                      acc[key].push(t)
                      return acc
                    }, {}),
                  ).map(([cat, items]) => (
                    <optgroup key={cat} label={cat}>
                      {items.map((t) => (
                        <option key={t.id} value={t.id}>{t.name}（{t.messageType}）</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </div>
            )}

            {form.responseType === 'add_tag' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">付与するタグ <span className="text-red-500">*</span></label>
                <select
                  value={form.responseContent}
                  onChange={(e) => setForm({ ...form, responseContent: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  <option value="">タグを選択...</option>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>{withGroup(t.name, t.groupName)}</option>
                  ))}
                </select>
              </div>
            )}

            {form.responseType === 'enroll_scenario' && (
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">開始するシナリオ <span className="text-red-500">*</span></label>
                <select
                  value={form.responseContent}
                  onChange={(e) => setForm({ ...form, responseContent: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white"
                >
                  <option value="">シナリオを選択...</option>
                  {scenarios.map((s) => (
                    <option key={s.id} value={s.id}>{withGroup(s.name, s.groupName)}</option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isActive"
                checked={form.isActive}
                onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                className="w-4 h-4 rounded border-gray-300 text-green-600"
              />
              <label htmlFor="isActive" className="text-sm text-gray-600">有効にする</label>
            </div>

            {formError && <p className="text-xs text-red-600">{formError}</p>}

            <div className="flex gap-2">
              <button onClick={handleSave} disabled={saving} className="px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
                {saving ? '保存中...' : (editingId ? '更新' : '作成')}
              </button>
              <button onClick={cancel} className="px-4 py-2 text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg">キャンセル</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-8 text-sm text-gray-400">読み込み中...</div>
      ) : rules.length === 0 ? (
        <div className="text-center py-12 text-sm text-gray-400">ルールがありません。「+ 新規ルール」から作成してください。</div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[720px]">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">キーワード</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">マッチ</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">アクション</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500">内容</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500">有効</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rules.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-900 font-medium">{r.keyword}</td>
                    <td className="px-4 py-3 text-gray-600">{r.matchType === 'exact' ? '完全一致' : '部分一致'}</td>
                    <td className="px-4 py-3 text-gray-700">{responseTypeLabels[(r.responseType as ResponseType)] ?? r.responseType}</td>
                    <td className="px-4 py-3 text-gray-700">{describeContent(r)}</td>
                    <td className="px-4 py-3 text-center">
                      <button
                        onClick={() => handleToggle(r)}
                        className={`text-xs px-2 py-0.5 rounded-full ${r.isActive ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}
                      >
                        {r.isActive ? 'ON' : 'OFF'}
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button onClick={() => openEdit(r)} className="text-xs text-gray-700 hover:text-gray-900 mr-2">編集</button>
                      <button onClick={() => handleDelete(r.id)} className="text-xs text-red-500 hover:text-red-700">削除</button>
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
