'use client'

import type { ReactNode } from 'react'

/**
 * Renders one message the way LINE will deliver it — bubble only, no avatar
 * or talk background. Each message type has its own JSON shape, so a plain
 * text bubble would show raw JSON for image / flex / buttons; we pivot per
 * type to show something faithful instead.
 */
export function MessageBubble({ messageType, messageContent }: { messageType: string; messageContent: string }) {
  if (messageType === 'text') {
    return (
      <div
        className="bg-white rounded-2xl px-3 py-2 text-[13px] text-gray-900 whitespace-pre-wrap break-words leading-relaxed"
        style={{ maxWidth: '320px' }}
      >
        {messageContent || <span className="text-gray-400">(空)</span>}
      </div>
    )
  }

  if (messageType === 'image') {
    let url: string | null = null
    try {
      const parsed = JSON.parse(messageContent) as { previewImageUrl?: string; originalContentUrl?: string }
      url = parsed.previewImageUrl ?? parsed.originalContentUrl ?? null
    } catch { /* fall through to the error bubble */ }
    return url ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" className="rounded-2xl block" style={{ maxWidth: '240px' }} />
    ) : (
      <div className="bg-white rounded-2xl px-3 py-2 text-[12px] text-red-500" style={{ maxWidth: '320px' }}>
        画像URLが解析できません
      </div>
    )
  }

  if (messageType === 'buttons') {
    let parsed: {
      thumbnailImageUrl?: string
      title?: string
      text?: string
      actions?: Array<{ label?: string }>
    } | null = null
    try { parsed = JSON.parse(messageContent) } catch { /* ignore */ }
    if (!parsed) {
      return (
        <div className="bg-white rounded-2xl px-3 py-2 text-[12px] text-red-500" style={{ maxWidth: '320px' }}>
          ボタンテンプレートが解析できません
        </div>
      )
    }
    return (
      <div className="bg-white rounded-2xl overflow-hidden text-[13px] text-gray-900" style={{ maxWidth: '320px' }}>
        {parsed.thumbnailImageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={parsed.thumbnailImageUrl} alt="" className="w-full block" style={{ aspectRatio: '1.51 / 1', objectFit: 'cover' }} />
        )}
        <div className="px-3 py-2">
          {parsed.title && <p className="font-bold mb-1 break-words">{parsed.title}</p>}
          <p className="whitespace-pre-wrap break-words leading-relaxed">{parsed.text}</p>
        </div>
        <div className="border-t border-gray-100">
          {(parsed.actions ?? []).map((a, i) => (
            <div key={i} className="px-3 py-2 text-center text-[#06C755] border-b border-gray-100 last:border-0">
              {a.label || `ボタン ${i + 1}`}
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (messageType === 'flex') {
    // Arbitrary Flex JSON can't be rendered faithfully without the LINE SDK
    // runtime, so we pull out the visible text + button labels — that is
    // enough to tell one step from another when scanning the whole scenario.
    try {
      const parsed = JSON.parse(messageContent)
      const texts: string[] = []
      const extract = (obj: Record<string, unknown>) => {
        if (obj.type === 'text' && obj.text) texts.push(obj.text as string)
        const action = obj.action as Record<string, unknown> | undefined
        if (obj.type === 'button' && action && action.label) texts.push(`[${action.label as string}]`)
        for (const val of Object.values(obj)) {
          if (Array.isArray(val)) val.forEach((v) => { if (v && typeof v === 'object') extract(v as Record<string, unknown>) })
          else if (val && typeof val === 'object') extract(val as Record<string, unknown>)
        }
      }
      extract(parsed)
      return (
        <div className="bg-white rounded-2xl px-3 py-2 text-[13px] text-gray-900 space-y-1" style={{ maxWidth: '320px' }}>
          <p className="text-[10px] font-medium text-orange-600">Flex Message</p>
          {texts.slice(0, 10).map((t, i) => (
            <p key={i} className={`break-words ${i === 0 ? 'font-medium' : 'text-gray-600'}`}>{t}</p>
          ))}
          {texts.length > 10 && <p className="text-[11px] text-gray-400">…他 {texts.length - 10} 要素</p>}
        </div>
      )
    } catch {
      return (
        <div className="bg-white rounded-2xl px-3 py-2 text-[12px] text-red-500" style={{ maxWidth: '320px' }}>
          Flex JSON パースエラー
        </div>
      )
    }
  }

  return (
    <div className="bg-white rounded-2xl px-3 py-2 text-[11px] text-gray-700 font-mono whitespace-pre-wrap break-all" style={{ maxWidth: '320px' }}>
      {messageContent.length > 400 ? messageContent.slice(0, 400) + '…' : messageContent}
    </div>
  )
}

/** Wraps a bubble in the talk-screen row (avatar + account name). */
export function TalkRow({ children, accountName = '公式アカウント' }: { children: ReactNode; accountName?: string }) {
  return (
    <div className="flex items-start gap-2">
      <div className="w-8 h-8 rounded-full bg-white/40 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-white/90 mb-1">{accountName}</p>
        {children}
      </div>
    </div>
  )
}

export interface TalkPreviewStep {
  key: string
  stepOrder: number
  /** 「即時」「1日後 10:00」など、配信タイミングの表示文字列 */
  timing: string
  messageType: string
  messageContent: string
  /** 「タグあり: セミナー参加」など。条件なしなら null */
  conditionLabel?: string | null
  /** richmenu ステップで切り替わる先の名前（未選択なら null＝解除） */
  richMenuLabel?: string | null
  templateName?: string | null
  /** 編集中のステップ（未保存の内容を反映している行）を目立たせる */
  highlight?: boolean
}

/**
 * 全ステップを1つのトーク画面として縦に並べる。ステップを開かなくても
 * シナリオ全体が友だちにどう届くかを見るためのもの。
 */
export default function ScenarioTalkPreview({
  steps,
  accountName,
}: {
  steps: TalkPreviewStep[]
  accountName?: string
}) {
  return (
    <div className="rounded-lg overflow-hidden border border-gray-200">
      <div className="bg-gray-800 text-white text-xs px-3 py-2 flex items-center justify-between">
        <span className="font-medium">トークプレビュー</span>
        <span className="text-white/60">{steps.length} ステップ</span>
      </div>
      <div className="bg-[#7da9c0] p-3 space-y-3 max-h-[70vh] overflow-y-auto">
        {steps.length === 0 ? (
          <p className="text-[12px] text-white/90 text-center py-6">ステップがまだありません</p>
        ) : (
          steps.map((step) => (
            <div key={step.key} className={step.highlight ? 'rounded-lg ring-2 ring-[#06C755] ring-offset-2 ring-offset-[#7da9c0] p-1' : undefined}>
              <div className="flex items-center justify-center gap-1.5 flex-wrap mb-2">
                <span className="text-[10px] text-white bg-black/25 rounded-full px-2 py-0.5">
                  {step.stepOrder}. {step.timing}
                </span>
                {step.conditionLabel && (
                  <span className="text-[10px] text-white bg-yellow-600/70 rounded-full px-2 py-0.5">
                    🔒 {step.conditionLabel}
                  </span>
                )}
                {step.templateName && (
                  <span className="text-[10px] text-white bg-black/25 rounded-full px-2 py-0.5">
                    🧩 {step.templateName}
                  </span>
                )}
                {step.highlight && (
                  <span className="text-[10px] text-white bg-[#06C755] rounded-full px-2 py-0.5">編集中</span>
                )}
              </div>
              {step.messageType === 'richmenu' ? (
                <p className="text-[11px] text-white text-center bg-black/20 rounded-md px-3 py-2">
                  {step.richMenuLabel
                    ? `リッチメニューを「${step.richMenuLabel}」に切り替え`
                    : 'リッチメニューを解除'}
                </p>
              ) : (
                <TalkRow accountName={accountName}>
                  <MessageBubble messageType={step.messageType} messageContent={step.messageContent} />
                </TalkRow>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
