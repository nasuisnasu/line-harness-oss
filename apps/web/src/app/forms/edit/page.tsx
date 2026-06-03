'use client'

import { Suspense } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import FormEditor from './form-editor'

function Inner() {
  const params = useSearchParams()
  const router = useRouter()
  const id = params.get('id')
  return <FormEditor id={id} onClose={() => router.push('/forms')} />
}

export default function FormEditPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-gray-400">読み込み中...</div>}>
      <Inner />
    </Suspense>
  )
}
