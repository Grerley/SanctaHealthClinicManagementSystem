import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Banner } from '@sancta/ui';

/**
 * Isolates a single screen's runtime failure. A clinic runs the whole day on one shell;
 * an unexpected error in one screen must never white-screen the device and strand a
 * clinician mid-shift. This boundary catches a render/lifecycle throw from the active
 * screen, keeps the shell and navigation mounted, and offers a way out (pick another
 * screen, or reload). Keyed by the active screen id in the shell, so switching screens
 * clears a prior error automatically.
 *
 * No PHI is logged: the message is generic and the caught error is not surfaced to the
 * UI or to any transport — only a non-identifying breadcrumb goes to the console.
 */
export class ScreenErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // Deliberately no PHI and no error detail off-device — just a breadcrumb that a
    // screen failed, so a crash is observable without leaking clinical data.
    // eslint-disable-next-line no-console
    console.error('A screen failed to render and was contained by the error boundary.');
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <div role="alert">
          <Banner tone="danger" assertive>
            This screen hit an unexpected problem and could not be shown. Your other work is
            unaffected — choose another screen from the menu, or reload this device.
          </Banner>
        </div>
      );
    }
    return this.props.children;
  }
}
