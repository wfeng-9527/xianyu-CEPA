import { createFileRoute } from '@tanstack/react-router'
import { TrainPage } from '@/features/train'

export const Route = createFileRoute('/_authenticated/train/')({
  component: TrainPage,
})
