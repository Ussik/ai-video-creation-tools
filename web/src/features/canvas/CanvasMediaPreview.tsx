import { Modal } from '@mantine/core'
import type { Asset } from '../../shared/api/api'
import CanvasNodeMedia from './CanvasNodeMedia'
import './canvas-media-preview.css'

export default function CanvasMediaPreview({ asset, title, onClose }: { asset: Asset; title: string; onClose: () => void }) {
  return <Modal opened onClose={onClose} centered size="min(1600px, calc(100vw - 32px))" radius={14} padding={0} zIndex={240}
    title={title || asset.filename} closeButtonProps={{ 'aria-label': '关闭素材预览' }}
    classNames={{ content: 'pc-media-preview', header: 'pc-media-preview-header', title: 'pc-media-preview-title', body: 'pc-media-preview-body' }}
    onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
    <div className="pc-media-preview-stage">
      {asset.kind === 'image' ? <img src={asset.url} alt={title || asset.filename} /> : <CanvasNodeMedia asset={asset} controls />}
    </div>
  </Modal>
}
