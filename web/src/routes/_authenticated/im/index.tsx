import { createFileRoute } from '@tanstack/react-router'
import { ImWorkbench } from '@/features/im'

export const Route = createFileRoute('/_authenticated/im/')({
  component: ImWorkbench,
})
