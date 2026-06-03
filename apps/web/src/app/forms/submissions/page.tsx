'use client'

import { Suspense, useState, useEffect, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { api, type FormItem, type FormSubmissionItem } from '@/lib/api'
import Header from '@/components/layout/header'

type ViewMode = 'cards' | 'table'

function Inner() {
  const params = useSearchParams()
  const id = params.get('id')
  const [form, setForm] = useState<FormItem | null>(null)
  const [submissions, setSubmissions] = useState<FormSubmissionItem[]>([])
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<ViewMode>('cards')
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!id) return
    Promise.all([
      api.forms.get(id),
      api.forms.submissions(id),
    ]).then(([fRes, sRes]) => {
      if (fRes.success) setForm(fRes.data)
      if (sRes.success) setSubmissions(sRes.data)
    }).finally(() => setLoading(false))
  }, [id])

  const filtered = useMemo(() => {
    if (!query.trim()) return submissions
    const q = query.toLowerCase()
    return submissions.filter(s => {
      if (s.friendName?.toLowerCase().includes(q)) return true
      if (s.friendId?.toLowerCase().includes(q)) return true
      return Object.values(s.data).some(v => {
        const str = Array.isArray(v) ? v.join(' ') : String(v ?? '')
        return str.toLowerCase().includes(q)
      })
    })
  }, [submissions, query])

  const downloadCsv = () => {
    if (!form) return
    const headers = ['回答日時', '友達名', '友達ID', ...form.fields.map(f => f.label)]
    const rows = filtered.map(s => [
      new Date(s.createdAt).toLocaleString('ja-JP'),
      s.friendName ?? '',
      s.friendId ?? '',
      ...form.fields.map(f => {
        const v = s.data[f.name]
        return Array.isArray(v) ? v.join(', ') : String(v ?? '')
      }),
    ])
    const csv = [headers, ...rows]
      .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n')
    const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${form.name}_回答_${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
  }

  if (!id) return <div className="p-8 text-center text-red-500">フォームIDが指定されていません</div>
  if (loading) return <div className="p-8 text-center text-gray-400">読み込み中...</div>
  if (!form) return <div className="p-8 text-center text-red-500">フォームが見つかりません</div>

  return (
    <div>
      <Header
        title={`回答一覧: ${form.name}`}
        description={`${submissions.length}件の回答${query ? `（${filtered.length}件表示中）` : ''}`}
        action={<Link href="/forms" className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded">← 一覧に戻る</Link>}
      />

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="名前・回答内容で検索..."
          className="flex-1 min-w-[200px] px-3 py-2 text-sm border border-gray-300 rounded bg-white"
        />
        <div className="flex border border-gray-300 rounded overflow-hidden">
          <button
            onClick={() => setView('cards')}
            className={`px-3 py-2 text-xs ${view === 'cards' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            カード
          </button>
          <button
            onClick={() => setView('table')}
            className={`px-3 py-2 text-xs border-l border-gray-300 ${view === 'table' ? 'bg-gray-900 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            テーブル
          </button>
        </div>
        <button
          onClick={downloadCsv}
          className="px-3 py-2 text-xs text-gray-600 border border-gray-300 rounded bg-white hover:bg-gray-50"
        >
          CSV書き出し
        </button>
      </div>

      {filtered.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-12 text-center text-gray-400">
          {submissions.length === 0 ? 'まだ回答がありません' : '該当する回答がありません'}
        </div>
      ) : view === 'cards' ? (
        // === Card view ===
        <div className="space-y-4">
          {filtered.map((sub, idx) => (
            <div key={sub.id} className="bg-white rounded-lg border border-gray-200 overflow-hidden">
              {/* Card header */}
              <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-200">
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono text-gray-400">#{submissions.length - submissions.indexOf(sub)}</span>
                  <div>
                    <div className="text-sm font-semibold text-gray-900">
                      {sub.friendName || <span className="text-gray-400">名前未設定</span>}
                    </div>
                    {sub.friendId && (
                      <div className="text-[10px] font-mono text-gray-400 mt-0.5">{sub.friendId.slice(0, 8)}</div>
                    )}
                  </div>
                </div>
                <div className="text-xs text-gray-500">
                  {new Date(sub.createdAt).toLocaleString('ja-JP', {
                    year: 'numeric', month: '2-digit', day: '2-digit',
                    hour: '2-digit', minute: '2-digit',
                  })}
                </div>
              </div>
              {/* Card body — Q&A pairs */}
              <div className="divide-y divide-gray-100">
                {form.fields.map(f => {
                  const val = sub.data[f.name]
                  const isEmpty = val === undefined || val === null || val === ''
                  const display = Array.isArray(val)
                    ? val.length > 0 ? val.join(' / ') : ''
                    : String(val ?? '')
                  return (
                    <div key={f.name} className="px-4 py-3">
                      <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                        {f.label}
                        {f.required && <span className="text-red-400 ml-1">*</span>}
                      </div>
                      {isEmpty ? (
                        <div className="text-sm text-gray-300 italic">未回答</div>
                      ) : (
                        <div className="text-sm text-gray-900 whitespace-pre-wrap break-words leading-relaxed">
                          {display}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        // === Table view ===
        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">回答日時</th>
                  <th className="text-left px-3 py-2 text-xs font-semibold text-gray-500">友達</th>
                  {form.fields.map(f => (
                    <th key={f.name} className="text-left px-3 py-2 text-xs font-semibold text-gray-500">{f.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtered.map(sub => (
                  <tr key={sub.id} className="hover:bg-gray-50 align-top">
                    <td className="px-3 py-2 text-xs text-gray-600 whitespace-nowrap">
                      {new Date(sub.createdAt).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-700">
                      {sub.friendName || <span className="text-gray-300">未設定</span>}
                      {sub.friendId && (
                        <div className="text-[10px] font-mono text-gray-400">{sub.friendId.slice(0, 8)}</div>
                      )}
                    </td>
                    {form.fields.map(f => {
                      const val = sub.data[f.name]
                      const display = Array.isArray(val) ? val.join(', ') : (val ?? '')
                      return (
                        <td key={f.name} className="px-3 py-2 text-xs text-gray-700 whitespace-pre-wrap break-words max-w-[280px]">
                          {String(display) || <span className="text-gray-300">—</span>}
                        </td>
                      )
                    })}
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

export default function FormSubmissionsPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-400">読み込み中...</div>}>
      <Inner />
    </Suspense>
  )
}
