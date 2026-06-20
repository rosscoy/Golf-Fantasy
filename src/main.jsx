import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(err) {
    return { error: err };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{padding:'2rem', fontFamily:'monospace', background:'#1a2e1a', color:'#c9a84c', minHeight:'100vh'}}>
          <h2 style={{color:'#e07070'}}>Something went wrong</h2>
          <p style={{color:'#ccc', marginBottom:'1rem'}}>
            Try <strong>F12 → Application → Service Workers → Unregister</strong>, then hard-refresh (Ctrl+Shift+R).
          </p>
          <pre style={{fontSize:'0.75rem', color:'#aaa', whiteSpace:'pre-wrap', wordBreak:'break-all'}}>
            {this.state.error.message}{'\n\n'}{this.state.error.stack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// Poll for SW updates every 60 s so open tabs pick up new deploys without a manual reload.
if ('serviceWorker' in navigator) {
  setInterval(() => {
    navigator.serviceWorker.getRegistration().then(r => r?.update()).catch(() => {});
  }, 60_000);
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
