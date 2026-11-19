import { useState } from 'react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'

/**
 * 统一头像组件：
 * - 闲鱼返回的头像全是 `http://`（公网），页面在 http 下能显示、一上 https 就被混合内容拦掉，
 *   所以统一升级成 https；
 * - Radix 的 AvatarImage 加载失败不会自动回退到文字，这里自己记 failed；
 * - 统一 `referrerPolicy=no-referrer`，避免部分 CDN 按 Referer 拒绝。
 */
export function normalizeImgUrl(url?: string | null): string {
  const u = String(url || '').trim()
  if (!u) return ''
  if (u.startsWith('//')) return 'https:' + u
  if (u.startsWith('http://')) return 'https://' + u.slice(7)
  return u
}

export function UserAvatar({
  src,
  name,
  className,
  fallbackClassName,
}: {
  src?: string | null
  name?: string | null
  className?: string
  fallbackClassName?: string
}) {
  const [failed, setFailed] = useState(false)
  const url = normalizeImgUrl(src)
  const label = (name || '?').trim().slice(0, 1) || '?'
  return (
    <Avatar className={cn('shrink-0', className)}>
      {url && !failed ? (
        <AvatarImage
          src={url}
          alt={name || ''}
          referrerPolicy='no-referrer'
          loading='lazy'
          onError={() => setFailed(true)}
        />
      ) : null}
      <AvatarFallback className={fallbackClassName}>{label}</AvatarFallback>
    </Avatar>
  )
}
