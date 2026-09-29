import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { MotionConfig } from 'motion/react';
import App from './App.tsx';
import './index.css';
import { installApiAuth } from './utils/api.ts';

// Attach the API-token fetch interceptor before anything can request —
// required for token-protected (non-loopback) deployments.
installApiAuth();

// If anything inside the app throws during boot, lift the boot screen and
// show a minimal terminal-style error instead of a stuck loading screen.
class BootBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: unknown) {
    document.getElementById("boot-screen")?.remove();
    console.error("GameTrack crashed:", error);
  }

  override render() {
    if (this.state.failed) {
      return (
        <div className="h-screen w-screen flex items-center justify-center bg-brand-bg">
          <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-red-400">
            FATAL ERROR — CHECK THE CONSOLE
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* reducedMotion="user" disables transform/opacity animations for users
        who prefer reduced motion (OS-level setting). */}
    <MotionConfig reducedMotion="user">
      <BootBoundary>
        <App />
      </BootBoundary>
    </MotionConfig>
  </StrictMode>,
);
