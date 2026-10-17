import { Modal } from '@mantine/core'
import type { Asset } from '../../shared/api/api'
import CanvasNodeMedia from './CanvasNodeMedia'
import CanvasImagePreview from './CanvasImagePreview'
import './canvas-media-preview.css'

export default function CanvasMediaPreview({ asset, title, onClose }: { asset: Asset; title: string; onClose: () => void }) {
  return <Modal opened onClose={onClose} closeOnEscape={false} fullScreen xOffset={0} yOffset={0} radius={0} padding={0} zIndex={240}
    title={title || asset.filename} closeButtonProps={{ 'aria-label': '关闭素材预览' }}
    classNames={{ content: 'pc-media-preview', header: 'pc-media-preview-header', title: 'pc-media-preview-title', body: 'pc-media-preview-body' }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => {
      if (event.key !== 'Tab') event.stopPropagation()
      // Close after window capture listeners have run, keeping the same Escape
      // from also closing a candidate manager or clearing the canvas selection.
      if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); onClose() }
    }}>
    <div className={`pc-media-preview-stage${asset.kind === 'image' ? ' pc-media-preview-image-stage' : ''}`}>
      {asset.kind === 'image' ? <CanvasImagePreview key={`${asset.id}:${asset.url}`} src={asset.url} alt={title || asset.filename} /> : <CanvasNodeMedia asset={asset} controls />}
    </div>
  </Modal>
}
