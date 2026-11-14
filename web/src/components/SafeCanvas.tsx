// An R3F <Canvas> that can't take the page down with it.
// - Errors while creating or rendering the scene (e.g. "Error creating WebGL context" when the GPU refuses a
//   context) are caught by an ErrorBoundary scoped to this canvas.
// - If the browser drops the WebGL context later (GPU reset, too many contexts), the canvas is replaced by a
//   small panel with a restart button instead of freezing or throwing.
import { useCallback, useState, type JSX } from 'react';
import { Canvas, type CanvasProps, type RootState } from '@react-three/fiber';
import { ErrorBoundary } from './ErrorBoundary';

interface SafeCanvasProps extends CanvasProps {
  /** Name used in the error panel and console, e.g. "3D view (Moon)". */
  name: string;
  /** Changing this clears an earlier failure (e.g. a different tile). */
  resetKey?: string;
}

export function SafeCanvas({ name, resetKey, onCreated, children, ...props }: SafeCanvasProps): JSX.Element {
  const [generation, setGeneration] = useState<number>(0);
  const [lost, setLost] = useState<boolean>(false);

  const restart = useCallback((): void => {
    setLost(false);
    setGeneration((g: number): number => g + 1);
  }, []);

  const handleCreated = useCallback(
    (state: RootState): void => {
      const el = state.gl.domElement;
      el.addEventListener('webglcontextlost', (e: Event): void => {
        e.preventDefault();
        // R3F also releases the context when the canvas unmounts; only react to a loss on a live canvas.
        window.setTimeout((): void => {
          if (el.isConnected) {
            console.warn(`[view] ${name}: WebGL context lost`);
            setLost(true);
          }
        }, 0);
      });
      onCreated?.(state);
    },
    [name, onCreated],
  );

  return (
    <ErrorBoundary name={name} compact resetKey={`${resetKey ?? ''}:${generation}`} onRetry={restart}>
      {lost ? (
        <div className="view-error view-error-compact" role="alert">
          <p className="view-error-title">The 3D view paused</p>
          <p className="view-error-msg">The browser dropped the graphics context (this can happen when many 3D views are open).</p>
          <button type="button" className="btn btn-sm" onClick={restart}>
            Restart 3D view
          </button>
        </div>
      ) : (
        <Canvas key={generation} {...props} onCreated={handleCreated}>
          {children}
        </Canvas>
      )}
    </ErrorBoundary>
  );
}
