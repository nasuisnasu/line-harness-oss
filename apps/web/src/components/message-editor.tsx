'use client'

import { useState } from 'react'

/**
 * Two-pane message editor: a resizable textarea on the left and a LINE
 * chat-style preview on the right. Operators were complaining that the
 * old single textarea didn't show where line breaks landed on mobile, so
 * they had to count characters manually. The preview mirrors the chat
 * bubble width on a typical LINE mobile chat (~250-300px text region) and
 * preserves explicit `\n` breaks so the operator can iterate on copy
 * without bouncing to LINE on their phone every time.
 *
 * The textarea uses CSS `resize: both` plus a min-height; users can drag
 * the bottom-right grip to grow the editor for long messages.
 */
export default function MessageEditor({
  value,
  onChange,
  placeholder,
  rows = 6,
}: {
  value: string
  onChange: (next: string) => void
  placeholder?: string
  rows?: number
}) {
  const [showPreview, setShowPreview] = useState(true)

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[11px] text-gray-400">{value.length} 文字</span>
        <button
          type="button"
          onClick={() => setShowPreview((v) => !v)}
          className="text-[11px] text-gray-500 hover:text-gray-800"
        >
          {showPreview ? 'プレビューを隠す' : 'プレビューを表示'}
        </button>
      </div>
      <div className={showPreview ? 'space-y-3' : ''}>
        <textarea
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500"
          style={{ resize: 'both', minHeight: `${rows * 1.5}rem` }}
          rows={rows}
          placeholder={placeholder ?? 'メッセージ内容を入力...'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {showPreview && (
          <ChatPreview text={value} />
        )}
      </div>
    </div>
  )
}

/**
 * Renders the input as a LINE chat bubble. Width is locked to ~260px to
 * approximate the wrap point for a mobile chat at default font size, so
 * the operator can see whether a Hiragana-heavy line will overflow before
 * they save. Newlines are preserved with `whitespace-pre-wrap`.
 */
function ChatPreview({ text }: { text: string }) {
  return (
    <div className="bg-[#7da9c0] rounded-lg p-3" aria-label="LINE プレビュー">
      <div className="flex items-start gap-2">
        <div className="w-8 h-8 rounded-full bg-white/40 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-[10px] text-white/90 mb-1">公式アカウント</p>
          <div
            className="bg-white rounded-2xl px-3 py-2 text-[13px] text-gray-900 whitespace-pre-wrap break-words leading-relaxed"
            style={{ maxWidth: 'calc(15em + 24px)' }}
          >
            {text || <span className="text-gray-400">(まだ何も入力されていません)</span>}
          </div>
        </div>
      </div>
    </div>
  )
}
