import { useState } from 'react'
import { FileText, ImageOff, Package } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { MessageMedia } from '@/lib/im'

function humanSize(n?: number) {
  const v = Number(n) || 0
  if (v >= 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB'
  if (v >= 1024) return Math.round(v / 1024) + ' KB'
  return v + ' B'
}

function Pic({ url, fromSelf }: { url: string; fromSelf: boolean }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return (
      <div className='flex h-24 w-40 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground'>
        <ImageOff className='size-4' />
        <span className='text-[11px]'>图片加载失败</span>
      </div>
    )
  }
  return (
    <img
      src={url}
      loading='lazy'
      referrerPolicy='no-referrer'
      onClick={() => window.open(url, '_blank', 'noopener')}
      onError={() => setFailed(true)}
      className={cn(
        'max-w-[260px] cursor-zoom-in rounded-lg object-cover',
        fromSelf ? 'bg-primary-foreground/10' : 'bg-muted'
      )}
      alt='图片'
    />
  )
}

/** 一条消息的内容区：图片 / 语音 / 文件 / 表情 / 商品卡 / 卡片 */
export function MessageMediaBody({
  media,
  fromSelf,
  sessionId,
}: {
  media: MessageMedia
  fromSelf: boolean
  sessionId?: string
}) {
  const { type } = media

  if (type === 'image' && media.images?.length) {
    const pics = media.images
    if (pics.length === 1) return <Pic url={pics[0].url} fromSelf={fromSelf} />
    return (
      <div className='grid w-[260px] grid-cols-3 gap-1'>
        {pics.map((p) => (
          <div key={p.url} className='aspect-square overflow-hidden rounded-md'>
            <Pic url={p.url} fromSelf={fromSelf} />
          </div>
        ))}
      </div>
    )
  }

  if (type === 'emoji' && media.emoji?.url) {
    return (
      <img
        src={media.emoji.url}
        alt={media.emoji.name || '表情'}
        title={media.emoji.name || ''}
        loading='lazy'
        referrerPolicy='no-referrer'
        className='size-24 object-contain'
      />
    )
  }

  if (type === 'audio' && media.audio?.url) {
    return (
      <div className='flex w-56 flex-col gap-1'>
        <audio controls preload='metadata' src={media.audio.url} className='w-full' />
        <span className='text-[11px] opacity-70'>
          语音 {media.audio.duration ? media.audio.duration + '"' : ''}
        </span>
      </div>
    )
  }

  if (type === 'file' && media.file) {
    const f = media.file
    const href =
      f.key && sessionId
        ? '/api/file/download?sessionId=' +
          encodeURIComponent(String(sessionId)) +
          '&fileKey=' +
          encodeURIComponent(f.key) +
          '&name=' +
          encodeURIComponent(f.name || 'file')
        : ''
    return (
      <div
        className={cn(
          'flex w-64 items-center gap-2 rounded-lg border px-2.5 py-2',
          fromSelf ? 'border-primary-foreground/25 bg-primary-foreground/10' : 'bg-background'
        )}
      >
        <FileText className='size-8 shrink-0 opacity-80' />
        <div className='min-w-0 flex-1'>
          <p className='truncate text-[13px] font-medium'>{f.name || '文件'}</p>
          <p className='text-[11px] opacity-70'>
            {humanSize(f.size)}
            {f.ext ? ' · ' + f.ext.toUpperCase() : ''}
            {href ? (
              <>
                {' · '}
                <a
                  className='underline decoration-dotted underline-offset-2 hover:opacity-80'
                  href={href}
                  download={f.name || 'file'}
                >
                  下载
                </a>
              </>
            ) : null}
          </p>
        </div>
      </div>
    )
  }

  if (type === 'item' && media.item) {
    const it = media.item
    return (
      <div className='flex w-64 items-start gap-2 rounded-lg border bg-background p-2'>
        {it.pic ? (
          <img src={it.pic} alt='' className='size-14 shrink-0 rounded object-cover' />
        ) : (
          <div className='flex size-14 shrink-0 items-center justify-center rounded bg-muted'>
            <Package className='size-5 text-muted-foreground' />
          </div>
        )}
        <div className='min-w-0 flex-1'>
          <p className='line-clamp-2 text-[13px] leading-snug'>{it.title || '商品'}</p>
          <p className='mt-1 text-[12px] font-medium text-red-500'>{it.price || ''}</p>
        </div>
      </div>
    )
  }

  if (type === 'transfer' && media.transfer) {
    return (
      <div className='flex w-56 items-center gap-2 rounded-lg border bg-background px-3 py-2'>
        {media.transfer.pic ? <img src={media.transfer.pic} alt='' className='size-8' /> : null}
        <div>
          <p className='text-[13px]'>{media.transfer.title || '转账'}</p>
          <p className='text-[12px] font-medium'>{media.transfer.content}</p>
        </div>
      </div>
    )
  }

  if (type === 'rtc') {
    return (
      <div className='flex flex-col gap-0.5'>
        <span>{media.rtc?.detail || media.text || '语音通话'}</span>
      </div>
    )
  }

  if (type === 'withdraw') {
    return <span className='text-[12px] italic opacity-70'>{media.text || '撤回了一条消息'}</span>
  }

  if (type === 'card') {
    const c = media.card
    return (
      <div className='flex w-64 flex-col gap-1 rounded-lg border bg-background p-2'>
        <p className='text-[13px] font-medium'>{c?.title || media.text}</p>
        {c?.desc ? <p className='line-clamp-2 text-[11px] text-muted-foreground'>{c.desc}</p> : null}
        {c?.button ? <p className='text-[11px] text-sky-600'>[{c.button}]</p> : null}
      </div>
    )
  }

  return <span>{media.text || ''}</span>
}
