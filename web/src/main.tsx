import '@mantine/core/styles.css'
import '@mantine/dropzone/styles.css'
import React from 'react'
import ReactDOM from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import App from './app/App'
import { theme } from './shared/ui/theme'
import './styles/styles.css'
import './shared/ui/controls.css'
import './styles/workspace.css'
import './styles/workspace-theme.css'
import './features/assets/asset-library.css'
import './shared/ui/dropdown-theme.css'
import './features/canvas/canvas-generation-controls.css'
import './shared/ui/creation-surfaces.css'
import './shared/ui/media/studio-media-player.css'
import './styles/theme.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <App />
    </MantineProvider>
  </React.StrictMode>,
)
