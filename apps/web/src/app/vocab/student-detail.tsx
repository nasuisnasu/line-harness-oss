'use client'

/**
 * 単語テスト — 生徒詳細
 *
 * 講師が知りたいのは次の4つ。この順で並べる。
 *   1. いつ・どういうテストをやったか
 *   2. 正答率がいくつか
 *   3. いま復習が必要な単語がどれくらいあるか
 *   4. 何で間違えているか
 *
 * 4 は**方向・形式・速度・範囲**で切る。語の意味でジャンル分けしない
 * （分類が恣意的なうえ、処方箋にならない。`06-metrics.md`）。
 *
 * 生徒に見せている言葉と揃える：習得済み／復習が必要／未挑戦。
 * 管理画面だけ「未習得」と書くと、生徒と話すときに話が食い違う。
 */

import { useEffect, useState, useCallback, Fragment } from 'react'
import {
  api,
  type VocabStudentDetail,
  type VocabAnswerRow,
  type VocabTrendPoint,
  type VocabCheckup,
} from '@/lib/api'

function fmtDateTime(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : iso
}

const kindLabel = (k: string) =>
  k === 'checkup' ? '実力' : k === 'review' ? '復習' : k === 'retry' ? 'もう一度' : 'セクション'
const fmtLabel = (f: string) => (f === 'recall' ? '自己採点' : '4択')
const dirLabel = (d: string, subject = 'en') =>
  subject === 'kobun' ? '古語→意味' : d === 'je' ? '日→英' : '英→日'
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`)

/**
 * 正答率の推移。
 *
 * **目盛りを必ず描く。** 軸の無い折れ線は「上がった/下がった」しか読めず、
 * 60%なのか90%なのかが分からないので判断に使えない。
 * 縦は0〜100%固定（データに合わせて伸縮させない。伸縮すると同じ形でも意味が変わる）。
 */
function Trend({ points }: { points: VocabTrendPoint[] }) {
  if (points.length < 2) {
    return <p className="text-sm text-gray-500">推移を出すにはあと{2 - points.length}回必要です。</p>
  }
  const W = 680
  const H = 190
  const L = 38   // 縦軸ラベルの幅
  const R = 12
  const T = 12
  const B = 30   // 日付ラベルの高さ
  const innerW = W - L - R
  const innerH = H - T - B
  const x = (i: number) => L + (points.length === 1 ? innerW / 2 : (innerW * i) / (points.length - 1))
  const y = (v: number) => T + innerH * (1 - v)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ')

  // 日付ラベルは詰まると読めないので、6個前後に間引く
  const everyN = Math.max(1, Math.ceil(points.length / 6))
  const shortDate = (iso: string) => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
    return m ? `${Number(m[2])}/${Number(m[3])}` : ''
  }

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full min-w-[420px]" role="img"
        aria-label="正答率の推移">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={L} y1={y(v)} x2={W - R} y2={y(v)}
              className={v === 0 || v === 1 ? 'stroke-gray-300' : 'stroke-gray-200'}
              stroke="currentColor" strokeWidth={1}
              strokeDasharray={v === 0 || v === 1 ? undefined : '3 3'} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="fill-gray-400" fontSize={11}>
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}

        <path d={d} fill="none" stroke="currentColor" className="text-emerald-500" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" />

        {points.map((p, i) => (
          <g key={i}>
            {/* 復習・もう一度の回は正答率が上がりやすいので、通常回と描き分ける */}
            <circle cx={x(i)} cy={y(p.rate)} r={p.kind === 'normal' ? 4 : 3.5}
              className={p.kind === 'normal' ? 'fill-emerald-600' : 'fill-white stroke-emerald-500'}
              strokeWidth={1.5}>
              <title>
                {`${shortDate(p.at)} ${Math.round(p.rate * 100)}%（${p.correct}/${p.total}）${
                  p.kind === 'normal' ? '' : p.kind === 'review' ? ' 復習' : ' もう一度'
                }`}
              </title>
            </circle>
            {i % everyN === 0 || i === points.length - 1 ? (
              <text x={x(i)} y={H - 10} textAnchor="middle" className="fill-gray-400" fontSize={11}>
                {shortDate(p.at)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      <p className="mt-1 text-xs text-gray-400">
        ● 通常のテスト　○ 復習・もう一度（正答率が上がりやすいので分けています）
      </p>
    </div>
  )
}

/** 実力テストの推移。全範囲・4択・5秒の固定条件で測った点なので、回をまたいで比較できる。 */
function CheckupTrend({ points }: { points: VocabCheckup[] }) {
  if (points.length < 2) {
    return (
      <p className="text-sm text-gray-500">
        推移を出すにはあと{2 - points.length}回必要です。
      </p>
    )
  }
  const W = 680, H = 190, L = 38, R = 12, T = 12, B = 30
  const iw = W - L - R, ih = H - T - B
  const x = (i: number) => L + (iw * i) / (points.length - 1)
  const y = (v: number) => T + ih * (1 - v)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ')
  const short = (iso: string) => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
    return m ? `${Number(m[2])}/${Number(m[3])}` : ''
  }
  const every = Math.max(1, Math.ceil(points.length / 6))
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full min-w-[420px]" role="img" aria-label="実力テストの推移">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={L} y1={y(v)} x2={W - R} y2={y(v)} stroke="currentColor"
              className={v === 0 || v === 1 ? 'text-gray-300' : 'text-gray-200'}
              strokeWidth={1} strokeDasharray={v === 0 || v === 1 ? undefined : '3 3'} />
            <text x={L - 6} y={y(v) + 4} textAnchor="end" className="fill-gray-400" fontSize={11}>
              {Math.round(v * 100)}%
            </text>
          </g>
        ))}
        {/* 4択なので何もしなくても25%は当たる。その下は実質ありえない */}
        <line x1={L} y1={y(0.25)} x2={W - R} y2={y(0.25)} stroke="currentColor"
          className="text-amber-300" strokeWidth={1.5} strokeDasharray="5 4" />
        <path d={d} fill="none" stroke="currentColor" className="text-emerald-500" strokeWidth={2}
          strokeLinecap="round" strokeLinejoin="round" />
        {points.map((p, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(p.score)} r={4} className="fill-emerald-600">
              <title>{`${short(p.at)} ${Math.round(p.score * 100)}%（${p.correct}/${p.total}）`}</title>
            </circle>
            {i % every === 0 || i === points.length - 1 ? (
              <text x={x(i)} y={H - 10} textAnchor="middle" className="fill-gray-400" fontSize={11}>
                {short(p.at)}
              </text>
            ) : null}
          </g>
        ))}
      </svg>
      <p className="mt-1 text-xs text-gray-400">
        黄色の破線は25%。4択なので、何も覚えていなくてもここまでは当たります。
      </p>
    </div>
  )
}

/** 横棒1本。基準に満たないものはそもそも呼び出し側で描かない。 */
function Bar({ label, value, note }: { label: string; value: number | null; note?: string }) {
  if (value === null) return null
  return (
    <div className="mb-2 flex items-center gap-3 last:mb-0">
      <span className="w-24 flex-none text-xs text-gray-500">{label}</span>
      <span className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
        <span className="block h-full bg-emerald-500" style={{ width: `${(value * 100).toFixed(1)}%` }} />
      </span>
      <span className="w-24 flex-none text-right text-xs tabular-nums text-gray-600">
        {pct(value)}
        {note && <span className="ml-1 text-gray-400">{note}</span>}
      </span>
    </div>
  )
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mt-4 rounded-lg border border-gray-200 bg-white">
      <div className="border-b border-gray-200 px-4 py-3">
        <h2 className="text-sm font-semibold text-gray-700">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-gray-500">{hint}</p>}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

export default function VocabStudentDetailPanel({
  friendId,
  displayName,
  onBack,
  fixedBookId,
  subject = 'en',
}: {
  friendId: string
  displayName: string | null
  onBack: () => void
  /** 古文単語テストの画面から開いたときは、その1冊に固定して切り替えさせない */
  fixedBookId?: number
  /** 'en' | 'kobun'。出題の向きの呼び名に使う */
  subject?: string
}) {
  const [data, setData] = useState<VocabStudentDetail | null>(null)
  const [bookId, setBookId] = useState<number | undefined>(fixedBookId)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openSession, setOpenSession] = useState<number | null>(null)
  const [answers, setAnswers] = useState<Record<number, VocabAnswerRow[]>>({})
  const [copied, setCopied] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await api.vocab.student(friendId, bookId))
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [friendId, bookId])

  useEffect(() => {
    load()
  }, [load])

  const toggleSession = async (sessionId: number) => {
    if (openSession === sessionId) {
      setOpenSession(null)
      return
    }
    setOpenSession(sessionId)
    if (!answers[sessionId]) {
      try {
        const res = await api.vocab.sessionAnswers(sessionId)
        setAnswers((prev) => ({ ...prev, [sessionId]: res.answers }))
      } catch {
        /* 内訳が出ないだけなので黙って諦める */
      }
    }
  }

  /** 授業前にそのままプリントにできるよう、TSVで書き出す。 */
  const copyTsv = (key: string, rows: string[]) => {
    void navigator.clipboard?.writeText(rows.join('\n'))
    setCopied(key)
    setTimeout(() => setCopied(''), 1600)
  }

  const focus = data?.focus_book
  const book = data?.books.find((b) => b.id === focus?.id) ?? null

  return (
    <div>
      <button onClick={onBack} className="text-sm text-gray-500 hover:underline">
        ← 生徒一覧
      </button>
      <div className="mt-2 flex flex-wrap items-baseline gap-3">
        <h2 className="text-lg font-bold text-gray-900">{displayName || '(名前なし)'}</h2>
        {data && data.books.length > 1 && !fixedBookId && (
          <select
            value={focus?.id ?? ''}
            onChange={(e) => setBookId(Number(e.target.value))}
            className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-700"
          >
            {data.books.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <p className="py-10 text-center text-sm text-gray-500">読み込み中...</p>
      ) : !data ? null : (
        <>
          {/* ── 総量 ── */}
          <div className="mt-4 grid gap-3 sm:grid-cols-4">
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-xs text-gray-500">実施回数</div>
              <div className="text-2xl font-bold tabular-nums">{data.totals.sessions}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-xs text-gray-500">学習日数</div>
              <div className="text-2xl font-bold tabular-nums">{data.totals.days}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-xs text-gray-500">解答数</div>
              <div className="text-2xl font-bold tabular-nums">{data.totals.answers}</div>
            </div>
            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <div className="text-xs text-gray-500">実力テスト</div>
              <div className="text-2xl font-bold tabular-nums">
                {pct(book?.checkup_score?.score ?? null)}
              </div>
              <div className="text-xs text-gray-400">
                {book?.checkup_score
                  ? `直近${book.checkup_score.sessions}回の加重平均`
                  : '未受験'}
              </div>
            </div>
          </div>

          {/* ── 実力テスト ── */}
          <Section
            title="実力テストの推移"
            hint="全範囲から100語ごとに均等出題・4択・5秒固定。条件をそろえているので回をまたいで比較できます"
          >
            <CheckupTrend points={book?.checkups ?? []} />
          </Section>

          {/* ── セクション別の定着率 ── */}
          {book && book.blocks?.length > 0 && (
            <Section
              title="セクション別の定着率"
              hint="100語ごと。直近のテストで正解できている語の割合です。どこが手薄かはここで見ます"
            >
              {book.blocks.map((b) => {
                const rate = b.total ? b.mastered / b.total : 0
                return (
                  <div key={b.block} className="mb-2 flex items-center gap-3 last:mb-0">
                    <span className="w-24 flex-none text-xs tabular-nums text-gray-500">
                      {b.from}–{b.to}
                    </span>
                    <span className="flex h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                      <span className="block h-full bg-emerald-500"
                        style={{ width: `${(b.total ? (b.mastered / b.total) * 100 : 0).toFixed(1)}%` }} />
                      <span className="block h-full bg-red-400"
                        style={{ width: `${(b.total ? (b.unmastered / b.total) * 100 : 0).toFixed(1)}%` }} />
                    </span>
                    <span className="w-32 flex-none text-right text-xs tabular-nums text-gray-600">
                      {pct(rate)}
                      <span className="ml-1 text-gray-400">
                        (復習{b.unmastered}/未挑戦{b.untried})
                      </span>
                    </span>
                  </div>
                )
              })}
            </Section>
          )}

          {/* ── 2. 正答率の推移 ── */}
          <Section
            title="セクションテストの正答率"
            hint="範囲を選んで解いた回。範囲も形式も毎回違うので、実力の比較には使えません。実力は上の実力テストで見てください"
          >
            <Trend points={data.trend} />
          </Section>

          {/* ── 4. 何で間違えているか ── */}
          <Section
            title="何で間違えているか"
            hint="方向・形式・速度で切っています。「動詞が苦手」のような意味での分類はしません（処方箋にならないため）"
          >
            {data.formats ? (
              <>
                <Bar label="英 → 日" value={data.formats.ej} />
                <Bar label="日 → 英" value={data.formats.je} />
                <div className="my-3 border-t border-gray-100" />
                <Bar label="4択" value={data.formats.choice} />
                <Bar label="自己採点" value={data.formats.recall} />
                <div className="my-3 border-t border-gray-100" />
                <Bar label="時間切れ率" value={data.formats.timeout_rate} note="(低いほど良い)" />
                {data.formats.recall !== null &&
                  data.formats.choice !== null &&
                  data.formats.recall - data.formats.choice > 0.15 && (
                    <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      自己採点が4択より{Math.round((data.formats.recall - data.formats.choice) * 100)}
                      ポイント高いです。自己採点が甘い可能性があります。
                    </p>
                  )}
              </>
            ) : (
              <p className="text-sm text-gray-500">まだデータがありません。</p>
            )}

            {data.sections.length > 0 && (
              <div className="mt-5">
                <h3 className="mb-2 text-xs font-semibold text-gray-500">
                  範囲別の正答率（100語ごと・10回以上解答したブロックのみ）
                </h3>
                {data.sections.map((sc) => (
                  <Bar key={sc.block} label={`${sc.from}–${sc.to}`} value={sc.rate} note={`(${sc.asked}回)`} />
                ))}
              </div>
            )}
          </Section>

          {/* ── くり返し間違えている単語 ── */}
          <Section title="くり返し間違えている単語" hint="出題2回以上・誤答率50%以上のものだけ。1回落としただけの単語は入れていません">
            {data.weak_words.length === 0 ? (
              <p className="text-sm text-gray-500">該当する単語がありません。</p>
            ) : (
              <>
                <button
                  onClick={() =>
                    copyTsv(
                      'weak',
                      data.weak_words.map((w) =>
                        [String(w.no).padStart(3, '0'), w.en, w.ja, `${w.wrong}/${w.asked}`].join('\t'),
                      ),
                    )
                  }
                  className="mb-3 rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  {copied === 'weak' ? 'コピーしました' : `TSVでコピー（${data.weak_words.length}語）`}
                </button>
                <ul className="divide-y divide-gray-100">
                  {data.weak_words.map((w) => (
                    <li key={w.word_id} className="flex items-baseline gap-3 py-1.5 text-sm">
                      <span className="w-9 flex-none tabular-nums text-xs text-gray-400">
                        {String(w.no).padStart(3, '0')}
                      </span>
                      <span className="font-medium text-gray-900">{w.en}</span>
                      <span className="text-gray-500">{w.ja}</span>
                      <span className="ml-auto tabular-nums text-xs text-red-600">
                        ×{w.wrong}/{w.asked}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>

          {/* ── いま復習が必要な単語（全件） ── */}
          <Section title="いま復習が必要な単語" hint="直近のテストで間違えた単語。次に正解すれば「習得済み」に移ります">
            {data.review_words.length === 0 ? (
              <p className="text-sm text-gray-500">ありません。</p>
            ) : (
              <>
                <button
                  onClick={() =>
                    copyTsv(
                      'review',
                      data.review_words.map((w) => [String(w.no).padStart(3, '0'), w.en, w.ja].join('\t')),
                    )
                  }
                  className="mb-3 rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  {copied === 'review' ? 'コピーしました' : `TSVでコピー（${data.review_words.length}語）`}
                </button>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  {data.review_words.map((w) => (
                    <span key={w.id} className="text-gray-700">
                      <span className="tabular-nums text-xs text-gray-400">
                        {String(w.no).padStart(3, '0')}
                      </span>{' '}
                      {w.en}
                    </span>
                  ))}
                </div>
              </>
            )}
          </Section>

          {/* ── 1. いつ・どういうテストをやったか ── */}
          <Section title="テスト履歴" hint="行をタップすると1問ごとの正誤が出ます。設定を必ず併記しています（同じ70%でも中身が違うため）">
            {data.sessions.length === 0 ? (
              <p className="text-sm text-gray-500">まだ実施していません。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                      <th className="py-2 pr-3 font-medium">日時</th>
                      <th className="py-2 pr-3 font-medium">単語帳</th>
                      <th className="py-2 pr-3 font-medium">範囲</th>
                      <th className="py-2 pr-3 font-medium">形式</th>
                      <th className="py-2 pr-3 font-medium">方向</th>
                      <th className="py-2 pr-3 font-medium">制限</th>
                      <th className="py-2 pr-3 font-medium">種別</th>
                      <th className="py-2 text-right font-medium">結果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sessions.map((s) => (
                      <Fragment key={s.id}>
                        <tr
                          onClick={() => void toggleSession(s.id)}
                          className="cursor-pointer border-b border-gray-100 text-gray-700 last:border-0 hover:bg-gray-50"
                        >
                          <td className="py-2 pr-3 tabular-nums">{fmtDateTime(s.finished_at)}</td>
                          <td className="py-2 pr-3">{s.book_name}</td>
                          <td className="py-2 pr-3 tabular-nums">
                            {s.range_from !== null ? `${s.range_from}–${s.range_to}` : '—'}
                          </td>
                          <td className="py-2 pr-3">{fmtLabel(s.format)}</td>
                          <td className="py-2 pr-3">{dirLabel(s.direction, subject)}</td>
                          <td className="py-2 pr-3 tabular-nums">{s.timer_sec ? `${s.timer_sec}秒` : 'なし'}</td>
                          <td className="py-2 pr-3">{kindLabel(s.kind)}</td>
                          <td className="py-2 text-right font-semibold tabular-nums">
                            {s.correct}/{s.total}
                            <span className="ml-2 text-xs font-normal text-gray-500">
                              {s.total ? Math.round((s.correct / s.total) * 100) : 0}%
                            </span>
                          </td>
                        </tr>
                        {openSession === s.id && (
                          <tr className="border-b border-gray-100 bg-gray-50">
                            <td colSpan={8} className="px-2 py-3">
                              {!answers[s.id] ? (
                                <span className="text-xs text-gray-500">読み込み中...</span>
                              ) : (
                                <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
                                  {answers[s.id].map((a) => (
                                    <span key={a.word_id} className={a.ok ? 'text-gray-600' : 'text-red-600'}>
                                      <span className="tabular-nums text-gray-400">
                                        {String(a.no).padStart(3, '0')}
                                      </span>{' '}
                                      {a.en}
                                      {a.timed_out ? '（時間切れ）' : ''}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  )
}
