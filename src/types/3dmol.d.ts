/** Minimal typings for the 3Dmol.js global loaded from the CDN. */
export {};

interface Mol3DViewer {
  addModel(data: string, format: string): unknown;
  setStyle(sel: Record<string, unknown>, style: Record<string, unknown>): void;
  addStyle(sel: Record<string, unknown>, style: Record<string, unknown>): void;
  addSurface(type: unknown, style: Record<string, unknown>, sel?: Record<string, unknown>): void;
  addLabel(text: string, options: Record<string, unknown>): unknown;
  removeAllModels(): void;
  removeAllLabels(): void;
  removeAllSurfaces(): void;
  zoomTo(sel?: Record<string, unknown>): void;
  zoom(factor: number, duration?: number): void;
  center(sel?: Record<string, unknown>, duration?: number): void;
  render(): void;
  resize(): void;
  clear(): void;
}

declare global {
  interface Window {
    $3Dmol?: {
      createViewer(element: HTMLElement, config?: Record<string, unknown>): Mol3DViewer;
      SurfaceType: { VDW: unknown; MS: unknown; SAS: unknown; SES: unknown };
    };
  }
}
