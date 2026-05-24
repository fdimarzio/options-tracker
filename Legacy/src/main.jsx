import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './pri-tod-v3.jsx'
import ImportPage from './ImportPage.jsx'
import OptionsChain from './OptionsChain.jsx'

const path = window.location.pathname

const Root = () => {
  if (path === '/import') return <ImportPage />
  if (path === '/chain')  return <OptionsChain />
  return <App />
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
