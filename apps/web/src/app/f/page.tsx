'use client'

import { Suspense, useState, useEffect } from 'react'
import { useSearchParams } from 'next/navigation'

interface FormField {
  name: string
  label: string
  type: 'text' | 'textarea' | 'radio' | 'select' | 'checkbox' | 'email' | 'tel'
  required?: boolean
  options?: string[]
  placeholder?: string
}

interface FormDef {
  id: string
  name: string
  description: string | null
  fields: FormField[]
  submitLabel?: string | null
  isActive: boolean
}

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787'

function PublicForm() {
  const search = useSearchParams()
  const id = search.get('id')
  const friendId = search.get('friend')
  const lineUserId = search.get('lineUserId')

  const [form, setForm] = useState<FormDef | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [data, setData] = useState<Record<string, unknown>>({})
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    if (!id) { setLoading(false); return }
    fetch(`${API_URL}/api/forms/${id}`)
      .then(r => r.json())
      .then(res => {
        if (res.success) setForm(res.data as FormDef)
        else setError(res.error)
      })
      .catch(() => setError('フォームの読み込みに失敗しました'))
      .finally(() => setLoading(false))
  }, [id])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!id) return
    setSubmitting(true)
    setError('')
    try {
      const res = await fetch(`${API_URL}/api/forms/${id}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, friendId, lineUserId }),
      })
      const json = await res.json()
      if (!json.success) {
        setError(json.error)
        return
      }
      setSubmitted(true)
    } catch {
      setError('送信に失敗しました')
    } finally {
      setSubmitting(false)
    }
  }

  if (!id) return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <div className="bg-white rounded-lg p-6 max-w-md text-center text-red-600">フォームIDが指定されていません</div>
    </div>
  )

  if (loading) return <div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">読み込み中...</div>

  if (!form) return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <div className="bg-white rounded-lg p-6 max-w-md text-center text-red-600">フォームが見つかりません</div>
    </div>
  )

  if (!form.isActive) return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gray-50">
      <div className="bg-white rounded-lg p-6 max-w-md text-center text-gray-600">このフォームは現在受付を停止しています</div>
    </div>
  )

  if (submitted) return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
      <div className="bg-white rounded-lg p-8 max-w-md text-center shadow-sm">
        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-100 flex items-center justify-center text-3xl">✓</div>
        <h1 className="text-lg font-bold text-gray-900 mb-2">回答ありがとうございました</h1>
        <p className="text-sm text-gray-600">いただいた内容は今後の運営に活かさせていただきます。</p>
      </div>
    </div>
  )

  return (
    <div className="min-h-screen bg-gray-50 py-8 px-4">
      <div className="max-w-xl mx-auto bg-white rounded-lg shadow-sm overflow-hidden">
        <div className="px-6 py-5 border-b border-gray-200 bg-gradient-to-r from-green-50 to-white">
          <h1 className="text-lg font-bold text-gray-900">{form.name}</h1>
          {form.description && (
            <p className="text-sm text-gray-600 mt-2 whitespace-pre-wrap">{form.description}</p>
          )}
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-5">
          {error && <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">{error}</div>}

          {form.fields.map(field => {
            const val = data[field.name]
            const setVal = (v: unknown) => setData(prev => ({ ...prev, [field.name]: v }))
            return (
              <div key={field.name}>
                <label className="block text-sm font-semibold text-gray-800 mb-1.5">
                  {field.label}
                  {field.required && <span className="text-red-500 ml-1">*</span>}
                </label>

                {field.type === 'text' && (
                  <input type="text" value={(val as string) ?? ''} onChange={e => setVal(e.target.value)} placeholder={field.placeholder} required={field.required} className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
                )}
                {field.type === 'textarea' && (
                  <textarea value={(val as string) ?? ''} onChange={e => setVal(e.target.value)} placeholder={field.placeholder} required={field.required} rows={4} className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 resize-y" />
                )}
                {field.type === 'email' && (
                  <input type="email" value={(val as string) ?? ''} onChange={e => setVal(e.target.value)} placeholder={field.placeholder ?? 'name@example.com'} required={field.required} className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
                )}
                {field.type === 'tel' && (
                  <input type="tel" value={(val as string) ?? ''} onChange={e => setVal(e.target.value)} placeholder={field.placeholder} required={field.required} className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500" />
                )}
                {field.type === 'radio' && (
                  <div className="space-y-2">
                    {(field.options ?? []).map(opt => (
                      <label key={opt} className="flex items-center gap-2 text-sm cursor-pointer">
                        <input type="radio" name={field.name} value={opt} checked={val === opt} onChange={() => setVal(opt)} required={field.required} className="text-green-600" />
                        {opt}
                      </label>
                    ))}
                  </div>
                )}
                {field.type === 'select' && (
                  <select value={(val as string) ?? ''} onChange={e => setVal(e.target.value)} required={field.required} className="w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-500">
                    <option value="">選択してください</option>
                    {(field.options ?? []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                )}
                {field.type === 'checkbox' && (
                  <div className="space-y-2">
                    {(field.options ?? []).map(opt => {
                      const arr = Array.isArray(val) ? (val as string[]) : []
                      const checked = arr.includes(opt)
                      return (
                        <label key={opt} className="flex items-center gap-2 text-sm cursor-pointer">
                          <input type="checkbox" checked={checked} onChange={e => setVal(e.target.checked ? [...arr, opt] : arr.filter(o => o !== opt))} className="text-green-600" />
                          {opt}
                        </label>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}

          <button type="submit" disabled={submitting} className="w-full py-3 rounded-lg text-white font-semibold disabled:opacity-50" style={{ backgroundColor: '#06C755' }}>
            {submitting ? '送信中...' : (form.submitLabel || '送信する')}
          </button>
        </form>
      </div>
    </div>
  )
}

export default function PublicFormPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center text-gray-400 text-sm">読み込み中...</div>}>
      <PublicForm />
    </Suspense>
  )
}
