'use client'

import { useState, useEffect } from 'react'
import type { Tag } from '@line-crm/shared'
import { api, type ApiBroadcast } from '@/lib/api'
import { withGroup } from '@/lib/format-group'
import ButtonsTemplateEditor, { emptyButtonsValue, serializeButtons, deserializeButtons } from '@/components/buttons-template-editor'
import MessageEditor from '@/components/message-editor'

interface BroadcastFormProps {
  tags: Tag[]
  lineAccountId?: string | null
  editing?: ApiBroadcast | null
  onSuccess: () => void
  onCancel: () => void
}

// Mirror of templates/page.tsx — keeps in sync when adding accounts
const liffIdMap: Record<string, string> = {
  'd49a3a13-8169-4b25-a669-3c8a4f4f964d': '2009821004-brTkmVVK',
  '40adcb23-277b-4d9d-b6e2-92fde47d31fb': '2006855304-UfNPHFOn',
}

const messageTypeLabels: Record<ApiBroadcast['messageType'], string> = {
  text: 'テキスト',
  image: '画像',
  flex: 'Flexメッセージ',
  richmenu: 'リッチメニュー',
  buttons: 'ボタン',
}

interface TemplateLite {
  id: string
  name: string
  category: string
  messageType: string
  messageContent: string
}

type AdditionalType = 'text' | 'image' | 'buttons'

interface FormState {
  title: string
  groupName: string
  messageType: ApiBroadcast['messageType']
  messageContent: string
  /** Optional 2nd〜5th messages bundled with this broadcast. */
  additionalMessages: { type: AdditionalType; content: string }[]
  targetType: ApiBroadcast['targetType']
  targetTagId: string
  targetTagMode: ApiBroadcast['targetTagMode']
  /** Multi-tag compound filter — empty arrays mean "no filter applied" */
  targetTagInclude: string[]
  targetTagExclude: string[]
  scheduledAt: string
  sendNow: boolean
}

function formatDatetimeLocal(iso: string | null): string {
  if (!iso) return ''
  // ISO with +09:00 → YYYY-MM-DDTHH:mm (JST wall-clock)
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/)
  return m ? `${m[1]}T${m[2]}` : ''
}

export default function BroadcastForm({ tags, lineAccountId, editing, onSuccess, onCancel }: BroadcastFormProps) {
  const isEdit = !!editing
  const liffId = lineAccountId ? liffIdMap[lineAccountId] ?? null : null
  const [form, setForm] = useState<FormState>({
    title: editing?.title ?? '',
    groupName: editing?.groupName ?? '',
    messageType: editing?.messageType ?? 'text',
    messageContent: editing?.messageContent ?? '',
    additionalMessages: editing?.messages && editing.messages.length > 1
      ? editing.messages.slice(1).map((m) => {
          const t: AdditionalType = m.type === 'image' || m.type === 'buttons' ? m.type : 'text'
          return { type: t, content: m.content }
        })
      : [],
    targetType: editing?.targetType ?? 'all',
    targetTagId: editing?.targetTagId ?? '',
    targetTagMode: editing?.targetTagMode ?? 'include',
    targetTagInclude: editing?.targetTagFilter?.include ?? [],
    targetTagExclude: editing?.targetTagFilter?.exclude ?? [],
    scheduledAt: formatDatetimeLocal(editing?.scheduledAt ?? null),
    sendNow: !editing?.scheduledAt,
  })
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState('')
  const [testResult, setTestResult] = useState('')
  const [templates, setTemplates] = useState<TemplateLite[]>([])

  useEffect(() => {
    const params = lineAccountId ? { lineAccountId } : undefined
    api.templates.list(undefined, params).then(r => {
      if (r.success) setTemplates(r.data.map(t => ({ id: t.id, name: t.name, category: t.category, messageType: t.messageType, messageContent: t.messageContent })))
    })
  }, [lineAccountId])

  const applyTemplate = (tpl: TemplateLite) => {
    // Templates can be any saved message_type; we just dump it into the
    // main message slot. Buttons templates serialize as JSON content with
    // type='buttons' which broadcasts now accept (migration 036).
    const allowed = ['text', 'image', 'flex', 'buttons']
    const t = (allowed.includes(tpl.messageType) ? tpl.messageType : 'text') as ApiBroadcast['messageType']
    setForm(f => ({ ...f, messageType: t, messageContent: tpl.messageContent }))
  }

  // When the operator stacks 2+ messages we send them as a `messages[]`
  // bundle. The single-message path is preserved when the bundle is empty.
  const buildMessagesPayload = (): { type: string; content: string }[] | undefined => {
    if (form.additionalMessages.length === 0) return undefined
    return [
      { type: form.messageType, content: form.messageContent },
      ...form.additionalMessages,
    ]
  }

  const handleTest = async () => {
    if (!lineAccountId) { setError('LINEアカウントを選択してからテスト送信してください'); return }
    if (!form.messageContent.trim()) { setError('メッセージ内容を入力してください'); return }
    if (form.messageType === 'flex') {
      try { JSON.parse(form.messageContent) } catch { setError('FlexメッセージのJSONが無効です'); return }
    }
    setTesting(true)
    setError('')
    setTestResult('')
    try {
      const messages = buildMessagesPayload()
      const res = await api.broadcasts.test(messages
        ? { lineAccountId, messages }
        : { lineAccountId, messageType: form.messageType, messageContent: form.messageContent })
      if (res.success) {
        setTestResult(`テスト送信しました（送信先: ${res.data.sentTo}）`)
      } else {
        setError(res.error)
      }
    } catch {
      setError('テスト送信に失敗しました')
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    if (!form.title.trim()) { setError('配信タイトルを入力してください'); return }
    if (!form.messageContent.trim()) { setError('メッセージ内容を入力してください'); return }
    if (form.messageType === 'flex') {
      try { JSON.parse(form.messageContent) } catch { setError('FlexメッセージのJSONが無効です'); return }
    }
    if (!form.sendNow && !form.scheduledAt) {
      setError('予約配信の場合は配信日時を指定してください')
      return
    }

    setSaving(true)
    setError('')
    try {
      const messages = buildMessagesPayload()
      // Multi-tag filter is the new model. The legacy single targetTagId is
      // kept for back-compat; we mirror the first include/exclude into it so
      // older listings still show a sensible value.
      const useMultiTag = form.targetType === 'tag' && (form.targetTagInclude.length > 0 || form.targetTagExclude.length > 0)
      const tagFilter = useMultiTag
        ? { include: form.targetTagInclude, exclude: form.targetTagExclude }
        : null
      const payload = {
        title: form.title,
        groupName: form.groupName.trim() || null,
        messageType: form.messageType,
        messageContent: form.messageContent,
        ...(messages ? { messages } : {}),
        targetType: form.targetType,
        targetTagId: form.targetType === 'tag'
          ? (useMultiTag ? null : (form.targetTagId || null))
          : null,
        targetTagMode: form.targetType === 'tag' ? form.targetTagMode : 'include',
        targetTagFilter: tagFilter,
        scheduledAt: form.sendNow || !form.scheduledAt
          ? null
          : form.scheduledAt + ':00.000+09:00',
      }
      const res = isEdit && editing
        ? await api.broadcasts.update(editing.id, payload)
        : await api.broadcasts.create({ ...payload, status: 'draft' }, lineAccountId ? { lineAccountId } : undefined)
      if (res.success) {
        onSuccess()
      } else {
        setError(res.error)
      }
    } catch {
      setError(isEdit ? '更新に失敗しました' : '作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
      <h2 className="text-sm font-semibold text-gray-800 mb-5">{isEdit ? '配信を編集' : '新規配信を作成'}</h2>

      <div className="space-y-4 max-w-lg">
        {/* Title */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            配信タイトル <span className="text-red-500">*</span>
          </label>
          <input
            type="text"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="例: 3月のキャンペーン告知"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>

        {/* Group */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            グループ名（任意）
          </label>
          <input
            type="text"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
            placeholder="例: セミナー告知 / 月次配信"
            value={form.groupName}
            onChange={(e) => setForm({ ...form, groupName: e.target.value })}
          />
          <p className="text-[11px] text-gray-400 mt-1">同じグループ名でまとめて表示されます</p>
        </div>

        {/* Template picker — quick-fill the main message body */}
        {templates.length > 0 && (
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">テンプレートから挿入（任意）</label>
            <select
              value=""
              onChange={(e) => {
                const tpl = templates.find(t => t.id === e.target.value)
                if (tpl) applyTemplate(tpl)
              }}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="">テンプレートを選択して流し込む...</option>
              {Object.entries(
                templates.reduce<Record<string, TemplateLite[]>>((acc, t) => {
                  const k = t.category || 'general'
                  if (!acc[k]) acc[k] = []
                  acc[k].push(t)
                  return acc
                }, {}),
              ).map(([cat, items]) => (
                <optgroup key={cat} label={cat}>
                  {items.map(t => (
                    <option key={t.id} value={t.id}>{t.name}（{messageTypeLabels[t.messageType as ApiBroadcast['messageType']] ?? t.messageType}）</option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="text-[11px] text-gray-400 mt-1">選択するとメッセージ種別と内容に流し込まれます（後から編集可）</p>
          </div>
        )}

        {/* Message type */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-2">メッセージ種別</label>
          <div className="flex gap-2">
            {(Object.keys(messageTypeLabels) as ApiBroadcast['messageType'][]).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setForm({ ...form, messageType: type })}
                className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-md border transition-colors ${
                  form.messageType === type
                    ? 'border-green-500 text-green-700 bg-green-50'
                    : 'border-gray-300 text-gray-600 bg-white hover:border-gray-400'
                }`}
              >
                {messageTypeLabels[type]}
              </button>
            ))}
          </div>
        </div>

        {/* Message content */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            メッセージ内容 <span className="text-red-500">*</span>
            {(form.messageType === 'flex' || form.messageType === 'image') && (
              <span className="ml-1 text-gray-400">(JSON形式)</span>
            )}
          </label>

          {/* Image helper: URL inputs that auto-generate the required LINE image JSON */}
          {form.messageType === 'image' && (() => {
            let parsed: { originalContentUrl?: string; previewImageUrl?: string } = {}
            try { parsed = JSON.parse(form.messageContent) } catch { /* not yet valid */ }
            return (
              <div className="space-y-2 mb-2">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">元画像URL (originalContentUrl)</label>
                  <input
                    type="url"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="https://example.com/image.png"
                    value={parsed.originalContentUrl ?? ''}
                    onChange={(e) => {
                      const orig = e.target.value
                      const prev = parsed.previewImageUrl ?? orig
                      setForm({ ...form, messageContent: JSON.stringify({ originalContentUrl: orig, previewImageUrl: prev }) })
                    }}
                  />
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">プレビュー画像URL (previewImageUrl)</label>
                  <input
                    type="url"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
                    placeholder="https://example.com/preview.png (空欄で元画像と同じ)"
                    value={parsed.previewImageUrl ?? ''}
                    onChange={(e) => {
                      const prev = e.target.value
                      setForm({ ...form, messageContent: JSON.stringify({ originalContentUrl: parsed.originalContentUrl ?? '', previewImageUrl: prev }) })
                    }}
                  />
                </div>
              </div>
            )
          })()}

          {form.messageType === 'text' ? (
            <MessageEditor
              value={form.messageContent}
              onChange={(next) => setForm({ ...form, messageContent: next })}
              placeholder="配信するメッセージを入力..."
              rows={4}
            />
          ) : (
            <textarea
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
              rows={form.messageType === 'flex' ? 8 : 3}
              placeholder={
                form.messageType === 'image'
                  ? '{"originalContentUrl":"...","previewImageUrl":"..."}'
                  : '{"type":"bubble","body":{...}}'
              }
              value={form.messageContent}
              onChange={(e) => setForm({ ...form, messageContent: e.target.value })}
              style={{ fontFamily: 'monospace' }}
            />
          )}
          {form.messageType === 'image' && (
            <p className="text-xs text-gray-400 mt-1">上のURLフォームか、直接JSONを編集できます</p>
          )}
        </div>

        {/* Additional messages — 1配信に複数バブル送る用 (max 5 total) */}
        <div className="border-t border-gray-100 pt-4 space-y-3">
          <div className="flex items-center justify-between">
            <label className="block text-xs font-medium text-gray-600">追加メッセージ（最大4件）</label>
            <button
              type="button"
              onClick={() => {
                if (form.additionalMessages.length >= 4) return
                setForm({ ...form, additionalMessages: [...form.additionalMessages, { type: 'text', content: '' }] })
              }}
              disabled={form.additionalMessages.length >= 4}
              className="text-xs px-2 py-1 rounded bg-gray-100 hover:bg-gray-200 disabled:opacity-40"
            >+ メッセージを追加</button>
          </div>
          {form.additionalMessages.length === 0 ? (
            <p className="text-[11px] text-gray-400">追加メッセージなし。1〜4件まで上に積み足すと、1回の配信で連続して届きます</p>
          ) : (
            form.additionalMessages.map((m, idx) => (
              <AdditionalMessageEditor
                key={idx}
                index={idx}
                value={m}
                onChange={(next) => setForm({ ...form, additionalMessages: form.additionalMessages.map((x, i) => i === idx ? next : x) })}
                onRemove={() => setForm({ ...form, additionalMessages: form.additionalMessages.filter((_, i) => i !== idx) })}
                onMove={(dir) => {
                  const tgt = idx + dir
                  if (tgt < 0 || tgt >= form.additionalMessages.length) return
                  const arr = [...form.additionalMessages]
                  ;[arr[idx], arr[tgt]] = [arr[tgt], arr[idx]]
                  setForm({ ...form, additionalMessages: arr })
                }}
                liffId={liffId}
                onSwapWithMain={idx === 0 ? () => {
                  const mainType = form.messageType
                  // additional supports text/image/buttons; main also supports flex/richmenu
                  if (mainType !== 'text' && mainType !== 'image' && mainType !== 'buttons') {
                    alert('メインメッセージが「テキスト」「画像」「ボタン」のときだけ入れ替えできます。\n（flex / richmenu は追加メッセージで使えないため）')
                    return
                  }
                  const newMainType = m.type
                  const newMainContent = m.content
                  const newAdditional: { type: AdditionalType; content: string }[] = [
                    { type: mainType as AdditionalType, content: form.messageContent },
                    ...form.additionalMessages.slice(1),
                  ]
                  setForm({
                    ...form,
                    messageType: newMainType,
                    messageContent: newMainContent,
                    additionalMessages: newAdditional,
                  })
                } : undefined}
              />
            ))
          )}
        </div>

        {/* Target */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-2">配信対象</label>
          <div className="flex flex-wrap gap-2 mb-2">
            <button
              type="button"
              onClick={() => setForm({ ...form, targetType: 'all', targetTagId: '' })}
              className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-md border transition-colors ${
                form.targetType === 'all'
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-gray-300 text-gray-600 bg-white hover:border-gray-400'
              }`}
            >
              全員
            </button>
            <button
              type="button"
              onClick={() => setForm({ ...form, targetType: 'tag' })}
              className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-md border transition-colors ${
                form.targetType === 'tag'
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-gray-300 text-gray-600 bg-white hover:border-gray-400'
              }`}
            >
              タグで絞り込み
            </button>
          </div>
          {form.targetType === 'tag' && (
            <TagFilterEditor
              tags={tags}
              include={form.targetTagInclude}
              exclude={form.targetTagExclude}
              onChange={(incl, excl) => setForm({ ...form, targetTagInclude: incl, targetTagExclude: excl })}
            />
          )}
        </div>

        {/* Schedule */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-2">配信タイミング</label>
          <div className="flex flex-wrap gap-2 mb-2">
            <button
              type="button"
              onClick={() => setForm({ ...form, sendNow: true, scheduledAt: '' })}
              className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-md border transition-colors ${
                form.sendNow
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-gray-300 text-gray-600 bg-white hover:border-gray-400'
              }`}
            >
              下書きとして保存
            </button>
            <button
              type="button"
              onClick={() => setForm({ ...form, sendNow: false })}
              className={`px-3 py-1.5 min-h-[44px] text-xs font-medium rounded-md border transition-colors ${
                !form.sendNow
                  ? 'border-green-500 text-green-700 bg-green-50'
                  : 'border-gray-300 text-gray-600 bg-white hover:border-gray-400'
              }`}
            >
              予約配信
            </button>
          </div>
          {!form.sendNow && (
            <input
              type="datetime-local"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
              value={form.scheduledAt}
              onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })}
            />
          )}
        </div>

        {/* Error / test result */}
        {error && <p className="text-xs text-red-600">{error}</p>}
        {testResult && <p className="text-xs text-green-700">{testResult}</p>}

        {/* Actions */}
        <div className="flex flex-wrap gap-2 pt-1">
          <button
            onClick={handleSave}
            disabled={saving || testing}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-white rounded-lg disabled:opacity-50 transition-opacity"
            style={{ backgroundColor: '#06C755' }}
          >
            {saving ? (isEdit ? '更新中...' : '作成中...') : (isEdit ? '更新' : '作成')}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={saving || testing}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-blue-700 bg-blue-50 border border-blue-200 hover:bg-blue-100 rounded-lg disabled:opacity-50 transition-colors"
          >
            {testing ? '送信中...' : 'テスト送信'}
          </button>
          <button
            onClick={onCancel}
            disabled={saving || testing}
            className="px-4 py-2 min-h-[44px] text-sm font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
          >
            キャンセル
          </button>
        </div>
      </div>
    </div>
  )
}

function TagFilterEditor({
  tags,
  include,
  exclude,
  onChange,
}: {
  tags: Tag[]
  include: string[]
  exclude: string[]
  onChange: (include: string[], exclude: string[]) => void
}) {
  const [pickerMode, setPickerMode] = useState<'include' | 'exclude'>('include')
  const tagById = (id: string) => tags.find(t => t.id === id)
  const usedIds = new Set([...include, ...exclude])
  const available = tags.filter(t => !usedIds.has(t.id))

  const addTag = (id: string) => {
    if (!id) return
    if (pickerMode === 'include') {
      onChange([...include, id], exclude)
    } else {
      onChange(include, [...exclude, id])
    }
  }
  const removeInclude = (id: string) => onChange(include.filter(x => x !== id), exclude)
  const removeExclude = (id: string) => onChange(include, exclude.filter(x => x !== id))

  return (
    <div className="space-y-3">
      {/* Include tags */}
      <div>
        <div className="text-xs font-medium text-gray-700 mb-1.5">
          ✅ 持っている人に配信（AND条件）
        </div>
        {include.length === 0 ? (
          <p className="text-[11px] text-gray-400 mb-1.5">未指定</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {include.map(id => {
              const t = tagById(id)
              return (
                <span key={id} className="inline-flex items-center gap-1 px-2 py-1 bg-green-50 border border-green-200 text-green-800 text-xs rounded">
                  {t ? withGroup(t.name, t.groupName) : id.slice(0, 8)}
                  <button type="button" onClick={() => removeInclude(id)} className="text-green-600 hover:text-green-900">×</button>
                </span>
              )
            })}
          </div>
        )}
      </div>

      {/* Exclude tags */}
      <div>
        <div className="text-xs font-medium text-gray-700 mb-1.5">
          🚫 持っていない人だけに配信（NOT条件）
        </div>
        {exclude.length === 0 ? (
          <p className="text-[11px] text-gray-400 mb-1.5">未指定</p>
        ) : (
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {exclude.map(id => {
              const t = tagById(id)
              return (
                <span key={id} className="inline-flex items-center gap-1 px-2 py-1 bg-red-50 border border-red-200 text-red-800 text-xs rounded">
                  {t ? withGroup(t.name, t.groupName) : id.slice(0, 8)}
                  <button type="button" onClick={() => removeExclude(id)} className="text-red-600 hover:text-red-900">×</button>
                </span>
              )
            })}
          </div>
        )}
      </div>

      {/* Add tag */}
      <div className="border-t border-gray-100 pt-3 space-y-2">
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPickerMode('include')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border ${pickerMode === 'include' ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'}`}
          >
            + 必須タグ
          </button>
          <button
            type="button"
            onClick={() => setPickerMode('exclude')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md border ${pickerMode === 'exclude' ? 'border-red-500 bg-red-50 text-red-700' : 'border-gray-300 bg-white text-gray-600 hover:border-gray-400'}`}
          >
            + 除外タグ
          </button>
        </div>
        <select
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 bg-white"
          value=""
          onChange={(e) => { addTag(e.target.value); e.target.value = '' }}
        >
          <option value="">{pickerMode === 'include' ? '必須として追加するタグを選択...' : '除外するタグを選択...'}</option>
          {available.map((tag) => (
            <option key={tag.id} value={tag.id}>{withGroup(tag.name, tag.groupName)}</option>
          ))}
        </select>
        <p className="text-[11px] text-gray-500 leading-relaxed">
          複数指定OK。例：「セミナー申し込み済み」<strong className="text-green-700">必須</strong> ＋「アンケート回答済み」<strong className="text-red-700">除外</strong> →
          セミナー申込済みでアンケート未回答の人だけに配信。
        </p>
      </div>
    </div>
  )
}

function AdditionalMessageEditor({
  index,
  value,
  onChange,
  onRemove,
  onMove,
  onSwapWithMain,
  liffId,
}: {
  index: number
  value: { type: AdditionalType; content: string }
  onChange: (next: { type: AdditionalType; content: string }) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
  onSwapWithMain?: () => void
  liffId?: string | null
}) {
  const [uploading, setUploading] = useState(false)
  let parsed: { originalContentUrl?: string; previewImageUrl?: string } = {}
  if (value.type === 'image') {
    try { parsed = JSON.parse(value.content) } catch { /* ignore */ }
  }
  const setImageUrls = (orig: string, prev?: string) => {
    onChange({ type: 'image', content: JSON.stringify({ originalContentUrl: orig, previewImageUrl: prev || orig }) })
  }
  const handleFile = async (file: File) => {
    setUploading(true)
    try {
      const res = await api.uploads.image(file)
      if (res.success) setImageUrls(res.data.url)
    } finally {
      setUploading(false)
    }
  }
  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-gray-50 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-gray-700">{index + 2}件目</span>
        <div className="flex gap-1 items-center">
          {index === 0 && onSwapWithMain && (
            <button
              type="button"
              onClick={onSwapWithMain}
              className="text-[11px] text-blue-600 hover:text-blue-800 border border-blue-200 rounded px-2 py-0.5 mr-1"
              title="1件目（メインメッセージ）と入れ替え"
            >⇅ メインと入れ替え</button>
          )}
          <button onClick={() => onMove(-1)} className="text-xs text-gray-500 hover:text-gray-700 px-1">↑</button>
          <button onClick={() => onMove(1)} className="text-xs text-gray-500 hover:text-gray-700 px-1">↓</button>
          <button onClick={onRemove} className="text-xs text-red-500 hover:text-red-700 px-1">削除</button>
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onChange({ type: 'text', content: '' })}
          className={`text-xs px-2 py-1 rounded border ${value.type === 'text' ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-300 bg-white text-gray-600'}`}
        >テキスト</button>
        <button
          type="button"
          onClick={() => onChange({ type: 'image', content: JSON.stringify({ originalContentUrl: '', previewImageUrl: '' }) })}
          className={`text-xs px-2 py-1 rounded border ${value.type === 'image' ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-300 bg-white text-gray-600'}`}
        >画像</button>
        <button
          type="button"
          onClick={() => onChange({ type: 'buttons', content: JSON.stringify({ title: '', text: '', actions: [{ type: 'uri', label: '', uri: '' }] }) })}
          className={`text-xs px-2 py-1 rounded border ${value.type === 'buttons' ? 'border-green-500 bg-green-50 text-green-700' : 'border-gray-300 bg-white text-gray-600'}`}
        >ボタン</button>
      </div>
      {value.type === 'text' ? (
        <MessageEditor
          value={value.content}
          onChange={(next) => onChange({ type: 'text', content: next })}
          placeholder="テキストを入力..."
          rows={3}
        />
      ) : value.type === 'buttons' ? (
        <ButtonsTemplateEditor
          liffId={liffId ?? null}
          value={deserializeButtons(value.content) ?? emptyButtonsValue()}
          onChange={(v) => onChange({ type: 'buttons', content: JSON.stringify(serializeButtons(v, liffId ?? null)) })}
        />
      ) : (
        <div className="space-y-2">
          <input
            type="url"
            value={parsed.originalContentUrl ?? ''}
            onChange={(e) => setImageUrls(e.target.value, parsed.previewImageUrl)}
            placeholder="https://example.com/image.png"
            className="w-full border border-gray-300 rounded-lg px-2 py-1.5 text-sm"
          />
          <label className="text-xs text-gray-600 inline-flex items-center gap-1 cursor-pointer">
            <span className="px-2 py-1 border border-gray-300 rounded bg-white hover:bg-gray-100">
              {uploading ? 'アップロード中...' : '📁 ファイルから選択'}
            </span>
            <input
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleFile(f)
                e.target.value = ''
              }}
            />
          </label>
          {parsed.originalContentUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={parsed.originalContentUrl} alt="" className="h-16 rounded border border-gray-200" />
          )}
        </div>
      )}
    </div>
  )
}
