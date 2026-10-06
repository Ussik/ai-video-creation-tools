import React from 'react'
import ReactDOM from 'react-dom/client'
import { MantineProvider } from '@mantine/core'
import App from './App'
import { theme } from './theme'
import '@mantine/core/styles.css'
import '@mantine/dropzone/styles.css'
import './styles.css'
import './controls.css'
import './theme.css'
import './workspace.css'
import './workspace-theme.css'
import './asset-library.css'
import './dropdown-theme.css'
import './canvas-generation-controls.css'
import './creation-surfaces.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <App />
    </MantineProvider>
  </React.StrictMode>,
)
