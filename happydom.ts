import { mock } from 'bun:test';

// Mock @kofany/beamterm-terx WASM module (Subterm renderer)
// beamterm uses wasm-bindgen which can't initialize in bun test.
// This mock provides enough API surface for Terminal tests to run.
mock.module('@kofany/beamterm-terx', () => {
  const mockCellSize = { width: 8, height: 16 };

  // Mock Batch object returned by renderer.batch()
  class MockBatch {
    clear(_color: number) {}
    text(_x: number, _y: number, _text: string, _style: any) {}
    cell(_x: number, _y: number, _cell: any) {}
    cells(_cells: any[]) {}
    flush() {}
  }

  // Mock CellStyle with chainable API
  class MockCellStyle {
    fg(_color: number) { return this; }
    bg(_color: number) { return this; }
    bold() { return this; }
    italic() { return this; }
    underline() { return this; }
    strikethrough() { return this; }
  }

  // Mock ModifierKey with .or() method
  class MockModifierKey {
    constructor(public value: number) {}
    or(_other: MockModifierKey) { return new MockModifierKey(this.value); }
  }

  class MockBeamtermRenderer {
    private _canvas: HTMLCanvasElement;
    constructor(_canvas: HTMLCanvasElement) {
      this._canvas = _canvas;
    }

    // Static factory (used in production: BeamtermRenderer.withDynamicAtlas(...))
    static withDynamicAtlas(
      _canvasSelector: string,
      _fontFamilies: string[],
      _fontSize: number,
      _autoResizeCanvasCss?: boolean
    ): MockBeamtermRenderer {
      // Create a dummy canvas for tests
      const canvas = typeof document !== 'undefined'
        ? document.createElement('canvas')
        : ({} as HTMLCanvasElement);
      return new MockBeamtermRenderer(canvas);
    }

    batch() { return new MockBatch(); }
    render() {}
    cellSize() { return { ...mockCellSize }; }
    resize(_width: number, _height: number) {}
    resizePhysical(
      _physicalWidth: number,
      _physicalHeight: number,
      _cssWidth: number,
      _cssHeight: number
    ) {}
    terminalSize() { return { width: 80, height: 24 }; }
    setSelectionRange(_x1: number, _y1: number, _x2: number, _y2: number) {}
    clearSelection() {}
    hasSelection() { return false; }
    enableSelectionWithOptions(_mode: any, _trimWhitespace: boolean, _modifiers: any) {}
    copyToClipboard(_text: string) {}
    replaceWithDynamicAtlas(_fontFamilies: string[], _fontSize: number) {}
    setThemeColors(_colors: any) {}
    setCursorStyle(_style: any) {}
    setCursorBlink(_blink: boolean) {}
    setFontSize(_size: number) {}
    setFontFamily(_family: string) {}
    free() {}
    dispose() {}
  }

  return {
    main: async () => {},
    BeamtermRenderer: MockBeamtermRenderer,
    style: (..._args: any[]) => new MockCellStyle(),
    cell: (..._args: any[]) => ({}),
    SelectionMode: { Linear: 0, Block: 1 },
    ModifierKeys: {
      NONE: new MockModifierKey(0),
      SHIFT: new MockModifierKey(1),
      ALT: new MockModifierKey(2),
      CTRL: new MockModifierKey(4),
      None: new MockModifierKey(0),
      Shift: new MockModifierKey(1),
      Alt: new MockModifierKey(2),
      Ctrl: new MockModifierKey(4),
    },
  };
});

/**
 * Happy DOM Setup for Tests
 *
 * This file is preloaded by Bun before running tests (configured in bunfig.toml).
 * It registers Happy DOM's global objects (window, document, HTMLElement, etc.)
 * so that tests requiring DOM APIs can run successfully.
 *
 * @see bunfig.toml - test.preload configuration
 * @see https://bun.sh/docs/test/dom
 */

import { GlobalRegistrator } from '@happy-dom/global-registrator';

// Register Happy DOM globals (window, document, etc.)
GlobalRegistrator.register();

// Mock Canvas 2D Context
// Happy DOM doesn't provide canvas rendering APIs, so we mock them for testing.
// This provides enough functionality for terminal tests to run without actual rendering.
const originalGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (contextType: string, options?: any) {
  if (contextType === '2d') {
    // Return a minimal mock of CanvasRenderingContext2D
    return {
      canvas: this,
      fillStyle: '#000000',
      strokeStyle: '#000000',
      font: '12px monospace',
      textAlign: 'start',
      textBaseline: 'alphabetic',
      globalAlpha: 1,
      globalCompositeOperation: 'source-over',
      imageSmoothingEnabled: true,
      lineWidth: 1,
      lineCap: 'butt',
      lineJoin: 'miter',
      miterLimit: 10,
      shadowBlur: 0,
      shadowColor: 'rgba(0, 0, 0, 0)',
      shadowOffsetX: 0,
      shadowOffsetY: 0,

      // Drawing methods (no-ops for tests)
      fillRect: () => {},
      strokeRect: () => {},
      clearRect: () => {},
      fillText: () => {},
      strokeText: () => {},
      measureText: (text: string) => ({ width: text.length * 8 }),
      drawImage: () => {},
      save: () => {},
      restore: () => {},
      scale: () => {},
      rotate: () => {},
      translate: () => {},
      transform: () => {},
      setTransform: () => {},
      resetTransform: () => {},
      createLinearGradient: () => ({
        addColorStop: () => {},
      }),
      createRadialGradient: () => ({
        addColorStop: () => {},
      }),
      createPattern: () => null,
      beginPath: () => {},
      closePath: () => {},
      moveTo: () => {},
      lineTo: () => {},
      bezierCurveTo: () => {},
      quadraticCurveTo: () => {},
      arc: () => {},
      arcTo: () => {},
      ellipse: () => {},
      rect: () => {},
      fill: () => {},
      stroke: () => {},
      clip: () => {},
      isPointInPath: () => false,
      isPointInStroke: () => false,
      getTransform: () => ({}),
      getImageData: () => ({
        data: new Uint8ClampedArray(0),
        width: 0,
        height: 0,
      }),
      putImageData: () => {},
      createImageData: () => ({
        data: new Uint8ClampedArray(0),
        width: 0,
        height: 0,
      }),
    } as any;
  }
  return originalGetContext.call(this, contextType, options);
};
