'use client'

/**
 * 文法テスト — 問題集の登録と取り込み
 *
 * 単語テストには無い画面。単語は en/ja の2列で済むので貼り付けAPIだけで足りたが、
 * 文法問題は1問に9項目あり、**取り込みが失敗する理由が多い**。どの行がなぜ弾かれたかを
 * 画面に出さないと直しようがないので、専用のUIを用意する。
 *
 * 取り込みは全か無か。1行でも壊れていたら何も入れない（サーバー側で弾く）。
 * 半分だけ入った状態がいちばん厄介で、どこまで入ったか分からないまま再投入すると
 * 番号がずれる。
 *
 * ★ 問題データはリポジトリに置かない。ここか、ローカルからの d1 execute で入れる。
 */

import { useEffect, useState, useCallback } from 'react'
import { api, type GrammarBookSummary, type GrammarQuestionRow } from '@/lib/api'
import { useAccount } from '@/lib/account-context'

const SAMPLE = [
  '1\t時制\tHe ( ) here since 2020.\thas lived\tlived\tis living\thad lived\t1\tsince があるので現在完了。過去形は「いつ」の一点を指すので since と噛み合わない。',
  '2\t関係詞\tThis is the house ( ) roof is red.\twhich\twhose\tthat\twhere\t2\t後ろが roof（名詞）で、その名詞が「家の」屋根。所有を表すのは whose。',
].join('\n')

function slugify(name: string): string {
  // 日本語のタイトルからは英字のslugを作れないので、その場合は使う側に入力させる
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s
}

export default function GrammarBooksPanel() {
  const { selectedAccount } = useAccount()
  const [books, setBooks] = useState<GrammarBookSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 取り込みフォーム
  const [slug, setSlug] = useState('')
  const [name, setName] = useState('')
  const [tsv, setTsv] = useState('')
  const [shared, setShared] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    ok: boolean
    message: string
    errors?: string[]
    warnings?: string[]
  } | null>(null)

  // 中身の確認
  const [openBook, setOpenBook] = useState<number | null>(null)
  const [category, setCategory] = useState<string>('')
  const [questions, setQuestions] = useState<GrammarQuestionRow[]>([])
  const [qTotal, setQTotal] = useState(0)
  const [qLoading, setQLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.grammar.books(selectedAccount?.id)
      setBooks(res.books ?? [])
    } catch {
      setError('読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [selectedAccount])

  useEffect(() => {
    load()
  }, [load])

  const loadQuestions = useCallback(async (bookId: number, cat: string) => {
    setQLoading(true)
    try {
      const res = await api.grammar.questions(bookId, { category: cat || undefined, limit: 200 })
      setQuestions(res.questions ?? [])
      setQTotal(res.total ?? 0)
    } catch {
      setQuestions([])
      setQTotal(0)
    } finally {
      setQLoading(false)
    }
  }, [])

  const openDetail = async (bookId: number) => {
    if (openBook === bookId) {
      setOpenBook(null)
      return
    }
    setOpenBook(bookId)
    setCategory('')
    await loadQuestions(bookId, '')
  }

  const submit = async () => {
    setResult(null)
    if (!slug.trim() || !name.trim()) {
      setResult({ ok: false, message: 'slug と 問題集名 は必須です' })
      return
    }
    setBusy(true)
    try {
      const res = await api.grammar.importBook({
        slug: slug.trim(),
        name: name.trim(),
        // 共有にしない限り、いま選んでいるOAに紐づける。
        // 未指定（null）は全OA共通になるので、既定にしてはいけない。
        lineAccountId: shared ? null : (selectedAccount?.id ?? null),
        tsv: tsv.trim() || undefined,
      })
      if (res.success) {
        setResult({
          ok: true,
          message: res.imported
            ? `${res.imported}問を取り込みました。`
            : '問題集を作りました（問題は未登録です）。',
          warnings: res.warnings,
        })
        setTsv('')
        await load()
        if (openBook) await loadQuestions(openBook, category)
      } else {
        setResult({ ok: false, message: res.error ?? '取り込みに失敗しました', errors: res.errors })
      }
    } catch {
      setResult({ ok: false, message: '通信に失敗しました' })
    } finally {
      setBusy(false)
    }
  }

  const openedBook = books.find((b) => b.id === openBook) ?? null

  return (
    <div>
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* ── 既存の問題集 ── */}
      {loading ? (
        <p className="py-6 text-center text-sm text-gray-500">読み込み中...</p>
      ) : books.length === 0 ? (
        <p className="rounded-lg border border-dashed border-gray-300 py-8 text-center text-sm text-gray-500">
          問題集がまだありません。下のフォームから作ってください。
        </p>
      ) : (
        <div className="space-y-3">
          {books.map((b) => (
            <div key={b.id} className="rounded-lg border border-gray-200 bg-white">
              <button
                onClick={() => void openDetail(b.id)}
                className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 p-4 text-left"
              >
                <span className="text-base font-semibold text-gray-900">{b.name}</span>
                <span className="text-xs text-gray-400">{b.slug}</span>
                <span className="ml-auto text-sm tabular-nums text-gray-600">
                  {b.count} 問 ／ {b.categories.length} 分野
                </span>
              </button>

              <div className="flex flex-wrap gap-1.5 px-4 pb-4">
                {b.categories.map((c) => (
                  <span
                    key={c.name}
                    className="rounded-full border border-gray-200 px-2.5 py-0.5 text-xs text-gray-600"
                  >
                    {c.name} <span className="tabular-nums text-gray-400">{c.count}</span>
                  </span>
                ))}
              </div>

              {openBook === b.id && (
                <div className="border-t border-gray-200 p-4">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <select
                      value={category}
                      onChange={(e) => {
                        setCategory(e.target.value)
                        void loadQuestions(b.id, e.target.value)
                      }}
                      className="rounded border border-gray-300 px-2 py-1 text-sm text-gray-700"
                    >
                      <option value="">すべての分野</option>
                      {b.categories.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name}（{c.count}）
                        </option>
                      ))}
                    </select>
                    <span className="text-xs text-gray-500">
                      {qTotal} 問中 {questions.length} 問を表示
                    </span>
                  </div>

                  {qLoading ? (
                    <p className="py-4 text-center text-sm text-gray-500">読み込み中...</p>
                  ) : questions.length === 0 ? (
                    <p className="py-4 text-center text-sm text-gray-500">問題がありません。</p>
                  ) : (
                    <ul className="max-h-[520px] space-y-3 overflow-auto">
                      {questions.map((q) => (
                        <li key={q.id} className="rounded border border-gray-100 bg-gray-50 p-3">
                          <div className="flex flex-wrap items-baseline gap-2">
                            <span className="tabular-nums text-xs text-gray-400">
                              {String(q.no).padStart(3, '0')}
                            </span>
                            <span className="rounded-full border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-500">
                              {q.category}
                            </span>
                            {q.sub_category && (
                              <span className="text-xs text-gray-400">{q.sub_category}</span>
                            )}
                            {q.level && (
                              <span className="text-xs text-gray-400">Lv.{q.level}</span>
                            )}
                          </div>
                          <p className="mt-1.5 text-sm text-gray-800">{q.prompt}</p>
                          <div className="mt-1.5 space-y-0.5 text-xs">
                            {q.choices.map((c, i) => {
                              const why = q.distractors?.[String(i)]
                              return (
                                <div key={i} className="flex flex-wrap items-baseline gap-2">
                                  <span
                                    className={
                                      i === q.answer
                                        ? 'font-semibold text-emerald-700'
                                        : 'text-gray-500'
                                    }
                                  >
                                    {i + 1}. {c}
                                    {i === q.answer && ' ◯'}
                                  </span>
                                  {/* 誤答がどの勘違いに対応するか。空なら誰も選ばない可能性が高い */}
                                  {i !== q.answer &&
                                    (why ? (
                                      <span className="text-gray-400">← {why}</span>
                                    ) : (
                                      <span className="text-amber-600">← 勘違いラベルなし</span>
                                    ))}
                                </div>
                              )
                            })}
                          </div>
                          {q.explanation ? (
                            <p className="mt-2 text-xs leading-relaxed text-gray-600">
                              {q.explanation}
                            </p>
                          ) : (
                            <p className="mt-2 text-xs text-amber-700">
                              解説がありません。文法テストは解説が本体なので、入れることを勧めます。
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── 取り込み ── */}
      <div className="mt-8 rounded-lg border border-gray-200 bg-white">
        <div className="border-b border-gray-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-gray-700">問題を取り込む</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            既にある slug を指定すると、同じ番号の問題を上書きします（消さずに更新するので、
            生徒の解答記録は残ります）。
          </p>
        </div>
        <div className="space-y-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs text-gray-500">問題集名</span>
              <input
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                  if (!slug) setSlug(slugify(e.target.value))
                }}
                placeholder="例：受験文法 基礎"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs text-gray-500">slug（英数字。あとから変えられません）</span>
              <input
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="例：grammar-basic"
                className="mt-1 w-full rounded border border-gray-300 px-3 py-2 text-sm font-mono"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm text-gray-600">
            <input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} />
            すべてのアカウントで使う
            <span className="text-xs text-gray-400">
              （外すと「{selectedAccount?.name ?? '選択中のアカウント'}」専用）
            </span>
          </label>

          <label className="block">
            <span className="text-xs text-gray-500">
              TSV（1行1問・タブ区切り）：No / 分野 / 問題文 / 選択肢… / 正解番号 / 解説
            </span>
            <textarea
              value={tsv}
              onChange={(e) => setTsv(e.target.value)}
              rows={10}
              spellCheck={false}
              placeholder={SAMPLE}
              className="mt-1 w-full rounded border border-gray-300 p-3 font-mono text-xs leading-relaxed"
            />
          </label>

          <div className="rounded bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
            <p className="font-semibold text-gray-700">書き方</p>
            <p className="mt-1 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-amber-900">
              <b>AIで生成するときはTSVではなくJSONを使ってください。</b>
              TSVには誤答の勘違いラベルが入りません。ラベルが無いと
              「誰も選ばない誤答」を見つけられず、実質3択の問題集になります。
              生成プロンプトの雛形は <code>lms/grammar/02-generation.md</code>。
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              <li>
                <b>正解番号は1始まり。</b>画面に見える番号と同じです（0始まりにしない）
              </li>
              <li>選択肢は2〜5個。空のセルは無視されます</li>
              <li>解説は省略できますが、入れてください。文法テストは解説が本体です</li>
              <li>
                問題文の <code className="rounded bg-white px-1">( )</code> は空所、
                <code className="ml-1 rounded bg-white px-1">[ ]</code> で囲むと下線として描かれます
              </li>
              <li>分野の並び順は問題番号の若い順です。分野ごとに番号をまとめて振ってください</li>
              <li>カンマ区切りは受け付けません（問題文と解説にカンマが入るため）</li>
              <li>同じ番号が2回出てくるとエラーになります</li>
            </ul>
            <button
              onClick={() => setTsv(SAMPLE)}
              className="mt-2 rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
            >
              サンプルを入れる
            </button>
          </div>

          {result && (
            <>
              <div
                className={`rounded-lg border px-4 py-3 text-sm ${
                  result.ok
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                    : 'border-red-200 bg-red-50 text-red-700'
                }`}
              >
                {result.message}
                {result.errors && result.errors.length > 0 && (
                  <>
                    <ul className="mt-2 max-h-48 list-disc space-y-0.5 overflow-auto pl-4 text-xs">
                      {result.errors.map((e, i) => (
                        <li key={i}>{e}</li>
                      ))}
                    </ul>
                    <p className="mt-2 text-xs">
                      1行でも直せていないと何も取り込みません。全部直してからもう一度実行してください。
                    </p>
                  </>
                )}
              </div>

              {/* 警告は取り込みを止めない。「消去法で解けるかもしれない」の指摘 */}
              {result.warnings && result.warnings.length > 0 && (
                <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <p className="font-semibold">取り込みましたが、気になる点があります</p>
                  <ul className="mt-2 list-disc space-y-1 pl-4 text-xs leading-relaxed">
                    {result.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs">
                    どれも「その単元を知らなくても消去法で解けてしまう」兆候です。
                    直したら同じ slug で入れ直せば上書きされます。
                  </p>
                </div>
              )}
            </>
          )}

          <button
            onClick={() => void submit()}
            disabled={busy}
            className="rounded bg-gray-900 px-4 py-2 text-sm font-medium text-white disabled:bg-gray-300"
          >
            {busy ? '取り込み中...' : '取り込む'}
          </button>
        </div>
      </div>
    </div>
  )
}
