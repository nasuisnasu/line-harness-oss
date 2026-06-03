'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'
import { useAccount } from '@/lib/account-context'

interface UploadedFile {
  id: string
  lineAccountId: string | null
  filename: string
  originalName: string | null
  size: number | null
  contentType: string | null
  createdAt: string
  url: string
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function FilesPage() {
  const { selectedAccount } = useAccount()
  const [files, setFiles] = useState<UploadedFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = selectedAccount ? { lineAccountId: selectedAccount.id } : undefined
      const res = await api.uploads.list(params)
      if (res.success) setFiles(res.data)
      else setError(res.error)
    } catch {
      setError('ファイル一覧の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount])

  useEffect(() => { void load() }, [load])

  const handleFile = async (file: File) => {
    if (file.type !== 'application/pdf') {
      setError('PDFのみ対応しています')
      return
    }
    if (file.size > 25 * 1024 * 1024) {
      setError('ファイルサイズは25MB以下にしてください')
      return
    }
    setUploading(true)
    setError('')
    try {
      const res = await api.uploads.file(file, selectedAccount?.id ?? null)
      if (res.success) {
        await load()
      } else {
        setError(res.error)
      }
    } catch {
      setError('アップロードに失敗しました')
    } finally {
      setUploading(false)
    }
  }

  const copyUrl = async (id: string, url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedId(id)
      setTimeout(() => setCopiedId(null), 1500)
    } catch {
      setError('クリップボードへのコピーに失敗しました')
    }
  }

  const removeFile = async (id: string) => {
    if (!confirm('このファイルを削除しますか？（共有済みのURLは無効になります）')) return
    const res = await api.uploads.deleteFile(id)
    if (res.success) await load()
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-6">
        <Header
          title="ファイル"
          description={`PDFをアップロードしてLINEで配布${selectedAccount ? `（${selectedAccount.name}）` : ''}`}
        />
      </div>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 space-y-6">
        <section className="bg-white rounded-lg border border-gray-200 p-6">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">PDFをアップロード</h2>
          <label
            onDragEnter={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragOver(false)
              const file = e.dataTransfer.files?.[0]
              if (file) void handleFile(file)
            }}
            className={`flex flex-col items-center justify-center gap-3 cursor-pointer rounded-lg border-2 border-dashed transition-colors px-6 py-10 ${
              dragOver
                ? 'border-green-500 bg-green-50'
                : 'border-gray-300 bg-gray-50 hover:bg-gray-100'
            }`}
          >
            <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m-9 1V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
            </svg>
            <div className="text-center">
              <p className="text-sm font-medium text-gray-700">
                {uploading ? 'アップロード中...' : 'PDFをドロップ または クリックで選択'}
              </p>
              <p className="text-xs text-gray-500 mt-1">最大 25MB / PDFのみ</p>
              {selectedAccount && (
                <p className="text-[11px] text-gray-400 mt-1">
                  アップロード先アカウント: {selectedAccount.name}
                </p>
              )}
            </div>
            <input
              type="file"
              accept="application/pdf"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                const file = e.target.files?.[0]
                if (file) void handleFile(file)
                e.target.value = ''
              }}
            />
          </label>
          {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        </section>

        <section className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-900">
          <p className="font-semibold mb-1">💡 LINEで配布するには</p>
          <ol className="list-decimal list-inside space-y-0.5 text-blue-800">
            <li>PDFをアップロード→公開URLが発行されます</li>
            <li>「テンプレート」または「一斉配信」でボタンメッセージを作成</li>
            <li>ボタンの URI アクションに、コピーしたURLを貼り付け</li>
          </ol>
        </section>

        <section className="bg-white rounded-lg border border-gray-200">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-sm font-semibold text-gray-900">アップロード済ファイル</h2>
            <p className="text-xs text-gray-500 mt-0.5">URLは永続的に有効。削除するとURL も無効になります。</p>
          </div>
          {loading ? (
            <div className="px-6 py-12 text-center text-sm text-gray-400">読み込み中...</div>
          ) : files.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-gray-400">
              まだファイルがアップロードされていません
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {files.map((file) => (
                <div key={file.id} className="px-6 py-3 flex items-center gap-4">
                  <div className="w-10 h-10 rounded-lg bg-red-50 flex items-center justify-center flex-shrink-0">
                    <span className="text-red-600 text-xs font-bold">PDF</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-900 truncate">{file.originalName ?? file.filename}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {formatSize(file.size)} · {formatDate(file.createdAt)}
                    </p>
                    <p className="text-xs text-gray-400 truncate font-mono mt-0.5">{file.url}</p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={() => copyUrl(file.id, file.url)}
                      className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                    >
                      {copiedId === file.id ? '✓ コピー済み' : 'URL コピー'}
                    </button>
                    <a
                      href={file.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-gray-100 hover:bg-gray-200 rounded-lg transition-colors"
                    >
                      開く
                    </a>
                    <button
                      onClick={() => removeFile(file.id)}
                      className="px-2 py-1.5 text-xs text-gray-400 hover:text-red-500 transition-colors"
                      title="削除"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
