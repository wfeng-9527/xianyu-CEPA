import { createFileRoute } from '@tanstack/react-router'
import { Placeholder } from '@/features/placeholder'

export const Route = createFileRoute('/_authenticated/accounts/')({
  component: () => (
    <Placeholder
      title='账号与 Cookie'
      note='多账号 Cookie 库与当前绑定。'
      todos={[
          '展示 data/accounts/*.cookie 与过期时间',
          '调 node scripts/add_account.js 加号',
          '一键校验（GET /api/health）',
      ]}
    />
  ),
})