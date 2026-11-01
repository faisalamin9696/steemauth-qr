/**
 * Built-in QR rendering — the package is all-in-one: no extra QR library
 * needed. The rendered content is the session payload (`session.qrString`);
 * you may still render that string with any QR library instead.
 */
import QRCode from 'qrcode';

export interface QrRenderOptions {
  /** pixel size for data-URL / canvas renders (default 300) */
  size?: number;
  /**
   * Quiet-zone modules around the code (default 4 — the scanned standard;
   * smaller margins make phones struggle in the wild).
   */
  margin?: number;
  /** Error-correction level (default 'M'; use 'H' when placing a logo) */
  errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H';
  /** dark/light colors, e.g. '#000000' / '#ffffff' */
  dark?: string;
  light?: string;
}

function renderOptions(options: QrRenderOptions) {
  return {
    margin: options.margin ?? 4,
    errorCorrectionLevel: options.errorCorrectionLevel ?? 'M',
    color: { dark: options.dark ?? '#000000', light: options.light ?? '#ffffff' },
  };
}

/** Render the QR payload as a standalone SVG string (SSR-friendly). */
export async function toQrSvg(payload: string, options: QrRenderOptions = {}): Promise<string> {
  return QRCode.toString(payload, { type: 'svg', ...renderOptions(options) });
}

/** Render the QR payload as a PNG data URL (browser / Node / React Native). */
export async function toQrDataUrl(payload: string, options: QrRenderOptions = {}): Promise<string> {
  return QRCode.toDataURL(payload, {
    type: 'image/png',
    width: options.size ?? 300,
    ...renderOptions(options),
  });
}

/**
 * Draw the QR payload onto an existing `<canvas>` (browser only — React /
 * Vue / vanilla). Use `size` to match the canvas' CSS pixel size × DPR.
 */
export async function toQrCanvas(
  canvas: HTMLCanvasElement,
  payload: string,
  options: QrRenderOptions = {},
): Promise<void> {
  await QRCode.toCanvas(canvas, payload, {
    width: options.size ?? 300,
    ...renderOptions(options),
  });
}
