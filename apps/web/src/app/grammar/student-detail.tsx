'use client'

/**
 * 文法テスト — 生徒詳細
 *
 * 講師が知りたいのは次の4つ。この順で並べる。
 *   1. **どの単元でつまずいているか**
 *   2. 前にできたことを忘れていないか
 *   3. **どの誤答を選んでいるか**
 *   4. いつ・どういうテストをやったか
 *
 * 1 と 3 が単語テストには無い視点で、いちばん価値がある。
 *
 * 1 は**解答の蓄積から出す。サンプリングでは出ない。**
 * 総復習テストは全体を薄く引くので、そこから「この単元が弱い」は読めない
 * （21分野を20問で回れば1分野1問、しかも4択で25%当たる）。
 * 復習テストが間違えた問題を繰り返し出すので、苦手な単元ほど回数が貯まる。
 *
 * 3 は「同じ誤答に集まっている」＝勘違いが1つあるので授業で直せる。
 * 「誤答がばらけている」＝単に知らないだけなので、まず覚えさせる。
 * 処方箋が変わるので、この2つを混ぜて「正答率が低い」で終わらせない。
 *
 * ★ **「実力」という言葉を使わない。** このツールが測れるのは問題集の仕上がりであって
 *   入試で何点取れるかではない（`lms/grammar/01-categories.md`）。
 *
 * 生徒に見せている言葉と揃える：習得済み／復習が必要／未挑戦。
 */

import { useEffect, useState, useCallback, Fragment } from 'react'
import {
  api,
  type GrammarStudentDetail,
  type GrammarAnswerRow,
  type GrammarCheckup,
  type GrammarDistractor,
  type GrammarUnitStat,
  type VocabTrendPoint,
} from '@/lib/api'

function fmtDateTime(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : iso
}

const kindLabel = (k: string) =>
  k === 'checkup' ? '総復習' : k === 'review' ? '復習' : k === 'retry' ? 'もう一度' : '単元'
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`

/** 問題文の `( )` と `[…]` を管理画面でも同じ見た目にする。 */
function Prompt({ text }: { text: string }) {
  const parts = text.split(/(\(\s*\)|\[[^\]]+\])/g)
  return (
    <span>
      {parts.map((p, i) => {
        if (/^\(\s*\)$/.test(p))
          return (
            <span key={i} className="mx-1 inline-block w-14 border-b-2 border-emerald-500 align-middle" />
          )
        if (/^\[[^\]]+\]$/.test(p))
          return (
            <span key={i} className="border-b-2 border-violet-400">
              {p.slice(1, -1)}
            </span>
          )
        return <Fragment key={i}>{p}</Fragment>
      })}
    </span>
  )
}

/**
 * 正答率の推移。
 *
 * **目盛りを必ず描く。** 軸の無い折れ線は「上がった/下がった」しか読めず、
 * 60%なのか90%なのかが分からないので判断に使えない。
 * 縦は0〜100%固定（データに合わせて伸縮させると同じ形でも意味が変わる）。
 */
function Trend({ points }: { points: VocabTrendPoint[] }) {
  if (points.length < 2) {
    return <p className="text-sm text-gray-500">推移を出すにはあと{2 - points.length}回必要です。</p>
  }
  const W = 680, H = 190, L = 38, R = 12, T = 12, B = 30
  const innerW = W - L - R
  const innerH = H - T - B
  const x = (i: number) => L + (innerW * i) / (points.length - 1)
  const y = (v: number) => T + innerH * (1 - v)
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`).join(' ')
  const everyN = Math.max(1, Math.ceil(points.length / 6))
  const shortDate = (iso: string) => {
    const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/)
    return m ? `${Number(m[2])}/${Number(m[3])}` : ''
  }

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full min-w-[420px]" role="img" aria-label="正答率の推移">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line
              x1={L} y1={y(v)} x2={W - R} y2={y(v)}
              className={v === 0 || v === 1 ? 'stroke-gray-300' : 'stroke-gray-200'}
              stroke="currentColor" strokeWidth={1}
              strokeDasharray={v === 0 || v === 1 ? undefined : '3 3'}
            />
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

/**
 * 総復習テストの推移。
 *
 * **これは実力ではない。** 測っているのは「一度できた問題を、時間をおいてまだ解けるか」。
 * 4択・20秒の固定条件なので回をまたいで比較はできる。
 */
function CheckupTrend({ points }: { points: GrammarCheckup[] }) {
  if (points.length < 2) {
    return <p className="text-sm text-gray-500">推移を出すにはあと{2 - points.length}回必要です。</p>
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
      <svg viewBox={`0 0 ${W} ${H}`} className="h-48 w-full min-w-[420px]" role="img" aria-label="総復習テストの推移">
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
        黄色の破線は25%。4択なので、何も分かっていなくてもここまでは当たります。
        下がっていたら「忘れている」のサインです。
      </p>
    </div>
  )
}

function Bar({ label, value, note }: { label: string; value: number | null; note?: string }) {
  if (value === null) return null
  return (
    <div className="mb-2 flex items-center gap-3 last:mb-0">
      <span className="w-28 flex-none text-xs text-gray-500">{label}</span>
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

/**
 * 誤答の選ばれ方。
 *
 * 誤答のうち最多のものが**誤答全体の6割以上**を占めるとき、勘違いが1つに
 * 集まっていると見なして印をつける。そこだけ授業で直せば効くため。
 */
const CONCENTRATED = 0.6

function DistractorRow({ d }: { d: GrammarDistractor }) {
  const wrongTotal = d.picks.reduce((a, p, i) => (i === d.answer ? a : a + p), 0)
  const topWrong = d.picks
    .map((n, i) => ({ n, i }))
    .filter((x) => x.i !== d.answer)
    .sort((a, b) => b.n - a.n)[0]
  const concentrated = wrongTotal > 0 && topWrong && topWrong.n / wrongTotal >= CONCENTRATED

  return (
    <li className="border-b border-gray-100 py-3 last:border-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="tabular-nums text-xs text-gray-400">
          {String(d.no).padStart(3, '0')}
        </span>
        <span className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-500">
          {d.category}
        </span>
        <span className="ml-auto text-xs tabular-nums text-gray-500">
          {d.asked}回中 {wrongTotal}回ミス
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-800">
        <Prompt text={d.prompt} />
      </p>
      <div className="mt-2 space-y-1">
        {d.choices.map((c, i) => {
          const n = d.picks[i] ?? 0
          const w = d.asked > 0 ? (n / d.asked) * 100 : 0
          const isAnswer = i === d.answer
          const isTop = !isAnswer && concentrated && topWrong && i === topWrong.i
          const why = d.distractors?.[String(i)]
          return (
            <div key={i}>
              <div className="flex items-center gap-2 text-xs">
                <span className={`w-40 flex-none truncate ${isAnswer ? 'font-semibold text-emerald-700' : 'text-gray-600'}`}>
                  {isAnswer ? '◯ ' : '　'}
                  {c}
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-gray-100">
                  <span
                    className={`block h-full ${isAnswer ? 'bg-emerald-500' : isTop ? 'bg-amber-500' : 'bg-gray-300'}`}
                    style={{ width: `${w.toFixed(1)}%` }}
                  />
                </span>
                <span className="w-8 flex-none text-right tabular-nums text-gray-500">{n}</span>
              </div>
              {/* この誤答がどの勘違いに対応するか。生成時に付けたラベル */}
              {!isAnswer && why && (
                <p className="ml-2 pl-40 text-[11px] leading-snug text-gray-400">← {why}</p>
              )}
            </div>
          )
        })}
      </div>
      {concentrated && (
        <p className="mt-2 rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
          誤答が「{d.choices[topWrong.i]}」に集まっています。
          {d.distractors?.[String(topWrong.i)]
            ? `「${d.distractors[String(topWrong.i)]}」という勘違いが1つなので、授業で直せば効きます。`
            : '勘違いが1つなので、授業で直せば効きます。'}
        </p>
      )}
      {/*
        死んだ選択肢。生徒ではなく**問題の側**の不具合なので、打ち手は「問題を直す」。
        出題回数が少ないうちは当然0回なので、十分に出してから読む。
      */}
      {d.asked >= 5 && d.dead.length > 0 && (
        <p className="mt-2 rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">
          {d.asked}回出して一度も選ばれていない誤答があります（
          {d.dead.map((i) => `「${d.choices[i]}」`).join('、')}）。
          この問題は実質{d.choices.length - d.dead.length}択になっています。
          <b>生徒ではなく問題の側の問題</b>なので、選択肢を作り直してください。
        </p>
      )}
    </li>
  )
}

/**
 * よく間違えている単元。**講師がいちばん見る表。**
 *
 * 延べ解答数（asked）と触れた問題数（questions）を必ず併記する。
 * 「3問を1回ずつやって33%」と「8問を延べ20回やって40%」は別物で、
 * 前者は判断に使えない。数字の確からしさを画面で見せる。
 */
function UnitRanking({ units }: { units: GrammarUnitStat[] }) {
  if (units.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        まだ判定できません。単元テストの解答が5問以上たまった単元から出てきます。
      </p>
    )
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
            <th className="py-2 pr-3 font-medium">単元</th>
            <th className="py-2 pr-3 font-medium">分野</th>
            <th className="py-2 pr-3 font-medium">正答率</th>
            <th className="py-2 pr-3 font-medium">延べ / 問数</th>
            <th className="py-2 font-medium">定着</th>
          </tr>
        </thead>
        <tbody>
          {units.map((u) => {
            // 延べ回数が少ないうちは数字がぶれる。薄く出して判断を急がせない
            const thin = u.asked < 10
            return (
              <tr key={`${u.category} ${u.name}`} className="border-b border-gray-100 last:border-0">
                <td className="py-2 pr-3 font-medium text-gray-900">{u.name}</td>
                <td className="py-2 pr-3 text-xs text-gray-500">{u.category}</td>
                <td className="py-2 pr-3">
                  <div className="flex items-center gap-2">
                    <span className="h-2 w-20 flex-none overflow-hidden rounded-full bg-gray-100">
                      <span
                        className={`block h-full ${thin ? 'bg-gray-400' : u.rate < 0.5 ? 'bg-red-500' : 'bg-emerald-500'}`}
                        style={{ width: `${(u.rate * 100).toFixed(1)}%` }}
                      />
                    </span>
                    <span className={`tabular-nums ${thin ? 'text-gray-400' : 'text-gray-800'}`}>
                      {pct(u.rate)}
                    </span>
                  </div>
                </td>
                <td className="py-2 pr-3 text-xs tabular-nums text-gray-500">
                  延べ{u.asked}回 / {u.questions}問
                  {thin && <span className="ml-1 text-amber-600">（回数が少ない）</span>}
                </td>
                <td className="py-2 text-xs tabular-nums text-gray-500">
                  {u.mastered}/{u.total}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-gray-400">
        上ほど苦手です。延べ回数が10回未満の行は薄く出しています。
        同じ問題を繰り返し解くほど数字が確かになります。
      </p>
    </div>
  )
}

export default function GrammarStudentDetailPanel({
  friendId,
  displayName,
  onBack,
}: {
  friendId: string
  displayName: string | null
  onBack: () => void
}) {
  const [data, setData] = useState<GrammarStudentDetail | null>(null)
  const [bookId, setBookId] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openSession, setOpenSession] = useState<number | null>(null)
  const [answers, setAnswers] = useState<Record<number, GrammarAnswerRow[]>>({})
  const [copied, setCopied] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      setData(await api.grammar.student(friendId, bookId))
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
        const res = await api.grammar.sessionAnswers(sessionId)
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
        {data && data.books.length > 1 && (
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
              <div className="text-xs text-gray-500">総復習テスト</div>
              <div className="text-2xl font-bold tabular-nums">
                {pct(book?.checkup_score?.score ?? null)}
              </div>
              <div className="text-xs text-gray-400">
                {book?.checkup_score ? `直近${book.checkup_score.sessions}回の加重平均` : '未受験'}
              </div>
            </div>
          </div>

          {/* ── 1. どの単元でつまずいているか（講師がまず見る） ── */}
          <Section
            title="よく間違えている単元"
            hint="解答の蓄積から出しています。総復習テストは全体を薄く引くので、そこからは単元の弱点は読めません"
          >
            <UnitRanking units={data.units} />
          </Section>

          {/* ── 2. 忘れの検出 ── */}
          <Section
            title="総復習テストの推移"
            hint="最後に正解してから時間が経った問題を優先して出しています。実力ではなく「前にできた問題を忘れていないか」の数字です"
          >
            <CheckupTrend points={book?.checkups ?? []} />
          </Section>

          {/* ── 3. 分野別の定着率 ── */}
          {book && book.categories?.length > 0 && (
            <Section
              title="分野別の定着率"
              hint="直近のテストで正解できている問題の割合。未挑戦も分母に入れています。どこが手薄かはここで見ます"
            >
              {book.categories.map((c) => {
                const w1 = c.total ? (c.mastered / c.total) * 100 : 0
                const w2 = c.total ? (c.unmastered / c.total) * 100 : 0
                return (
                  <div key={c.name} className="mb-2 flex items-center gap-3 last:mb-0">
                    <span className="w-28 flex-none truncate text-xs text-gray-500">{c.name}</span>
                    <span className="flex h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                      <span className="block h-full bg-emerald-500" style={{ width: `${w1.toFixed(1)}%` }} />
                      <span className="block h-full bg-red-400" style={{ width: `${w2.toFixed(1)}%` }} />
                    </span>
                    <span className="w-36 flex-none text-right text-xs tabular-nums text-gray-600">
                      {pct(c.rate)}
                      <span className="ml-1 text-gray-400">
                        (復習{c.unmastered}/未挑戦{c.untried})
                      </span>
                    </span>
                  </div>
                )
              })}
            </Section>
          )}

          {/* ── 分野別の正答率（解いたぶんだけ） ── */}
          {data.categories.length > 0 && (
            <Section
              title="分野別の正答率"
              hint="解答が5問以上ある分野だけ。上ほど苦手です。定着率（上）は未挑戦を含む数字、こちらは実際に解いたぶんの正答率です"
            >
              {data.categories.map((c) => (
                <Bar key={c.name} label={c.name} value={c.rate} note={`(${c.asked}問)`} />
              ))}
            </Section>
          )}

          {/* ── 3. どの誤答を選んでいるか ── */}
          <Section
            title="どの誤答を選んでいるか"
            hint="集まっていれば勘違いが1つ（授業で直せる）、ばらけていれば単に知らないだけ（まず覚えさせる）。一度も選ばれない誤答があれば、それは問題の側の不具合です"
          >
            {data.distractors.length === 0 ? (
              <p className="text-sm text-gray-500">まだ誤答のデータがありません。</p>
            ) : (
              <ul>
                {data.distractors.map((d) => (
                  <DistractorRow key={d.question_id} d={d} />
                ))}
              </ul>
            )}
          </Section>

          {/* ── 解く速さ ── */}
          {data.pace && (data.pace.median_ms !== null || data.pace.timeout_rate !== null) && (
            <Section title="解く速さ" hint="正解した問題だけの中央値。遅いのは「分かるが遅い」＝入試では落とす状態です">
              <div className="flex flex-wrap gap-6 text-sm text-gray-700">
                {data.pace.median_ms !== null && (
                  <span>
                    正解までの中央値{' '}
                    <b className="tabular-nums">{(data.pace.median_ms / 1000).toFixed(1)}秒</b>
                  </span>
                )}
                {data.pace.timeout_rate !== null && (
                  <span>
                    時間切れ率 <b className="tabular-nums">{pct(data.pace.timeout_rate)}</b>
                    <span className="ml-1 text-xs text-gray-400">(制限時間ありの回のみ)</span>
                  </span>
                )}
              </div>
            </Section>
          )}

          {/* ── くり返し間違えている問題 ── */}
          <Section
            title="くり返し間違えている問題"
            hint="出題2回以上・誤答率50%以上のものだけ。1回落としただけの問題は入れていません"
          >
            {data.weak_questions.length === 0 ? (
              <p className="text-sm text-gray-500">該当する問題がありません。</p>
            ) : (
              <>
                <button
                  onClick={() =>
                    copyTsv(
                      'weak',
                      data.weak_questions.map((w) =>
                        [
                          String(w.no).padStart(3, '0'),
                          w.category,
                          w.prompt,
                          w.choices[w.answer] ?? '',
                          `${w.wrong}/${w.asked}`,
                        ].join('\t'),
                      ),
                    )
                  }
                  className="mb-3 rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  {copied === 'weak' ? 'コピーしました' : `TSVでコピー（${data.weak_questions.length}問）`}
                </button>
                <ul className="divide-y divide-gray-100">
                  {data.weak_questions.map((w) => (
                    <li key={w.question_id} className="py-2 text-sm">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="tabular-nums text-xs text-gray-400">
                          {String(w.no).padStart(3, '0')}
                        </span>
                        <span className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-500">
                          {w.category}
                        </span>
                        <span className="ml-auto tabular-nums text-xs text-red-600">
                          ×{w.wrong}/{w.asked}
                        </span>
                      </div>
                      <p className="mt-1 text-gray-800">
                        <Prompt text={w.prompt} />
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        正解 <b className="text-emerald-700">{w.choices[w.answer] ?? ''}</b>
                      </p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>

          {/* ── いま復習が必要な問題（全件） ── */}
          <Section title="いま復習が必要な問題" hint="直近のテストで間違えた問題。次に正解すれば「習得済み」に移ります">
            {data.review_questions.length === 0 ? (
              <p className="text-sm text-gray-500">ありません。</p>
            ) : (
              <>
                <button
                  onClick={() =>
                    copyTsv(
                      'review',
                      data.review_questions.map((q) =>
                        [String(q.no).padStart(3, '0'), q.category, q.prompt].join('\t'),
                      ),
                    )
                  }
                  className="mb-3 rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  {copied === 'review' ? 'コピーしました' : `TSVでコピー（${data.review_questions.length}問）`}
                </button>
                <ul className="divide-y divide-gray-100 text-sm">
                  {data.review_questions.map((q) => (
                    <li key={q.id} className="flex items-baseline gap-2 py-1.5">
                      <span className="w-9 flex-none tabular-nums text-xs text-gray-400">
                        {String(q.no).padStart(3, '0')}
                      </span>
                      <span className="w-24 flex-none truncate text-xs text-gray-500">{q.category}</span>
                      <span className="text-gray-700">
                        <Prompt text={q.prompt} />
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>

          {/* ── 4. いつ・どういうテストをやったか ── */}
          <Section title="テスト履歴" hint="行をタップすると1問ごとの正誤と、選んだ選択肢が出ます">
            {data.sessions.length === 0 ? (
              <p className="text-sm text-gray-500">まだ実施していません。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-gray-200 text-left text-xs text-gray-500">
                      <th className="py-2 pr-3 font-medium">日時</th>
                      <th className="py-2 pr-3 font-medium">問題集</th>
                      <th className="py-2 pr-3 font-medium">単元</th>
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
                          <td className="py-2 pr-3">
                            {s.sub_category || s.category || '—'}
                          </td>
                          <td className="py-2 pr-3 tabular-nums">
                            {s.timer_sec ? `${s.timer_sec}秒` : 'なし'}
                          </td>
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
                            <td colSpan={6} className="px-2 py-3">
                              {!answers[s.id] ? (
                                <span className="text-xs text-gray-500">読み込み中...</span>
                              ) : (
                                <ul className="space-y-1.5 text-xs">
                                  {answers[s.id].map((a) => (
                                    <li key={a.question_id} className="flex flex-wrap items-baseline gap-2">
                                      <span className="tabular-nums text-gray-400">
                                        {String(a.no).padStart(3, '0')}
                                      </span>
                                      <span className={a.ok ? 'text-gray-600' : 'text-red-600'}>
                                        <Prompt text={a.prompt} />
                                      </span>
                                      {!a.ok && (
                                        <span className="text-gray-500">
                                          →{' '}
                                          {a.timed_out
                                            ? '時間切れ'
                                            : `「${a.chosen !== null ? a.choices[a.chosen] : '—'}」を選択`}
                                          （正解「{a.choices[a.answer] ?? ''}」）
                                        </span>
                                      )}
                                    </li>
                                  ))}
                                </ul>
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

          {/* 単語テストの「セクションテストの正答率」にあたるもの。実力とは別物なので下に置く */}
          <Section
            title="単元テストの正答率"
            hint="単元を選んで解いた回。単元も問題数も毎回違うので、回どうしの比較には使えません"
          >
            <Trend points={data.trend} />
          </Section>
        </>
      )}
    </div>
  )
}
