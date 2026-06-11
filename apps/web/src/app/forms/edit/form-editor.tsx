'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { api, type FormFieldItem } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'
import { withGroup } from '@/lib/format-group'

const FIELD_TYPES: { value: FormFieldItem['type']; label: string; needsOptions?: boolean }[] = [
  { value: 'text', label: 'テキスト1行' },
  { value: 'textarea', label: 'テキスト複数行' },
  { value: 'radio', label: '単一選択（ラジオ）', needsOptions: true },
  { value: 'select', label: 'プルダウン', needsOptions: true },
  { value: 'checkbox', label: '複数選択（チェック）', needsOptions: true },
  { value: 'email', label: 'メール' },
  { value: 'tel', label: '電話番号' },
]

const newField = (): FormFieldItem => ({
  name: `field_${Math.random().toString(36).slice(2, 8)}`,
  label: '',
  type: 'text',
  required: false,
  options: [],
  placeholder: '',
})

export default function FormEditor({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [fields, setFields] = useState<FormFieldItem[]>([newField()])
  const [tagId, setTagId] = useState('')
  const [scenarioId, setScenarioId] = useState('')
  const [submitMessage, setSubmitMessage] = useState('')
  const [submitLabel, setSubmitLabel] = useState('')
  const [saveToMetadata, setSaveToMetadata] = useState(true)
  const [submitOnce, setSubmitOnce] = useState(false)
  const [lineAccountId, setLineAccountId] = useState<string>('')
  const [isActive, setIsActive] = useState(true)
  const [tags, setTags] = useState<{ id: string; name: string; color?: string; groupName?: string | null }[]>([])
  const [scenarios, setScenarios] = useState<{ id: string; name: string; groupName?: string | null }[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [previewOpen, setPreviewOpen] = useState(false)
  const [editingTagsForField, setEditingTagsForField] = useState<{ idx: number; opt: string } | null>(null)
  const { selectedAccount, accounts } = useAccount()

  useEffect(() => {
    // Always scope tag/scenario pickers to the currently selected LINE account.
    // Without this filter operators see every account's data and inadvertently
    // wire forms across accounts. This pattern bites us repeatedly — any new
    // selector that touches scenarios/tags should pass `lineAccountId` too.
    const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
    api.tags.list(params).then(r => { if (r.success) setTags(r.data) })
    api.scenarios.list(params).then(r => { if (r.success) setScenarios(r.data.map(s => ({ id: s.id, name: s.name, groupName: s.groupName }))) })
  }, [selectedAccount])

  useEffect(() => {
    if (!id) return
    setLoading(true)
    api.forms.get(id).then(res => {
      if (res.success) {
        setName(res.data.name)
        setDisplayName(res.data.displayName ?? '')
        setDescription(res.data.description ?? '')
        setFields(res.data.fields.length > 0 ? res.data.fields : [newField()])
        setTagId(res.data.onSubmitTagId ?? '')
        setScenarioId(res.data.onSubmitScenarioId ?? '')
        setSubmitMessage(res.data.onSubmitMessage ?? '')
        setSubmitLabel(res.data.submitLabel ?? '')
        setSaveToMetadata(res.data.saveToMetadata)
        setSubmitOnce(Boolean(res.data.submitOnce))
        setLineAccountId(res.data.lineAccountId ?? '')
        setIsActive(res.data.isActive)
      } else {
        setError(res.error)
      }
    }).finally(() => setLoading(false))
  }, [id])

  const updateField = (idx: number, updater: (f: FormFieldItem) => FormFieldItem) => {
    setFields(prev => prev.map((f, i) => i === idx ? updater(f) : f))
  }

  const addField = () => setFields(prev => [...prev, newField()])
  const removeField = (idx: number) => setFields(prev => prev.filter((_, i) => i !== idx))
  const moveField = (idx: number, dir: -1 | 1) => {
    setFields(prev => {
      const next = [...prev]
      const target = idx + dir
      if (target < 0 || target >= next.length) return prev
      ;[next[idx], next[target]] = [next[target], next[idx]]
      return next
    })
  }

  const handleSave = async () => {
    if (!name.trim()) { setError('フォーム名を入力してください'); return }
    for (const f of fields) {
      if (!f.label.trim()) { setError('全ての項目にラベルを入力してください'); return }
      if ((f.type === 'radio' || f.type === 'select' || f.type === 'checkbox') && (!f.options || f.options.length === 0)) {
        setError(`「${f.label}」に選択肢を追加してください`); return
      }
    }
    setSaving(true)
    setError('')
    try {
      const payload = {
        name,
        displayName: displayName.trim() || null,
        description: description || null,
        fields,
        onSubmitTagId: tagId || null,
        onSubmitScenarioId: scenarioId || null,
        onSubmitMessage: submitMessage.trim() ? submitMessage : null,
        submitLabel: submitLabel || null,
        saveToMetadata,
        submitOnce,
        lineAccountId: lineAccountId || null,
        isActive,
      }
      const res = id
        ? await api.forms.update(id, payload)
        : await api.forms.create(payload)
      if (!res.success) { setError(res.error); return }
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="p-8 text-center text-gray-400">読み込み中...</div>

  return (
    <div>
      <Header
        title={id ? 'フォーム編集' : '新規フォーム'}
        action={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPreviewOpen(!previewOpen)}
              className={`px-3 py-2 text-sm rounded border ${previewOpen ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'}`}
            >
              👁 プレビュー
            </button>
            <Link href="/forms" className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded">← 一覧に戻る</Link>
          </div>
        }
      />

      {previewOpen && (
        <div className="mb-6 bg-white rounded-lg border-2 border-blue-300 overflow-hidden">
          <div className="bg-blue-50 px-4 py-2 border-b border-blue-300 text-xs font-semibold text-blue-800 flex items-center gap-2">
            <span>📱 プレビュー（実際の回答画面の見え方）</span>
          </div>
          <FormPreview name={displayName.trim() || name} description={description} fields={fields} submitLabel={submitLabel} />
        </div>
      )}

      {error && <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700 mb-4">{error}</div>}

      <div className="bg-white rounded-lg border border-gray-200 p-6 space-y-5 max-w-3xl">
        {/* 基本情報 */}
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">管理名（一覧画面で識別するための内部用） *</label>
          <input
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="例: セミナー事後アンケート（社内整理用）"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">フォームタイトル（回答者に見える名前）</label>
          <input
            type="text"
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            placeholder="例: ご参加ありがとうございました！アンケート"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
          />
          <p className="text-[11px] text-gray-400 mt-1">空欄の場合は管理名がそのまま表示されます</p>
        </div>

        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">説明（任意）</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            placeholder="フォーム上部に表示される説明文"
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm resize-none"
          />
        </div>

        {/* 項目 */}
        <div className="border-t border-gray-200 pt-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-gray-800">質問項目</h3>
            <button onClick={addField} className="text-xs px-3 py-1 rounded bg-gray-100 hover:bg-gray-200">+ 項目追加</button>
          </div>
          <div className="space-y-3">
            {fields.map((f, idx) => {
              const def = FIELD_TYPES.find(t => t.value === f.type)
              return (
                <div key={idx} className="border border-gray-200 rounded-lg p-3 bg-gray-50">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-gray-700">項目 {idx + 1}</span>
                    <div className="flex items-center gap-1">
                      <button onClick={() => moveField(idx, -1)} disabled={idx === 0} className="text-xs px-2 py-0.5 rounded hover:bg-gray-200 disabled:opacity-30">↑</button>
                      <button onClick={() => moveField(idx, 1)} disabled={idx === fields.length - 1} className="text-xs px-2 py-0.5 rounded hover:bg-gray-200 disabled:opacity-30">↓</button>
                      {fields.length > 1 && (
                        <button onClick={() => removeField(idx)} className="text-xs text-red-500 hover:text-red-700 px-2 py-0.5">削除</button>
                      )}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <input
                      type="text"
                      value={f.label}
                      onChange={e => updateField(idx, x => ({ ...x, label: e.target.value }))}
                      placeholder="質問文（例: 学年）"
                      className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
                    />
                    <select
                      value={f.type}
                      onChange={e => updateField(idx, x => {
                        const nextType = e.target.value as FormFieldItem['type']
                        const needsOpts = ['radio', 'select', 'checkbox'].includes(nextType)
                        // newField() seeds options as []; nullish-coalescing wouldn't
                        // replace an empty array, so we'd render zero option rows.
                        const seeded = x.options && x.options.length > 0 ? x.options : ['', '']
                        return { ...x, type: nextType, options: needsOpts ? seeded : x.options }
                      })}
                      className="border border-gray-300 rounded px-2 py-1.5 text-sm bg-white"
                    >
                      {FIELD_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                  </div>

                  {def?.needsOptions && (
                    <div className="space-y-1 mt-2">
                      <label className="text-xs text-gray-500">選択肢（タグボタンで「この選択肢を選んだ時に付与するタグ」を設定可）</label>
                      {(f.options ?? []).map((opt, oi) => {
                        const optTags = (f.optionTags?.[opt] ?? [])
                        const tagNames = optTags.map(tid => tags.find(t => t.id === tid)?.name).filter(Boolean) as string[]
                        return (
                          <div key={oi}>
                            <div className="flex items-center gap-1">
                              <input
                                type="text"
                                value={opt}
                                onChange={e => {
                                  const newVal = e.target.value
                                  updateField(idx, x => {
                                    const oldOpt = (x.options ?? [])[oi]
                                    const newOptions = (x.options ?? []).map((o, i) => i === oi ? newVal : o)
                                    const newOptionTags = { ...(x.optionTags ?? {}) }
                                    if (oldOpt !== newVal && newOptionTags[oldOpt]) {
                                      newOptionTags[newVal] = newOptionTags[oldOpt]
                                      delete newOptionTags[oldOpt]
                                    }
                                    return { ...x, options: newOptions, optionTags: newOptionTags }
                                  })
                                }}
                                placeholder={`選択肢 ${oi + 1}`}
                                className="flex-1 border border-gray-300 rounded px-2 py-1 text-xs bg-white"
                              />
                              <button
                                onClick={() => setEditingTagsForField(editingTagsForField?.idx === idx && editingTagsForField?.opt === opt ? null : { idx, opt })}
                                className={`text-xs px-2 py-1 rounded border ${optTags.length > 0 ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-gray-300 text-gray-500 hover:bg-gray-50'}`}
                              >
                                🏷 タグ {optTags.length > 0 ? `(${optTags.length})` : ''}
                              </button>
                              <button onClick={() => updateField(idx, x => {
                                const newOptions = (x.options ?? []).filter((_, i) => i !== oi)
                                const newOptionTags = { ...(x.optionTags ?? {}) }
                                delete newOptionTags[opt]
                                return { ...x, options: newOptions, optionTags: newOptionTags }
                              })} className="text-xs text-red-400 hover:text-red-600 px-1">×</button>
                            </div>
                            {editingTagsForField?.idx === idx && editingTagsForField?.opt === opt && (
                              <div className="mt-1 ml-2 p-2 bg-blue-50 border border-blue-200 rounded">
                                <p className="text-xs text-gray-600 mb-1.5">「{opt}」を選んだ時に付与するタグ:</p>
                                <div className="flex flex-wrap gap-1">
                                  {tags.map(t => {
                                    const selected = optTags.includes(t.id)
                                    return (
                                      <button
                                        key={t.id}
                                        onClick={() => updateField(idx, x => {
                                          const cur = x.optionTags?.[opt] ?? []
                                          const next = cur.includes(t.id) ? cur.filter(id => id !== t.id) : [...cur, t.id]
                                          return { ...x, optionTags: { ...(x.optionTags ?? {}), [opt]: next } }
                                        })}
                                        className={`text-xs px-2 py-0.5 rounded-full border ${selected ? 'text-white border-transparent' : 'text-gray-600 bg-white border-gray-300'}`}
                                        style={selected ? { backgroundColor: t.color ?? '#06C755' } : undefined}
                                      >
                                        {selected ? '✓ ' : ''}{t.name}
                                      </button>
                                    )
                                  })}
                                </div>
                              </div>
                            )}
                            {tagNames.length > 0 && editingTagsForField?.opt !== opt && (
                              <p className="text-xs text-blue-600 ml-2 mt-0.5">付与: {tagNames.join(', ')}</p>
                            )}
                          </div>
                        )
                      })}
                      <button onClick={() => updateField(idx, x => ({ ...x, options: [...(x.options ?? []), ''] }))} className="text-xs text-gray-500 hover:text-gray-700 mt-1">+ 選択肢追加</button>
                    </div>
                  )}

                  {!def?.needsOptions && (f.type === 'text' || f.type === 'textarea' || f.type === 'email' || f.type === 'tel') && (
                    <input
                      type="text"
                      value={f.placeholder ?? ''}
                      onChange={e => updateField(idx, x => ({ ...x, placeholder: e.target.value }))}
                      placeholder="プレースホルダ（任意）"
                      className="w-full border border-gray-300 rounded px-2 py-1.5 text-xs bg-white mt-2"
                    />
                  )}

                  <label className="flex items-center gap-1 text-xs text-gray-600 mt-2">
                    <input type="checkbox" checked={f.required ?? false} onChange={e => updateField(idx, x => ({ ...x, required: e.target.checked }))} />
                    必須項目
                  </label>
                </div>
              )
            })}
          </div>
        </div>

        {/* 送信時アクション */}
        <div className="border-t border-gray-200 pt-5">
          <h3 className="text-sm font-semibold text-gray-800 mb-3">送信時アクション</h3>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">送信ボタンの文言（空欄で「送信する」）</label>
              <input
                type="text"
                value={submitLabel}
                onChange={e => setSubmitLabel(e.target.value)}
                placeholder="例: アンケートを送信する / 申し込む / 回答を確定する"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">回答者全員にタグ付与（全回答共通）</label>
              <select value={tagId} onChange={e => setTagId(e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white">
                <option value="">なし</option>
                {tags.map(t => <option key={t.id} value={t.id}>{withGroup(t.name, t.groupName)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">回答者にシナリオ自動配信</label>
              <select value={scenarioId} onChange={e => setScenarioId(e.target.value)} className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white">
                <option value="">なし</option>
                {scenarios.map(s => <option key={s.id} value={s.id}>{withGroup(s.name, s.groupName)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">送信時のテキスト返信（任意）</label>
              <textarea
                value={submitMessage}
                onChange={e => setSubmitMessage(e.target.value)}
                rows={4}
                placeholder="例：受講登録ありがとうございます！担当よりすぐにご連絡します。"
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm resize-y"
              />
              <p className="text-[11px] text-gray-400 mt-1">シナリオとは独立して、回答直後に1通だけLINEで送ります。空欄なら送りません。</p>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={saveToMetadata} onChange={e => setSaveToMetadata(e.target.checked)} />
              回答内容を友達のメタデータに保存する
            </label>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={submitOnce} onChange={e => setSubmitOnce(e.target.checked)} />
              1人1回まで（既に回答済みの友達は「既に回答されています」と表示）
            </label>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">帰属LINEアカウント（共有URL生成に使用）</label>
              <select
                value={lineAccountId}
                onChange={e => setLineAccountId(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white"
              >
                <option value="">未設定（/f URL を使用）</option>
                {accounts.map(a => (
                  <option key={a.id} value={a.id}>{a.name}{a.liffId ? '' : '（LIFF未設定）'}</option>
                ))}
              </select>
              <p className="text-[11px] text-gray-400 mt-1">設定するとフォーム共有URLが LIFF URL（ベタ打ち共有OK / friend ID 不要）になります。LIFF ID はアカウント編集で別途設定が必要です。</p>
            </div>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
              フォームを公開する（チェックを外すと回答受付停止）
            </label>
          </div>
        </div>

        <div className="flex gap-2 pt-3 border-t border-gray-200">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm font-medium text-white rounded disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {saving ? '保存中...' : '保存'}
          </button>
          <Link href="/forms" className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded">キャンセル</Link>
        </div>
      </div>
    </div>
  )
}

function FormPreview({ name, description, fields, submitLabel }: {
  name: string
  description: string
  fields: FormFieldItem[]
  submitLabel: string
}) {
  return (
    <div className="p-4 bg-gray-50">
      <div className="max-w-md mx-auto bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-200 bg-gradient-to-r from-green-50 to-white">
          <h2 className="text-base font-bold text-gray-900">{name || '（フォーム名）'}</h2>
          {description && <p className="text-sm text-gray-600 mt-1.5 whitespace-pre-wrap">{description}</p>}
        </div>
        <div className="px-5 py-4 space-y-4 pointer-events-none">
          {fields.length === 0 ? (
            <p className="text-sm text-gray-400">項目がありません</p>
          ) : fields.map((f, idx) => (
            <div key={idx}>
              <label className="block text-sm font-semibold text-gray-800 mb-1">
                {f.label || `（項目${idx + 1}）`}
                {f.required && <span className="text-red-500 ml-1">*</span>}
              </label>
              {(f.type === 'text' || f.type === 'email' || f.type === 'tel') && (
                <input type="text" placeholder={f.placeholder ?? ''} disabled className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-gray-50" />
              )}
              {f.type === 'textarea' && (
                <textarea rows={3} placeholder={f.placeholder ?? ''} disabled className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-gray-50 resize-none" />
              )}
              {f.type === 'radio' && (
                <div className="space-y-1.5">
                  {(f.options ?? []).map(opt => (
                    <label key={opt} className="flex items-center gap-2 text-sm">
                      <input type="radio" disabled />
                      {opt || '（空の選択肢）'}
                    </label>
                  ))}
                </div>
              )}
              {f.type === 'select' && (
                <select disabled className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-gray-50">
                  <option>選択してください</option>
                  {(f.options ?? []).map(opt => <option key={opt}>{opt}</option>)}
                </select>
              )}
              {f.type === 'checkbox' && (
                <div className="space-y-1.5">
                  {(f.options ?? []).map(opt => (
                    <label key={opt} className="flex items-center gap-2 text-sm">
                      <input type="checkbox" disabled />
                      {opt || '（空の選択肢）'}
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
          <button disabled className="w-full py-3 rounded-lg text-white font-semibold opacity-60" style={{ backgroundColor: '#06C755' }}>
            {submitLabel || '送信する'}
          </button>
        </div>
      </div>
    </div>
  )
}
