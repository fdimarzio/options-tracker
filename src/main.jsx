import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './pri-tod-v3.jsx'
import ImportPage from './ImportPage.jsx'

const isImport = window.location.pathname === '/import'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isImport ? <ImportPage /> : <App />}
  </React.StrictMode>
)
