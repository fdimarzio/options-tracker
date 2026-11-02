import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './pri-tod-v3.jsx'
import ImportPage from './ImportPage.jsx'
import OptionsChain from './OptionsChain.jsx'
import AuthGate from './AuthGate.jsx'

const path = window.location.pathname

const Root = () => {
  if (path === '/import') return <ImportPage />
  if (path === '/chain')  return <OptionsChain />
  return <App />
}

// Every route sits behind the gate — nothing renders or loads data until the
// user is signed in and allow-listed.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate>
      <Root />
    </AuthGate>
  </React.StrictMode>
)
